'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangleIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  HistoryIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  RotateCwIcon,
  TypeIcon,
  XIcon,
} from 'lucide-react';
import {
  approveAd,
  editAdCopy,
  getAdHistory,
  giveAdFeedback,
  listTiles,
  regenerateOneAd,
  rejectAd,
  retryAd,
  sweepCampaign,
  unsetAdStatus,
  type AdTile,
} from '@/app/actions';
import type { VersionInfo } from '@/lib/manage';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
      {/* Three wide columns: big enough to judge an ad and fit its actions on one row. */}
      <div className="grid grid-cols-3 gap-6">
        {tiles.map((t) => (
          <Tile key={t.adId} tile={t} onRetry={() => retryAd(t.variantId).then(refresh)} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function Tile({ tile, onRetry, onChanged }: { tile: AdTile; onRetry: () => void; onChanged: () => void }) {
  const angle = ANGLE_LABEL[tile.angle as Angle] ?? tile.angle;
  const [dialog, setDialog] = useState<'edit' | 'feedback' | 'history' | null>(null);
  const finished = tile.status === 'draft' || tile.status === 'approved' || tile.status === 'rejected';
  const ring = tile.status === 'approved' ? 'ring-2 ring-emerald-500' : tile.status === 'rejected' ? 'opacity-50 grayscale' : '';
  return (
    <figure className="space-y-2">
      <div className={`relative aspect-[9/16] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 shadow-sm transition ${ring}`}>
        {tile.status === 'generating' && <Rendering tile={tile} />}
        {tile.status === 'failed' && <Failed tile={tile} onRetry={onRetry} />}
        {finished && tile.imageUrl && (
          <a href={tile.imageUrl} target="_blank" rel="noreferrer" className="group block size-full">
            {/* eslint-disable-next-line @next/next/no-img-element -- the final render from Storage, already 1080×1920 */}
            <img src={tile.imageUrl} alt={`${tile.product} ad: ${tile.headline}`} className="size-full animate-[reveal_600ms_ease-out] object-cover" />
            <span className="absolute top-2 right-2 rounded-full bg-white/90 p-1.5 opacity-0 shadow-sm transition group-hover:opacity-100">
              <ExternalLinkIcon className="size-3.5" />
            </span>
          </a>
        )}
        {tile.status === 'approved' && (
          <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">
            <CheckIcon className="size-3" /> Approved
          </span>
        )}
      </div>
      <figcaption className="space-y-1.5 px-0.5">
        <div>
          <p className="truncate text-sm font-medium text-zinc-900">{tile.product}</p>
          <p className="text-xs text-zinc-500">
            {angle} · v{tile.version}
            {tile.versions > 1 ? ` of ${tile.versions}` : ''} · {STATUS_LABEL[tile.status]}
          </p>
        </div>
        <TileActions tile={tile} finished={finished} onOpen={setDialog} onChanged={onChanged} />
      </figcaption>
      <AdDialogs tile={tile} open={dialog} onClose={() => setDialog(null)} onChanged={onChanged} />
    </figure>
  );
}

const STATUS_LABEL: Record<AdTile['status'], string> = { generating: 'Rendering', draft: 'Draft', approved: 'Approved', rejected: 'Rejected', failed: 'Failed' };

function ActionButton({ label, onClick, active, disabled, children }: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid size-7 place-items-center rounded-full border transition disabled:opacity-30 ${
        active ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-400 hover:text-zinc-900'
      }`}
    >
      {children}
    </button>
  );
}

function TileActions({ tile, finished, onOpen, onChanged }: { tile: AdTile; finished: boolean; onOpen: (d: 'edit' | 'feedback' | 'history') => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(onChanged).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <ActionButton
        label={tile.status === 'approved' ? 'Unapprove' : 'Approve'}
        active={tile.status === 'approved'}
        disabled={!finished || busy}
        onClick={() => run(() => (tile.status === 'approved' ? unsetAdStatus(tile.variantId) : approveAd(tile.variantId)))}
      >
        <CheckIcon className="size-3.5" />
      </ActionButton>
      <ActionButton
        label={tile.status === 'rejected' ? 'Unreject' : 'Reject'}
        active={tile.status === 'rejected'}
        disabled={!finished || busy}
        onClick={() => run(() => (tile.status === 'rejected' ? unsetAdStatus(tile.variantId) : rejectAd(tile.variantId)))}
      >
        <XIcon className="size-3.5" />
      </ActionButton>
      <ActionButton label="Edit headline and button" disabled={!finished} onClick={() => onOpen('edit')}>
        <TypeIcon className="size-3.5" />
      </ActionButton>
      <ActionButton label="Give feedback on this ad" disabled={!finished} onClick={() => onOpen('feedback')}>
        <MessageSquareIcon className="size-3.5" />
      </ActionButton>
      <ActionButton label="Regenerate" disabled={!finished || busy} onClick={() => run(() => regenerateOneAd(tile.adId))}>
        <RefreshCwIcon className="size-3.5" />
      </ActionButton>
      <ActionButton label="Version history" onClick={() => onOpen('history')}>
        <HistoryIcon className="size-3.5" />
      </ActionButton>
      {tile.status === 'approved' && (
        <a
          href={`/api/download/${tile.variantId}`}
          title="Download"
          aria-label="Download"
          className="grid size-7 place-items-center rounded-full border border-emerald-600 bg-emerald-600 text-white transition hover:bg-emerald-700"
        >
          <DownloadIcon className="size-3.5" />
        </a>
      )}
    </div>
  );
}

function AdDialogs({ tile, open, onClose, onChanged }: { tile: AdTile; open: 'edit' | 'feedback' | 'history' | null; onClose: () => void; onChanged: () => void }) {
  return (
    <>
      <EditCopyDialog tile={tile} open={open === 'edit'} onClose={onClose} onChanged={onChanged} />
      <FeedbackDialog tile={tile} open={open === 'feedback'} onClose={onClose} onChanged={onChanged} />
      <VersionDrawer tile={tile} open={open === 'history'} onClose={onClose} />
    </>
  );
}

const field = 'w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-500';

function EditCopyDialog({ tile, open, onClose, onChanged }: { tile: AdTile; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [headline, setHeadline] = useState(tile.headline);
  const [cta, setCta] = useState(tile.cta);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit the words</DialogTitle>
          <DialogDescription>Only the text changes. The image is re-rendered from this version with everything else kept as it is.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            editAdCopy(tile.adId, headline, cta)
              .then((r) => {
                if (r.error) setError(r.error);
                else {
                  onChanged();
                  onClose();
                }
              })
              .finally(() => setPending(false));
          }}
        >
          <label className="block space-y-1 text-xs font-medium text-zinc-500">
            Headline
            <input value={headline} onChange={(e) => setHeadline(e.target.value)} className={field} maxLength={80} />
          </label>
          <label className="block space-y-1 text-xs font-medium text-zinc-500">
            Button
            <input value={cta} onChange={(e) => setCta(e.target.value)} className={field} maxLength={30} />
          </label>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button type="submit" disabled={pending} className="w-full rounded-lg bg-zinc-900 py-2 text-sm font-medium text-white disabled:opacity-60">
            {pending ? 'Starting…' : `Make v${tile.versions + 1}`}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FeedbackDialog({ tile, open, onClose, onChanged }: { tile: AdTile; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Feedback on this ad</DialogTitle>
          <DialogDescription>Only this ad changes. Later versions of it keep honoring the note. For every ad, add a rule above the grid instead.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            giveAdFeedback(tile.adId, text)
              .then((r) => {
                if (r.error) setError(r.error);
                else {
                  setText('');
                  onChanged();
                  onClose();
                }
              })
              .finally(() => setPending(false));
          }}
        >
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="e.g. warmer lighting" className={`${field} resize-none`} autoFocus />
          <div className="flex flex-wrap gap-1.5">
            {['Warmer lighting', 'Brighter background', 'Show more of the loop', 'Less busy scene'].map((s) => (
              <button key={s} type="button" onClick={() => setText(s)} className="rounded-full border px-2.5 py-1 text-xs text-zinc-600 hover:border-zinc-400">
                {s}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button type="submit" disabled={pending || !text.trim()} className="w-full rounded-lg bg-zinc-900 py-2 text-sm font-medium text-white disabled:opacity-60">
            {pending ? 'Starting…' : `Make v${tile.versions + 1}`}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VersionDrawer({ tile, open, onClose }: { tile: AdTile; open: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  useEffect(() => {
    if (open) getAdHistory(tile.adId).then(setVersions);
  }, [open, tile.adId, tile.variantId, tile.status]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {tile.product} · {ANGLE_LABEL[tile.angle as Angle] ?? tile.angle}
          </DialogTitle>
          <DialogDescription>Every version of this ad, and what produced it.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-4 overflow-x-auto pb-2">
          {(versions ?? []).map((v) => (
            <div key={v.id} className="w-56 shrink-0 space-y-2">
              <div className="aspect-[9/16] overflow-hidden rounded-xl border bg-zinc-100">
                {v.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a stored render
                  <img src={v.imageUrl} alt={`v${v.version}`} className="size-full object-cover" />
                ) : (
                  <div className="grid size-full place-items-center text-xs text-zinc-500">{STATUS_LABEL[v.status]}</div>
                )}
              </div>
              <p className="text-sm font-semibold">
                v{v.version} <span className="font-normal text-zinc-500">· {STATUS_LABEL[v.status]}</span>
              </p>
              <p className="text-xs leading-snug text-zinc-700">{v.origin}</p>
              <details className="text-[11px] text-zinc-500">
                <summary className="cursor-pointer">Prompt</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-50 p-2">{v.prompt}</pre>
              </details>
            </div>
          ))}
          {!versions && <p className="text-sm text-zinc-500">Loading…</p>}
        </div>
      </DialogContent>
    </Dialog>
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
      {tile.previousImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- the previous version, while the next one renders
        <img src={tile.previousImageUrl} alt="" className="absolute inset-0 size-full object-cover opacity-50" />
      ) : (
        tile.photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- the product photo this ad is built from
          <img src={tile.photoUrl} alt="" className="absolute inset-0 size-full scale-110 object-cover opacity-40 blur-md" />
        )
      )}
      <div className="absolute inset-0 animate-pulse bg-[color-mix(in_oklab,var(--brand)_18%,transparent)]" />
      <div className="absolute inset-x-0 top-0 p-3">
        <p className="line-clamp-3 text-sm font-semibold leading-snug text-zinc-900">“{tile.headline}”</p>
      </div>
      <div className="absolute inset-x-0 bottom-0 space-y-0.5 p-3">
        <Shimmer className="text-xs font-medium">{tile.versions > 1 ? `Rendering v${tile.version}…` : 'Rendering…'}</Shimmer>
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
