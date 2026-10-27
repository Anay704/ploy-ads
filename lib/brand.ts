// Brand research (PLAN.md §3): Firecrawl `branding` for the look, the homepage HTML and
// /meta.json for the words, then one LLM call for voice, value prop, audience and claims.
// Claims are validated in code: each must be a verbatim substring of the scraped text.

import Firecrawl, { type BrandingProfile } from '@mendable/firecrawl-js';
import { generateText, Output } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';
import { llm } from './llm';
import type { ShopMeta } from './shopify';


export type BrandColors = { primary: string; secondary: string; accent: string; background: string; text: string };

export type BrandKit = {
  name: string; // exactly as the site writes it, for display
  shortName: string; // what ad prompts call the brand, e.g. Loopy for Loopy®Cases
  logoUrl: string | null;
  colors: BrandColors | null;
  fonts: string[];
  voice: { adjectives: string[]; sample: string };
  valueProp: string;
  audience: string;
  claims: string[];
  claimGroups: ClaimGroup[]; // near-duplicates grouped, so a round of ads spreads across facts
  rejectedClaims: RejectedClaim[]; // proposed by the LLM, with the reason it can't be used
  sources: { firecrawl: 'ok' | 'cached' | 'skipped' | 'failed'; logo: string; colors: string };
};

// ── Homepage parsing (also the fallback when Firecrawl fails) ────────────────

export type Homepage = {
  title: string;
  description: string;
  siteName: string;
  jsonLd: { name?: string; logo?: string; description?: string; sameAs: string[] };
  headerLogo: string | null;
  text: string;
};

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

function absolute(src: string, origin: string) {
  if (src.startsWith('//')) return `https:${src}`;
  return new URL(src, origin).toString();
}

function metaContent(html: string, key: string): string {
  // Attribute order varies between themes, so match the tag first, then read content.
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i'))?.[0];
  return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? '').trim() : '';
}

export function parseHomepage(html: string, origin: string): Homepage {
  const jsonLd: Homepage['jsonLd'] = { sameAs: [] };
  for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(block[1]);
      for (const node of Array.isArray(data) ? data : [data]) {
        if (node?.['@type'] !== 'Organization') continue;
        jsonLd.name ??= node.name;
        jsonLd.logo ??= typeof node.logo === 'string' ? node.logo : node.logo?.url;
        jsonLd.description ??= node.description;
        if (Array.isArray(node.sameAs)) jsonLd.sameAs.push(...node.sameAs);
      }
    } catch {
      // themes ship malformed JSON-LD often enough; skip that block
    }
  }

  // The first <img> whose src contains "logo" is the header logo on Shopify themes.
  // Never the favicon, and never og:image (Loopy's is a dark Shopify placeholder logo).
  const logoImg = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]).find((src) => /logo/i.test(src.split('?')[0]));

  const body = html.replace(/<head[\s\S]*?<\/head>/i, ' ');
  const text = decode(
    body
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
    description: metaContent(html, 'description') || metaContent(html, 'og:description'),
    siteName: metaContent(html, 'og:site_name'),
    jsonLd,
    headerLogo: logoImg ? absolute(decode(logoImg), origin) : null,
    text,
  };
}

async function fetchHomepage(origin: string): Promise<string> {
  const res = await fetch(origin, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PloyAdsResearch/0.1)' } });
  if (!res.ok) throw new Error(`homepage ${res.status}`);
  return res.text();
}

export type FirecrawlResult = {
  status: 'ok' | 'skipped' | 'failed';
  branding?: BrandingProfile;
  markdown?: string;
  error?: string;
  fetchedAt: string;
};

// A scrape costs credits and a brand doesn't change hour to hour, so a successful one is
// reused for a week. Failures are never cached: the next run tries again.
export const FIRECRAWL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isFreshFirecrawl(cached: unknown, now = Date.now()): cached is FirecrawlResult {
  const c = cached as Partial<FirecrawlResult> | null | undefined;
  return !!c && c.status === 'ok' && !!c.markdown && !!c.fetchedAt && now - Date.parse(c.fetchedAt) < FIRECRAWL_TTL_MS;
}

async function scrapeFirecrawl(origin: string): Promise<FirecrawlResult> {
  const fetchedAt = new Date().toISOString();
  if (!process.env.FIRECRAWL_API_KEY) return { status: 'skipped', error: 'FIRECRAWL_API_KEY not set', fetchedAt };
  try {
    const fc = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY, timeoutMs: 90_000 });
    const doc = await fc.scrape(origin, { formats: ['branding', 'markdown'], onlyMainContent: false });
    return { status: 'ok', branding: doc.branding, markdown: doc.markdown, fetchedAt };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message, fetchedAt };
  }
}

// ── Names ────────────────────────────────────────────────────────────────────

const GENERIC_SUFFIX = /\s+(cases?|co\.?|company|shop|store|official|inc\.?|llc|ltd\.?|brand)$/i;

/**
 * A short brand name for ad prompts, derived from the store name. A mark between two words
 * ("Loopy®Cases") ends the brand word; after that, separators split off taglines and a
 * generic trailing word ("Cases", "Shop", "Co") is dropped while something is left.
 */
export function shortBrandName(name: string): string {
  let n = name.trim();
  const mark = n.match(/^(.+?)[®™©℠]\S/); // a mark followed directly by more text
  if (mark) n = mark[1];
  n = n.replace(/[®™©℠]/g, '').split(/\s+[|–—-]\s+|\s*:\s+/)[0].trim();
  while (GENERIC_SUFFIX.test(n) && n.replace(GENERIC_SUFFIX, '').trim()) n = n.replace(GENERIC_SUFFIX, '').trim();
  return n || name.trim();
}

// ── Claim validation ─────────────────────────────────────────────────────────

export type ClaimGroup = { topic: string; claims: string[] };

/**
 * Groups kept claims by the topic the LLM labelled them with ("warranty", "returns"), so
 * copy generation uses one claim per group and two ads in a round don't lean on the same
 * fact (PLAN.md §5). Groups keep the order of their first claim.
 */
export function groupClaims(labelled: { text: string; topic: string }[], kept: string[]): ClaimGroup[] {
  const keptKeys = new Map(kept.map((k) => [normalizeForMatch(k), k]));
  const groups = new Map<string, string[]>();
  for (const { text, topic } of labelled) {
    const claim = keptKeys.get(normalizeForMatch(cleanClaim(text)));
    if (!claim) continue;
    const key = topic.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
    if (!groups.get(key)?.includes(claim)) groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  return [...groups].map(([topic, claims]) => ({ topic, claims }));
}

export type RejectedClaim = { claim: string; reason: 'not_verbatim' | 'promotion' | 'too_short' };

/**
 * Firecrawl returns markdown. Its syntax is formatting, not words, so it is removed before
 * the LLM reads the text and before claims are matched against it: "Get 1 **FREE**" is
 * "Get 1 FREE" on the page.
 */
export function markdownToText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/(\*\*|__|\*|`)/g, '') // emphasis and code marks
    .replace(/(^|\W)_|_(?=\W|$)/g, '$1') // _emphasis_ underscores, but not snake_case words
    .replace(/^\s*[-+>]\s+/gm, '') // list bullets and quotes
    .replace(/[ \t]+/g, ' ');
}

// Promotions are true on the site today but time-limited, and offer copy may only use a
// real compare_at_price (PLAN.md §5). A banner like "Buy 2, Get 1 Free" must not become a claim.
const PROMOTION = [/\$\s?\d/, /\d\s?%\s*off\b/i, /\bbuy \d/i, /\bget \d\b/i, /\bshipping\b/i, /\bcode\b/i, /\bsale\b/i, /\b(off|discount)\b/i];

// A leading article doesn't change the claim and reads badly in copy: "a lifetime warranty".
const LEADING_ARTICLE = /^(a|an|the)\s+/i;

/** Markdown, trailing punctuation and a leading article are not part of the claim. */
function cleanClaim(raw: string): string {
  return markdownToText(raw).trim().replace(/[.!]+$/, '').replace(LEADING_ARTICLE, '');
}

/**
 * Case, whitespace, quote style, hyphens between words and ®/™/© are presentation, not
 * content, so they don't block a match ("Five-Star Reviews" is "five star reviews").
 */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[®™©℠]/g, '') // before NFKC, which would turn ™ into the letters "TM"
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\w)[-–—](\w)/g, '$1 $2') // word-joining hyphens; "risk-free" matches "risk free"
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Keeps only claims that appear verbatim in the scraped text. Everything else is rejected,
 * however plausible: ad copy may only state what the site itself says (CLAUDE.md invariant).
 */
export function validateClaims(claims: string[], sourceText: string): { kept: string[]; rejected: RejectedClaim[] } {
  const haystack = normalizeForMatch(markdownToText(sourceText));
  const kept: string[] = [];
  const rejected: RejectedClaim[] = [];
  const seen = new Set<string>();
  for (const raw of claims) {
    // Trailing punctuation and a leading article the model kept are not a change of meaning.
    const claim = cleanClaim(raw);
    const key = normalizeForMatch(claim);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key.length < 4) rejected.push({ claim, reason: 'too_short' });
    else if (!haystack.includes(key)) rejected.push({ claim, reason: 'not_verbatim' });
    else if (PROMOTION.some((re) => re.test(claim))) rejected.push({ claim, reason: 'promotion' });
    else kept.push(claim);
  }
  return { kept, rejected };
}

// ── Colors ───────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
const toHex = (c: number[]) => `#${c.map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** True for whites, blacks and greys: they can't carry a brand accent. */
function isNeutral(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

function farApart(a: string, b: string): boolean {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) > 60;
}

/**
 * Primary, secondary and accent from the site's colors, each visibly different. Firecrawl
 * often reports the same color twice (Loopy: accent and button are both mint), so duplicates
 * and neutrals are skipped, and a missing accent is derived by deepening the primary.
 */
export function distinctPalette(candidates: (string | undefined)[], primary: string): { secondary: string; accent: string } {
  const pool: string[] = [];
  for (const c of candidates) {
    if (!c || !HEX.test(c) || isNeutral(c)) continue;
    const hex = c.toUpperCase();
    if (farApart(hex, primary) && pool.every((p) => farApart(p, hex))) pool.push(hex);
  }
  const deeper = toHex(rgb(primary).map((n) => n * 0.72));
  const secondary = pool[0] ?? deeper;
  const accent = pool[1] ?? (farApart(deeper, secondary) ? deeper : toHex(rgb(primary).map((n) => n * 0.5)));
  return { secondary, accent };
}

function colorsFromBranding(b?: BrandingProfile): BrandColors | null {
  const c = b?.colors;
  if (!c?.primary || !HEX.test(c.primary)) return null;
  const pick = (v: string | undefined, fallback: string) => (v && HEX.test(v) ? v.toUpperCase() : fallback);
  const primary = c.primary.toUpperCase();
  const { secondary, accent } = distinctPalette(
    [c.secondary, c.accent, b?.components?.buttonPrimary?.background, b?.components?.buttonSecondary?.background, c.link],
    primary,
  );
  return { primary, secondary, accent, background: pick(c.background, '#FFFFFF'), text: pick(c.textPrimary, '#111111') };
}

/** Fallback palette: the logo's dominant color as primary, on white. */
async function colorsFromLogo(logoUrl: string): Promise<BrandColors | null> {
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    const { dominant } = await sharp(Buffer.from(await res.arrayBuffer())).flatten({ background: '#ffffff' }).stats();
    const hex = `#${[dominant.r, dominant.g, dominant.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    return { primary: hex, secondary: '#FFFFFF', accent: hex, background: '#FFFFFF', text: '#111111' };
  } catch {
    return null;
  }
}

// ── LLM step ─────────────────────────────────────────────────────────────────

const BrandInference = z.object({
  adjectives: z.array(z.string()).length(3).describe('three adjectives for the brand voice'),
  sample: z.string().describe('one short line written in the brand voice, no claims or numbers'),
  valueProp: z.string().describe('one sentence: what the product does for the customer'),
  audience: z.string().describe('one sentence: who buys this'),
  claims: z
    .array(
      z.object({
        text: z.string(),
        topic: z
          .string()
          .describe(
            'one or two lowercase words naming the kind of fact. Claims that make the same kind of promise share a topic: ' +
              '"warranty" for a lifetime warranty and a lifetime guarantee, "returns" for risk-free returns and a 30 day trial.',
          ),
      }),
    )
    .max(10)
    .describe(
      'lasting factual selling claims COPIED VERBATIM from the source text: what the product does for the customer ' +
        '(the core benefit, e.g. how it prevents a problem), track record, reviews and ratings, guarantees, warranties, awards. ' +
        'Each claim states ONE fact as a short phrase of 2 to 12 words, cut from the source as a contiguous run of characters ' +
        '(e.g. "70,000+ five star reviews", not the whole sentence around it). Do not paraphrase, reorder, or join phrases. ' +
        'If the site makes the same kind of promise in different words, give those claims the same topic. ' +
        'Exclude promotions and offers (prices, discounts, "buy X get Y", free shipping thresholds, codes): they are time-limited.',
    ),
});

async function inferBrand(input: { name: string; sources: string; personality?: BrandingProfile['personality'] }) {
  const { output } = await generateText({
    model: llm(),
    output: Output.object({ schema: BrandInference, name: 'brand_kit' }),
    system:
      'You extract a brand kit for an ad generator from a store website. Be concrete and short. ' +
      'Claims are checked by exact substring match against the source text, so any claim you paraphrase will be thrown away.',
    prompt: [
      `Store: ${input.name}`,
      input.personality ? `Visual personality from the site design (a hint, not a claim): ${JSON.stringify(input.personality)}` : '',
      `Source text from the site:\n${input.sources}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  return output;
}

// ── Orchestration ────────────────────────────────────────────────────────────

const MAX_SOURCE_CHARS = 12_000;

export type ResearchBrandOptions = {
  /** A previous successful scrape for this domain (brand_kits.raw.firecrawl), used instead of scraping again. */
  cachedFirecrawl?: unknown;
  /** Called as soon as a fresh scrape returns, so the caller can save it before anything later can fail. */
  onFirecrawl?: (result: FirecrawlResult) => Promise<void>;
};

export async function researchBrand(origin: string, meta: ShopMeta, opts: ResearchBrandOptions = {}): Promise<BrandKit & { raw: { firecrawl: FirecrawlResult } & Record<string, unknown> }> {
  const cached = isFreshFirecrawl(opts.cachedFirecrawl) ? opts.cachedFirecrawl : null;
  const scrape = cached
    ? Promise.resolve(cached)
    : scrapeFirecrawl(origin).then(async (r) => {
        if (r.status === 'ok') await opts.onFirecrawl?.(r);
        return r;
      });
  const [html, fc] = await Promise.all([fetchHomepage(origin), scrape]);
  const home = parseHomepage(html, origin);

  // Text the claims are checked against: everything the site states about itself.
  const sourceText = [home.title, home.description, meta.description, home.jsonLd.description, fc.markdown ? markdownToText(fc.markdown) : home.text]
    .filter(Boolean)
    .join('\n');

  // Kept exactly as the site writes it, symbols included: rewriting ™ as ® would misstate a trademark.
  const name = (home.jsonLd.name || fc.branding?.brandName || meta.name || home.siteName).trim();

  const fcLogo = fc.branding?.images?.logo || fc.branding?.logo || null;
  const logoUrl = fcLogo ?? home.jsonLd.logo ?? home.headerLogo;
  const logoSource = fcLogo ? 'firecrawl' : home.jsonLd.logo ? 'json-ld' : home.headerLogo ? 'header img' : 'none';

  let colors = colorsFromBranding(fc.branding);
  let colorSource = colors ? 'firecrawl' : 'none';
  if (!colors && logoUrl) {
    colors = await colorsFromLogo(logoUrl);
    if (colors) colorSource = 'logo dominant color';
  }

  const fonts = [
    ...new Set(
      [fc.branding?.typography?.fontFamilies?.heading, fc.branding?.typography?.fontFamilies?.primary, ...(fc.branding?.fonts?.map((f) => f.family) ?? [])].filter(
        (f): f is string => !!f,
      ),
    ),
  ].slice(0, 3);

  // The LLM sees the head of the source text, not the whole page. Meta and title come first,
  // which is where Shopify stores put their strongest claims.
  const inferred = await inferBrand({ name, sources: sourceText.slice(0, MAX_SOURCE_CHARS), personality: fc.branding?.personality });
  const { kept, rejected } = validateClaims(
    inferred.claims.map((c) => c.text),
    sourceText,
  );

  return {
    name,
    shortName: shortBrandName(name),
    logoUrl,
    colors,
    fonts,
    voice: { adjectives: inferred.adjectives.map((a) => a.toLowerCase()), sample: inferred.sample },
    valueProp: inferred.valueProp,
    audience: inferred.audience,
    claims: kept,
    claimGroups: groupClaims(inferred.claims, kept),
    rejectedClaims: rejected,
    sources: { firecrawl: cached ? 'cached' : fc.status, logo: logoSource, colors: colorSource },
    raw: { firecrawl: fc, homepage: { ...home, text: undefined }, meta },
  };
}
