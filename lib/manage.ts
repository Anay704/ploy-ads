// Managing ads after generation (PLAN.md §1 step 4-5, §6): status, copy edits, ad-level
// feedback, regenerate, campaign rules, and the lookups the agent and the drawer use. The grid
// buttons (server actions) and the agent's tools call the same functions.

import 'server-only';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { copyProblem } from './copy';
import { IMAGE_MODEL, startJobs } from './generate';
import { llm } from './llm';
import { EDIT_PREFIX, editPrompt, REVISION_MARKER, revisedPrompt } from './prompt';
import { must } from './research';
import { BUCKET, supabaseServer } from './supabase/server';
import type { Angle } from './angles';

type VariantRow = {
  id: string;
  version: number;
  parent_variant_id: string | null;
  status: 'generating' | 'draft' | 'approved' | 'rejected' | 'failed';
  headline: string;
  cta: string;
  prompt: string | null;
  created_at: string;
  asset_id: string | null;
};

const FINISHED = ['draft', 'approved', 'rejected'] as const;

async function loadAd(adId: string) {
  const db = supabaseServer();
  const ad = must(
    await db.from('ads').select('id, campaign_id, angle, product_id, products(title, price, compare_at_price, description), campaigns(brand_kit_id)').eq('id', adId).single(),
    'load ad',
  );
  const variants = must(
    await db.from('ad_variants').select('id, version, parent_variant_id, status, headline, cta, prompt, created_at, asset_id').eq('ad_id', adId).order('version'),
    'load versions',
  ) as VariantRow[];
  return { ad, variants };
}

/** The newest version that finished rendering: the one new versions start from. */
function latestFinished(variants: VariantRow[]): VariantRow {
  const v = [...variants].reverse().find((x) => (FINISHED as readonly string[]).includes(x.status));
  if (!v) throw new Error('This ad has no finished version yet.');
  return v;
}

/** Root-to-leaf chain of versions that led to `leaf`. */
function lineage(variants: VariantRow[], leaf: VariantRow): VariantRow[] {
  const byId = new Map(variants.map((v) => [v.id, v]));
  const chain: VariantRow[] = [];
  for (let v: VariantRow | undefined = leaf; v; v = v.parent_variant_id ? byId.get(v.parent_variant_id) : undefined) chain.unshift(v);
  return chain;
}

/** The nearest full scene prompt in the lineage (a copy edit's prompt is only an edit instruction). */
function fullPrompt(chain: VariantRow[]): { prompt: string; headline: string; cta: string } {
  const v = [...chain].reverse().find((x) => x.prompt && !x.prompt.startsWith(EDIT_PREFIX));
  if (!v?.prompt) throw new Error('No full prompt found for this ad.');
  return { prompt: v.prompt, headline: v.headline, cta: v.cta };
}

async function activeRules(campaignId: string): Promise<string[]> {
  const db = supabaseServer();
  return must(await db.from('feedback').select('text').eq('campaign_id', campaignId).eq('scope', 'campaign').eq('active', true).order('created_at'), 'load rules').map(
    (r) => r.text,
  );
}

/** PLAN.md §6: ad notes for this ad's lineage only, oldest first, so v3 still honors v2's note. */
async function lineageNotes(adId: string, chain: VariantRow[]): Promise<string[]> {
  const db = supabaseServer();
  const ids = chain.map((v) => v.id);
  return must(await db.from('feedback').select('text, variant_id').eq('ad_id', adId).eq('scope', 'ad').order('created_at'), 'load notes')
    .filter((f) => f.variant_id && ids.includes(f.variant_id))
    .map((f) => f.text);
}

async function insertVersion(
  ad: { id: string; campaign_id: string },
  parent: VariantRow,
  next: { version: number; headline: string; cta: string; prompt: string },
): Promise<string> {
  const db = supabaseServer();
  const row = must(
    await db
      .from('ad_variants')
      .insert({
        ad_id: ad.id,
        campaign_id: ad.campaign_id,
        parent_variant_id: parent.id,
        version: next.version,
        headline: next.headline,
        cta: next.cta,
        prompt: next.prompt,
        model: IMAGE_MODEL.endpoint,
        status: 'generating',
      })
      .select('id')
      .single(),
    'create version',
  );
  startJobs([row.id]);
  return row.id;
}

// ── Status ───────────────────────────────────────────────────────────────────

export async function setVariantStatus(variantId: string, status: 'approved' | 'rejected' | 'draft'): Promise<void> {
  const db = supabaseServer();
  must(
    await db.from('ad_variants').update({ status }).eq('id', variantId).in('status', [...FINISHED]).select('id'),
    'update status (only finished versions can be approved or rejected)',
  );
}

// ── Copy edits ───────────────────────────────────────────────────────────────

/**
 * Typed copy goes through the same claim guardrails as generated copy: it may cite any
 * approved claim, but a fact no claim backs is refused.
 */
async function checkTypedCopy(ad: Awaited<ReturnType<typeof loadAd>>['ad'], headline: string, cta: string): Promise<string | null> {
  const db = supabaseServer();
  const kit = must(await db.from('brand_kits').select('claim_groups').eq('id', ad.campaigns!.brand_kit_id).single(), 'load claims');
  const claims = ((kit.claim_groups ?? []) as { claims: string[] }[]).flatMap((g) => g.claims);
  const product = {
    title: ad.products!.title,
    price: Number(ad.products!.price),
    compareAtPrice: ad.products!.compare_at_price === null ? null : Number(ad.products!.compare_at_price),
    description: ad.products!.description ?? '',
  };
  const attempts = [null, ...claims].map((citedClaim) => copyProblem({ headline, cta, citedClaim }, { angle: ad.angle as Angle, claims, product }));
  return attempts.includes(null) ? null : attempts[0];
}

/**
 * PLAN.md §5: changing only the text re-renders from the previous raw render with a
 * "change nothing else" prompt, so the scene, product and hand stay as they were.
 */
export async function editCopy(adId: string, next: { headline: string; cta: string }): Promise<string> {
  const headline = next.headline.trim();
  const cta = next.cta.trim();
  if (!headline || !cta) throw new Error('Headline and button text are both needed.');
  const { ad, variants } = await loadAd(adId);
  const problem = await checkTypedCopy(ad, headline, cta);
  if (problem) throw new Error(`That copy can't run: ${problem}.`);
  const parent = latestFinished(variants);
  if (parent.headline === headline && parent.cta === cta) throw new Error('Nothing changed.');
  return insertVersion(ad, parent, {
    version: variants.at(-1)!.version + 1,
    headline,
    cta,
    prompt: editPrompt({ headline: parent.headline, cta: parent.cta }, { headline, cta }),
  });
}

// ── Feedback ─────────────────────────────────────────────────────────────────

const Imperative = z.object({ instruction: z.string().describe('a short imperative instruction for an image model') });

/** PLAN.md §6: free text becomes a short imperative ("warmer lighting" → "Use warmer, golden-hour lighting"). */
export async function toImperative(text: string): Promise<string> {
  const { output } = await generateText({
    model: llm('claude-haiku-5-5'),
    output: Output.object({ schema: Imperative, name: 'instruction' }),
    system: 'Rewrite marketer feedback on an ad image as one short imperative instruction for an image model. Keep the meaning; add nothing.',
    prompt: text,
  });
  return output.instruction.trim().replace(/\.$/, '');
}

/**
 * Ad-level feedback (PLAN.md §6): saved against the version it was given on, then a new
 * version renders from the previous one with every note in this ad's lineage, oldest first.
 */
export async function reviseAd(adId: string, feedback: string, opts: { headline?: string; cta?: string; rewrite?: boolean } = {}): Promise<{ variantId: string; note: string }> {
  const { ad, variants } = await loadAd(adId);
  const parent = latestFinished(variants);
  const note = opts.rewrite === false ? feedback.trim() : await toImperative(feedback);
  const headline = opts.headline?.trim() || parent.headline;
  const cta = opts.cta?.trim() || parent.cta;
  if (headline !== parent.headline || cta !== parent.cta) {
    const problem = await checkTypedCopy(ad, headline, cta);
    if (problem) throw new Error(`That copy can't run: ${problem}.`);
  }

  const db = supabaseServer();
  must(
    await db.from('feedback').insert({ campaign_id: ad.campaign_id, scope: 'ad', ad_id: ad.id, variant_id: parent.id, text: note }).select('id'),
    'save feedback',
  );
  const chain = lineage(variants, parent);
  const full = fullPrompt(chain);
  const prompt = revisedPrompt(full.prompt, {
    brandRules: await activeRules(ad.campaign_id),
    revisionNotes: await lineageNotes(ad.id, chain),
    fromPrevious: true,
    headline: { from: full.headline, to: headline },
    cta: { from: full.cta, to: cta },
  });
  const variantId = await insertVersion(ad, parent, { version: variants.at(-1)!.version + 1, headline, cta, prompt });
  return { variantId, note };
}

/** A fresh render of the same ad: new scene take, same copy, current rules and this ad's notes. */
export async function regenerateAd(adId: string): Promise<string> {
  const { ad, variants } = await loadAd(adId);
  const parent = latestFinished(variants);
  const chain = lineage(variants, parent);
  const full = fullPrompt(chain);
  const prompt = revisedPrompt(full.prompt, {
    brandRules: await activeRules(ad.campaign_id),
    revisionNotes: await lineageNotes(ad.id, chain),
    fromPrevious: false,
    headline: { from: full.headline, to: parent.headline },
    cta: { from: full.cta, to: parent.cta },
  });
  return insertVersion(ad, parent, { version: variants.at(-1)!.version + 1, headline: parent.headline, cta: parent.cta, prompt });
}

// ── Campaign rules ───────────────────────────────────────────────────────────

export type Rule = { id: string; text: string; active: boolean };

/** PLAN.md §6: a campaign rule applies to every later generation; existing ads are untouched. */
export async function addBrandRule(campaignId: string, text: string, opts: { rewrite?: boolean } = {}): Promise<Rule> {
  const rule = opts.rewrite === false ? text.trim() : await toImperative(text);
  const db = supabaseServer();
  return must(
    await db.from('feedback').insert({ campaign_id: campaignId, scope: 'campaign', text: rule }).select('id, text, active').single(),
    'save rule',
  );
}

export async function setRuleActive(ruleId: string, active: boolean): Promise<void> {
  const db = supabaseServer();
  must(await db.from('feedback').update({ active }).eq('id', ruleId).eq('scope', 'campaign').select('id'), 'toggle rule');
}

export async function listRules(campaignId: string): Promise<Rule[]> {
  const db = supabaseServer();
  return must(await db.from('feedback').select('id, text, active').eq('campaign_id', campaignId).eq('scope', 'campaign').order('created_at'), 'load rules');
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Grid order, numbered from 1, so the agent can resolve "the second one" or "the Night Sky one". */
export async function listAds(campaignId: string) {
  const db = supabaseServer();
  const ads = must(await db.from('ads').select('id, angle, created_at, products(title)').eq('campaign_id', campaignId).order('created_at'), 'load ads');
  const versions = must(await db.from('ad_variants').select('ad_id, version, status, headline').eq('campaign_id', campaignId), 'load versions');
  return ads.map((a, i) => {
    const latest = versions.filter((v) => v.ad_id === a.id).sort((x, y) => y.version - x.version)[0];
    return { position: i + 1, adId: a.id, product: a.products?.title ?? '', angle: a.angle, version: latest?.version ?? 0, status: latest?.status ?? 'generating', headline: latest?.headline ?? '' };
  });
}

export type VersionInfo = {
  id: string;
  version: number;
  status: VariantRow['status'];
  headline: string;
  cta: string;
  imageUrl: string | null;
  origin: string; // what produced this version, in words
  prompt: string;
  createdAt: string;
};

/** The version drawer: every version with what produced it (PLAN.md §1 step 4, §6). */
export async function adHistory(adId: string): Promise<VersionInfo[]> {
  const db = supabaseServer();
  const { variants } = await loadAd(adId);
  const notes = must(await db.from('feedback').select('text, variant_id, created_at').eq('ad_id', adId).eq('scope', 'ad').order('created_at'), 'load notes');
  const assets = must(
    await db.from('assets').select('id, storage_path').in('id', variants.map((v) => v.asset_id).filter((x): x is string => !!x)),
    'load renders',
  );
  return variants.map((v) => {
    const parent = variants.find((p) => p.id === v.parent_variant_id);
    // The note given on the parent just before this version was created produced it.
    const note = notes.filter((n) => n.variant_id === v.parent_variant_id && n.created_at <= v.created_at).at(-1);
    const origin = !parent
      ? 'Original'
      : v.prompt?.startsWith(EDIT_PREFIX)
        ? `Copy edited: "${parent.headline}" → "${v.headline}"`
        : note
          ? `Feedback: ${note.text}`
          : v.prompt?.includes(REVISION_MARKER)
            ? 'Revised'
            : 'Regenerated';
    const asset = assets.find((a) => a.id === v.asset_id);
    return {
      id: v.id,
      version: v.version,
      status: v.status,
      headline: v.headline,
      cta: v.cta,
      imageUrl: asset ? db.storage.from(BUCKET).getPublicUrl(asset.storage_path).data.publicUrl : null,
      origin,
      prompt: v.prompt ?? '',
      createdAt: v.created_at,
    };
  });
}
