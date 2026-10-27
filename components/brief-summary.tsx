'use client';

import { CheckCircle2Icon } from 'lucide-react';
import type { BriefApproval } from '@/lib/agent';
import type { BriefData } from '@/lib/brief';
import type { AdTile } from '@/app/actions';
import { AdGrid } from '@/components/ad-grid';

// After Generate: the approved brief and the live grid. Until the agent has queued the round,
// the slots are honest placeholders labeled by product, not fake ads.
export function BriefSummary({ brief, approval, tiles }: { brief: BriefData; approval: BriefApproval; tiles: AdTile[] }) {
  const products = approval.products.map((p) => brief.products.find((b) => b.id === p.id) ?? { ...p, imageUrl: null });
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <CheckCircle2Icon className="size-5 text-emerald-600" />
        <div>
          <h2 className="text-lg font-semibold">Brief approved</h2>
          <p className="text-sm text-zinc-500">
            {approval.shortName} · {approval.goal} · claims from {approval.claimTopics.length} topics
          </p>
        </div>
      </div>

      <AdGrid
        campaignId={brief.campaignId}
        initial={tiles}
        placeholders={
          <div className="grid grid-cols-3 gap-5 xl:grid-cols-6">
        {products.flatMap((p) =>
          [1, 2].map((n) => (
            <div key={`${p.id}-${n}`} className="relative aspect-[9/16] overflow-hidden rounded-2xl border border-dashed border-zinc-300 bg-zinc-50">
              {p.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- the product photo the ad will use
                <img src={p.imageUrl} alt="" className="absolute inset-0 size-full object-cover opacity-25 grayscale" />
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/90 to-transparent p-3 pt-10">
                <p className="truncate text-xs font-medium text-zinc-800">{p.title}</p>
                <p className="text-[11px] text-zinc-500">Angle {n} · writing copy…</p>
              </div>
            </div>
          )),
        )}
      </div>
        }
      />

    </div>
  );
}
