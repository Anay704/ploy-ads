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

const Draft = z.object({
  headline: z.string().describe('6 words or fewer (count them), in the brand voice'),
  cta: z.string().describe('3 words or fewer, e.g. "Shop Now", "Get Yours"'),
  citedClaim: z.string().nullable().describe('the exact claim the headline relies on, copied from the list, or null if it states no fact'),
});

const ANGLE_BRIEF: Record<Angle, string> = {
  benefit: 'what the product does for the customer (grip, security, comfort)',
  social_proof: 'that people love it, using the review or trust claim',
  offer: 'the real discount, quoting the price exactly',
  aesthetic: 'the look and the season; no facts needed',
  guarantee: 'the risk-free promise, using the warranty or returns claim',
};

async function draft(input: CopyInput, problem?: string): Promise<Copy> {
  const p = input.product;
  const { output } = await generateText({
    model: llm(),
    output: Output.object({ schema: Draft, name: 'ad_copy' }),
    system:
      'You write the two strings on a 9:16 mobile ad: a headline and a button. Short, specific, in the brand voice. ' +
      'Never state a fact, number, guarantee or discount that is not in the claims or prices you are given.',
    prompt: [
      `Brand: ${input.brandName}. Voice: ${input.voice.adjectives.join(', ')}. Example line: "${input.voice.sample}".`,
      `Value proposition: ${input.valueProp}`,
      `Product: ${p.title}. Price: $${p.price.toFixed(2)}${p.compareAtPrice ? `, was $${p.compareAtPrice.toFixed(2)}` : ''}. ${p.description.slice(0, 300)}`,
      `Angle: ${input.angle}, which means the headline leads with ${ANGLE_BRIEF[input.angle]}.`,
      input.claims.length ? `Claims you may use (cite the one you use, exactly):\n${input.claims.map((c) => `- ${c}`).join('\n')}` : 'There are no claims for this ad: state no facts.',
      input.rules?.length ? `Brand rules:\n${input.rules.map((r) => `- ${r}`).join('\n')}` : '',
      input.ctaHint ? `For the button, prefer "${input.ctaHint}" or something close to it; other ads in this round use other buttons.` : '',
      input.avoid?.length ? `Other ads in this round already say: ${input.avoid.map((h) => `"${h}"`).join(', ')}. Write something clearly different.` : '',
      problem ? `Your last draft was rejected: ${problem}. Fix that.` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  return { headline: output.headline.trim().replace(/^"|"$/g, ''), cta: output.cta.trim().replace(/^"|"$/g, ''), citedClaim: output.citedClaim };
}

/**
 * Drafts copy, checks it, redrafts once with the reason, then falls back to the aesthetic angle
 * with no claims. The returned angle is the one the ad actually runs as.
 */
export async function writeCopy(input: CopyInput): Promise<Copy & { angle: Angle }> {
  const repeats = (c: Copy) => (input.avoid?.some((h) => h.toLowerCase() === c.headline.toLowerCase()) ? `headline repeats another ad: "${c.headline}"` : null);
  const first = await draft(input);
  const problem = copyProblem(first, input) ?? repeats(first);
  if (!problem) return { ...first, angle: input.angle };
  console.warn(`copy redraft (${input.product.title}, ${input.angle}): ${problem}`);

  // Up to 3 drafts in the planned angle: in M4 the usual miss was a 7-word headline, which a
  // quoted redraft fixes, and falling back to aesthetic too early collapsed the round's variety.
  let last = problem;
  for (let i = 0; i < 2; i++) {
    const next = await draft(input, last);
    const issue = copyProblem(next, input) ?? repeats(next);
    if (!issue) return { ...next, angle: input.angle };
    last = issue;
  }
  console.warn(`copy falls back to aesthetic (${input.product.title}, ${input.angle}): ${last}`);

  const plain = { ...input, angle: 'aesthetic' as const, claims: [] };
  const third = await draft(plain);
  if (!copyProblem(third, plain)) return { ...third, angle: 'aesthetic' };
  // Last resort: copy that can't be wrong.
  return { headline: words(input.product.title).slice(0, 6).join(' '), cta: 'Shop Now', citedClaim: null, angle: 'aesthetic' };
}
