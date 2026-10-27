'use client';

import { useEffect, useState } from 'react';
import { PlusIcon, ScaleIcon } from 'lucide-react';
import { createRule, getRules, toggleRule } from '@/app/actions';
import type { Rule } from '@/lib/manage';

/**
 * Campaign rules (PLAN.md §6): they apply to every later generation, and can be switched off.
 * `refreshKey` changes when the chat does, so a rule the agent added appears here too.
 */
export function RulesPanel({ campaignId, refreshKey }: { campaignId: string; refreshKey: number }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRules(campaignId).then(setRules);
  }, [campaignId, refreshKey]);

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <ScaleIcon className="size-4 text-zinc-500" />
        <h3 className="text-sm font-semibold">Rules for every ad</h3>
        <p className="text-xs text-zinc-500">Apply to every ad generated from now on. Existing ads stay as they are.</p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {rules.map((r) => (
          <li key={r.id}>
            <label className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${r.active ? 'border-zinc-300 bg-zinc-50' : 'border-dashed text-zinc-400'}`}>
              <input
                type="checkbox"
                checked={r.active}
                onChange={(e) => {
                  const active = e.target.checked;
                  setRules(rules.map((x) => (x.id === r.id ? { ...x, active } : x)));
                  void toggleRule(r.id, active);
                }}
                className="accent-zinc-900"
              />
              <span className={r.active ? '' : 'line-through'}>{r.text}</span>
            </label>
          </li>
        ))}
        {!rules.length && <li className="text-sm text-zinc-400">No rules yet. Try “never use dark backgrounds”.</li>}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          createRule(campaignId, text)
            .then((r) => {
              if (r.error) setError(r.error);
              else if (r.rule) {
                setRules([...rules, r.rule]);
                setText('');
              }
            })
            .finally(() => setPending(false));
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a rule, e.g. always show the finger loop"
          className="flex-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
        />
        <button type="submit" disabled={pending || !text.trim()} className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white disabled:opacity-50">
          <PlusIcon className="size-3.5" /> {pending ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
