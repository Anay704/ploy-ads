import { StartForm } from '@/components/start-form';

// Screen 1 (PLAN.md §1): one input. Everything else happens in the workspace.
export default function Home() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,_#fdf2f8_0%,_#ffffff_55%)]">
      <header className="mx-auto flex w-full max-w-5xl items-center gap-2 px-6 py-6">
        <span className="size-2.5 rounded-full bg-zinc-900" />
        <span className="font-semibold tracking-tight">Ploy Ads</span>
      </header>

      <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 pb-24">
        <p className="mb-4 text-sm font-medium text-zinc-500">AI ads manager for Shopify stores</p>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-zinc-900 sm:text-5xl">
          From store link to
          <br />
          ads worth running.
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-zinc-600">
          Paste a store or product link. Ploy reads the catalog and the brand, picks what to feature, and drafts 9:16 interstitial ads from your
          real product photos for you to review.
        </p>

        <StartForm />

        <ol className="mt-14 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          {[
            ['Research', 'Catalog, logo, colors, voice and only the claims your site makes.'],
            ['Review', 'One card to check the brand kit, the 3 products and the goal.'],
            ['Generate', 'Six ads to approve, tweak by chat, or regenerate.'],
          ].map(([title, body], i) => (
            <li key={title} className="rounded-2xl border border-zinc-200/80 bg-white/70 p-4 backdrop-blur">
              <p className="font-medium text-zinc-900">
                <span className="mr-2 text-zinc-400">{i + 1}</span>
                {title}
              </p>
              <p className="mt-1 leading-relaxed text-zinc-500">{body}</p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
