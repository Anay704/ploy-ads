'use client';

import { useEffect, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import { listSwapCandidates } from '@/app/actions';
import type { BriefProduct } from '@/lib/brief';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkeletonBlock } from '@/components/workspace-skeleton';

// The rest of the catalog, by rank, for replacing one of the 3 picks.
export function SwapDialog({
  open,
  brandKitId,
  exclude,
  onClose,
  onPick,
}: {
  open: boolean;
  brandKitId: string;
  exclude: string[];
  onClose: () => void;
  onPick: (p: BriefProduct) => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<BriefProduct[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    // Debounced so typing doesn't fire a request per keystroke.
    const t = setTimeout(() => listSwapCandidates(brandKitId, query).then((r) => live && setItems(r)), query ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, query, brandKitId]);

  const shown = items?.filter((p) => !exclude.includes(p.id));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Swap a product</DialogTitle>
          <DialogDescription>Available products, best ranked first. Clearance comes last.</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 rounded-lg border px-3">
          <SearchIcon className="size-4 text-zinc-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" className="h-10 w-full bg-transparent text-sm outline-none" autoFocus />
        </label>
        <div className="grid max-h-[60vh] grid-cols-4 gap-3 overflow-y-auto pr-1">
          {!shown
            ? Array.from({ length: 8 }, (_, i) => <SkeletonBlock key={i} className="aspect-[3/4]" />)
            : shown.map((p) => (
                <button key={p.id} type="button" onClick={() => onPick(p)} className="group text-left">
                  <div className="aspect-[3/4] overflow-hidden rounded-xl bg-zinc-100">
                    {p.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element -- CDN thumbnail, already 480px wide
                      <img src={p.imageUrl} alt={p.title} loading="lazy" className="size-full object-cover transition group-hover:scale-[1.03]" />
                    )}
                  </div>
                  <p className="mt-1.5 truncate text-sm font-medium">{p.title}</p>
                  <p className="text-xs text-zinc-500">
                    ${p.price.toFixed(2)}
                    {p.clearance ? ' · clearance' : p.tags.includes('new') ? ' · new' : p.tags.includes('best seller') ? ' · best seller' : ''}
                  </p>
                </button>
              ))}
          {shown && !shown.length && <p className="col-span-4 py-10 text-center text-sm text-zinc-500">No products match “{query}”.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
