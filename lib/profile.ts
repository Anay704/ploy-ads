// What an ad needs to know about a product it hasn't seen before (PLAN.md §5 "Product
// fidelity"). The prompts used to assume a Loopy phone case ("keep the finger loop and camera
// cutout"); on a shoe or a coffee bag that tells the image model to keep parts that don't exist.
// So each product gets a short profile, read once from its Shopify data and its actual photo,
// and the prompt's fidelity section and scenes are built from it.

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { llm } from './llm';

export const PROFILE_MODEL = 'claude-haiku-5-5';

export const MODES = ['held', 'worn', 'placed'] as const;
export type Mode = (typeof MODES)[number];

// A fixed list, so a scene line never reads "in a bright anywhere" (seen on the first Loopy run).
export const SETTINGS = ['kitchen', 'bathroom', 'bedroom', 'living room', 'home office', 'home gym', 'entryway', 'dining room'] as const;
export type Setting = (typeof SETTINGS)[number];

export const ProductProfileSchema = z.object({
  category: z
    .string()
    .describe('what the product is, 1-3 lowercase words as you would say it after "the": "phone case", "running shoes", "face serum", "bag of coffee", "duvet cover", "lip kit"'),
  mode: z
    .enum(MODES)
    .describe('how it appears in a lifestyle photo: "held" (in a hand: phone cases, bottles, cosmetics), "worn" (on a body: clothing, shoes, jewelry, bags), "placed" (set in a room: bedding, food, home goods)'),
  use: z
    .string()
    .describe(
      'how a person uses it, a short phrase starting with "the", 14 words or fewer, with no place (the scene sets it), brand names, camera angles or poses: "the phone held securely by the case\'s finger loop", "the sneakers worn by someone walking", "the duvet cover spread on a freshly made bed", "the ground coffee scooped into a pour-over"',
    ),
  setting: z.enum(SETTINGS).describe('the room at home where it is most naturally used (a scene is set there)'),
  features: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe(
      'the 3 to 5 visual features an image model must preserve, read from the photo: pattern, colors, shape, label or printed text, distinctive parts. Concrete and visual: "navy and cream checkerboard pattern", "white rubber sole with a green heel tab", not "stylish design".',
    ),
  inUsePhoto: z.boolean().describe('true when the photo shows the product held, worn or used by a person (a hand counts)'),
});
export type ProductProfile = z.infer<typeof ProductProfileSchema>;

export type ShopifyFacts = { title: string; productType: string | null; tags: string[] };

/**
 * Used when the vision call fails, so a round never blocks on it. The category comes from
 * product_type ("Cases" → "case"); the prompt then falls back to generic fidelity wording.
 */
export function fallbackProfile(p: ShopifyFacts): ProductProfile {
  const type = (p.productType ?? '').trim().toLowerCase();
  const category = type ? type.replace(/(?<=[^s])s$/, '') : 'product';
  return { category, mode: 'placed', use: `the ${category} in natural use`, setting: 'living room', features: [], inUsePhoto: false };
}

/** One cheap vision call per product, cached on products.profile by the caller. */
export async function profileProduct(image: Buffer, p: ShopifyFacts): Promise<ProductProfile> {
  const { output } = await generateText({
    model: llm(PROFILE_MODEL),
    output: Output.object({ schema: ProductProfileSchema, name: 'product_profile' }),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', data: image, mediaType: 'image/jpeg' },
          {
            type: 'text',
            text: [
              'This is the product photo an image model will use as its reference for an ad. Describe the product so the ad keeps it exact.',
              `Shopify title: ${p.title}`,
              `Shopify product_type: ${p.productType || '(none)'}`,
              `Shopify tags: ${p.tags.slice(0, 15).join(', ') || '(none)'}`,
              'Use the Shopify data for what the product is, and the photo for how it looks. Describe only the product, not the background or props.',
            ].join('\n'),
          },
        ],
      },
    ],
  });
  return output;
}
