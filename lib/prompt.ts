// The image prompt (PLAN.md §5). Every variant stores the exact prompt it was generated with,
// so the version drawer can show which feedback produced it.

import { SCENES, type Angle } from './angles';

export type { Angle };

// Where the real logo is composited after generation. The M4 safe-zone re-run showed that
// asking for an empty top band fails twice over: the headline still crosses it, and the model
// paints a solid color bar to "keep it empty" (NOTES.md, M4). So the logo moved to a badge in
// the bottom-left corner, beside the CTA, and the prompt never asks for an empty band.
export const LOGO_PLACEMENT: 'top' | 'corner' = 'corner';
export const SAFE_BAND = 0.15; // only used by the 'top' layout

export type PromptInput = {
  brandName: string; // the short name ("Loopy"), never the legal one
  productTitle: string;
  isHero: boolean; // the reference shows the case in a hand
  angle: Angle;
  scene: number; // index into SCENES[angle]; unique per round
  season: string;
  colors: { primary: string; text: string };
  buttonInk: string; // text color that reads on the primary
  voiceAdjectives: string[];
  headline: string;
  cta: string;
  ratingStars?: boolean; // only when the ad cites a reviews or rating claim
  brandRules?: string[]; // campaign feedback, as imperative lines
  revisionNotes?: string[]; // this ad's lineage feedback, oldest first
};

export function sceneFor(angle: Angle, scene: number, season: string): string {
  const options = SCENES[angle];
  return options[scene % options.length].replace(/\{season\}/g, season);
}

export function buildPrompt(p: PromptInput): string {
  const band = `${Math.round(SAFE_BAND * 100)}%`;
  const layout =
    LOGO_PLACEMENT === 'top'
      ? [
          `LAYOUT — HARD RULE: the top ${band} of the image is empty background only. No text, no product, no hands, no props in that band.`,
          `The headline starts below that band.`,
        ]
      : [
          'LAYOUT — the headline sits in the top third. The button is a pill centered horizontally near the bottom edge, no wider than 40% of the image width.',
          'Keep the bottom-left corner, beside the button, free of any text: the scene simply continues there.',
        ];
  const lines = [
    `Create a full-screen vertical 9:16 mobile ad (portrait interstitial) for ${p.brandName}.`,
    '',
    `PRODUCT — use the reference image exactly. The phone case "${p.productTitle}" must keep its exact`,
    'pattern, colors, finish, finger loop and camera cutout. Do not redraw, restyle or add products. Only this one case appears.',
    p.isHero ? 'Keep the hand and loop interaction from the photo.' : 'Show the case in a hand or resting naturally in the scene.',
    '',
    `SCENE — ${sceneFor(p.angle, p.scene, p.season)}. Mood: ${p.voiceAdjectives.filter(Boolean).join(', ')}.`,
    ...(p.ratingStars ? ['Add a single small row of five gold rating stars under the headline, as a graphic.'] : []),
    'A real photograph, not a template: no color bands, panels, frames, borders, stickers or collage. The scene keeps its own natural colors.',
    '',
    ...layout,
    '',
    'TEXT — render exactly these two strings, each exactly once, spelled exactly, and no other words anywhere (including on props):',
    `  Headline (large, bold rounded sans, ${p.colors.text} or white for contrast, ${LOGO_PLACEMENT === 'top' ? `just below the empty top ${band}` : 'in the top third, with the scene continuing behind it'}): "${p.headline}"`,
    `  Button (pill, centered near the bottom, ${p.colors.primary} fill, ${p.buttonInk} text): "${p.cta}"`,
    'No prices, logos, watermarks, labels or extra captions.',
  ];
  if (p.brandRules?.length) lines.push('', 'BRAND RULES — follow all of these:', ...p.brandRules.map((r) => `- ${r}`));
  if (p.revisionNotes?.length) lines.push('', 'REVISION NOTES for this ad, oldest first — the latest wins:', ...p.revisionNotes.map((r) => `- ${r}`));
  return lines.join('\n');
}

// ── Versions (PLAN.md §5, §6) ────────────────────────────────────────────────

// Section headers buildPrompt appends after the base prompt. A new version keeps the base and
// replaces these, so feedback never piles up as stale text.
const SECTION_MARKERS = ['\n\nREFERENCE IMAGES —', '\n\nBRAND RULES —', '\n\nREVISION NOTES'];

/** Marks a copy-only edit: the job sends only the previous render as the reference. */
export const EDIT_PREFIX = 'Edit this ad image.';

/** A revision: the job sends the previous render first, then the product photo. */
export const REVISION_MARKER = '\n\nREFERENCE IMAGES —';

export function basePrompt(prompt: string): string {
  const cut = Math.min(...SECTION_MARKERS.map((m) => prompt.indexOf(m)).filter((i) => i >= 0), prompt.length);
  return prompt.slice(0, cut);
}

/** PLAN.md §5: a copy change re-renders from the previous raw render and changes nothing else. */
export function editPrompt(old: { headline: string; cta: string }, next: { headline: string; cta: string }): string {
  return [
    EDIT_PREFIX,
    `Replace the headline text "${old.headline}" with "${next.headline}" and the button text "${old.cta}" with "${next.cta}", in the same font, size, color and position.`,
    'Keep everything else pixel-identical: product, hand, background, layout, colors. Change nothing else.',
    'Render each new string exactly once, spelled exactly, and no other words.',
  ].join('\n');
}

/**
 * A new full version of an ad: the original prompt's base, the round's current brand rules and
 * this ad's revision notes (oldest first). With `fromPrevious`, the previous render is the
 * starting point, so "warmer lighting" changes the light, not the whole composition.
 */
export function revisedPrompt(
  previous: string,
  opts: { brandRules: string[]; revisionNotes: string[]; fromPrevious: boolean; headline?: { from: string; to: string }; cta?: { from: string; to: string } },
): string {
  let base = basePrompt(previous);
  if (opts.headline) base = base.replace(`"${opts.headline.from}"`, `"${opts.headline.to}"`);
  if (opts.cta) base = base.replace(`"${opts.cta.from}"`, `"${opts.cta.to}"`);
  const lines = [base];
  if (opts.fromPrevious) {
    lines.push(
      '',
      // "Keep its composition" alone made the model too timid: M5's first "warmer lighting" moved
      // warmth by ~5%, which no marketer would notice. So the change is asked for explicitly.
      'REFERENCE IMAGES — the first image is the current version of this ad: keep its composition, product placement and text layout. ' +
        'Apply the revision notes below clearly and visibly: someone comparing the two images must see the change at a glance. ' +
        'The second image is the product photo: the case must match it exactly.',
    );
  }
  if (opts.brandRules.length) lines.push('', 'BRAND RULES — follow all of these:', ...opts.brandRules.map((r) => `- ${r}`));
  if (opts.revisionNotes.length) lines.push('', 'REVISION NOTES for this ad, oldest first — the latest wins:', ...opts.revisionNotes.map((r) => `- ${r}`));
  return lines.join('\n');
}
