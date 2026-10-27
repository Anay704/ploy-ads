// The vision text check (PLAN.md §5): a cheap vision model reads the raw render, and code
// decides. The headline and CTA must each appear exactly once, spelled exactly, with no other
// legible words. Text printed on the product itself (the "loopy" loop, the p mark) is allowed.

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { llm } from './llm';

export const TEXT_CHECK_MODEL = 'claude-haiku-5-5';

const Reading = z.object({
  adText: z.array(z.string()).describe('every piece of overlaid ad text (headline, button, captions), one entry per occurrence, exactly as spelled'),
  productText: z.array(z.string()).describe('text printed or embossed on the phone case itself'),
  sceneText: z.array(z.string()).describe('legible words on anything else in the scene: signs, cups, packaging, books. Skip illegible or blurred marks.'),
});
export type TextReading = z.infer<typeof Reading>;

export type TextCheck = { pass: boolean; reason: string | null; reading: TextReading };

// Case and whitespace are styling (a button may be set in caps); letters and punctuation are not.
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[’‘]/g, "'");

/** Pure: the rule applied to what the model read. */
export function judgeText(reading: TextReading, headline: string, cta: string): { pass: boolean; reason: string | null } {
  const ad = reading.adText.map(norm).filter(Boolean);
  // A headline set on several lines is read as several entries ("Try Loopy" / "risk-free for" /
  // "30 days"), so runs of up to 4 consecutive entries are joined before matching.
  const joined = ad.flatMap((_, i) => [1, 2, 3, 4].map((n) => ad.slice(i, i + n).join(' ')).filter((_, n) => i + n < ad.length));
  const count = (want: string) => ad.filter((t) => t === norm(want)).length || (joined.includes(norm(want)) ? 1 : 0);

  const h = count(headline);
  const c = count(cta);
  if (h === 0) return { pass: false, reason: `headline not found as written: "${headline}"` };
  if (h > 1) return { pass: false, reason: `headline appears ${h}×` };
  if (c === 0) return { pass: false, reason: `button text not found as written: "${cta}"` };
  if (c > 1) return { pass: false, reason: `button text appears ${c}×` };

  const expected = [norm(headline), norm(cta)];
  const parts = new Set(norm(headline).split(' '));
  const extra = ad.filter((t) => !expected.includes(t) && !t.split(' ').every((w) => parts.has(w)));
  if (extra.length) return { pass: false, reason: `extra text "${extra[0]}"` };
  if (reading.sceneText.length) return { pass: false, reason: `legible words in the scene: "${reading.sceneText[0]}"` };
  return { pass: true, reason: null };
}

export async function checkRenderText(image: Buffer, headline: string, cta: string): Promise<TextCheck> {
  const { output } = await generateText({
    model: llm(TEXT_CHECK_MODEL),
    output: Output.object({ schema: Reading, name: 'text_reading' }),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', data: image, mediaType: 'image/png' },
          {
            type: 'text',
            text: 'Transcribe every legible piece of text in this ad image, exactly as spelled, sorted into ad text, text on the phone case, and text elsewhere in the scene. List repeated text once per occurrence. Do not correct spelling.',
          },
        ],
      },
    ],
  });
  return { ...judgeText(output, headline, cta), reading: output };
}
