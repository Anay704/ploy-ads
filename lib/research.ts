// researchStore without the agent (PLAN.md §3): Shopify catalog + brand research, saved to
// brand_kits and products. Only the logo and the 3 picks' source photos are copied into
// Storage; the rest of the catalog stays as CDN URLs until an ad uses it.

import 'server-only';
import sharp from 'sharp';
import { supabaseServer, BUCKET, type Db } from './supabase/server';
import type { Json } from './supabase/database.types';
import { researchBrand, type BrandKit } from './brand';
import {
  detectShopify,
  fetchCatalog,
  fetchProduct,
  fetchSeasonalCollections,
  imageFetchUrl,
  parseStoreUrl,
  pickMix,
  pickSourceImage,
  slimProduct,
  suggestGoal,
  type Goal,
  type RankedProduct,
  type Slot,
} from './shopify';

export type Recommended = {
  productId: string;
  title: string;
  price: number;
  compareAtPrice: number | null;
  tags: string[];
  slot: Slot;
  reason: string;
  imageAssetId: string;
  imageUrl: string; // public Storage URL of the copied photo
};

export type ResearchResult =
  | { error: 'not_shopify'; url: string }
  | {
      brandKitId: string;
      brandKit: BrandKit;
      logoAssetId: string | null;
      recommended: Recommended[];
      suggestedGoal: Goal;
      skipped: { title: string; reason: string }[]; // products passed over for the picks, and why
      catalogCount: number;
      candidates: string[]; // top 20 as one-liners: what the agent will see, never raw JSON
    };

export type Progress = (step: string) => void;

export async function research(
  input: string,
  onProgress: Progress = () => {},
  opts: { freshScrape?: boolean; today?: Date } = {},
): Promise<ResearchResult> {
  const target = parseStoreUrl(input);
  onProgress(`Checking ${target.domain} for a Shopify catalog…`);
  const shop = await detectShopify(target.origin);
  if (!shop) return { error: 'not_shopify', url: input };

  const db = supabaseServer();
  const kit = must(
    await db
      .from('brand_kits')
      .upsert({ domain: target.domain, store_url: shop.origin, name: shop.meta.name, status: 'researching' }, { onConflict: 'domain' })
      .select('id, raw')
      .single(),
    'upsert brand kit',
  );

  // Catalog and brand research are independent, so they run in parallel.
  const catalogP = (async () => {
    const raw = await fetchCatalog(shop.origin);
    if (target.productHandle && !raw.some((p) => p.handle === target.productHandle)) {
      const pinned = await fetchProduct(shop.origin, target.productHandle);
      if (pinned) raw.push(pinned);
    }
    onProgress(`Reading catalog… ${raw.length} products`);
    return raw.map(slimProduct);
  })();
  const prevRaw = (kit.raw ?? {}) as Record<string, unknown>;
  const brandP = (async () => {
    onProgress('Extracting brand…');
    return researchBrand(shop.origin, shop.meta, {
      cachedFirecrawl: opts.freshScrape ? undefined : prevRaw.firecrawl,
      // Saved straight away, so a failure later in research doesn't throw the credits away.
      onFirecrawl: async (firecrawl) => {
        must(await db.from('brand_kits').update({ raw: { ...prevRaw, firecrawl } as Json }).eq('id', kit.id).select('id'), 'cache firecrawl');
      },
    });
  })();
  const [products, brand, collections] = await Promise.all([catalogP, brandP, fetchSeasonalCollections(shop.origin)]);

  onProgress('Picking products…');
  const { picks, ordered, skipped } = pickMix(products, { today: opts.today ?? new Date(), collections, pinnedHandle: target.productHandle });
  const rankById = new Map(ordered.map((r) => [r.shopifyId, r]));

  // Every slimmed product is stored so the review card's Swap picker can offer the rest.
  const rows = products.map((p) => {
    const r = rankById.get(p.shopifyId);
    return {
      brand_kit_id: kit.id,
      shopify_id: p.shopifyId,
      handle: p.handle,
      title: p.title,
      product_type: p.productType,
      tags: p.tags,
      price: p.price,
      compare_at_price: p.compareAtPrice,
      available: p.available,
      description: p.description,
      images: p.images,
      rank: r?.rank ?? null,
      rank_reason: r?.rankReason ?? null,
    };
  });
  const saved = new Map<number, string>();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = must(
      await db.from('products').upsert(rows.slice(i, i + 500), { onConflict: 'brand_kit_id,shopify_id' }).select('id, shopify_id'),
      'upsert products',
    );
    for (const row of chunk) saved.set(row.shopify_id, row.id);
  }

  const logoAssetId = brand.logoUrl ? await copyLogo(db, kit.id, brand.logoUrl) : null;
  const recommended = await Promise.all(picks.map((p) => copyPick(db, kit.id, saved.get(p.shopifyId)!, p, p.slot)));
  await removeUnusedProductImages(db, kit.id, new Set(recommended.map((r) => r.imageAssetId)));

  const { raw, ...brandKit } = brand;
  must(
    await db
      .from('brand_kits')
      .update({
        name: brand.name,
        short_name: brand.shortName,
        claim_groups: brand.claimGroups as Json,
        logo_asset_id: logoAssetId,
        colors: brand.colors,
        fonts: brand.fonts,
        voice: brand.voice,
        value_prop: brand.valueProp,
        audience: brand.audience,
        claims: brand.claims,
        raw: { ...raw, rejectedClaims: brand.rejectedClaims, sources: brand.sources } as Json,
        status: 'draft',
      })
      .eq('id', kit.id)
      .select('id'),
    'save brand kit',
  );

  return {
    brandKitId: kit.id,
    brandKit,
    logoAssetId,
    recommended,
    suggestedGoal: suggestGoal(picks),
    skipped,
    catalogCount: products.length,
    candidates: ordered.slice(0, 20).map(oneLiner),
  };
}

function oneLiner(p: RankedProduct): string {
  const price = p.compareAtPrice ? `$${p.price.toFixed(2)} (was $${p.compareAtPrice.toFixed(2)})` : `$${p.price.toFixed(2)}`;
  return `#${p.rank} ${p.title} · ${price} · tags: ${p.tags.join(', ') || 'none'}`;
}

// ── Storage copies ───────────────────────────────────────────────────────────

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function saveAsset(
  db: Db,
  a: { brandKitId: string; kind: 'logo' | 'product_image'; path: string; sourceUrl: string; body: Buffer; mime: string },
): Promise<string> {
  must(await db.storage.from(BUCKET).upload(a.path, a.body, { contentType: a.mime, upsert: true }), `upload ${a.path}`);
  const meta = await sharp(a.body).metadata();
  const row = must(
    await db
      .from('assets')
      .upsert(
        { brand_kit_id: a.brandKitId, kind: a.kind, storage_path: a.path, source_url: a.sourceUrl, width: meta.width, height: meta.height, mime: a.mime },
        { onConflict: 'storage_path' },
      )
      .select('id')
      .single(),
    `record asset ${a.path}`,
  );
  return row.id;
}

/**
 * A rerun can change the picks. Product photos copied for earlier picks are deleted unless
 * they are current picks or an ad already uses them, so Storage only holds images in use.
 */
async function removeUnusedProductImages(db: Db, brandKitId: string, keep: Set<string>) {
  const assets = must(await db.from('assets').select('id, storage_path').eq('brand_kit_id', brandKitId).eq('kind', 'product_image'), 'list product images');
  const used = must(await db.from('ads').select('source_asset_id').in('source_asset_id', assets.map((a) => a.id)), 'find used images');
  const usedIds = new Set(used.map((u) => u.source_asset_id));
  const stale = assets.filter((a) => !keep.has(a.id) && !usedIds.has(a.id));
  if (!stale.length) return;
  must(await db.storage.from(BUCKET).remove(stale.map((a) => a.storage_path)), 'remove stale images');
  must(await db.from('assets').delete().in('id', stale.map((a) => a.id)).select('id'), 'delete stale asset rows');
}

/** The logo is rasterized to PNG (SVG logos included), since sharp composites it in M4. */
async function copyLogo(db: Db, brandKitId: string, logoUrl: string): Promise<string | null> {
  try {
    const png = await sharp(await download(logoUrl), { density: 300 }).resize({ width: 800, withoutEnlargement: true }).png().toBuffer();
    return await saveAsset(db, { brandKitId, kind: 'logo', path: `brands/${brandKitId}/logo.png`, sourceUrl: logoUrl, body: png, mime: 'image/png' });
  } catch (e) {
    console.warn(`logo copy failed (${logoUrl}): ${(e as Error).message}`);
    return null;
  }
}

async function copyPick(db: Db, brandKitId: string, productId: string, p: RankedProduct, slot: Slot): Promise<Recommended> {
  const img = pickSourceImage(p);
  if (!img) throw new Error(`${p.title} has no images`);
  const url = imageFetchUrl(img.src);
  // Re-encode to JPEG whatever the CDN sends (it returns PNG for GIF sources).
  const jpg = await sharp(await download(url)).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  const path = `brands/${brandKitId}/products/${productId}/${img.id}.jpg`;
  const imageAssetId = await saveAsset(db, { brandKitId, kind: 'product_image', path, sourceUrl: url, body: jpg, mime: 'image/jpeg' });
  return {
    productId,
    title: p.title,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    tags: p.tags,
    slot,
    reason: p.rankReason,
    imageAssetId,
    imageUrl: db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
  };
}

function must<R extends { data: unknown; error: { message: string } | null }>(res: R, what: string): NonNullable<R['data']> {
  if (res.error || res.data === null) throw new Error(`${what}: ${res.error?.message ?? 'no data'}`);
  return res.data as NonNullable<R['data']>;
}
