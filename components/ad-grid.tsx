'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangleIcon, ExternalLinkIcon, RotateCwIcon } from 'lucide-react';
import { listTiles, retryAd, sweepCampaign, type AdTile } from '@/app/actions';
import { ANGLE_LABEL, type Angle } from '@/lib/angles';
import { supabaseBrowser } from '@/lib/supabase/client';
import { Shimmer } from '@/components/ai-elements/shimmer';

const STUCK_MS = 5 * 60 * 1000;

/**
 * The grid (PLAN.md §2): tiles fill in as each render finishes, whatever the chat is doing.
 * Realtime readiness (PLAN.md §4, found in M1): wait for the postgres_changes system message,
 * then fetch, then refetch on every change, so a render that finished in between still shows.
 */
export function AdGrid({ campaignId, initial, placeholders }: { campaignId: string; initial: AdTile[]; placeholders: React.ReactNode }) {
  const [tiles, setTiles] = useState(initial);
  const [live, setLive] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    // Several rows change at once when a round starts; one fetch covers them.
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => listTiles(campaignId).then(setTiles), 150);
  }, [campaignId]);

  useEffect(() => {
    const db = supabaseBrowser();
    const channel = db
      .channel(`grid-${campaignId}`)
      .on('system', {}, (msg: { extension?: string; status?: string }) => {
        if (msg.extension === 'postgres_changes' && msg.status === 'ok') {
          setLive(true);
          refresh();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ad_variants', filter: `campaign_id=eq.${campaignId}` }, refresh)
      .subscribe();
    return () => {
      void db.removeChannel(channel);
    };
  }, [campaignId, refresh]);

  // The stuck rule's client half: a tile rendering for 5 minutes asks the server to sweep.
  useEffect(() => {
    const t = setInterval(() => {
      const stuck = tiles.some((x) => x.status === 'generating' && Date.now() - Date.parse(x.startedAt) > STUCK_MS);
      if (stuck) sweepCampaign(campaignId).then(refresh);
    }, 20_000);
    return () => clearInterval(t);
  }, [tiles, campaignId, refresh]);

  if (!tiles.length) return <>{placeholders}</>;

  const done = tiles.filter((t) => t.status !== 'generating').length;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm text-zinc-500">
        <span className="font-medium text-zinc-900">
          {done} of {tiles.length} ready
        </span>
        <span className={`inline-flex items-center gap-1.5 text-xs ${live ? 'text-emerald-700' : 'text-zinc-400'}`}>
          <span className={`size-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
          {live ? 'Live' : 'Connecting'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-5 xl:grid-cols-6">
        {tiles.map((t) => (
          <Tile key={t.variantId} tile={t} onRetry={() => retryAd(t.variantId).then(refresh)} />
        ))}
      </div>
    </div>
  );
}

function Tile({ tile, onRetry }: { tile: AdTile; onRetry: () => void }) {
  const angle = ANGLE_LABEL[tile.angle as Angle] ?? tile.angle;
  return (
    <figure className="space-y-2">
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 shadow-sm">
        {tile.status === 'generating' && <Rendering tile={tile} />}
        {tile.status === 'failed' && <Failed tile={tile} onRetry={onRetry} />}
        {tile.status !== 'generating' && tile.status !== 'failed' && tile.imageUrl && (
          <a href={tile.imageUrl} target="_blank" rel="noreferrer" className="group block size-full">
            {/* eslint-disable-next-line @next/next/no-img-element -- the final render from Storage, already 1080×1920 */}
            <img src={tile.imageUrl} alt={`${tile.product} ad: ${tile.headline}`} className="size-full animate-[reveal_600ms_ease-out] object-cover" />
            <span className="absolute top-2 right-2 rounded-full bg-white/90 p-1.5 opacity-0 shadow-sm transition group-hover:opacity-100">
              <ExternalLinkIcon className="size-3.5" />
            </span>
          </a>
        )}
      </div>
      <figcaption className="px-0.5">
        <p className="truncate text-sm font-medium text-zinc-900">{tile.product}</p>
        <p className="text-xs text-zinc-500">
          {angle} · v{tile.version} · {tile.status === 'draft' ? 'Draft' : tile.status === 'generating' ? 'Rendering' : tile.status === 'failed' ? 'Failed' : tile.status}
        </p>
      </figcaption>
    </figure>
  );
}

function Rendering({ tile }: { tile: AdTile }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - Date.parse(tile.startedAt)) / 1000));
  return (
    <>
      {tile.photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- the product photo this ad is built from
        <img src={tile.photoUrl} alt="" className="absolute inset-0 size-full scale-110 object-cover opacity-40 blur-md" />
      )}
      <div className="absolute inset-0 animate-pulse bg-[color-mix(in_oklab,var(--brand)_18%,transparent)]" />
      <div className="absolute inset-x-0 top-0 p-3">
        <p className="line-clamp-3 text-sm font-semibold leading-snug text-zinc-900">“{tile.headline}”</p>
      </div>
      <div className="absolute inset-x-0 bottom-0 space-y-0.5 p-3">
        <Shimmer className="text-xs font-medium">Rendering…</Shimmer>
        <p className="text-[11px] text-zinc-600">{secs}s</p>
      </div>
    </>
  );
}

function Failed({ tile, onRetry }: { tile: AdTile; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const reason = (tile.error ?? 'unknown error').replace(/^text_check: /, 'Text check: ').replace(/^render failed: /, 'Render failed: ');
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 bg-zinc-50 p-4 text-center">
      <AlertTriangleIcon className="size-5 text-amber-500" />
      <p className="text-xs leading-snug text-zinc-600">{tile.error === 'timeout' ? 'Took too long to render.' : reason}</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onRetry();
        }}
        className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
      >
        <RotateCwIcon className={`size-3.5 ${busy ? 'animate-spin' : ''}`} /> Retry
      </button>
    </div>
  );
}
