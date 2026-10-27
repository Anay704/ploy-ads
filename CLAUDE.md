# CLAUDE.md

AI ads manager slice for the Ploy take-home: a Shopify store URL goes in, and 9:16 interstitial ads come out for the marketer to review, iterate on and approve. **PLAN.md is the spec.** Follow it, and when a decision changes, update PLAN.md in the same change.

## Working rules

- **One milestone at a time** (M0–M7 in PLAN.md §8). When a milestone is done, stop and post:
  1. what changed (files, plus one line each),
  2. how to test it (exact commands and what you should see),
  3. anything skipped or unverified.

  Then wait for the user before starting the next milestone.
- **Explain non-obvious decisions** in one or two sentences, in the milestone summary or a short code comment. The user has to be able to explain every part in review.
- **Never hardcode secrets.** Keys live in `.env.local`, which is never committed. Every variable the code reads is listed in `.env.example` with a placeholder and a one-line comment, updated in the same change that adds the variable.
- **Commit after each milestone**, with a clear message: `M<n>: <what now works>`, plus a short body.
- Use **npm** everywhere (`npm install`, `npm run <script>`, `npx`). Do not use bun, pnpm or yarn.

## Stack (fixed by the brief)

Next.js App Router + React + Tailwind · Vercel AI SDK v7 + AI Elements · Supabase (Postgres, Storage, Realtime; single demo user, no Auth) · fal.ai for images · Firecrawl `branding` for brand research · LLM via Vercel AI Gateway · Vercel hosting.

## Invariants

- Ads only use the store's real product photos. Never an invented product.
- Every fal output is copied to Supabase Storage before a variant leaves `generating`. Never store a fal URL as an asset.
- Only images actually used are copied to Storage, not the catalog.
- The LLM never sees raw `products.json`. It sees slimmed, tag-filtered candidates (PLAN.md §3).
- Ad copy only states claims found verbatim on the site, and only shows real `compare_at_price` discounts (PLAN.md §5).
- The grid, driven by the DB and Realtime, is the source of truth. Chat only reports what happened.
