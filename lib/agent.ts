// The campaign agent (PLAN.md §3): tool definitions and the system prompt. The chat route
// builds these per request, because the tools are bound to one campaign.

import { tool, type InferUITools, type UIMessage } from 'ai';
import { z } from 'zod';
import { queueRound, startJobs } from './generate';
import { must, research, type ProgressStep } from './research';
import { supabaseServer } from './supabase/server';
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

    // Steering before approval ("make the voice more premium"). It changes the words around
    // the brand, never the claims: those stay verbatim from the site.
    reviseBrief: tool({
      description:
        "Change the draft brand kit before the marketer approves it: the name used in ads, the voice, the value proposition or the audience. Claims can't be changed. " +
        'Afterwards call confirmBrief again so the marketer sees the updated card.',
      inputSchema: z.object({
        shortName: z.string().max(40).optional(),
        voiceAdjectives: z.array(z.string().max(24)).length(3).optional(),
        voiceSample: z.string().max(200).optional(),
        valueProp: z.string().max(300).optional(),
        audience: z.string().max(300).optional(),
      }),
      execute: async (edits) => {
        const db = supabaseServer();
        const campaign = must(await db.from('campaigns').select('status, brand_kit_id').eq('id', ctx.campaignId).single(), 'load campaign');
        if (campaign.status !== 'briefing') return { updated: [] as string[], note: 'The brief is already approved; brand changes now go through feedback.' };
        const kit = must(await db.from('brand_kits').select('voice').eq('id', campaign.brand_kit_id).single(), 'load brand kit');
        const voice = (kit.voice ?? { adjectives: [], sample: '' }) as { adjectives: string[]; sample: string };
        const update = {
          ...(edits.shortName && { short_name: edits.shortName }),
          ...((edits.voiceAdjectives || edits.voiceSample) && {
            voice: { adjectives: edits.voiceAdjectives ?? voice.adjectives, sample: edits.voiceSample ?? voice.sample },
          }),
          ...(edits.valueProp && { value_prop: edits.valueProp }),
          ...(edits.audience && { audience: edits.audience }),
        };
        must(await db.from('brand_kits').update(update).eq('id', campaign.brand_kit_id).select('id'), 'revise brand kit');
        return { updated: Object.keys(update), note: 'Saved. Call confirmBrief again to show the updated card.' };
      },
    }),

    generateAds: tool({
      description:
        'Generate ads for the approved brief: by default 2 angles for each campaign product (6 ads), planned so no two share a setting. ' +
        'Returns at once with the queued ads; the grid fills in as each one renders. Caps: 8 per call, 40 per campaign.',
      inputSchema: z.object({
        productIds: z.array(z.string()).optional().describe('a subset of the campaign products; omit for all'),
        perProduct: z.number().int().min(1).max(2).optional(),
      }),
      execute: async ({ productIds, perProduct }) => {
        const { queued, capped } = await queueRound(ctx.campaignId, { productIds, perProduct });
        startJobs(queued.map((q) => q.variantId));
        return { queued: queued.map(({ product, angle, headline, cta }) => ({ product, angle, headline, cta })), capped };
      },
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

While the brief is waiting for approval, the marketer may ask for changes in chat:
- Product changes ("add a Halloween design", "focus on the newest drops"): call confirmBrief again with the new productIds (from researchStore's candidates or skipped list) and goal. Products skipped for a too-close holiday may be used when the marketer asks; say the timing risk in one short clause.
- Brand wording ("make the voice more premium"): call reviseBrief, then confirmBrief again with the same products.
- Keep the reply to one sentence; the card shows the result.

After the marketer approves the brief (confirmBrief returns approved: true):
- Call generateAds right away, with no arguments.
- Then reply in 1 or 2 short sentences: how many ads are rendering and that the grid fills in as each finishes. Do not list them; the grid shows them. Never claim an ad is finished: you can't see renders finish.

Style: plain, warm, brief. No markdown headings. Never invent products, prices, discounts or claims; use only what the tools returned.`;
}
