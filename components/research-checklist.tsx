'use client';

import { CheckIcon } from 'lucide-react';
import type { ProgressStep } from '@/lib/research';
import { Shimmer } from '@/components/ai-elements/shimmer';

// The research steps in the order a marketer thinks about them. Catalog and brand run in
// parallel, so a later row can finish before an earlier one.
const ORDER: ProgressStep['key'][] = ['shopify', 'catalog', 'brand', 'picks', 'photos'];
const PENDING_LABEL: Record<ProgressStep['key'], string> = {
  shopify: 'Check the store runs on Shopify',
  catalog: 'Read the catalog',
  brand: 'Extract the brand',
  picks: 'Pick 3 products to feature',
  photos: 'Save the logo and product photos',
};

export function ResearchChecklist({ steps, size = 'sm', finished = false }: { steps: ProgressStep[]; size?: 'sm' | 'lg'; finished?: boolean }) {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const text = size === 'lg' ? 'text-base' : 'text-sm';
  return (
    <ol className="space-y-2.5">
      {ORDER.map((key) => {
        const step = byKey.get(key);
        const done = finished || step?.status === 'done';
        const active = !done && step?.status === 'active';
        return (
          <li key={key} className={`flex items-start gap-3 ${text}`}>
            <span
              className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border transition-colors ${
                done ? 'border-transparent bg-[var(--brand)] text-[var(--brand-ink)]' : active ? 'border-[var(--brand)]' : 'border-zinc-300'
              }`}
            >
              {done ? <CheckIcon className="size-3" strokeWidth={3} /> : active ? <span className="size-2 animate-ping rounded-full bg-[var(--brand)]" /> : null}
            </span>
            {active ? (
              <Shimmer className={text} duration={1.6}>
                {`${step!.label}…`}
              </Shimmer>
            ) : (
              <span className={done ? 'text-zinc-900' : 'text-zinc-400'}>{step?.label ?? PENDING_LABEL[key]}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
