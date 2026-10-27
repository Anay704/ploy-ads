'use server';

// Server actions for the start screen and the review card (PLAN.md §2). Grid actions arrive in M4.

import { redirect } from 'next/navigation';
import { BriefApproval } from '@/lib/agent';
import { BriefEdits, hasRealDiscount, type BriefData, type BriefProduct } from '@/lib/brief';
import { ensureProductImage, must, removeUnusedProductImages } from '@/lib/research';
import { detectShopify, imageFetchUrl, parseStoreUrl, pickSourceImage, type ShopifyImage } from '@/lib/shopify';
import { BUCKET, supabaseServer } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/database.types';

// ── Start ────────────────────────────────────────────────────────────────────

export type StartState = { error?: string; url?: string };

/**
 * Checks the URL is a Shopify store before anything is created, then creates the brand kit
 * (researching) and the campaign (briefing) and opens the workspace, where the agent researches.
 */
export async function startResearch(_prev: StartState, form: FormData): Promise<StartState> {
  const url = String(form.get('url') ?? '').trim();
  if (!url) return { error: 'Paste a store or product URL to start.', url };

  let target;
  try {
    target = parseStoreUrl(url);
    if (!target.domain.includes('.')) throw new Error('no domain');
  } catch {
    return { error: "That doesn't look like a web address. Try something like loopycases.com.", url };
  }

  const shop = await detectShopify(target.origin);
  if (!shop) return { error: "We currently support Shopify stores. This one doesn't expose a Shopify catalog.", url };

  const db = supabaseServer();
  const kit = must(
    await db
      .from('brand_kits')
      .upsert({ domain: target.domain, store_url: shop.origin, name: shop.meta.name, status: 'researching' }, { onConflict: 'domain' })
      .select('id')
      .single(),
    'create brand kit',
  );
  const campaign = must(
    await db.from('campaigns').insert({ brand_kit_id: kit.id, source_url: url, name: `${shop.meta.name} campaign` }).select('id').single(),
    'create campaign',
  );
  redirect(`/c/${campaign.id}`);
}

// ── Review card data ─────────────────────────────────────────────────────────

type ProductRow = {
  id: string;
  title: string;
  price: number;
  compare_at_price: number | null;
  tags: string[];
  rank_reason: string | null;
  images: unknown;
};

function toBriefProduct(row: ProductRow, storedImage: string | null): BriefProduct {
  const images = (row.images ?? []) as ShopifyImage[];
  const img = pickSourceImage({ images });
  return {
    id: row.id,
    title: row.title,
    price: Number(row.price),
    compareAtPrice: row.compare_at_price === null ? null : Number(row.compare_at_price),
    clearance: row.tags.includes('last call'),
    tags: row.tags,
    reason: row.rank_reason,
    // The copied Storage photo when there is one; the CDN for catalog browsing in Swap.
    imageUrl: storedImage ?? (img ? imageFetchUrl(img.src).replace('width=1080', 'width=480') : null),
  };
}

/**
 * Everything the review card shows comes from the database, not from the model's tool input,
 * so the agent can point at products but can't change a claim, a price or a color.
 */
export async function loadBrief(campaignId: string, brandKitId: string, productIds: string[]): Promise<BriefData> {
  const db = supabaseServer();
  const campaign = must(await db.from('campaigns').select('id, status, goal, product_ids, brand_kit_id').eq('id', campaignId).single(), 'load campaign');
  if (campaign.brand_kit_id !== brandKitId) throw new Error('brand kit does not belong to this campaign');
  const kit = must(
    await db
      .from('brand_kits')
      .select('id, name, short_name, domain, colors, voice, value_prop, audience, claims, claim_groups, logo:assets!brand_kits_logo_asset_id_fkey(storage_path)')
      .eq('id', brandKitId)
      .single(),
    'load brand kit',
  );
  // Once confirmed, the saved choice wins over what the model first proposed.
  const ids = campaign.status === 'active' && campaign.product_ids.length ? campaign.product_ids : productIds;
  const rows = must(
    await db.from('products').select('id, title, price, compare_at_price, tags, rank_reason, images').eq('brand_kit_id', brandKitId).in('id', ids),
    'load products',
  );
  const stored = await storedImages(brandKitId, ids);
  const publicUrl = (path: string) => db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const colors = (kit.colors ?? {}) as Partial<BriefData['brandKit']['colors']>;
  const voice = (kit.voice ?? { adjectives: [], sample: '' }) as BriefData['brandKit']['voice'];

  return {
    campaignId,
    status: campaign.status,
    goal: campaign.goal,
    brandKit: {
      id: kit.id,
      name: kit.name ?? kit.domain,
      shortName: kit.short_name ?? kit.name ?? kit.domain,
      domain: kit.domain,
      logoUrl: kit.logo ? publicUrl(kit.logo.storage_path) : null,
      colors: { primary: '#111111', secondary: '#FFFFFF', accent: '#111111', background: '#FFFFFF', text: '#111111', ...colors },
      voice: { adjectives: [...voice.adjectives, '', '', ''].slice(0, 3), sample: voice.sample },
      valueProp: kit.value_prop ?? '',
      audience: kit.audience ?? '',
      claimGroups: (kit.claim_groups ?? []) as BriefData['brandKit']['claimGroups'],
      verifiedClaims: kit.claims,
    },
    products: ids.flatMap((id) => {
      const row = rows.find((r) => r.id === id);
      return row ? [toBriefProduct(row, stored.get(row.id) ?? null)] : [];
    }),
  };
}

async function storedImages(brandKitId: string, productIds: string[]): Promise<Map<string, string>> {
  const db = supabaseServer();
  const assets = must(await db.from('assets').select('storage_path').eq('brand_kit_id', brandKitId).eq('kind', 'product_image'), 'load product images');
  const map = new Map<string, string>();
  for (const a of assets) {
    const productId = a.storage_path.split('/')[3]; // brands/{kit}/products/{productId}/{imageId}.jpg
    if (productIds.includes(productId)) map.set(productId, db.storage.from(BUCKET).getPublicUrl(a.storage_path).data.publicUrl);
  }
  return map;
}

/** The Swap picker: available products by rank, clearance last, optionally filtered by title. */
export async function listSwapCandidates(brandKitId: string, query = ''): Promise<BriefProduct[]> {
  const db = supabaseServer();
  let q = db
    .from('products')
    .select('id, title, price, compare_at_price, tags, rank_reason, images')
    .eq('brand_kit_id', brandKitId)
    .eq('available', true)
    .not('rank', 'is', null)
    .order('rank')
    .limit(60);
  if (query.trim()) q = q.ilike('title', `%${query.trim().replace(/[%_]/g, '')}%`);
  const rows = must(await q, 'list products');
  return rows.map((r) => toBriefProduct(r, null)).sort((a, b) => Number(a.clearance) - Number(b.clearance));
}

// ── Generate ─────────────────────────────────────────────────────────────────

/**
 * The marketer clicked Generate. Saves the edited brand kit, copies photos for any swapped-in
 * product, and activates the campaign. Returns the approval the client hands to the agent.
 */
export async function confirmBrief(input: BriefEdits): Promise<BriefApproval> {
  const edits = BriefEdits.parse(input);
  const db = supabaseServer();

  const campaign = must(await db.from('campaigns').select('id, status, goal, product_ids, brand_kit_id').eq('id', edits.campaignId).single(), 'load campaign');
  if (campaign.brand_kit_id !== edits.brandKitId) throw new Error('brand kit does not belong to this campaign');

  const kit = must(await db.from('brand_kits').select('claims').eq('id', edits.brandKitId).single(), 'load brand kit');
  const verified = new Set(kit.claims);
  const invented = edits.claimGroups.flatMap((g) => g.claims).filter((c) => !verified.has(c));
  if (invented.length) throw new Error(`Claims must come from the site: ${invented.join('; ')}`);

  const productIds = [...new Set(edits.productIds)];
  const products = must(
    await db.from('products').select('id, title, price, compare_at_price, tags, images, available').eq('brand_kit_id', edits.brandKitId).in('id', productIds),
    'load products',
  );
  if (products.length !== productIds.length || products.some((p) => !p.available)) throw new Error('Pick available products from this store.');
  const brief = products.map((p) => toBriefProduct({ ...p, rank_reason: null }, null));
  if (edits.goal === 'sale' && !brief.some(hasRealDiscount)) throw new Error('A sale needs a product with a real discount that is not clearance.');

  must(
    await db
      .from('brand_kits')
      .update({
        short_name: edits.shortName,
        colors: edits.colors,
        voice: edits.voice,
        value_prop: edits.valueProp,
        audience: edits.audience,
        claim_groups: edits.claimGroups as unknown as NonNullable<Json>,
        status: 'confirmed',
      })
      .eq('id', edits.brandKitId)
      .select('id'),
    'save brand kit',
  );

  // Swapped-in products need their photo in Storage; dropped picks' photos are removed.
  const images = await Promise.all(
    productIds.map((id) => {
      const p = products.find((x) => x.id === id)!;
      return ensureProductImage(db, edits.brandKitId, id, { title: p.title, images: (p.images ?? []) as ShopifyImage[] });
    }),
  );
  await removeUnusedProductImages(db, edits.brandKitId, new Set(images.map((i) => i.assetId)));

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  must(
    await db
      .from('campaigns')
      .update({ goal: edits.goal, product_ids: productIds, status: 'active', name: `${edits.shortName} · ${edits.goal} · ${date}` })
      .eq('id', edits.campaignId)
      .select('id'),
    'activate campaign',
  );

  return {
    approved: true,
    campaignId: edits.campaignId,
    goal: edits.goal,
    shortName: edits.shortName,
    products: productIds.map((id) => ({ id, title: products.find((p) => p.id === id)!.title })),
    claimTopics: edits.claimGroups.map((g) => g.topic),
  };
}
