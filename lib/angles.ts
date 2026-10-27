// The round planner (PLAN.md §3, §5): which 2 angles each product gets, which claim topic each
// ad leans on, and which scene it is shot in. Pure and client-safe, so the review card's
// preview and generateAds always agree.

import type { CampaignGoal } from './agent-goals';

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
  social_proof: /review|rating|recommend|trust|track|customer|proof/i,
  guarantee: /warrant|guarantee|return|trial|refund/i,
  benefit: /benefit|grip|drop|feature|function|comfort/i,
};
const NEEDS_CLAIM: Angle[] = ['social_proof', 'guarantee'];

// Scenes per angle (PLAN.md §5 "Scene variety"): each a different setting, framing and set
// of props. An angle used twice in a round gets its next scene, so no two ads share a setting.
export const SCENES: Record<Angle, string[]> = {
  benefit: [
    'outdoors on a busy city sidewalk at golden hour, the phone held securely by the finger loop mid-stride',
    // Not another warm-drink scene: M4's round had two cozy cup-and-sweater ads that read alike.
    'in a bright kitchen while cooking: the phone held by the loop in one hand, the other hand stirring a pan, daylight',
    'on a commuter train, the phone held by the loop while standing, soft daylight through the window',
  ],
  social_proof: [
    // Rating stars are added by the prompt only when the ad cites a reviews claim: stars imply a rating.
    'a clean, bright studio with the case front and center on a simple pedestal',
    // Only ever one case in frame: a second phone case would be an invented product.
    'a bright, happy lifestyle moment: the case held up toward the camera, smiling friends softly blurred in the background',
    'a minimal studio on a soft gradient backdrop, the case floating at a slight angle with a gentle shadow',
  ],
  offer: [
    'a bold color-block studio set with large geometric shapes, energetic and promotional',
    'a gift-box unboxing scene on a bright surface, tissue paper and ribbon, the case just revealed',
    'a punchy flat studio backdrop with a strong diagonal light beam across it',
  ],
  aesthetic: [
    'a {season} styled scene that matches the case pattern: knit sweater, warm drink and soft natural light on a wooden table',
    // No books, menus or packaging: printed pages put extra words in the ad (an open book's page
    // number failed the text check in M4's first round).
    'a cozy {season} window seat: a chunky knit blanket, a lit candle and soft fairy lights, the case resting on the blanket',
    'outdoors in {season}: a park path or a street with seasonal color, the case in hand, shallow depth of field',
  ],
  guarantee: [
    'a calm, premium scene on stone and linen in soft daylight that suggests durability',
    'a minimal oak desk with a notebook and a pen, quiet and dependable, morning light',
    'a hand holding the case against a clean concrete wall, crisp and confident, soft shadows',
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
