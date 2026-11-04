'use server';

// Server actions for the start screen and the review card (PLAN.md §2). Grid actions arrive in M4.

import { redirect } from 'next/navigation';
import { BriefApproval } from '@/lib/agent';
import { BriefEdits, hasRealDiscount, type BriefData, type BriefProduct } from '@/lib/brief';
import { retryVariant, sweepStuck } from '@/lib/generate';
import {
  addBrandRule,
  adHistory,
  editCopy,
  listRules,
  regenerateAd,
  reviseAd,
  setRuleActive,
  setVariantStatus,
  type Rule,
  type VersionInfo,
} from '@/lib/manage';
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

function toBriefProduct(row: ProductRow, storedImage: string | null, seasonal: Record<string, string> = {}): BriefProduct {
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
    seasonal: seasonal[row.id] ?? null,
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
      .select('id, name, short_name, domain, colors, voice, value_prop, audience, claims, claim_groups, raw, logo:assets!brand_kits_logo_asset_id_fkey(storage_path)')
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
    catalogNote: catalogNoteOf(kit.raw),
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
      return row ? [toBriefProduct(row, stored.get(row.id) ?? null, seasonalOf(kit.raw))] : [];
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

/** Saved by research in brand_kits.raw.catalog: what the picks were drawn from, and whether the catalog was cut off. */
function catalogNoteOf(raw: unknown): string | null {
  const c = (raw as { catalog?: { count: number; truncated: boolean; core: string | null } } | null)?.catalog;
  if (!c) return null;
  const parts = [c.core ? `Picked from ${c.core}` : null, c.truncated ? `from the first ${c.count.toLocaleString('en-US')} products: the catalog is larger` : null];
  return parts.filter(Boolean).join(', ') || null;
}

function seasonalOf(raw: unknown): Record<string, string> {
  return ((raw as { seasonal?: Record<string, string> } | null)?.seasonal ?? {}) as Record<string, string>;
}

async function seasonalFor(brandKitId: string) {
  const { data } = await supabaseServer().from('brand_kits').select('raw').eq('id', brandKitId).single();
  return seasonalOf(data?.raw);
}

/** Specific products for the card, e.g. a holiday product the marketer chose to "Use anyway". */
export async function getBriefProducts(brandKitId: string, ids: string[]): Promise<BriefProduct[]> {
  const db = supabaseServer();
  const rows = must(
    await db.from('products').select('id, title, price, compare_at_price, tags, rank_reason, images').eq('brand_kit_id', brandKitId).in('id', ids),
    'load products',
  );
  const seasonal = await seasonalFor(brandKitId);
  return ids.flatMap((id) => {
    const r = rows.find((x) => x.id === id);
    return r ? [toBriefProduct(r, null, seasonal)] : [];
  });
}

/** The Swap picker: available products by rank, clearance last, optionally filtered by title. */
export async function listSwapCandidates(brandKitId: string, query = ''): Promise<BriefProduct[]> {
  const db = supabaseServer();
  const seasonal = await seasonalFor(brandKitId);
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
  return rows.map((r) => toBriefProduct(r, null, seasonal)).sort((a, b) => Number(a.clearance) - Number(b.clearance));
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

// ── The grid ─────────────────────────────────────────────────────────────────

export type AdTile = {
  variantId: string;
  adId: string;
  product: string;
  angle: string;
  version: number;
  status: 'generating' | 'draft' | 'approved' | 'rejected' | 'failed';
  headline: string;
  cta: string;
  imageUrl: string | null; // the final 1080×1920 render
  photoUrl: string | null; // the product photo, shown while it renders
  error: string | null;
  startedAt: string;
  versions: number;
  previousImageUrl: string | null; // the last finished render, shown under a version that is rendering
};

/** The newest variant of every ad in the campaign, in creation order. The grid's source of truth. */
export async function listTiles(campaignId: string): Promise<AdTile[]> {
  const db = supabaseServer();
  const rows = must(
    await db
      .from('ad_variants')
      .select(
        'id, ad_id, version, status, headline, cta, error, created_at, render:assets!ad_variants_asset_id_fkey(storage_path), ads!ad_variants_ad_id_fkey(angle, created_at, products(title), photo:assets!ads_source_asset_id_fkey(storage_path))',
      )
      .eq('campaign_id', campaignId)
      .order('version', { ascending: false }),
    'load ads',
  );
  const url = (path?: string | null) => (path ? db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null);
  const latest = new Map<string, (typeof rows)[number]>();
  const previous = new Map<string, string | null>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.ad_id, (counts.get(r.ad_id) ?? 0) + 1);
    if (!latest.has(r.ad_id)) latest.set(r.ad_id, r);
    else if (!previous.has(r.ad_id) && r.render?.storage_path) previous.set(r.ad_id, url(r.render.storage_path));
  }
  return [...latest.values()]
    .sort((a, b) => (a.ads?.created_at ?? '').localeCompare(b.ads?.created_at ?? ''))
    .map((r) => ({
      variantId: r.id,
      adId: r.ad_id,
      product: r.ads?.products?.title ?? 'Product',
      angle: r.ads?.angle ?? '',
      version: r.version,
      status: r.status,
      headline: r.headline,
      cta: r.cta,
      imageUrl: url(r.render?.storage_path),
      photoUrl: url(r.ads?.photo?.storage_path),
      error: r.error,
      startedAt: r.created_at,
      versions: counts.get(r.ad_id) ?? 1,
      previousImageUrl: previous.get(r.ad_id) ?? null,
    }));
}

/** The grid's client timer calls this when a tile has been generating for 5 minutes. */
export async function sweepCampaign(campaignId: string): Promise<number> {
  return sweepStuck(campaignId);
}

export async function retryAd(variantId: string): Promise<void> {
  await retryVariant(variantId);
}

// ── Managing ads (M5/M6): the grid calls the same functions as the agent's tools ──

export async function approveAd(variantId: string) {
  await setVariantStatus(variantId, 'approved');
}
export async function rejectAd(variantId: string) {
  await setVariantStatus(variantId, 'rejected');
}
export async function unsetAdStatus(variantId: string) {
  await setVariantStatus(variantId, 'draft');
}
export async function editAdCopy(adId: string, headline: string, cta: string): Promise<{ error?: string }> {
  try {
    await editCopy(adId, { headline, cta });
    return {};
  } catch (e) {
    return { error: (e as Error).message };
  }
}
export async function giveAdFeedback(adId: string, feedback: string): Promise<{ error?: string; note?: string }> {
  try {
    const { note } = await reviseAd(adId, feedback);
    return { note };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
export async function regenerateOneAd(adId: string) {
  await regenerateAd(adId);
}
export async function getAdHistory(adId: string): Promise<VersionInfo[]> {
  return adHistory(adId);
}
export async function getRules(campaignId: string): Promise<Rule[]> {
  return listRules(campaignId);
}
export async function createRule(campaignId: string, text: string): Promise<{ error?: string; rule?: Rule }> {
  if (!text.trim()) return { error: 'Write the rule first.' };
  try {
    return { rule: await addBrandRule(campaignId, text) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
export async function toggleRule(ruleId: string, active: boolean) {
  await setRuleActive(ruleId, active);
}
