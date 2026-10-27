'use client';

import { useActionState, useRef, useState } from 'react';
import { flushSync, useFormStatus } from 'react-dom';
import { ArrowRightIcon, StoreIcon } from 'lucide-react';
import { startResearch, type StartState } from '@/app/actions';
import { Shimmer } from '@/components/ai-elements/shimmer';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-12 shrink-0 items-center gap-2 rounded-xl bg-zinc-900 px-5 font-medium text-white transition hover:bg-zinc-700 disabled:cursor-wait disabled:bg-zinc-700"
    >
      {pending ? (
        <Shimmer className="[--color-muted-foreground:#ffffff] [--color-background:#71717a]">Checking store…</Shimmer>
      ) : (
        <>
          Start <ArrowRightIcon className="size-4" />
        </>
      )}
    </button>
  );
}

export function StartForm() {
  const [state, action] = useActionState<StartState, FormData>(startResearch, {});
  const [url, setUrl] = useState(state.url ?? '');
  const form = useRef<HTMLFormElement>(null);

  // The example starts research in one click: the value is committed to the input before the
  // form submits, so the action receives it.
  const tryExample = () => {
    flushSync(() => setUrl('loopycases.com'));
    form.current?.requestSubmit();
  };

  return (
    <form ref={form} action={action} className="mt-10">
      <div className="flex gap-2 rounded-2xl border border-zinc-200 bg-white p-2 shadow-[0_8px_30px_rgb(0,0,0,0.06)] focus-within:border-zinc-400">
        <label className="flex flex-1 items-center gap-3 pl-3">
          <StoreIcon className="size-5 shrink-0 text-zinc-400" />
          <span className="sr-only">Store or product URL</span>
          <input
            name="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste your store or product URL"
            autoComplete="url"
            autoFocus
            className="h-12 w-full bg-transparent text-base outline-none placeholder:text-zinc-400"
          />
        </label>
        <Submit />
      </div>

      {state.error ? (
        <p role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {state.error}
        </p>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">
          Try{' '}
          <button type="button" onClick={tryExample} className="font-medium text-zinc-700 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-700">
            loopycases.com
          </button>
        </p>
      )}
    </form>
  );
}
