'use client';

import { useMemo, useState, useTransition } from 'react';
import { ArrowLeftRightIcon, InfoIcon, PlusIcon, SparklesIcon, XIcon } from 'lucide-react';
import { confirmBrief, getBriefProducts } from '@/app/actions';
import { ANGLE_LABEL, planRound } from '@/lib/angles';
import type { BriefApproval } from '@/lib/agent';
import { GOALS, type CampaignGoal } from '@/lib/agent-goals';
import { hasRealDiscount, suggestGoalFor, type BriefData, type BriefProduct } from '@/lib/brief';
import { brandStyle } from '@/lib/theme';
import { SwapDialog } from '@/components/swap-dialog';
import type { ResearchDone } from '@/components/campaign-state';

const SLOT_LABEL: Record<string, string> = {
  best_seller: 'Best seller',
  newest: 'Newest',
  seasonal: 'Seasonal',
  pinned: 'You linked it',
  next_best: 'Top ranked',
  swapped: 'Your pick',
};

const GOAL_COPY: Record<CampaignGoal, { label: string; hint: string }> = {
  seasonal: { label: 'Seasonal', hint: 'Lead with the season and the look.' },
  sale: { label: 'Sale', hint: 'Lead with a real discount.' },
  launch: { label: 'Launch', hint: 'Lead with what is new.' },
  evergreen: { label: 'Evergreen', hint: 'Lead with the product and the brand.' },
};

const price = (n: number) => `$${n.toFixed(2)}`;

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-4 border-t border-zinc-100 px-5 py-6 first:border-t-0 sm:px-8 sm:py-7">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-semibold tracking-wide text-zinc-900 uppercase">{title}</h3>
        {aside && <p className="text-xs text-zinc-500">{aside}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--brand)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--brand)_25%,transparent)]';

function ProductTile({ product, slot, reason, onSwap }: { product: BriefProduct; slot: string; reason: string | null; onSwap: () => void }) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white transition hover:shadow-md">
      <div className="relative aspect-[3/4] overflow-hidden bg-zinc-100">
        {product.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- already sized by Storage/the CDN
          <img src={product.imageUrl} alt={product.title} className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" />
        )}
        <span className="absolute top-3 left-3 rounded-full bg-[var(--brand)] px-2.5 py-1 text-xs font-semibold text-[var(--brand-ink)] shadow-sm">
          {SLOT_LABEL[slot] ?? slot}
        </span>
        <button
          type="button"
          onClick={onSwap}
          className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm backdrop-blur transition hover:bg-white"
        >
          <ArrowLeftRightIcon className="size-3.5" /> Swap
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium text-zinc-900">{product.title}</p>
          <p className="shrink-0 text-sm text-zinc-600">
            {product.compareAtPrice ? (
              <>
                <span className="mr-1 text-zinc-400 line-through">{price(product.compareAtPrice)}</span>
                {price(product.price)}
              </>
            ) : (
              price(product.price)
            )}
          </p>
        </div>
        {reason && <p className="text-xs leading-relaxed text-zinc-500">{reason}</p>}
      </div>
    </div>
  );
}

export function ReviewCard({
  brief,
  research,
  suggestedGoal,
  onApproved,
}: {
  brief: BriefData;
  research?: ResearchDone;
  suggestedGoal: CampaignGoal;
  onApproved: (approval: BriefApproval) => void;
}) {
  const k = brief.brandKit;
  const [shortName, setShortName] = useState(k.shortName);
  const [colors, setColors] = useState(k.colors);
  const [adjectives, setAdjectives] = useState(k.voice.adjectives);
  const [sample, setSample] = useState(k.voice.sample);
  const [valueProp, setValueProp] = useState(k.valueProp);
  const [audience, setAudience] = useState(k.audience);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [products, setProducts] = useState(brief.products);
  const [swappedIds, setSwappedIds] = useState<Set<string>>(new Set());
  // Reasons for products the marketer brought in ("Chosen by you", "Used anyway: …").
  const [ownReasons, setOwnReasons] = useState<Map<string, string>>(new Map());
  const [goal, setGoal] = useState<CampaignGoal>(suggestedGoal);
  // Once the marketer picks a goal, swaps stop re-suggesting it.
  const [goalTouched, setGoalTouched] = useState(false);
  const [usingAnyway, setUsingAnyway] = useState<string | null>(null);
  const [swapIndex, setSwapIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const slotOf = useMemo(() => new Map(research?.recommended.map((r) => [r.productId, r.slot]) ?? []), [research]);
  const saleOk = products.some(hasRealDiscount);
  const adCount = products.length * 2;
  const keptGroups = k.claimGroups.map((g) => ({ ...g, claims: g.claims.filter((c) => !removed.has(c)) })).filter((g) => g.claims.length);
  const recommendedGoal = suggestGoalFor(products);
  // The same planner generateAds uses, so this preview is exactly what Generate makes.
  const plan = planRound(
    products.map((p) => ({ id: p.id, hasDiscount: hasRealDiscount(p), seasonal: !!p.seasonal, bestSeller: p.tags.includes('best seller') })),
    goal,
    keptGroups.map((g) => g.topic),
  );

  const replaceProduct = (index: number, p: BriefProduct, reason: string) => {
    const next = products.map((x, i) => (i === index ? p : x));
    setProducts(next);
    setSwappedIds(new Set([...swappedIds, p.id]));
    setOwnReasons(new Map([...ownReasons, [p.id, reason]]));
    if (!goalTouched || (goal === 'sale' && !next.some(hasRealDiscount))) setGoal(suggestGoalFor(next));
  };

  // "Use anyway" replaces the seasonal pick (or the last product): the override is the
  // marketer's call, so the skipped product takes the seasonal slot it was kept out of.
  const keepAnyway = (skipped: { productId: string; title: string; reason: string }) => {
    setUsingAnyway(skipped.productId);
    getBriefProducts(k.id, [skipped.productId])
      .then(([p]) => {
        if (!p) return;
        const seasonalIndex = products.findIndex((x) => slotOf.get(x.id) === 'seasonal' && !swappedIds.has(x.id));
        replaceProduct(seasonalIndex === -1 ? products.length - 1 : seasonalIndex, p, `Used anyway: ${skipped.reason.split(',')[0]}`);
      })
      .finally(() => setUsingAnyway(null));
  };

  const generate = () => {
    setError(null);
    startTransition(async () => {
      try {
        const approval = await confirmBrief({
          campaignId: brief.campaignId,
          brandKitId: k.id,
          shortName,
          colors,
          voice: { adjectives, sample },
          valueProp,
          audience,
          claimGroups: keptGroups,
          productIds: products.map((p) => p.id),
          goal,
        });
        onApproved(approval);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };

  return (
    // The card previews the edited colors live: its own variables follow the inputs.
    <div style={brandStyle(colors)} className="overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.18)]">
      <header className="flex flex-wrap items-center gap-4 bg-[color-mix(in_oklab,var(--brand)_14%,white)] px-5 py-5 sm:px-8 sm:py-6">
        {k.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the brand's own logo from Storage
          <img src={k.logoUrl} alt={`${k.name} logo`} className="h-9 w-auto max-w-40 object-contain" />
        ) : (
          <span className="text-xl font-semibold">{k.name}</span>
        )}
        <div className="ml-auto text-right">
          <h2 className="text-lg font-semibold text-zinc-900">Review your brief</h2>
          <p className="text-sm text-zinc-600">Everything is editable. Nothing is generated until you say so.</p>
        </div>
      </header>

      <Section title="Products" aside="3 products × 2 angles each">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {products.map((p, i) => (
            <ProductTile
              key={p.id}
              product={p}
              slot={swappedIds.has(p.id) ? 'swapped' : (slotOf.get(p.id) ?? 'next_best')}
              reason={ownReasons.get(p.id) ?? p.reason}
              onSwap={() => setSwapIndex(i)}
            />
          ))}
        </div>
        {(() => {
          const skipped = research?.skipped.filter((s) => !products.some((p) => p.id === s.productId)) ?? [];
          if (!skipped.length) return null;
          return (
            <div className="rounded-xl bg-zinc-50 px-4 py-3 text-xs leading-relaxed text-zinc-600">
              <p className="flex gap-2">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>Left out for timing: {skipped[0].reason}.</span>
              </p>
              <div className="mt-2 flex flex-wrap gap-2 pl-5">
                {skipped.map((s) => (
                  <button
                    key={s.productId}
                    type="button"
                    onClick={() => keepAnyway(s)}
                    disabled={usingAnyway !== null}
                    className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 font-medium text-zinc-700 transition hover:border-zinc-400 disabled:opacity-50"
                  >
                    {s.title}
                    <span className="text-zinc-400">·</span>
                    <span className="text-[var(--brand-text)]">{usingAnyway === s.productId ? 'Adding…' : 'Use anyway'}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="rounded-xl border border-zinc-200 px-4 py-3">
          <p className="mb-2 text-xs font-medium text-zinc-500">The {plan.length} ads Generate will make</p>
          <ul className="space-y-1 text-sm">
            {products.map((p) => (
              <li key={p.id} className="flex gap-2">
                <span className="w-40 shrink-0 truncate font-medium text-zinc-900">{p.title}</span>
                <span className="text-zinc-600">
                  {plan
                    .filter((a) => a.productId === p.id)
                    .map((a) => ANGLE_LABEL[a.angle])
                    .join(' + ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section title="Goal" aside={goal === recommendedGoal ? 'Suggested from the products' : undefined}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Campaign goal">
          {GOALS.map((g) => {
            const disabled = g === 'sale' && !saleOk;
            const selected = goal === g;
            return (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => {
                  setGoal(g);
                  setGoalTouched(true);
                }}
                title={disabled ? 'None of these products has a real discount, so there is nothing true to put on sale.' : undefined}
                className={`rounded-xl border px-3 py-3 text-left transition ${
                  selected ? 'border-[var(--brand)] bg-[color-mix(in_oklab,var(--brand)_12%,white)] ring-1 ring-[var(--brand)]' : 'border-zinc-200 hover:border-zinc-300'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                  {GOAL_COPY[g].label}
                  {g === recommendedGoal && <SparklesIcon className="size-3.5 text-[var(--brand-text)]" />}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-zinc-500">{disabled ? 'No real discounts here' : GOAL_COPY[g].hint}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Brand kit" aside={`From ${k.domain}`}>
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Store name">
                <p className="truncate rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">{k.name}</p>
              </Field>
              <Field label="Name in ads">
                <input value={shortName} onChange={(e) => setShortName(e.target.value)} className={inputClass} maxLength={40} />
              </Field>
            </div>
            <Field label="Colors">
              <div className="flex gap-3">
                {(Object.keys(colors) as (keyof typeof colors)[]).map((key) => (
                  <label key={key} className="group flex flex-col items-center gap-1.5">
                    <span className="relative size-11 overflow-hidden rounded-full border border-zinc-200 shadow-inner" style={{ background: colors[key] }}>
                      <input
                        type="color"
                        value={colors[key]}
                        onChange={(e) => setColors({ ...colors, [key]: e.target.value.toUpperCase() })}
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                        aria-label={`${key} color`}
                      />
                    </span>
                    <span className="text-[11px] text-zinc-500 capitalize">{key}</span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Voice">
              <div className="grid grid-cols-3 gap-2">
                {adjectives.map((a, i) => (
                  <input key={i} value={a} onChange={(e) => setAdjectives(adjectives.map((x, j) => (j === i ? e.target.value : x)))} className={inputClass} />
                ))}
              </div>
              <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={2} className={`${inputClass} mt-2 resize-none italic`} />
            </Field>
          </div>
          <div className="space-y-5">
            <Field label="Value proposition">
              <textarea value={valueProp} onChange={(e) => setValueProp(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
            </Field>
            <Field label="Audience">
              <textarea value={audience} onChange={(e) => setAudience(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
            </Field>
          </div>
        </div>
      </Section>

      <Section title="Claims ads may use" aside="Verbatim from the site. Remove any you don't want; each ad uses one per topic.">
        <div className="space-y-3">
          {k.claimGroups.map((g) => (
            <div key={g.topic} className="flex items-start gap-4">
              <span className="w-20 shrink-0 pt-1.5 text-xs font-medium text-zinc-500 capitalize sm:w-28">{g.topic.replace(/-/g, ' ')}</span>
              <div className="flex flex-wrap gap-2">
                {g.claims.map((c) => {
                  const off = removed.has(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setRemoved((r) => (r.has(c) ? new Set([...r].filter((x) => x !== c)) : new Set([...r, c])))}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${
                        off ? 'border-dashed border-zinc-300 text-zinc-400 line-through' : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-400'
                      }`}
                      aria-pressed={!off}
                      aria-label={`${off ? 'Use' : 'Remove'} claim: ${c}`}
                    >
                      {c}
                      {off ? <PlusIcon className="size-3.5" /> : <XIcon className="size-3.5 text-zinc-400" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <footer className="sticky bottom-0 flex flex-wrap items-center gap-4 border-t border-zinc-100 bg-white/95 px-5 py-4 backdrop-blur sm:px-8 sm:py-5">
        <p className="flex-1 text-sm text-zinc-600">
          <span className="font-medium text-zinc-900">{adCount} ads</span> · {products.length} products × 2 angles · {GOAL_COPY[goal].label}
          {error && <span className="mt-1 block text-red-700">{error}</span>}
        </p>
        <button
          type="button"
          onClick={generate}
          disabled={pending || !shortName.trim() || !keptGroups.length}
          className="inline-flex h-12 items-center gap-2 rounded-xl bg-[var(--brand)] px-6 font-semibold text-[var(--brand-ink)] shadow-sm transition hover:brightness-95 active:scale-[0.99] disabled:opacity-60"
        >
          <SparklesIcon className="size-4" />
          {pending ? 'Saving your brief…' : `Generate ${adCount} ads`}
        </button>
      </footer>

      <SwapDialog
        open={swapIndex !== null}
        brandKitId={k.id}
        exclude={products.map((p) => p.id)}
        onClose={() => setSwapIndex(null)}
        onPick={(p) => {
          if (swapIndex !== null) replaceProduct(swapIndex, p, 'Chosen by you');
          setSwapIndex(null);
        }}
      />
    </div>
  );
}
