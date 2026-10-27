// The campaign agent (PLAN.md §3): tool definitions and the system prompt. The chat route
// builds these per request, because the tools are bound to one campaign.

import { tool, type InferUITools, type UIMessage } from 'ai';
import { z } from 'zod';
import { research, type ProgressStep } from './research';
import { parseStoreUrl } from './shopify';

import { GOALS } from './agent-goals';

export type CampaignContext = { campaignId: string; sourceUrl: string; domain: string };

// What the client resolves confirmBrief with, after the confirmBrief server action has saved
// the brief. The chat route checks it against the database before the model sees it.
export const BriefApproval = z.object({
  approved: z.literal(true),
  campaignId: z.string(),
  goal: z.enum(GOALS),
  shortName: z.string(),
  products: z.array(z.object({ id: z.string(), title: z.string() })),
  claimTopics: z.array(z.string()),
});
export type BriefApproval = z.infer<typeof BriefApproval>;

export function createTools(ctx: CampaignContext) {
  return {
    researchStore: tool({
      description:
        "Research the campaign's Shopify store: catalog, brand kit (logo, colors, voice, verified claims) and 3 recommended products. " +
        'Streams progress. Call it once, first.',
      inputSchema: z.object({ url: z.string().describe('the store or product URL the marketer pasted') }),
      // An async generator: every yield before the last is a preliminary result, which the UI
      // renders as the live research checklist. The last yield is what the model sees.
      async *execute({ url }) {
        // The tool is bound to this campaign's store, so the model can't research another one here.
        if (parseStoreUrl(url).domain !== ctx.domain) url = ctx.sourceUrl;

        const steps: ProgressStep[] = [];
        let dirty = false;
        let finished = false;
        let wake: (() => void) | null = null;
        let result: Awaited<ReturnType<typeof research>> | undefined;
        let failure: unknown;

        research(url, (step) => {
          const i = steps.findIndex((s) => s.key === step.key);
          if (i === -1) steps.push(step);
          else steps[i] = step;
          dirty = true;
          wake?.();
        })
          .then((r) => (result = r))
          .catch((e) => (failure = e))
          .finally(() => {
            finished = true;
            wake?.();
          });

        // Bridge research()'s progress callback to yields. `dirty` covers a step that lands
        // between two awaits, so no update is lost.
        while (!finished) {
          if (!dirty) await new Promise<void>((r) => (wake = r));
          wake = null;
          if (dirty && !finished) {
            dirty = false;
            yield { status: 'running' as const, steps: [...steps] };
          }
        }
        if (failure) throw failure;
        if (!result || 'error' in result) {
          yield { status: 'not_shopify' as const, steps };
          return;
        }

        const r = result;
        yield {
          status: 'done' as const,
          steps,
          brandKitId: r.brandKitId,
          brand: {
            name: r.brandKit.name,
            shortName: r.brandKit.shortName,
            valueProp: r.brandKit.valueProp,
            voice: r.brandKit.voice,
            claimTopics: r.brandKit.claimGroups.map((g) => g.topic),
          },
          recommended: r.recommended.map((p) => ({
            productId: p.productId,
            title: p.title,
            price: p.price,
            compareAtPrice: p.compareAtPrice,
            slot: p.slot,
            reason: p.reason,
          })),
          suggestedGoal: r.suggestedGoal,
          skipped: r.skipped,
          catalogCount: r.catalogCount,
          candidates: r.candidates,
        };
      },
    }),

    // The one pause (PLAN.md §3). No execute: the client renders the review card and resolves
    // this call with addToolOutput once the marketer clicks Generate.
    confirmBrief: tool({
      description:
        'Show the marketer the review card: brand kit, the 3 products and the goal, all editable. ' +
        'Call it right after researchStore with exactly its recommended product ids and suggested goal. Generation waits for this.',
      inputSchema: z.object({
        brandKitId: z.string(),
        productIds: z.array(z.string()).min(1).max(3),
        goal: z.enum(GOALS),
      }),
      outputSchema: BriefApproval,
    }),
  };
}

export type AgentTools = ReturnType<typeof createTools>;
export type AgentUIMessage = UIMessage<unknown, never, InferUITools<AgentTools>>;

export function systemPrompt(ctx: CampaignContext & { brandName?: string | null; status: 'briefing' | 'active' }): string {
  return `You are Ploy, an AI ads manager. You make 9:16 interstitial ads from a Shopify store's real product photos.

Campaign ${ctx.campaignId} for ${ctx.brandName ?? ctx.domain}. Store URL: ${ctx.sourceUrl}. Status: ${ctx.status}.

How a campaign starts:
1. Call researchStore with the store URL. Before it, write at most one short sentence.
2. As soon as research is done, call confirmBrief with its brandKitId, the recommended productIds in order, and the suggestedGoal. Do not restate the brief in text: the review card shows it, and the marketer edits it there.
3. If research says not_shopify, say in one sentence that only Shopify stores are supported, and stop.

After the marketer approves the brief (confirmBrief returns approved: true):
- Reply in 2 or 3 short sentences: what you will generate. That is 6 ads, 3 products x 2 angles, and for each product name the two angles you would use and why, in a few words.
- Angles come from this fixed set: benefit, social_proof, offer (only if a product has a real discount), aesthetic, guarantee. Pick them for the approved goal.
- Ad generation is not switched on yet in this version, so say the ads are queued, and do not claim any were made.

Style: plain, warm, brief. No markdown headings. Never invent products, prices, discounts or claims; use only what the tools returned.`;
}
