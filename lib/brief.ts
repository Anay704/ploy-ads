// Shapes shared by the review card (client) and the brief server actions. No server imports.

import { z } from 'zod';
import { GOALS } from './agent-goals';

export { GOALS };

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a color like #F990A8');

export const BrandColorsSchema = z.object({ primary: hex, secondary: hex, accent: hex, background: hex, text: hex });

/** What the marketer can change on the review card, as submitted by Generate. */
export const BriefEdits = z.object({
  campaignId: z.string().uuid(),
  brandKitId: z.string().uuid(),
  shortName: z.string().trim().min(1).max(40),
  colors: BrandColorsSchema,
  voice: z.object({ adjectives: z.array(z.string().trim().min(1).max(24)).length(3), sample: z.string().trim().max(200) }),
  valueProp: z.string().trim().min(1).max(300),
  audience: z.string().trim().min(1).max(300),
  // Claims can be removed but never rewritten: each one is checked against the verified list.
  claimGroups: z.array(z.object({ topic: z.string(), claims: z.array(z.string()).min(1) })),
  productIds: z.array(z.string().uuid()).min(1).max(3),
  goal: z.enum(GOALS),
});
export type BriefEdits = z.infer<typeof BriefEdits>;

export type BriefProduct = {
  id: string;
  title: string;
  price: number;
  compareAtPrice: number | null;
  clearance: boolean;
  tags: string[];
  reason: string | null;
  imageUrl: string | null;
};

export type BriefData = {
  campaignId: string;
  status: 'briefing' | 'active';
  goal: (typeof GOALS)[number] | null;
  brandKit: {
    id: string;
    name: string;
    shortName: string;
    domain: string;
    logoUrl: string | null;
    colors: z.infer<typeof BrandColorsSchema>;
    voice: { adjectives: string[]; sample: string };
    valueProp: string;
    audience: string;
    claimGroups: { topic: string; claims: string[] }[];
    verifiedClaims: string[];
  };
  products: BriefProduct[];
};

/** A product is fair game for offer copy only with a real, non-clearance discount (PLAN.md §5). */
export const hasRealDiscount = (p: Pick<BriefProduct, 'compareAtPrice' | 'clearance'>) => p.compareAtPrice !== null && !p.clearance;
