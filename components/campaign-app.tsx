'use client';

import { useEffect, useMemo, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import Link from 'next/link';
import { AlertCircleIcon } from 'lucide-react';
import { loadBrief } from '@/app/actions';
import type { AgentUIMessage, BriefApproval } from '@/lib/agent';
import type { CampaignGoal } from '@/lib/agent-goals';
import type { BriefData } from '@/lib/brief';
import { brandStyle, type BrandColors } from '@/lib/theme';
import { ChatPanel } from '@/components/chat-panel';
import { ResearchChecklist } from '@/components/research-checklist';
import { ReviewCard } from '@/components/review-card';
import { BriefSummary } from '@/components/brief-summary';
import { ProductTilesSkeleton, SkeletonBlock } from '@/components/workspace-skeleton';
import { phaseOf, stepsOf, type Phase } from '@/components/campaign-state';

type Brand = { name: string; logoUrl: string | null; colors: BrandColors | null };

export function CampaignApp({
  campaignId,
  sourceUrl,
  domain,
  initialMessages,
  initialBrand,
  initialBrief,
}: {
  campaignId: string;
  sourceUrl: string;
  domain: string;
  initialMessages: AgentUIMessage[];
  initialBrand: Brand;
  initialBrief: BriefData | null;
}) {
  const { messages, sendMessage, addToolOutput, status, error } = useChat<AgentUIMessage>({
    id: campaignId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      // The server holds the conversation (campaigns.chat), so only the newest message travels.
      prepareSendMessagesRequest: ({ messages, id }) => ({ body: { id, message: messages.at(-1) } }),
    }),
    // Once the review card resolves confirmBrief, the agent continues without another prompt.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  // A new campaign starts itself: research begins the moment the workspace opens. The send
  // is scheduled and cleared on cleanup, so React's dev double-mount sends once (from the
  // instance that survives); a ref guard here would block the surviving instance instead.
  const empty = messages.length === 0;
  useEffect(() => {
    if (!empty || status !== 'ready') return;
    const t = setTimeout(() => sendMessage({ text: `Research ${sourceUrl}` }), 0);
    return () => clearTimeout(t);
  }, [empty, status, sendMessage, sourceUrl]);

  const phase = useMemo(() => phaseOf(messages), [messages]);
  const brief = useBrief(campaignId, phase, initialBrief);
  const brand: Brand = brief
    ? { name: brief.brandKit.shortName, logoUrl: brief.brandKit.logoUrl, colors: brief.brandKit.colors }
    : initialBrand;

  const onApproved = (approval: BriefApproval) => {
    if (phase.kind !== 'review') return;
    addToolOutput({ tool: 'confirmBrief', toolCallId: phase.confirm.toolCallId, output: approval });
  };

  return (
    <div style={brandStyle(brand.colors)} className="flex h-dvh flex-col bg-white">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b px-5">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
          <span className="size-2.5 rounded-full bg-zinc-900" />
          Ploy Ads
        </Link>
        <span className="h-5 w-px bg-zinc-200" />
        <div className="flex min-w-0 items-center gap-3">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the brand's logo from Storage
            <img src={brand.logoUrl} alt={brand.name} className="h-6 w-auto max-w-32 object-contain" />
          ) : (
            <span className="truncate text-sm font-medium">{brand.name}</span>
          )}
          <span className="truncate text-sm text-zinc-500">{domain}</span>
        </div>
        <PhaseBadge phase={phase} />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[400px_1fr]">
        <ChatPanel messages={messages} status={status} error={error} onSend={(text) => sendMessage({ text })} />
        <main className="min-h-0 overflow-y-auto bg-[linear-gradient(180deg,color-mix(in_oklab,var(--brand-2)_10%,white)_0%,white_320px)]">
          <div className="mx-auto max-w-5xl p-8">
            <Workspace phase={phase} brief={brief} domain={domain} onApproved={onApproved} />
          </div>
        </main>
      </div>
    </div>
  );
}

/** Loads the review card's data from the database once the agent proposes a brief. */
function useBrief(campaignId: string, phase: Phase, initial: BriefData | null): BriefData | null {
  const [brief, setBrief] = useState<BriefData | null>(initial);
  const key = phase.kind === 'review' || phase.kind === 'confirmed' ? phase.confirm.toolCallId : null;
  const input = phase.kind === 'review' || phase.kind === 'confirmed' ? phase.confirm.input : null;
  useEffect(() => {
    if (!key || !input?.brandKitId || !input.productIds) return;
    let live = true;
    loadBrief(campaignId, input.brandKitId, input.productIds.filter((id): id is string => !!id)).then((b) => live && setBrief(b));
    return () => {
      live = false;
    };
    // Reload when the proposal or its approval changes, not on every streamed token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, key, phase.kind]);
  return brief;
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const label = {
    starting: 'Starting',
    researching: 'Researching',
    not_shopify: 'Not supported',
    failed: 'Research failed',
    review: 'Review your brief',
    confirmed: 'Brief approved',
  }[phase.kind];
  const live = phase.kind === 'starting' || phase.kind === 'researching';
  return (
    <span className="ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-zinc-700">
      <span className={`size-1.5 rounded-full ${live ? 'animate-pulse bg-[var(--brand)]' : phase.kind === 'confirmed' ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
      {label}
    </span>
  );
}

function Workspace({ phase, brief, domain, onApproved }: { phase: Phase; brief: BriefData | null; domain: string; onApproved: (a: BriefApproval) => void }) {
  if (phase.kind === 'not_shopify' || phase.kind === 'failed') {
    return (
      <div className="mx-auto mt-24 max-w-md text-center">
        <AlertCircleIcon className="mx-auto size-8 text-amber-500" />
        <h2 className="mt-4 text-lg font-semibold">{phase.kind === 'not_shopify' ? 'We currently support Shopify stores' : 'Research did not finish'}</h2>
        <p className="mt-2 text-sm text-zinc-500">
          {phase.kind === 'not_shopify' ? `${domain} doesn't expose a Shopify catalog.` : phase.message}
        </p>
        <Link href="/" className="mt-6 inline-block rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white">
          Try another store
        </Link>
      </div>
    );
  }

  if ((phase.kind === 'review' || phase.kind === 'confirmed') && brief) {
    if (phase.kind === 'confirmed') return <BriefSummary brief={brief} approval={phase.approval} />;
    return (
      <ReviewCard
        key={phase.confirm.toolCallId}
        brief={brief}
        research={phase.research}
        suggestedGoal={(phase.confirm.input.goal ?? phase.research?.suggestedGoal ?? 'evergreen') as CampaignGoal}
        onApproved={onApproved}
      />
    );
  }

  // Research in flight (or the brief still loading): the live checklist, mirrored large, over
  // the shapes the review card is about to fill.
  const steps = phase.kind === 'researching' ? stepsOf(phase.part) : [];
  const ready = phase.kind === 'review' || phase.kind === 'confirmed';
  return (
    <div className="space-y-10">
      <div className="grid grid-cols-[1fr_320px] items-start gap-10">
        <div>
          <p className="text-sm font-medium text-zinc-500">{ready ? 'Opening your brief' : 'Getting to know the store'}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{domain}</h1>
          <p className="mt-3 max-w-lg text-zinc-600">
            Reading the catalog and the brand, then choosing a best seller, a new drop and something seasonal. This takes about half a minute.
          </p>
        </div>
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <ResearchChecklist steps={steps} size="lg" finished={ready} />
        </div>
      </div>
      <ProductTilesSkeleton />
      <div className="grid grid-cols-2 gap-6">
        <SkeletonBlock className="h-40" />
        <SkeletonBlock className="h-40" />
      </div>
    </div>
  );
}
