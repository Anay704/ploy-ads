// The agent (PLAN.md §2): one streamText call per turn with the campaign's tools. The client
// sends only its newest message; the conversation itself lives in campaigns.chat.

import {
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  validateUIMessages,
} from 'ai';
import { createTools, systemPrompt, type AgentUIMessage } from '@/lib/agent';
import { llm } from '@/lib/llm';
import { supabaseServer } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/database.types';

// Research takes 10-40s, and M4's generation jobs share this budget (Hobby maximum).
export const maxDuration = 300;

export async function POST(req: Request) {
  const { id, message } = (await req.json()) as { id: string; message: AgentUIMessage };
  const db = supabaseServer();

  const { data: campaign } = await db
    .from('campaigns')
    .select('id, status, source_url, chat, brand_kits(domain, store_url, name, short_name)')
    .eq('id', id)
    .maybeSingle();
  if (!campaign?.brand_kits) return new Response('campaign not found', { status: 404 });

  // A tool output arrives as an update to the last assistant message, not a new message, so
  // replace by id; anything else is appended.
  const stored = (campaign.chat ?? []) as unknown as AgentUIMessage[];
  // A new user message while a brief waits for approval means "change it" (a suggestion chip,
  // or typed feedback). The open confirmBrief call is closed as superseded, so the model never
  // sees a tool call without a result, and its next confirmBrief opens a fresh card.
  const history =
    message.role === 'user'
      ? stored.map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === 'tool-confirmBrief' && p.state === 'input-available'
              ? { ...p, state: 'output-error' as const, errorText: 'Superseded: the marketer asked for changes in chat.' }
              : p,
          ),
        }))
      : stored;
  const merged = (history.at(-1)?.id === message.id ? [...history.slice(0, -1), message] : [...history, message]) as AgentUIMessage[];

  // The client resolves confirmBrief, but the database decides: an approval only counts if the
  // confirmBrief server action actually saved the brief and activated the campaign.
  const claimsApproval = message.parts.some((p) => p.type === 'tool-confirmBrief' && p.state === 'output-available');
  if (claimsApproval && campaign.status !== 'active') return new Response('brief not confirmed', { status: 409 });

  const ctx = {
    campaignId: campaign.id,
    sourceUrl: campaign.source_url ?? campaign.brand_kits.store_url,
    domain: campaign.brand_kits.domain,
  };
  const tools = createTools(ctx);
  const messages = await validateUIMessages<AgentUIMessage>({ messages: merged, tools });
  // Saved before streaming, so a reload mid-research shows the conversation instead of an
  // empty chat that would start research a second time.
  await db
    .from('campaigns')
    .update({ chat: messages as unknown as NonNullable<Json> })
    .eq('id', id);

  const result = streamText({
    model: llm(),
    system: systemPrompt({ ...ctx, brandName: campaign.brand_kits.short_name ?? campaign.brand_kits.name, status: campaign.status }),
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(8),
  });
  // Run to completion even if the tab closes, so research is finished and saved.
  result.consumeStream();

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
      // Tool errors are our own messages ("homepage 503", "logo copy failed"), so show them
      // instead of the SDK's generic text; they carry no secrets.
      onError: (e) => (e instanceof Error ? e.message : 'Something went wrong.'),
      onEnd: async ({ messages }) => {
        await db
          .from('campaigns')
          .update({ chat: messages as unknown as NonNullable<Json> })
          .eq('id', id);
      },
    }),
  });
}
