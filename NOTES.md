# NOTES

Decisions made while building, with the evidence behind each. PLAN.md is the spec. This file records why it ended up the way it did.

## M0: image model bake-off (2026-10-26)

**Decision: Nano Banana Pro edit (`fal-ai/nano-banana-pro/edit`), set in `lib/generate.ts`.**

**Setup.** 3 models × 2 inputs × 2 runs = 12 renders, same prompt (`lib/prompt.ts`) and copy ("Style you can hold onto" / "Shop Now"), all run in parallel. 12/12 succeeded for about $0.98 at the list prices in PLAN.md (not checked against fal billing).
- **A.** Black Bows hero: a white case with a black bow print, held in a hand.
- **B.** Lavender Pearl studio cutout: an iridescent pink-lilac-blue gradient with studded lens bezels.

Each render was compared at full size against its source photo. The logo zone was checked against a drawn 12% line, not eyeballed. Per-output reasons are in `bakeoff/scores.json`. Run `npm run bakeoff -- --html` to rebuild the grid.

| Model | Min fidelity A / B | Text | Layout | Latency | $/image | Total /28 |
|---|---|---|---|---|---|---|
| Nano Banana 2.1 | **1 / 1** (fails gate) | 8/8 | 6/8 | 23–26s | $0.06 | 23 |
| Nano Banana Pro | 2 / 2 | 6/8 | 5/8 | 26–49s | $0.15 | 20 |
| Seedream 5.0 Lite | 2 / 2 | 8/8 | 2/8 | 44–52s | $0.035 | 20 |

**Why Pro.**
- **Fidelity is the gate.** An ad showing a slightly wrong product is worse than no ad, because it misrepresents what the customer would receive. Nano Banana 2.1 had the highest raw total but changed the product in half its renders: a grey loop instead of charcoal, a rainbow sheen instead of the pink-lilac-blue gradient, and plain lens rings instead of studded bezels. That's disqualifying.
- **Breaking the Pro vs Seedream tie.** Both passed the gate and scored 20. They fail in different ways:
  - Pro failed once, by rendering the headline twice. That's a single, detectable error.
  - Seedream's problems are systematic. Its fidelity came mostly from pasting the source photo (one render is a framed photo with stickers, soft and upscaled), it invented bottom ports in one render, and it put the headline in the logo zone in 3 of 4 renders, once as a near-invisible outline.
  - A detectable one-off can be caught and retried. A systematic layout habit can't.
- **Cost is not a factor that matters here.** Pro is $0.09 more per image than 2.1. That's $0.90 for a 6-ad round and at most $6 at the 40-variant campaign cap.
- **Latency fits.** Pro's slowest run was 49s, and even with one retry plus text checks a variant stays well inside the 300s `after()` budget.

**Not built: the composite fallback.** A model passed the fidelity gate, so overlaying the untouched photo isn't needed. It stays documented in PLAN.md §5 in case M4 sees drift on other products.

**What the bake-off changed in the plan.**
1. **The vision text check is core, not stretch.** 1 doubled headline in 4 Pro runs is a small sample, but a marketer would never run that ad, and nothing else in the pipeline would catch it. Every render is now checked by Claude Haiku 5.5: the headline and CTA must each appear exactly once, with no other legible text. On a mismatch the variant retries once, then becomes `failed` with the reason (PLAN.md §5).
2. **The logo safe zone needs a verified fix.** 6 of 12 renders, across all three models, put the headline inside the top 12%. M4 strengthens the wording and re-runs 2 Pro renders against the same 12% line. If either still crosses it, the logo moves to the bottom strip above the CTA instead of fighting the model (PLAN.md §5).

**Smaller findings, now in PLAN.md.**
- **GIF images.** Shopify's CDN ignores `format=jpg` for GIFs and returns the GIF, while `format=png` does flatten it. `width=1080` never upscales: the GIF cutouts stay 720×960.
- **Seedream's native minimum is 2560×1440 pixels**, so it was run at 1440×2560 rather than 1152×2048.
- **Pro returns 1536×2752**, slightly taller than 9:16. The post-process crops about 21px of height before resizing to 1080×1920.
- **Bake-off colors are stand-ins.** The palette (`#F88A8A`, `#8FE8B3`) is the most-used colors in the site's CSS, standing in until M2's brand kit.
- **Props carry pseudo-text.** Both Nano Banana models drew illegible pseudo-lettering on props such as cosmetics labels and a notebook. The text check ignores illegible marks and fails only on legible extra words.

**Reviewer observations (Anay, from bakeoff.html).**
- **Pro run 1 on Black Bows is the best ad of the set.** The bow pattern, the charcoal loop and the small "p" mark on the case all match the source, and it reads as a real lifestyle photo, not a template. This is the bar M4 renders are held to.
- **Pro run 2 fails on more than text.** Beyond the doubled headline, the whole layout is a stock template with color bands, and it would feel cheap even with the text fixed. The text check catches the doubled headline. It does not catch template-looking layouts, so that stays a prompt problem (below).
- **Seedream run 2 on Black Bows looks like the photo was pasted onto a sticker collage.** A marketer would not run it. This backs the tie-break: Seedream's fidelity came from pasting, not compositing.
- **The scenes are repetitive.** Almost every render is the same pink and mint flat-lay with lipsticks and makeup brushes, and a round of 6 like that would feel like one ad six times. Two causes are in the bake-off's own setup:
  - All 12 renders used the `aesthetic` angle, so every prompt carried the same scene line.
  - The prompt's `Palette:` line sits inside SCENE, which reads as "make the scene pink and mint".

  M4 gives each angle a clearly different scene direction and limits the palette to text, button and accents (PLAN.md §5, "Scene variety").

## M1: data layer (2026-10-27)

- **Demo data is world-readable, on purpose.** RLS allows reads where `owner_id is null`, and the publishable key ships in the browser bundle, so anyone with the deployed URL can read every brand kit, campaign (including its saved chat) and ad. That's acceptable for a single-user demo with no accounts: the data is a public store's catalog and brand plus the ads made from it, and writes are blocked for that key. The `ads` bucket is public-read anyway. Adding Auth means:
  - populating `owner_id` on `brand_kits` and `campaigns`, and dropping the `owner_id is null` clause, so child tables follow automatically through their `exists` policies;
  - changing `brand_kits.domain unique` to `unique (owner_id, domain)`, because two users may research the same store;
  - making the bucket private and serving signed URLs.

## M2: research (2026-10-27)

**LLM provider: Anthropic directly, not the Vercel AI Gateway.** The brief recommends the gateway but allows any provider ("Any provider (Vercel AI Gateway recommended)").
- **What happened on the gateway:**
  - It first refused every call until the Vercel account had a card on file.
  - With a card, its free tier still blocked every Claude model (Haiku 5.5, Sonnet 5, Sonnet 5.5, Opus 5) and the newer Gemini models. Only older models such as `openai/gpt-5-mini` responded.
- **Why direct Anthropic:** we already have Anthropic credit. Calling it directly keeps Claude Sonnet 5.5, which was picked for tool use in the M3 agent, at no extra cost, instead of paying for gateway credits or downgrading the model.
- **How it's wired:** all LLM calls go through `llm()` in `lib/llm.ts` (`@ai-sdk/anthropic`), with the model id in `LLM_MODEL` (default `claude-sonnet-5-5`). Moving back to the gateway is one line there plus a gateway id in `LLM_MODEL`.
- **What we give up:** the gateway's single key for switching to other providers, and its usage dashboard.

**Firecrawl scrapes are cached per domain.** Three research runs that failed later, at the LLM step, each spent a Firecrawl scrape.
- **When it's saved:** a successful scrape (branding plus page markdown) is written to `brand_kits.raw.firecrawl` as soon as it returns, before anything else can fail.
- **When it's reused:** for 7 days. Failed or skipped scrapes are never cached.
- **Forcing a fresh scrape:** `npm run research -- <url> --fresh` scrapes again.
- **Proof:** the free-tier failure above left a saved 30,715-character scrape behind.

**Review of the first real run (2026-10-27), and what changed.**
- **The picks are a mix, not the top 3 of one ranking.** The first run picked three 2025 best sellers and skipped the 11 new drops.
  - **New rule:** one best seller, one of the newest, and one fresh seasonal product. Seasons come from Loopy's own "Fall Favorites" collection.
  - **Holiday cutoff:** products themed on a holiday under 14 days away are skipped (five Halloween designs on Oct 27), because a campaign needs time to ramp.
  - **Clearance last:** `last call` stock never leads, even on sale.
  - **Goal rule:** seasonal if the seasonal pick is in play; sale only for a real, non-clearance discount; otherwise evergreen.
  - **Result:** Cocoa Checkered (best seller), Raspberry Dots (newest), Night Sky (fall), goal seasonal.
- **Short name for ads.** `short_name` ("Loopy") is derived in code from the exact store name ("Loopy®Cases"), which is kept for display. Both are editable in the review card.
- **Near-duplicate claims are grouped** by a topic the LLM labels (warranty, returns, reviews…). M4 uses one claim per group per ad and spreads groups across a round.
- **Fonts are left as Firecrawl reports them** (Roboto). The theme also loads Exo2, but the prompt asks for a bold rounded sans anyway.
- **Claims vary between runs, and that's accepted.** The LLM picks different wordings each time, and the verbatim check makes every kept claim safe, not stable. Stability comes from the workflow instead: the brand kit the marketer confirms on the review card is saved and reused for every later generation, and research isn't rerun per ad.

## M3: agent and review card (2026-10-27)

- **The campaign row is created when research starts, not on Generate.** PLAN first had `confirmBrief` create it. But the chat has to be saved somewhere while research streams, or a reload mid-research loses everything. Migration 0003 adds `campaigns.status` (`briefing` → `active`) and `source_url`, and makes `goal` nullable until the brief is confirmed. A check constraint keeps an active campaign from missing its goal or products.
- **The database decides what the brief is, not the model.**
  - **Minimal tool input:** `confirmBrief`'s input is only `{ brandKitId, productIds, goal }`. The review card loads the brand kit and products itself, so the model can't change a claim, price or color by restating it.
  - **Claims can't be invented in the card:** the marketer can remove claims but not type new ones. The server action rejects any claim not in the verified list, which keeps the "claims verbatim from the site" invariant through the human step.
  - **Approvals are checked:** the chat route refuses (409) a client message that claims an approval while the campaign isn't `active`. A tampered client can't skip the pause.
- **Chat persistence.**
  - **What travels:** the client sends only its newest message. The server holds the conversation in `campaigns.chat`.
  - **Tool outputs replace by ID:** a tool output arrives as an update to the last assistant message, not a new message, so the server replaces by message ID instead of appending.
  - **When it's saved:** the chat is saved before streaming, so a reload mid-research doesn't start research twice, and again in `onEnd`. `consumeStream()` lets research finish and save even if the tab closes.
- **Research progress is preliminary tool results.** `researchStore.execute` is an async generator. Each progress event from `research()` is yielded, and the UI renders the latest as a live checklist. Only the final yield (a compact summary and the 20 one-line candidates) goes to the model.
- **The auto-start needed a React-specific fix.** React's development double-mount sent the first message from a chat instance that was then discarded, and a ref guard blocked the surviving one, so research never started. The send is now scheduled in the effect and cleared in its cleanup, so exactly one mount sends it.
- **Bugs found by running it in the browser, all fixed:**
  - **Swapped photos failed to copy:** `ensureProductImage` treated "no existing asset" as an error, so every first-time copy failed.
  - **Errors were hidden:** tool errors showed only the SDK's generic "An error occurred." Ours are now shown.
  - **Wrong font:** shadcn's init wrote a self-referencing `--font-sans`, so the app fell back to a serif.
  - **Slow reload:** a reload took a few seconds to show the brief, so the page now loads it on the server.
- **Design.**
  - **Brand colors throughout:** the workspace takes the brand's colors as CSS variables once research is done, and button text is picked for contrast (Loopy's pink needs dark text, not white).
  - **Loading never shows a blank screen:** research shows a live checklist over skeletons shaped like the card.
  - **Sale can't be chosen falsely:** it's disabled when no product has a real, non-clearance discount, because there would be nothing true to put on sale.
  - **Screenshots:** in `docs/screenshots/m3-*.jpg`.
- **Testing used the local Supabase stack.** Pushing migration 0003 to the hosted project was blocked by the session's permission rules, so `npm run dev:local` points the app at the local stack (`scripts/dev-local.sh`). The hosted project needs `npx supabase db push` before `npm run dev` works against it.

## M4: generation (2026-10-27)

**Brief fixes from your review.**
- **Marketer-worded reasons:** "One of your 4 best sellers", "Your newest drop (Oct 8)", "From your Fall Favorites collection". The date is read as the store wrote it; converting to UTC had shown Oct 9.
- **"Use anyway" on skipped holiday products.**
- **A per-product angle preview from the real planner.**
- **Suggestion chips that steer the brief through the agent** (`reviseBrief`, then a new `confirmBrief`).
- **A distinct accent color:** derived by deepening the primary, since Loopy's other candidates were neutrals.
- **One-click "Try loopycases.com".**
- **A goal that re-suggests after a swap** until the marketer picks one.
- **Claim chips that announce the claim text** (already in place since M3).

**Logo layout.** The strengthened top safe zone failed twice over (the headline still crossed it, and the model painted solid bars), so the logo is now a badge beside the CTA, placed by detecting where the button actually is. See PLAN.md §5.

**What the real Loopy rounds found, all fixed and tested.** Three rounds on the hosted project.
1. **Every job died immediately.** `ad_variants` and `ads` are joined by two foreign keys, so the embed was ambiguous. Fixed by naming the key.
2. **The text check failed headlines set on 3 lines.** It only joined 2. Fixed to join runs of up to 4.
3. **An open book in a scene put a page number in the ad.** The text check was right to fail it. The scene now has no printed props.
4. **Copy fell back to aesthetic too often.** The model kept writing 7-word headlines. It now gets 3 drafts with the long headline quoted back.
5. **Fallbacks collided.** A fallback could give two ads the same angle, scene and headline. Fallback ads now take an unused setting, and repeated headlines are redrafted.
6. **"Free" slipped through.** "Try Loopy Free for 30 Days" passed the word-level guardrail. A trigger word must now match the claim's own compound.
7. **Network blips burned paid re-renders.** "fetch failed" was Node 26 reusing a closed HTTP/2 session to Supabase (`ERR_HTTP2_INVALID_SESSION`). It cost a render retry or left a variant stuck. Network I/O now retries in place, and a good render is never re-rendered for a storage error.
8. **Rating stars appeared without a reviews claim.** They're now only added when the ad cites one.
9. **Two cozy warm-drink scenes read alike.** One was replaced with a kitchen scene.

**Verified live.**
- **Realtime grid:** waits for readiness, then fills tile by tile.
- **Stuck sweep:** turned three stuck tiles into "Took too long to render" at the 5-minute mark.
- **Retry:** re-rendered a failed tile.
- **Text check:** caught the M0 doubled headline in a dry run.

**Not verified.** The sweep's recover-from-fal branch: the stuck variants had no saved request ID.

**Cost.** About $4 of fal across the safe-zone re-runs ($0.60) and three rounds. The final round was $0.90: 6 renders, no retries.

## Copy pass, M5 and M6 (2026-10-27)

**Copy.** The writer now drafts 3 candidates, runs the claim guardrails on each, and a cheap judge scores the survivors against a rubric. Under 4 out of 5, its critique goes back for another round. The first rubric said "names this product", which pushed awkward lines like "Prevent drops in Raspberry Dots", so it now says specific to the design or the claim, and naming the product isn't required. Before and after for the M4 round, text only, with no renders:

| Ad | Before | After |
|---|---|---|
| Cocoa Checkered · social proof | Trusted since 2012, still loop-ably loved | Trusted since 2012. Checkered, cozy, yours. |
| Cocoa Checkered · aesthetic | Checkered cocoa for every season's story | Spring to winter, one checkered look |
| Raspberry Dots · benefit | Loop in comfort, keep phone close | Raspberry dots deserve a good grip |
| Raspberry Dots · guarantee | Try Loopy 30 days, risk-free | Pop of color, money-back guaranteed. |
| Night Sky · aesthetic | Night Sky: Stargazing Style, Every Season | Wear the night sky, any season |
| Night Sky · benefit | Grip like you mean it. | Golden stars that stay in hand |

**Real tests on the hosted project, measured rather than eyeballed.**
- **Headline edit (v1 → v2):** "Loop in comfort, keep phone close" became "Raspberry dots deserve a good grip". On the raw renders, the mean pixel change is 22.5 in the headline band and 3.2 everywhere else, which is edge noise from re-encoding. Only the text changed.
- **Ad feedback "warmer lighting":** the first version of the revision prompt ("keep its composition") made a change nobody would see. Warmth (mean R−B) went 55.8 → 58.5. The prompt now asks for a change visible at a glance. The follow-up from chat ("golden-hour light") took it to 94.5.
  - **Lineage checked:** v3's prompt carries both notes, oldest first, and the brand rule added after v2.
  - **Side effect:** v3 changed the hand and grip too, so the stronger wording trades some composition stability.
- **Campaign rule from chat:** "Never use dark backgrounds" was saved by `addBrandRule` and appeared in the next generation's prompt. The agent resolved "the Night Sky stargazing one" via `listAds` and regenerated it. Dark pixels went 22.8% → 10.9%, and brightness rose 9 points.
- **Cost:** every new version passed its text check on the first render, at $0.15 each, about $0.60 for these tests.

**Screenshots:** `docs/screenshots/m56-*.jpg`.

**Download:** approving v3 enabled download. `/api/download/<id>` returned a 4.9 MB PNG as `loopy-raspberry-dots-guarantee-v3.png`.

**Not verified:** toggling a rule off before a generation.

## Beyond Loopy: four more stores (2026-11-04)

The prompts and the picker were built on one store, so they were tested on four more Shopify stores, chosen to stress different things. Death Wish Coffee and Allbirds got a full round of 6. Brooklinen and Gymshark stop at the review card, because the fal balance ran out (more below).

**Prompts were hard-coded to a phone case.** "The phone case … must keep its finger loop and camera cutout" would tell the model to keep parts a shoe doesn't have. Each product now gets a profile from one Haiku vision call on its actual source photo plus its Shopify title, type and tags, cached in `products.profile` (migration 0004, `lib/profile.ts`). The profile has the category, whether the product is held, worn or placed, how it's used, its room, and 3–5 visual features to keep. Scenes have one line per mode where it matters.
- **Loopy is checked before and after, with no renders.** The profiles found the finger loop, the camera cutout and the finish on all three products unprompted. One thing was lost and put back: the specific action in the held scene ("stirring a pan"), which had become "the other hand busy". Each room now has a concrete action.

**"Pick from the most common product_type" only worked for single-category stores.** Death Wish has more apparel (37) than coffee (35), Brooklinen lists 83 "Content" items, and Gymshark's types are paths like `Womens>Apparel>Leggings>full_length`. The picker now finds the store's core family from the brand's own words and ranks merch, bundles and non-products below it (PLAN.md §3). The brief says which family and why.

**Bugs found by running the stores, all fixed:**
- **Most stores got 1–2 picks, not 3.** "No look-alikes" treated any shared title word as a duplicate, and every Gymshark title says "Gymshark". Words common to the pool no longer count.
- **Gymshark picked a tote, a bowling bag and a keyring.** Its brand text says "workout clothes and accessories", never "apparel", so only Accessories matched. Synonyms count now, and a named family must be at least 10% of the largest.
- **"One of your 2685 best sellers."** Gymshark tags every product `most-loved`. A tag on more than half the pool is ignored.
- **Allbirds got two seasonal picks**, one per matching collection. Now there's one.
- **Brooklinen picked clearance as its newest product.** Its tags say "active last call" and "final sale".
- **Brooklinen could only use 2 angles.** "award-winning sheets" didn't count as social proof.
- **A raw collection title showed in the brief:** "Collection Data - Fall Collection - Brushed Flannel Sheets". It now reads "Fall".
- **Gymshark's catalog hits the 10,000-product cap.** We pick from what was fetched and the brief says so.
- **Scenes and copy (fixed after the renders, checked on prompt text only):**
  - "In a bright entryway… walking outdoors": the `use` phrase may no longer carry a place.
  - A foot up on a table or desk in two Allbirds ads: those scenes have worn-product lines now.
  - Two near-identical Death Wish kitchen-counter ads: the second placed scene now puts a person in the background.
  - "Chocolate rum ball, delicious since 2012" for an October flavor: the copy rubric now says track-record claims describe the brand.
- **Season fit.** Allbirds' third pick was a dusty-pink flip-flop, captioned "sunny beach walks", in November. Warm-weather products (sandals, flip-flops, swim) are left out in fall and winter, and cold-weather ones in spring and summer. They're listed on the review card with "Use anyway". Verified by rerunning Allbirds research only: the flip-flop became Men's Canvas Runner NZ, and two flip-flops and a slide are listed as left out.
- **A failed render said only "Forbidden".** It was fal's "User is locked. Reason: Exhausted balance". The error now carries fal's own reason, and an account refusal isn't retried.

**Results.**

| Store | Stresses | Result | Weakness |
|---|---|---|---|
| Loopy | Busy patterns, hand-held hero photos | 6/6 (Oct 27 round, before profiles) | Built on this store; the only one with real merchandising tags |
| Death Wish Coffee | Brand voice, label text on a placed product | 6/6, $1.05 (1 retry for a garbled label) | Labels are a fidelity risk: the vision check caught one, and the next could pass |
| Allbirds | Studio photography, worn shoes | 6/6, $0.90 | The generic scenes didn't know a shoe is worn (fixed, not re-rendered) |
| Brooklinen | Home goods, lifestyle photography | Review card only | Only 17 single products in the core range, so all picks are sheets |
| Gymshark | 10,000+ product catalog | Review card only | The picks come from the first 10,000 products, and its verified claims allow only 2 angles |

Contact sheets: `docs/screenshots/stores-deathwish-round.jpg`, `docs/screenshots/stores-allbirds-round.jpg`.
