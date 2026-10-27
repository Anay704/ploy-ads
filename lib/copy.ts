// The headline and CTA writer (PLAN.md §5). The LLM drafts; code decides whether the draft
// may run. Every fact in the copy must trace to a verified claim or the real price.

import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Angle } from './angles';
import { llm } from './llm';

export type CopyInput = {
  brandName: string;
  voice: { adjectives: string[]; sample: string };
  valueProp: string;
  product: { title: string; price: number; compareAtPrice: number | null; description: string };
  angle: Angle;
  claims: string[]; // the claim group this ad leans on (may be empty)
  rules?: string[]; // campaign brand rules
  ctaHint?: string; // a different suggested button per ad, so a round doesn't repeat one CTA
  avoid?: string[]; // headlines other ads in the round already use
};

export type Copy = { headline: string; cta: string; citedClaim: string | null };

// Words that assert a fact (PLAN.md §5). If one appears, the cited claim must contain it.
export const TRIGGER_WORDS = ['warranty', 'guarantee', 'lifetime', 'free', 'returns', 'reviews', 'rated', '#1', 'best', 'proven', 'prevents', 'never', 'original', 'trusted', 'since'];

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const norm = (s: string) => s.toLowerCase().replace(/[®™©]/g, '');

/** Why a draft can't run, or null if it can. Pure, so it is tested directly. */
export function copyProblem(copy: Copy, input: Pick<CopyInput, 'angle' | 'claims' | 'product'>): string | null {
  const { headline, cta, citedClaim } = copy;
  if (words(headline).length > 6) return `headline "${headline}" has ${words(headline).length} words; cut it to 6 or fewer`;
  if (words(cta).length > 3) return `CTA has ${words(cta).length} words (max 3)`;
  if (citedClaim && !input.claims.includes(citedClaim)) return `cited claim "${citedClaim}" is not one of the approved claims`;

  const text = `${headline} ${cta}`;
  const claim = norm(citedClaim ?? '');
  const prices = [input.product.price, input.product.compareAtPrice].filter((n): n is number => n !== null);
  const priceStrings = prices.flatMap((n) => [n.toFixed(2), String(Math.round(n)), String(n)]);

  // Numbers: in a cited claim verbatim, or (offer only) one of the real prices.
  // A trailing comma or period is punctuation, not part of the number ("since 2012, …").
  for (const n of (text.match(/\d[\d,.]*\+?%?/g) ?? []).map((x) => x.replace(/[,.]+$/, ''))) {
    const bare = n.replace(/[^\d.]/g, '');
    const fromClaim = claim.includes(n.toLowerCase());
    const fromPrice = input.angle === 'offer' && priceStrings.some((p) => p === bare || p === bare.replace(/\.$/, ''));
    if (!fromClaim && !fromPrice) return `number "${n}" is not in the cited claim${input.angle === 'offer' ? ' or the real price' : ''}`;
  }
  if (/%\s*off|\bsale\b|\bdeal\b|\bdiscount/i.test(text) && (input.angle !== 'offer' || input.product.compareAtPrice === null)) return 'mentions a discount without a real compare_at_price';

  const lower = norm(text);
  for (const w of TRIGGER_WORDS) {
    const re = new RegExp(`(^|[^a-z])${w.replace('#', '\\#')}([^a-z]|$)`, 'i');
    if (!re.test(text)) continue;
    if (!claim.includes(w)) return `"${w}" needs a cited claim that says it`;
    // The word must be used the way the claim uses it: a claim of "risk-free returns" allows
    // "risk-free", not "free" on its own ("Try it free" would promise something else).
    const compound = claim.match(new RegExp(`[a-z0-9]+-${w}|${w}-[a-z0-9]+`))?.[0];
    if (compound && !lower.includes(compound)) return `"${w}" must appear as "${compound}", the way the claim says it`;
  }
  return null;
}

const Drafts = z.object({
  candidates: z
    .array(
      z.object({
        headline: z.string().describe('6 words or fewer (count them)'),
        citedClaim: z.string().nullable().describe('the exact claim this headline relies on, copied from the list, or null if it states no fact'),
      }),
    )
    .length(3)
    .describe('three clearly different headlines'),
  cta: z.string().describe('3 words or fewer, e.g. "Shop Now", "Get Yours"'),
});

const ANGLE_BRIEF: Record<Angle, string> = {
  benefit: 'what the product does for the customer (grip, security, comfort)',
  social_proof: 'that people love it, using the review or trust claim',
  offer: 'the real discount, quoting the price exactly',
  aesthetic: 'the look of this specific design and the season; no facts needed',
  guarantee: 'the risk-free promise, using the warranty or returns claim',
};

// What separates copy a marketer would run from copy they would rewrite (M4 review: "Checkered
// cocoa for every season's story" says nothing; "loop-ably" is not a word; "keep phone close"
// drops a word).
export const COPY_RUBRIC = [
  'Specific: about this design (its pattern, colors, mood) or the cited claim, so it could not be pasted onto any other product. Naming the product is not required; forcing the name in usually reads badly.',
  'Benefit-led: the shopper sees what is in it for them.',
  'Natural grammar: read it aloud. It sounds like something a person would say, with no dropped words and no odd phrasing.',
  'No invented words, forced puns or portmanteaus.',
  'Short: under 6 words when possible.',
];

async function draftCandidates(input: CopyInput, problem?: string) {
  const p = input.product;
  const { output } = await generateText({
    model: llm(),
    output: Output.object({ schema: Drafts, name: 'ad_copy' }),
    system:
      'You write the two strings on a 9:16 mobile ad: a headline and a button, in the brand voice. ' +
      'Never state a fact, number, guarantee or discount that is not in the claims or prices you are given.\n' +
      `A good headline is:\n${COPY_RUBRIC.map((r) => `- ${r}`).join('\n')}`,
    prompt: [
      `Brand: ${input.brandName}. Voice: ${input.voice.adjectives.join(', ')}. Example line: "${input.voice.sample}".`,
      `Value proposition: ${input.valueProp}`,
      `Product: ${p.title}. Price: $${p.price.toFixed(2)}${p.compareAtPrice ? `, was $${p.compareAtPrice.toFixed(2)}` : ''}. ${p.description.slice(0, 300)}`,
      `Angle: ${input.angle}, which means the headline leads with ${ANGLE_BRIEF[input.angle]}.`,
      input.claims.length ? `Claims you may use (cite the one you use, exactly):\n${input.claims.map((c) => `- ${c}`).join('\n')}` : 'There are no claims for this ad: state no facts.',
      input.rules?.length ? `Brand rules:\n${input.rules.map((r) => `- ${r}`).join('\n')}` : '',
      input.ctaHint ? `For the button, prefer "${input.ctaHint}" or something close to it; other ads in this round use other buttons.` : '',
      input.avoid?.length ? `Other ads in this round already say: ${input.avoid.map((h) => `"${h}"`).join(', ')}. Write something clearly different.` : '',
      problem ? `Your last drafts were all rejected, for example: ${problem}. Fix that.` : '',
      'Write three clearly different headline candidates and one button.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  const clean = (t: string) => t.trim().replace(/^"|"$/g, '');
  return output.candidates.map((c) => ({ headline: clean(c.headline), cta: clean(output.cta), citedClaim: c.citedClaim }));
}

const Pick = z.object({
  scores: z.array(z.number().int().min(1).max(5)).describe('one score per candidate, 5 = a marketer would run it as written'),
  best: z.number().int().min(0),
  critique: z.string().describe('one sentence: what would make the best one better'),
});

// Below this, the best candidate goes back for another round with the judge's critique.
export const MIN_SCORE = 4;

/** A second, cheap call scores the candidates that passed the guardrails and picks the best. */
async function pickBest(input: CopyInput, candidates: Copy[]): Promise<{ copy: Copy; score: number; critique: string }> {
  const { output } = await generateText({
    model: llm(JUDGE_MODEL),
    output: Output.object({ schema: Pick, name: 'pick' }),
    system: `You are a senior ad copy editor. Score each headline 1-5 for whether a marketer would run it as written.\nRubric, in order of importance:\n${COPY_RUBRIC.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
    prompt: `Product: ${input.product.title}. Angle: ${input.angle}.\nCandidates:\n${candidates.map((c, i) => `${i}. "${c.headline}"`).join('\n')}\n\nScore each, return the index of the best, and say what would make it better.`,
  });
  const i = Math.min(output.best, candidates.length - 1);
  return { copy: candidates[i], score: output.scores[i] ?? 0, critique: output.critique };
}

export const JUDGE_MODEL = 'claude-haiku-5-5';

/**
 * One round: 3 candidates, guardrails on each, then the judge scores the survivors. Returns the
 * best legal candidate (if any) with its score, or why nothing passed.
 */
async function draftBest(
  input: CopyInput,
  repeats: (c: Copy) => string | null,
  problem?: string,
): Promise<{ copy: Copy | null; score: number; problem: string | null }> {
  const candidates = await draftCandidates(input, problem);
  const checked = candidates.map((c) => ({ c, issue: copyProblem(c, input) ?? repeats(c) }));
  const passing = checked.filter((x) => !x.issue).map((x) => x.c);
  if (!passing.length) return { copy: null, score: 0, problem: checked[0].issue };
  const { copy, score, critique } = await pickBest(input, passing);
  return { copy, score, problem: `the best was "${copy.headline}" (${score}/5): ${critique}` };
}

/**
 * Drafts 3 candidates, keeps those that pass the claim guardrails, and lets the judge pick.
 * Up to 3 rounds in the planned angle, then the aesthetic angle with no claims. The returned
 * angle is the one the ad actually runs as.
 */
export async function writeCopy(input: CopyInput): Promise<Copy & { angle: Angle }> {
  const repeats = (c: Copy) => (input.avoid?.some((h) => h.toLowerCase() === c.headline.toLowerCase()) ? `headline repeats another ad: "${c.headline}"` : null);
  let problem: string | undefined;
  let best: { copy: Copy; score: number } | null = null;
  for (let i = 0; i < 3; i++) {
    const r = await draftBest(input, repeats, problem);
    if (r.copy && (!best || r.score > best.score)) best = { copy: r.copy, score: r.score };
    // Good enough to run as written: stop. Otherwise redraft with the judge's critique.
    if (best && best.score >= MIN_SCORE) break;
    problem = r.problem ?? undefined;
    console.warn(`copy redraft (${input.product.title}, ${input.angle}): ${problem}`);
  }
  if (best) return { ...best.copy, angle: input.angle };
  console.warn(`copy falls back to aesthetic (${input.product.title}, ${input.angle}): ${problem}`);

  const plain = { ...input, angle: 'aesthetic' as const, claims: [] };
  const r = await draftBest(plain, repeats);
  if (r.copy) return { ...r.copy, angle: 'aesthetic' };

  // Last resort: copy that can't be wrong.
  return { headline: words(input.product.title).slice(0, 6).join(' '), cta: 'Shop Now', citedClaim: null, angle: 'aesthetic' };
}
