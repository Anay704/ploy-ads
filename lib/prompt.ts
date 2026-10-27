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
