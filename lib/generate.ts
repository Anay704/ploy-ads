// Image generation (PLAN.md §5): prompt builder → fal → text check → post-process → Storage → DB.
// Jobs run in after(), one per variant, and each updates its own row; the grid follows over
// Realtime. A fal URL is never stored as an asset: every output is copied into Storage first.

import 'server-only';
import { fal } from '@fal-ai/client';
import { after } from 'next/server';
import sharp from 'sharp';
import { planRound, SCENES, type Angle } from './angles';
import type { CampaignGoal } from './agent-goals';
import { writeCopy } from './copy';
import { buildPrompt, EDIT_PREFIX, REVISION_MARKER } from './prompt';
import { ensureProductImage, ensureProfile, must } from './research';
import { currentSeason } from './seasons';
import { cleanType, type ShopifyImage } from './shopify';
import { BUCKET, supabaseServer, type Db } from './supabase/server';
import type { Json } from './supabase/database.types';
import { checkRenderText } from './text-check';
import { inkOn } from './theme';

// Bake-off winner (2026-10-26, see NOTES.md and bakeoff/scores.json): the only model with
// product fidelity 2 on every output. Nano Banana 2.1 drifted the product; Seedream 5.0 Lite
// passed fidelity but pasted the photo and kept putting the headline in the logo zone.
export const IMAGE_MODEL = {
  name: 'Nano Banana Pro edit',
  endpoint: 'fal-ai/nano-banana-pro/edit',
  usdPerImage: 0.15,
  input: (prompt: string, imageUrls: string[]) => ({
    prompt,
    image_urls: imageUrls,
    aspect_ratio: '9:16',
    resolution: '2K',
    output_format: 'png',
  }),
} as const;

// Pro returns 1536×2752 at 2K, slightly taller than 9:16; post-process crops then resizes to this.
export const AD_SIZE = { width: 1080, height: 1920 } as const;

export const MAX_PER_CALL = 8; // PLAN.md §7: runaway-cost caps
export const MAX_PER_CAMPAIGN = 40;
export const STUCK_AFTER_MS = 5 * 60 * 1000;

let falReady = false;
function falClient() {
  if (!falReady) {
    if (!process.env.FAL_KEY) throw new Error('FAL_KEY is not set (see .env.example).');
    fal.config({ credentials: process.env.FAL_KEY });
    falReady = true;
  }
  return fal;
}

const publicUrl = (db: Db, path: string) => db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

/**
 * "fetch failed" alone hides the reason; the cause (ECONNRESET, a timeout) is what helps. fal's
 * errors carry theirs in body.detail: a plain "Forbidden" was an exhausted fal balance.
 */
const describe = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string; message?: string }; body?: { detail?: unknown } };
  const detail = typeof err.body?.detail === 'string' ? err.body.detail : null;
  const cause = detail ?? err.cause?.code ?? err.cause?.message;
  return cause ? `${err.message} (${cause})` : err.message;
};

/** fal refuses the account itself (bad key, no balance): a second attempt can't succeed. */
const accountRefused = (e: unknown) => [401, 403].includes((e as { status?: number }).status ?? 0);

/**
 * Network I/O (Storage, the database, downloads) retries itself: a blip must not cost a paid
 * re-render or fail an ad. In M4's second Loopy round, a burst of "fetch failed" at one moment
 * failed four ads and spent their render retries on a storage problem.
 */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
}

// ── Queue a round ────────────────────────────────────────────────────────────

export type QueuedAd = { adId: string; variantId: string; product: string; angle: Angle; headline: string; cta: string };

/**
 * Plans the round, writes copy, and inserts ads and their first variants as `generating`.
 * Rendering starts separately (startJobs), so the caller can return before fal finishes.
 */
export async function queueRound(campaignId: string, opts: { productIds?: string[]; perProduct?: number } = {}): Promise<{ queued: QueuedAd[]; capped: boolean }> {
  const db = supabaseServer();
  const { drafted, capped } = await prepareRound(campaignId, opts);
  const queued: QueuedAd[] = [];
  for (const d of drafted) {
    const ad = must(
      await db.from('ads').insert({ campaign_id: campaignId, product_id: d.product.id, angle: d.copy.angle, source_asset_id: d.sourceAssetId }).select('id').single(),
      'create ad',
    );
    const variant = must(
      await db
        .from('ad_variants')
        .insert({ ad_id: ad.id, campaign_id: campaignId, version: 1, headline: d.copy.headline, cta: d.copy.cta, prompt: d.prompt, model: IMAGE_MODEL.endpoint, status: 'generating' })
        .select('id')
        .single(),
      'create variant',
    );
    queued.push({ adId: ad.id, variantId: variant.id, product: d.product.title, angle: d.copy.angle, headline: d.copy.headline, cta: d.copy.cta });
  }
  return { queued, capped };
}

/** Plans the round and writes its copy and prompts, without writing anything to the database. */
export async function prepareRound(campaignId: string, opts: { productIds?: string[]; perProduct?: number } = {}) {
  const db = supabaseServer();
  const campaign = must(await db.from('campaigns').select('id, status, goal, product_ids, brand_kit_id').eq('id', campaignId).single(), 'load campaign');
  if (campaign.status !== 'active' || !campaign.goal) throw new Error('Confirm the brief before generating.');

  const kit = must(
    await db.from('brand_kits').select('id, short_name, name, colors, voice, value_prop, claim_groups, raw').eq('id', campaign.brand_kit_id).single(),
    'load brand kit',
  );
  const productIds = opts.productIds?.length ? opts.productIds.filter((id) => campaign.product_ids.includes(id)) : campaign.product_ids;
  const products = must(
    await db.from('products').select('id, title, price, compare_at_price, tags, description, images, product_type').in('id', productIds),
    'load products',
  );
  const { count } = await db.from('ad_variants').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
  const room = Math.min(MAX_PER_CALL, MAX_PER_CAMPAIGN - (count ?? 0));
  if (room <= 0) throw new Error(`This campaign has reached its cap of ${MAX_PER_CAMPAIGN} ads.`);

  const groups = (kit.claim_groups ?? []) as { topic: string; claims: string[] }[];
  const seasonal = ((kit.raw as { seasonal?: Record<string, string> } | null)?.seasonal ?? {}) as Record<string, string>;
  const ordered = productIds.flatMap((id) => products.filter((p) => p.id === id));
  const discount = (p: (typeof products)[number]) => p.compare_at_price !== null && !p.tags.includes('last call');
  const fullPlan = planRound(
    ordered.map((p) => ({ id: p.id, hasDiscount: discount(p), seasonal: !!seasonal[p.id], bestSeller: p.tags.includes('best seller') })),
    campaign.goal as CampaignGoal,
    groups.map((g) => g.topic),
    opts.perProduct ?? 2,
  );
  const plan = fullPlan.slice(0, room);

  const rules = must(await db.from('feedback').select('text').eq('campaign_id', campaignId).eq('scope', 'campaign').eq('active', true).order('created_at'), 'load rules').map(
    (r) => r.text,
  );
  const colors = (kit.colors ?? {}) as { primary?: string; text?: string };
  const primary = colors.primary ?? '#111111';
  const voice = (kit.voice ?? { adjectives: [], sample: '' }) as { adjectives: string[]; sample: string };
  const brandName = kit.short_name ?? kit.name ?? 'the brand';
  const season = currentSeason(new Date());

  // Copy for all ads in parallel: each is one LLM call (plus at most two redrafts). Each ad
  // gets a different suggested button so the round doesn't repeat one CTA.
  const CTA_HINTS = ['Shop Now', 'Get Yours', 'Find Your Look', 'See Why', 'Shop the Look', 'Grab Yours', 'Try It', 'Discover More'];
  const write = (ad: (typeof plan)[number], i: number, avoid: string[] = []) => {
    const p = ordered.find((x) => x.id === ad.productId)!;
    return writeCopy({
      brandName,
      voice,
      valueProp: kit.value_prop ?? '',
      product: { title: p.title, price: Number(p.price), compareAtPrice: p.compare_at_price === null ? null : Number(p.compare_at_price), description: p.description ?? '' },
      angle: ad.angle,
      claims: groups.find((g) => g.topic === ad.claimTopic)?.claims ?? [],
      rules,
      ctaHint: CTA_HINTS[i % CTA_HINTS.length],
      avoid,
    });
  };
  const copies = await Promise.all(plan.map((ad, i) => write(ad, i)));

  // A copy fallback can change an ad's angle (claims didn't survive the guardrails), which can
  // collide with another ad: same angle, same setting, same headline (seen on Loopy in M4).
  // Resolve in order: a fallback ad takes the next unused setting, and a repeated headline is
  // rewritten once with the round's other headlines to avoid.
  const usedSettings = new Set<string>();
  const usedHeadlines: string[] = [];
  const scenes: number[] = [];
  for (let i = 0; i < plan.length; i++) {
    let copy = copies[i];
    if (usedHeadlines.some((h) => h.toLowerCase() === copy.headline.toLowerCase())) {
      copy = copies[i] = await write({ ...plan[i], angle: copy.angle }, i, usedHeadlines);
    }
    let scene = copy.angle === plan[i].angle ? plan[i].scene : 0;
    while (usedSettings.has(`${copy.angle}#${scene}`) && scene < SCENES[copy.angle].length - 1) scene++;
    usedSettings.add(`${copy.angle}#${scene}`);
    usedHeadlines.push(copy.headline);
    scenes.push(scene);
  }

  const drafted = await Promise.all(
    plan.map(async (ad, i) => {
      const p = ordered.find((x) => x.id === ad.productId)!;
      const images = (p.images ?? []) as ShopifyImage[];
      const source = await ensureProductImage(db, kit.id, p.id, { title: p.title, images });
      const profile = await ensureProfile(db, p.id, { title: p.title, productType: cleanType(p.product_type ?? ''), tags: p.tags }, source.path);
      const copy = copies[i];
      const prompt = buildPrompt({
        brandName,
        productTitle: p.title,
        product: profile,
        angle: copy.angle,
        scene: scenes[i],
        season,
        colors: { primary, text: colors.text ?? '#111111' },
        buttonInk: inkOn(primary, colors.text),
        voiceAdjectives: voice.adjectives,
        headline: copy.headline,
        cta: copy.cta,
        ratingStars: /star|review|rated|rating/i.test(copy.citedClaim ?? ''),
        brandRules: rules,
      });
      return { ad, product: p, sourceAssetId: source.assetId, copy, prompt };
    }),
  );

  return { drafted, capped: plan.length < fullPlan.length };
}

/** Starts the render jobs after the response is sent. They share the route's maxDuration. */
export function startJobs(variantIds: string[]) {
  after(() => Promise.allSettled(variantIds.map((id) => runVariant(id))));
}

// ── One render ───────────────────────────────────────────────────────────────

class TextCheckFailed extends Error {}

/**
 * Renders a variant: at most 2 fal calls in total, whether the first fails or its text check
 * does (PLAN.md §5), then `failed` with the reason. `resumeRequestId` finishes a fal job that
 * completed after its original runner died (the stuck sweep).
 */
export async function runVariant(variantId: string, opts: { resumeRequestId?: string } = {}): Promise<void> {
  const db = supabaseServer();
  const v = must(
    await db
      .from('ad_variants')
      .select('id, ad_id, campaign_id, parent_variant_id, headline, cta, prompt, status, ads!ad_variants_ad_id_fkey(source_asset_id, assets!ads_source_asset_id_fkey(storage_path)), campaigns(brand_kit_id)')
      .eq('id', variantId)
      .single(),
    'load variant',
  );
  if (v.status !== 'generating') return;
  const brandKitId = v.campaigns!.brand_kit_id;
  const sourcePath = v.ads?.assets?.storage_path;
  let spent = 0;
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let outputUrl: string;
      const f = falClient();
      if (attempt === 0 && opts.resumeRequestId) {
        const result = await f.queue.result(IMAGE_MODEL.endpoint, { requestId: opts.resumeRequestId });
        outputUrl = (result.data as { images: { url: string }[] }).images[0].url;
      } else {
        // Which references a version renders from (PLAN.md §5, §6): a new ad or a regenerate uses
        // the product photo; a copy edit only the previous raw render (so nothing else moves); a
        // revision the previous render first, then the product photo to keep the product exact.
        const prompt = v.prompt ?? '';
        const parentRaw = v.parent_variant_id ? `campaigns/${v.campaign_id}/${v.ad_id}/${v.parent_variant_id}.raw.png` : null;
        const paths = prompt.startsWith(EDIT_PREFIX) ? [parentRaw] : prompt.includes(REVISION_MARKER) ? [parentRaw, sourcePath] : [sourcePath];
        if (paths.some((x) => !x)) throw new Error('a reference image is missing');
        // fal can't reach a local Supabase, so the images' bytes go to fal's own storage.
        const imageUrls = await Promise.all(
          (paths as string[]).map(async (path) => {
            const bytes = await withRetry(() => download(publicUrl(db, path)));
            return withRetry(() => f.storage.upload(new Blob([new Uint8Array(bytes)], { type: path.endsWith('.png') ? 'image/png' : 'image/jpeg' })));
          }),
        );
        const { data } = await f.subscribe(IMAGE_MODEL.endpoint, {
          input: IMAGE_MODEL.input(prompt, imageUrls) as never,
          onEnqueue: (requestId) => {
            void db.from('ad_variants').update({ fal_request_id: requestId }).eq('id', variantId);
          },
        });
        spent += IMAGE_MODEL.usdPerImage;
        outputUrl = (data as { images?: { url: string }[] }).images?.[0]?.url ?? '';
        if (!outputUrl) throw new Error('fal returned no image');
      }

      // Copied before anything else: the fal URL expires, and it is never stored as the asset.
      const raw = await withRetry(() => download(outputUrl));
      const base = `campaigns/${v.campaign_id}/${v.ad_id}/${variantId}`;
      await withRetry(() => saveAsset(db, { brandKitId, kind: 'ad_raw', path: `${base}.raw.png`, sourceUrl: outputUrl, body: raw, mime: 'image/png' }));

      const check = await withRetry(() => checkRenderText(raw, v.headline, v.cta));
      await db.from('ad_variants').update({ text_check: check as unknown as Json }).eq('id', variantId);
      if (!check.pass) throw new TextCheckFailed(`text_check: ${check.reason}`);

      // From here the render is good: storage trouble retries in place, never re-renders.
      try {
        const final = await postProcess(raw, await logoFor(db, brandKitId), await primaryFor(db, brandKitId));
        const assetId = await withRetry(() => saveAsset(db, { brandKitId, kind: 'ad_render', path: `${base}.png`, sourceUrl: outputUrl, body: final, mime: 'image/png' }));
        await withRetry(async () =>
          must(
            await db.from('ad_variants').update({ status: 'draft', asset_id: assetId, error: null, cost_usd: spent }).eq('id', variantId).eq('status', 'generating').select('id'),
            'finish variant',
          ),
        );
        await withRetry(async () => must(await db.from('ads').update({ current_variant_id: variantId }).eq('id', v.ad_id).select('id'), 'set current variant'));
        return;
      } catch (e) {
        lastError = `saving failed: ${describe(e)}`;
        break;
      }
    } catch (e) {
      lastError = e instanceof TextCheckFailed ? e.message : `render failed: ${describe(e)}`;
      console.warn(`variant ${variantId} attempt ${attempt + 1}: ${lastError}`);
      if (accountRefused(e)) break;
    }
  }
  await withRetry(async () => db.from('ad_variants').update({ status: 'failed', error: lastError, cost_usd: spent }).eq('id', variantId).eq('status', 'generating'));
}

// ── Post-process ─────────────────────────────────────────────────────────────

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Finds the CTA pill: the largest run of the brand's primary color in the bottom 22% of the
 * render. The model doesn't reliably keep the button narrow (in M4's Loopy round, 4 of 6 CTAs
 * reached into the logo's corner), so the badge is placed around where the button really is.
 */
export async function findButton(img: Buffer, primary: string): Promise<Box | null> {
  const { width: W, height: H } = AD_SIZE;
  const top = Math.round(H * 0.78);
  const { data, info } = await sharp(img).extract({ left: 0, top, width: W, height: H - top }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [pr, pg, pb] = [1, 3, 5].map((i) => parseInt(primary.slice(i, i + 2), 16));
  let box: Box | null = null;
  let count = 0;
  for (let y = 0; y < info.height; y += 2) {
    for (let x = 0; x < info.width; x += 2) {
      const i = (y * info.width + x) * 3;
      if (Math.hypot(data[i] - pr, data[i + 1] - pg, data[i + 2] - pb) > 42) continue;
      count++;
      box = box
        ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y + top), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y + top) }
        : { x0: x, y0: y + top, x1: x, y1: y + top };
    }
  }
  // A real button is a solid block, not a few scattered pink pixels in the scene.
  return box && count > 1500 ? box : null;
}

/**
 * Where the badge goes, always somewhere a designer would put it (never floating mid-scene,
 * which happened live in M7 when a wide CTA left no room beside it): beside the button on the
 * left, else on the right, else centered just below it, else as a mark in the top-left corner.
 */
export function placeBadge(button: Box | null, size: { bw: number; bh: number }): { x: number; y: number; w: number } {
  const { width: W, height: H } = AD_SIZE;
  const margin = Math.round(W * 0.04);
  const gap = 20;
  const corner = { x: margin, y: H - Math.round(H * 0.04) - size.bh, w: size.bw };
  if (!button) return corner;
  const midY = Math.round((button.y0 + button.y1) / 2 - size.bh / 2);
  const left = button.x0 - gap - margin;
  const right = W - margin - (button.x1 + gap);
  if (left >= size.bw * 0.72) return { x: margin, y: midY, w: Math.min(size.bw, left) };
  if (right >= size.bw * 0.72) {
    const w = Math.min(size.bw, right);
    return { x: W - margin - w, y: midY, w };
  }
  if (H - button.y1 - gap >= size.bh + Math.round(H * 0.015)) return { x: Math.round((W - size.bw) / 2), y: button.y1 + gap, w: size.bw };
  return { x: margin, y: Math.round(H * 0.03), w: Math.round(size.bw * 0.8) };
}

/**
 * Crop to 9:16 at 1080×1920 and composite the real logo, so the logo is never AI-drawn. The
 * logo sits on a white pill beside the CTA (prompt.ts LOGO_PLACEMENT), readable on any scene.
 */
export async function postProcess(raw: Buffer, logo: Buffer | null, primary = '#111111'): Promise<Buffer> {
  const { width: W, height: H } = AD_SIZE;
  const base = await sharp(raw).resize(W, H, { fit: 'cover', position: 'centre' }).png().toBuffer();
  if (!logo) return base;

  const bh = Math.round(H * 0.055);
  const { x, y, w: bw } = placeBadge(await findButton(base, primary), { bw: Math.round(W * 0.26), bh });
  const pad = Math.round(bh * 0.22);
  const pill = Buffer.from(
    `<svg width="${bw}" height="${bh}"><rect width="${bw}" height="${bh}" rx="${bh / 2}" fill="#FFFFFF" fill-opacity="0.94"/></svg>`,
  );
  const mark = await sharp(logo)
    .resize(bw - pad * 3, bh - pad * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const meta = await sharp(mark).metadata();
  return sharp(base)
    .composite([
      { input: pill, left: x, top: y },
      { input: mark, left: x + Math.round((bw - (meta.width ?? 0)) / 2), top: y + Math.round((bh - (meta.height ?? 0)) / 2) },
    ])
    .png()
    .toBuffer();
}

async function primaryFor(db: Db, brandKitId: string): Promise<string> {
  const { data } = await db.from('brand_kits').select('colors').eq('id', brandKitId).single();
  return ((data?.colors as { primary?: string } | null)?.primary ?? '#111111').toUpperCase();
}

const logoCache = new Map<string, Buffer | null>();
async function logoFor(db: Db, brandKitId: string): Promise<Buffer | null> {
  if (logoCache.has(brandKitId)) return logoCache.get(brandKitId)!;
  const { data } = await db.from('brand_kits').select('logo:assets!brand_kits_logo_asset_id_fkey(storage_path)').eq('id', brandKitId).single();
  const logo = data?.logo ? await download(publicUrl(db, data.logo.storage_path)).catch(() => null) : null;
  logoCache.set(brandKitId, logo);
  return logo;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url.split('?')[0]} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function saveAsset(
  db: Db,
  a: { brandKitId: string; kind: 'ad_raw' | 'ad_render'; path: string; sourceUrl: string; body: Buffer; mime: string },
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

// ── Stuck sweep and retry ────────────────────────────────────────────────────

/**
 * PLAN.md §2: a variant still `generating` 5 minutes after it started is stuck. If fal finished
 * it anyway, the result is recovered; otherwise it becomes `failed (timeout)` with Retry.
 * Returns how many variants changed.
 */
export async function sweepStuck(campaignId: string): Promise<number> {
  const db = supabaseServer();
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  const stuck = must(
    await db.from('ad_variants').select('id, fal_request_id').eq('campaign_id', campaignId).eq('status', 'generating').lt('created_at', cutoff),
    'find stuck variants',
  );
  for (const v of stuck) {
    let completed = false;
    if (v.fal_request_id) {
      try {
        const status = await falClient().queue.status(IMAGE_MODEL.endpoint, { requestId: v.fal_request_id });
        completed = status.status === 'COMPLETED';
      } catch {
        // fal doesn't know the request: treat it as lost
      }
    }
    if (completed) {
      // Restart the clock and finish from fal's stored result.
      await db.from('ad_variants').update({ created_at: new Date().toISOString() }).eq('id', v.id);
      after(() => runVariant(v.id, { resumeRequestId: v.fal_request_id! }));
    } else {
      await db.from('ad_variants').update({ status: 'failed', error: 'timeout' }).eq('id', v.id).eq('status', 'generating');
    }
  }
  return stuck.length;
}

/** The Retry button: the same variant, rendered again from its stored prompt. */
export async function retryVariant(variantId: string): Promise<void> {
  const db = supabaseServer();
  must(
    await db
      .from('ad_variants')
      .update({ status: 'generating', error: null, text_check: null, fal_request_id: null, created_at: new Date().toISOString() })
      .eq('id', variantId)
      .eq('status', 'failed')
      .select('id'),
    'reset variant',
  );
  after(() => runVariant(variantId));
}
