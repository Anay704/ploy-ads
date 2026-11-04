// The round planner (PLAN.md §3, §5): which 2 angles each product gets, which claim topic each
// ad leans on, and which scene it is shot in. Pure and client-safe, so the review card's
// preview and generateAds always agree.

import type { CampaignGoal } from './agent-goals';
import type { Mode, Setting } from './profile';

export const ANGLES = ['benefit', 'social_proof', 'offer', 'aesthetic', 'guarantee'] as const;
export type Angle = (typeof ANGLES)[number];

export const ANGLE_LABEL: Record<Angle, string> = {
  benefit: 'Benefit',
  social_proof: 'Social proof',
  offer: 'Offer',
  aesthetic: 'Aesthetic',
  guarantee: 'Guarantee',
};

// What each goal leads with, in order.
const PRIORITY: Record<CampaignGoal, Angle[]> = {
  seasonal: ['aesthetic', 'benefit', 'social_proof', 'guarantee'],
  sale: ['offer', 'benefit', 'social_proof', 'guarantee', 'aesthetic'],
  launch: ['aesthetic', 'benefit', 'social_proof', 'guarantee'],
  evergreen: ['benefit', 'social_proof', 'guarantee', 'aesthetic'],
};

// Which claim topics an angle can lean on. Topics are the LLM's labels ("reviews", "warranty",
// "core-benefit"), matched loosely. Angles that need proof are only used when a matching
// claim exists, because the copy may only state what the site says.
const TOPICS: Partial<Record<Angle, RegExp>> = {
  social_proof: /review|rating|recommend|trust|track|customer|proof|award|press/i,
  guarantee: /warrant|guarantee|return|trial|refund/i,
  benefit: /benefit|grip|drop|feature|function|comfort|quality|material|performance|ingredient|fit|design/i,
};
const NEEDS_CLAIM: Angle[] = ['social_proof', 'guarantee'];

// Scenes per angle (PLAN.md §5 "Scene variety"): each a different setting, framing and set
// of props. An angle used twice in a round gets its next scene, so no two ads share a setting.
// Scenes adapt to the product (lib/profile.ts): {product} is "the running shoes", {use} how it
// looks in use, {setting} the room it belongs in. A scene that depends on whether the product
// is held, worn or placed has one line per mode: a shoe is worn, a serum held, a coffee bag sits.
export type Scene = string | Record<Mode, string>;

// A concrete action per room, so a held or worn scene shows a real moment ("stirring a pan")
// instead of "the other hand busy", which reads as nothing in a render.
export const SETTING_ACTION: Record<Setting, string> = {
  kitchen: 'stirring a pan on the stove',
  bathroom: 'turning on the tap at the sink',
  bedroom: 'pulling open the curtains',
  'living room': 'watering a plant on the windowsill',
  'home office': 'typing on a laptop',
  'home gym': 'picking up a dumbbell',
  entryway: 'grabbing keys from a hook by the door',
  'dining room': 'setting a plate on the table',
};

export const SCENES: Record<Angle, Scene[]> = {
  benefit: [
    {
      held: 'outdoors on a busy city sidewalk at golden hour, {use}, mid-stride',
      worn: 'outdoors on a busy city sidewalk at golden hour, {use}, mid-stride',
      placed: 'in a bright {setting} in morning daylight, {use}',
    },
    // Not another warm-drink scene: M4's round had two cozy cup-and-sweater ads that read alike.
    {
      held: 'in a bright {setting}, {use} in one hand while the other is {action}, daylight',
      worn: 'in a bright {setting} in morning daylight, {use} while {action}',
      // A person in the background: two Death Wish ads were the same bag on the same counter.
      placed: 'a person mid-routine in the {setting}, softly blurred in the background, {action}, while in the foreground {use}, golden hour',
    },
    {
      held: 'on a commuter train, {use} while standing, soft daylight through the window',
      worn: 'on a park path in soft daylight, {use}, full-length framing',
      placed: 'close up on a clean surface in a {setting}, soft window light, {use}, a hand reaching in',
    },
  ],
  social_proof: [
    // Rating stars are added by the prompt only when the ad cites a reviews claim: stars imply a rating.
    'a clean, bright studio with {product} front and center on a simple pedestal',
    // Only ever one product in frame: a second one would be an invented product.
    {
      held: 'a bright, happy lifestyle moment: {product} held up toward the camera, smiling friends softly blurred in the background',
      worn: 'a bright, happy lifestyle moment: {product} worn by a smiling person in the foreground, friends softly blurred in the background',
      placed: 'a bright, happy lifestyle moment at home: {product} in the foreground, smiling friends softly blurred in the background',
    },
    'a minimal studio on a soft gradient backdrop, {product} floating at a slight angle with a gentle shadow',
  ],
  offer: [
    'a bold color-block studio set with large geometric shapes, energetic and promotional',
    'a gift-box unboxing scene on a bright surface, tissue paper and ribbon, {product} just revealed',
    'a punchy flat studio backdrop with a strong diagonal light beam across it',
  ],
  aesthetic: [
    // Worn products get their own line: on the table version, Allbirds put a foot up next to the mug.
    {
      held: 'a {season} styled scene that matches the colors of {product}: knit sweater, warm drink and soft natural light on a wooden table',
      worn: 'a {season} café corner that matches the colors of {product}: a knit sweater and a warm drink in hand, {product} worn by someone seated, soft natural light',
      placed: 'a {season} styled scene that matches the colors of {product}: knit sweater, warm drink and soft natural light on a wooden table',
    },
    // No books, menus or packaging: printed pages put extra words in the ad (an open book's page
    // number failed the text check in M4's first round).
    {
      held: 'a cozy {season} window seat: a chunky knit blanket, a lit candle and soft fairy lights, {product} resting on the blanket',
      worn: 'a cozy {season} window seat: a chunky knit blanket, a lit candle and soft fairy lights, {product} worn by someone curled up on the seat',
      placed: 'a cozy {season} window seat: a chunky knit blanket, a lit candle and soft fairy lights, {product} resting on the blanket',
    },
    {
      held: 'outdoors in {season}: a park path or a street with seasonal color, {product} in hand, shallow depth of field',
      worn: 'outdoors in {season}: a park path or a street with seasonal color, {product} worn by someone walking, shallow depth of field',
      placed: 'outdoors in {season}: a park bench on a path with seasonal color, {product} set on the bench, shallow depth of field',
    },
  ],
  guarantee: [
    'a calm, premium scene on stone and linen in soft daylight that suggests durability',
    {
      held: 'a minimal oak desk with a notebook and a pen, quiet and dependable, morning light',
      worn: 'a minimal, quiet bedroom with an oak bench in morning light, {product} worn by someone sitting on the bench, calm and dependable',
      placed: 'a minimal oak desk with a notebook and a pen, quiet and dependable, morning light',
    },
    {
      held: 'a hand holding {product} against a clean concrete wall, crisp and confident, soft shadows',
      worn: '{product} worn against a clean concrete wall, crisp and confident, soft shadows',
      placed: '{product} on a simple plinth against a clean concrete wall, crisp and confident, soft shadows',
    },
  ],
};

export type PlannedAd = { productId: string; angle: Angle; scene: number; claimTopic: string | null };

export type PlanProduct = { id: string; hasDiscount: boolean; seasonal: boolean; bestSeller?: boolean };

/**
 * Two distinct angles per product, balanced across the round so the 6 ads don't repeat one
 * idea. A best seller leads with social proof and a seasonal product with aesthetic, but only
 * while that angle is still unused: on Loopy most picks also sit in a seasonal collection, and
 * an unconditional lead gave every product the same angle. Claim topics and scenes are spread
 * so two ads share neither a fact (while unused topics remain) nor a setting.
 */
export function planRound(products: PlanProduct[], goal: CampaignGoal, claimTopics: string[], perProduct = 2): PlannedAd[] {
  const angleUse = new Map<Angle, number>();
  const topicUse = new Map<string, number>();
  const plan: PlannedAd[] = [];

  const topicsFor = (angle: Angle) => claimTopics.filter((t) => TOPICS[angle]?.test(t));
  const available = (angle: Angle, p: PlanProduct) =>
    (angle !== 'offer' || p.hasDiscount) && (!NEEDS_CLAIM.includes(angle) || topicsFor(angle).length > 0);

  for (const p of products) {
    const order = [...PRIORITY[goal]];
    if (p.hasDiscount && !order.includes('offer')) order.push('offer');
    const candidates = order.filter((a) => available(a, p));
    const lead = (
      [
        [p.bestSeller, 'social_proof'],
        [p.seasonal, 'aesthetic'],
      ] as const
    ).find(([applies, angle]) => applies && candidates.includes(angle) && !angleUse.get(angle))?.[1];
    // Then least-used first and the goal's priority, so the round covers as many angles as it can.
    const rest = candidates
      .filter((a) => a !== lead)
      .sort((a, b) => (angleUse.get(a) ?? 0) - (angleUse.get(b) ?? 0) || candidates.indexOf(a) - candidates.indexOf(b));
    const chosen = [...(lead ? [lead] : []), ...rest].slice(0, perProduct);

    for (const angle of chosen) {
      const used = angleUse.get(angle) ?? 0;
      angleUse.set(angle, used + 1);
      const topics = topicsFor(angle).sort((a, b) => (topicUse.get(a) ?? 0) - (topicUse.get(b) ?? 0));
      const claimTopic = topics[0] ?? null;
      if (claimTopic) topicUse.set(claimTopic, (topicUse.get(claimTopic) ?? 0) + 1);
      plan.push({ productId: p.id, angle, scene: used % SCENES[angle].length, claimTopic });
    }
  }
  return plan;
}
