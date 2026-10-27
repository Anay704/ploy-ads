import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import type { AgentUIMessage } from '@/lib/agent';
import { BUCKET, supabaseServer } from '@/lib/supabase/server';
import type { BrandColors } from '@/lib/theme';
import { loadBrief } from '@/app/actions';
import { CampaignApp } from '@/components/campaign-app';
import { phaseOf } from '@/components/campaign-state';
import { WorkspaceSkeleton } from '@/components/workspace-skeleton';

// Server actions started from this page (Generate now, Retry and edit copy in M4) share the
// route's budget (PLAN.md §2).
export const maxDuration = 300;

// Screen 2 (PLAN.md §1). The campaign is read at request time, so it streams in behind a
// Suspense boundary (Cache Components) while the shell renders immediately.
export default function CampaignPage({ params }: { params: Promise<{ campaignId: string }> }) {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <Campaign params={params} />
    </Suspense>
  );
}

async function Campaign({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) notFound();

  const db = supabaseServer();
  const { data: campaign } = await db
    .from('campaigns')
    .select('id, status, source_url, chat, brand_kits(domain, name, short_name, colors, status, logo:assets!brand_kits_logo_asset_id_fkey(storage_path))')
    .eq('id', campaignId)
    .maybeSingle();
  if (!campaign?.brand_kits) notFound();

  const kit = campaign.brand_kits;
  const messages = (campaign.chat ?? []) as unknown as AgentUIMessage[];
  // A reload past research renders the review card (or the approved brief) straight away
  // instead of loading it after hydration.
  const phase = phaseOf(messages);
  const proposal = phase.kind === 'review' || phase.kind === 'confirmed' ? phase.confirm.input : null;
  const initialBrief =
    proposal?.brandKitId && proposal.productIds
      ? await loadBrief(campaign.id, proposal.brandKitId, proposal.productIds.filter((id): id is string => !!id)).catch(() => null)
      : null;
  // Before research finishes the kit has no logo or colors; the workspace starts neutral and
  // takes on the brand once the review card loads it.
  const researched = kit.status !== 'researching';
  return (
    <CampaignApp
      campaignId={campaign.id}
      sourceUrl={campaign.source_url ?? kit.domain}
      domain={kit.domain}
      initialMessages={messages}
      initialBrief={initialBrief}
      initialBrand={{
        name: researched ? (kit.short_name ?? kit.name ?? kit.domain) : kit.domain,
        logoUrl: researched && kit.logo ? db.storage.from(BUCKET).getPublicUrl(kit.logo.storage_path).data.publicUrl : null,
        colors: researched ? ((kit.colors as BrandColors | null) ?? null) : null,
      }}
    />
  );
}
