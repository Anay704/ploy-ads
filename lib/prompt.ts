// Prompt template from PLAN.md §5. The bake-off imports this same builder, so the
// model we pick is judged on the exact prompt the app will send.

export type Angle = 'benefit' | 'social_proof' | 'offer' | 'aesthetic' | 'guarantee';

export const ANGLE_SCENES: Record<Angle, string> = {
  benefit: 'a hand confidently holding the phone mid-scroll on a busy street, showing the secure grip',
  social_proof: 'a bright, upbeat lifestyle moment that feels loved and trusted, soft confetti accents',
  offer: 'a clean studio set with bold color blocking, energetic and promotional',
  aesthetic: 'a soft, styled flat-lay or vanity scene that matches the case pattern and season',
  guarantee: 'a calm, premium studio scene that feels durable and dependable',
};

export type PromptInput = {
  brandName: string;
  productTitle: string;
  isHero: boolean;
  angle: Angle;
  colors: { primary: string; secondary: string; background: string };
  voiceAdjectives: string[];
  headline: string;
  cta: string;
  brandRules?: string[];
  revisionNotes?: string[];
};

export function buildPrompt(p: PromptInput): string {
  const lines = [
    `Create a full-screen vertical 9:16 mobile ad (portrait interstitial) for ${p.brandName}.`,
    '',
    `PRODUCT — use the reference image exactly. The phone case "${p.productTitle}" must keep its exact`,
    'pattern, colors, finish, finger loop and camera cutout. Do not redraw, restyle or add products.',
    p.isHero
      ? 'Keep the hand and loop interaction from the photo.'
      : 'Place the case in a fitting lifestyle scene.',
    '',
    `SCENE — ${ANGLE_SCENES[p.angle]}. Palette: ${p.colors.primary}, ${p.colors.secondary}, ${p.colors.background}.`,
    `Mood: ${p.voiceAdjectives.join(', ')}. Leave the top 12% clear (logo goes there).`,
    '',
    'TEXT — render exactly these two strings, spelled exactly, nothing else:',
    `  Headline (large, top third, bold rounded sans): "${p.headline}"`,
    `  Button (pill, bottom 15%, ${p.colors.primary} fill, white text): "${p.cta}"`,
    'No other words, prices, logos or watermarks.',
  ];
  if (p.brandRules?.length) lines.push('', ...p.brandRules);
  if (p.revisionNotes?.length) lines.push('', ...p.revisionNotes);
  return lines.join('\n');
}
