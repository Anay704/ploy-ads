# PLAN: AI Ads Manager slice

From a store URL to 9:16 interstitial ads a marketer would actually run. The agent does the work, and the user steers at two points: one review card before generation, and feedback after it.

Versions checked on 2026-10-25: `ai@7.0.x`, `@ai-sdk/react@4.0.x`, `next@16.4`, `@fal-ai/client@1.10`, `@supabase/supabase-js@2.118`, `@mendable/firecrawl-js@4.51`.

---

## 1. Marketer flow, screen by screen

**Screen 1: Start (`/`).** There is one input: "Paste your store or product URL". On submit, the `startResearch` server action checks the site is Shopify, then creates a `brand_kits` row in `researching` state and a `campaigns` row in `briefing` state, and routes to `/c/[campaignId]`. The campaign exists from the start so the chat can be saved while research streams, and a reload restores it. A store that isn't Shopify gets an inline message: *"We currently support Shopify stores. This one doesn't expose a Shopify catalog."* No workspace is created.

**Screen 2: Workspace (`/c/[campaignId]`).** This is the only screen after start. Chat sits on the left (about 400px) and the campaign workspace on the right.

1. **Research (streaming).** The workspace sends the first message itself ("Research loopycases.com"). The chat shows the `researchStore` tool (AI Elements `Tool` + `Task`) with live steps that tick off as preliminary tool results arrive: "Read the catalog: 228 products", "Brand kit drafted: 10 verified claims", "Picked Cocoa Checkered, …". The right side mirrors the checklist large over skeletons shaped like the review card.
2. **Review card (the one pause).** One card appears in the chat and is mirrored large on the right. It contains:
   - **Brand kit (editable):** logo (the pink wordmark), the store name exactly as the site writes it ("Loopy®Cases") and the short name ads use ("Loopy"), 3–5 color swatches, voice (3 adjectives and one sample line), value proposition, audience, and the approved claims grouped by topic (warranty, returns, reviews…).
   - **Products:** the 3 recommended products are preselected as tiles showing hero image, title, price and the reason for each pick. They're a mix: one best seller, one of the newest, one seasonal (§3). Products skipped for a too-close holiday are listed with the reason. "Swap" opens a picker with the rest of the catalog.
   - **Goal:** preselected from the data:
     - *Seasonal* if the seasonal pick is in play (its season is current, or its holiday is 14–60 days out).
     - *Sale* if a pick has a real `compare_at_price` and isn't `last call` clearance.
     - *Evergreen* otherwise.

     *Launch* is no longer suggested, because the newest-product slot would make it fire every time. It's still in the dropdown with the other goals.
   - **Primary button:** **Generate 6 ads**. It is a single click, and edits are optional.
3. **Generate (streaming).** The grid shows 6 tiles (3 products × 2 angles) in `generating` state. Each tile fills in as its ad finishes, in any order. The chat posts one line per completed ad.
4. **Manage.** Each tile shows the ad at 9:16, the angle label, status, version count, and the actions approve, reject, edit copy, feedback, regenerate and download (download appears once approved). Opening a tile shows a detail drawer with version history (v1 → v2 → v3) and the feedback that produced each version.
5. **Steer from chat.** The user can type requests such as "make the bows one warmer", "never use dark backgrounds", "add 2 more angles" or "try Lavender Pearl too". The agent calls the right tool, and the grid updates. The grid is the source of truth; chat only reports what happened.

---

## 2. Architecture

```
app/
  page.tsx                      start screen (URL form → server action startResearch)
  c/[campaignId]/page.tsx       workspace: <ChatPanel/> + <Workspace/>
  api/chat/route.ts             agent: streamText + tools, maxDuration 300
  actions.ts                    server actions: confirmBrief, setStatus, editCopy, regenerate, addFeedback
lib/
  shopify.ts                    detect, fetch, slim, filter, rank
  brand.ts                      Firecrawl branding + homepage meta → LLM inference
  research.ts                   researchStore without the agent: runs both, saves rows, copies used images
  copy.ts                       headline/CTA writer (generateText + Output.object, claims-constrained)
  generate.ts                   prompt builder → fal → post-process → Storage → DB
  prompt.ts                     prompt template + feedback injection
  supabase/{server,client}.ts
  tools.ts                      AI SDK tool definitions
components/
  ai-elements/*                 copied in via the AI Elements CLI (shadcn registry)
  review-card.tsx, ad-grid.tsx, ad-tile.tsx, ad-drawer.tsx
scripts/bakeoff.ts              model bake-off (M0)
supabase/migrations/0001_init.sql
```

**Where the agent runs.** It runs in `app/api/chat/route.ts` as a `streamText` call with `stopWhen: stepCountIs(8)`. The model is Claude Sonnet 5.5 (`claude-sonnet-5-5`), which is cheap and good at tool use. Every LLM call gets its model from `lib/llm.ts`, which calls Anthropic directly through `@ai-sdk/anthropic`, with the id in `LLM_MODEL`. The brief recommends the Vercel AI Gateway but allows any provider. Its free tier blocks Claude models, so we use direct Anthropic credit instead (NOTES.md, M2). Moving back to the gateway is one line in `lib/llm.ts`. The system prompt carries the campaign ID and a compact brand kit summary. The route's `maxDuration` is set to 300 seconds.

**Long-running generation.** `generateAds` does not wait for fal. It inserts `ad_variants` rows with status `generating`, starts the work with Next's `after()` (one promise per variant, run in parallel), and returns the IDs right away. Each job updates its own row. The grid subscribes to Supabase Realtime on `ad_variants` filtered by `campaign_id`, so tiles fill in as they finish no matter what the chat is doing.

- **`after()` is bounded by the route's `maxDuration`.** Next's docs say `after` "will run for the platform's default or configured max duration of your route". On Vercel it runs through `waitUntil` in the same invocation, so the chat stream and the fal jobs share one 300s budget, which is also the Hobby maximum. That budget covers 6 parallel jobs of about 10–40s each. Server actions that start jobs (Retry, edit copy, regenerate) take the page's segment config, so `app/c/[campaignId]/page.tsx` also exports `maxDuration = 300`.
- **Stuck-variant rule.** Any variant still `generating` 5 minutes after `created_at` is marked `failed` with `error = 'timeout'`, and the tile shows Retry. This is enforced in two places:
  - In the workspace page's server load, with one `update … where status='generating' and created_at < now() - interval '5 minutes'`.
  - On the grid, where a client timer checks each generating tile's age and calls the same `sweepStuck(campaignId)` server action.
- **fal queue with webhook: not used.** The queue API with a webhook would be more reliable, because the job lives on fal's side and fal delivers the result to us whether or not our function survives. We don't use it because webhooks need a public URL (a tunnel in local dev), signature verification and an extra route. Instead we use `fal.queue.submit` and store `fal_request_id`, so before marking a variant timed out the sweep asks fal for its status and recovers a finished result.

**Tools.** Each tool is defined with `tool({ description, inputSchema: z.object(...), execute })`. The pause tool `confirmBrief` has **no `execute`**: the client renders it and resolves it with `addToolOutput`. `useChat` uses `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`, so the agent continues on its own once the user clicks Generate.

**AI Elements used:** `Conversation`, `Message`, `PromptInput`, `Tool` (collapsible research and generation steps), `Task` (research checklist inside the research `Tool`), `Shimmer` (the active research step, "Thinking…", and loading states; the registry no longer has `Loader`, checked 2026-10-27), `Suggestion` (chips such as "More angles", "Add a product", "Warmer tone"), and `Image`. AI Elements is scheduled for deprecation. The source is the banner at the top of [elements.ai-sdk.dev](https://elements.ai-sdk.dev/), checked 2026-10-25: "AI Elements is moving to shadcn/ui. This project will be deprecated at the end of November 2026." The components are copied into the repo as source, so this does not block the build. It belongs in the submission note.

---

## 3. Agent design

| Tool | Input | Output | Side effects |
|---|---|---|---|
| `researchStore` | `{ url }` | `{ brandKitId, brandKit, recommended: Product[3], suggestedGoal, catalogCount }` or `{ error: "not_shopify" }` | Upserts `brand_kits` (status `draft`) and the slimmed `products` rows. Copies **only** the logo and the chosen hero image for each recommended product into Storage as `assets` |
| `confirmBrief` **(pause)** | `{ brandKitId, productIds, goal }`, filled by the agent from research. The brand kit is not in the input: the card loads it from the database, so the model can point at products but can't alter a claim, price or color | `{ approved: true, campaignId, goal, shortName, products[], claimTopics[] }`, as returned by the client | None from the agent. The Generate button calls the `confirmBrief` server action, which validates the edits (claims may be removed, never rewritten), saves the brand kit as `confirmed`, copies photos for swapped-in products, and activates the campaign (`briefing` → `active`). The client then calls `addToolOutput`. The chat route rejects an approval the database doesn't back (409) |
| `generateAds` | `{ productIds?, perProduct? }` (bound to the campaign) | `{ queued: [{product, angle, headline, cta}], capped }` | Plans the round (`planRound`), writes copy (`lib/copy.ts`), inserts `ads` and `ad_variants` (`generating`), and starts fal jobs in `after()`. Caps: 8 per call, 40 per campaign |
| `reviseBrief` | `{ shortName?, voiceAdjectives?, voiceSample?, valueProp?, audience? }` | `{ updated[] }` | Before approval only. Changes the brand kit's wording, never its claims; the agent then calls `confirmBrief` again. A new chat message supersedes the open `confirmBrief` (the route closes it as an error result, so the model never sees a dangling call) |
| `reviseAd` | `{ adId, feedback?, headline?, cta? }` | `{ variantId }` | Inserts `feedback` (scope `ad`) and a child `ad_variants` row (`generating`, `parent_variant_id`), then starts the job |
| `addBrandRule` | `{ campaignId, rule }` | `{ feedbackId, activeRules }` | Inserts `feedback` (scope `campaign`). Applies to all later generations and does not regenerate existing ads unless asked |
| `setStatus` | `{ variantId, status: 'approved' \| 'rejected' }` | `{ ok }` | Updates `ad_variants.status` |
| `listAds` | `{ campaignId }` | compact rows `{ adId, product, angle, version, status, headline }` | Read-only. Lets the agent resolve "the second one" and "the bows one" against the grid |

Grid buttons call the same logic through server actions (`lib/generate.ts`) without going through the LLM, so approve and edit copy respond instantly.

**The exact pause point.** After `researchStore` returns, the system prompt requires the agent's next call to be `confirmBrief`, and generation never starts before that tool has an output. It is the only blocking step. Everything after it is steering, not gating.

**Angles** come from a fixed set, and **code** picks 2 per product (`planRound` in `lib/angles.ts`, pure and shared by the review card's preview and `generateAds`, so the preview is exactly what Generate makes). It balances angles across the round, leads a best seller with social proof and a seasonal product with aesthetic while that angle is unused, only uses social proof or guarantee when a matching claim group exists, spreads claim topics, and gives every ad a different scene. The angles are: `benefit` (StoptheDrop®, grip), `social_proof` (70,000+ five-star reviews, since 2012), `offer` (only if there is a real `compare_at_price`), `aesthetic` (the product's look and season), and `guarantee` (lifetime warranty).

**Research details (`lib/shopify.ts`, `lib/brand.ts`):**
- **URL normalization.** A `/products/<handle>` URL goes to `/products/<handle>.json`, and that product is pinned as pick #1. Any other URL is treated as the store root.
- **Shopify detection.** `GET /meta.json` and `GET /products.json?limit=1` must both return JSON with the expected shape. Otherwise the tool returns `not_shopify`.
- **Fetch and slim, server side.** The app pages through `/products.json?limit=250` until a page comes back empty, about 6.7 MB for Loopy. It keeps only the needed fields: `id, handle, title, product_type, tags(filtered), price, compare_at_price, available, description(text), images[{src, position, isHero}]`. The LLM never sees raw JSON. It sees at most 20 pre-ranked candidates as one-liners.
- **Tag filter.** The tag list is an allowlist built at runtime. Internal tags are dropped by regex: `/^contains /i`, `/UNI$/`, `/^pf-/`, `/^pc-/`, `/^is-/`, `testpromo`, `LTE`, any `key:value` tag (`auto-select:off`), and device codes or screen sizes (`i13`, `S24`, `6.1`). Warehouse, feed and app tags from the multi-store runs are dropped too: dates (`11/3/26`), long numbers, tags with `# | _ @ (`, and words like wave, truck, feed, blocklist, yotpo (`wc wave 1 truck #1-#16 7.30.2026`). Kept tags are lowercased. The rules come from Loopy's real 49 distinct tags and are covered by `lib/shopify.test.ts`.
- **Core range (changed after M7, for multi-category stores).** "The store's dominant type" only worked for Loopy: Death Wish Coffee has more apparel than coffee, Brooklinen lists 83 "Content" items, Gymshark's types are paths like `Womens>Apparel>Leggings>full_length`. Now:
  - **Type family.** Products are grouped by the first meaningful segment of `product_type` (gender segments dropped): `Apparel` for Gymshark, the flat type elsewhere. `cleanType` gives the readable leaf ("Leggings") for the product profile.
  - **Core family.** One named in the brand's own words (value prop, audience, store description; "clothes" counts for apparel, "bedding" for sheets) wins, non-merch first, if it holds at least 10% of the largest family. Otherwise the largest non-merch family, otherwise the largest. The review card says which: "Picked from Coffee (35 products), named in your brand description."
  - **Order.** Core products, then other products, merch (apparel, accessories, mugs…), bundles, then non-products (`Content`, gift cards, samples, package protection, $0 items). The named slots only use single core products; the rest only fill a slot nothing else can.
- **Ranking within a family.** The base order is `best seller` > `new` > `limited` > the rest, with `last call` pushed down. Ties break by having at least 3 hero images, then by recency. A merchandising tag on more than half of a 20+ product pool is ignored: Gymshark puts `most-loved` on every product. Synonyms are normalized (`most-loved`, `bestseller` → best seller; `new-releases`, `newarrivals` → new; `final sale`, `clearance` → last call). This order feeds the agent's top-20 candidates and the Swap picker. The first image is never taken blindly.
- **Huge catalogs.** Fetching stops at 40 pages (10,000 products, about 25 s for Gymshark). The picks come from what was fetched, and the brief says "from the first 10,000 products: the catalog is larger". A failed page is retried once, so a rate limit doesn't look like a small catalog.
- **The 3 picks are a mix, not the top 3** (`pickMix`, decided after the first Loopy run, where the top 3 were all 2025 best sellers):
  1. **Best seller:** the top `best seller` by the base order.
  2. **Newest:** the most recently published product, preferring at least 3 hero images.
  3. **Seasonal:** the freshest product in a collection named for the current season ("Fall Favorites"). Failing that, one in a collection or with a theme for a holiday 14–60 days out ("Holiday | Neutral Tones" for Christmas).
- **Pick rules:**
  - **Seasons come from the store's own collections** (`/collections.json`), because that's the merchant's merchandising, not a guess. Seasons go by month (northern hemisphere).
  - **Too-close holidays are skipped everywhere.** A product whose title or tags are themed on a holiday under 14 days away is skipped from every slot (Halloween designs on 2026-10-27), because ads need time to ramp. Holidays are fixed-date only: Valentine's, St. Patrick's, Fourth of July, Halloween, Christmas. Keyword patterns are in `lib/seasons.ts`.
  - **No clearance unless nothing else fits.** `last call` products only fill a slot when nothing else can, even if they're on sale.
  - **Pinned first.** A pinned product (from a `/products/<handle>` URL) takes the first place.
  - **No look-alikes.** A product that shares a title word with an earlier pick is passed over, so "Java Dots" doesn't follow "Raspberry Dots". Words common to the pool don't count (in 15% of titles for 20+ products, half for smaller pools): every Gymshark title says "Gymshark" and Allbirds' say "Men's" or "Women's", which left those stores with 1–2 picks. If the core range runs out of distinct products, a look-alike core product beats going outside it.
  - **One seasonal pick**, even when several seasonal collections match (Allbirds had two).
  - **Season fit.** Warm-weather products (sandals, flip-flops, slides, swim) don't fill a slot in fall or winter, and cold-weather ones (puffers, parkas, beanies) don't in spring or summer, unless nothing else can (`offSeason` in `lib/seasons.ts`). The top 3 left out are listed on the review card with "Use anyway". Year-round materials (wool, flannel, fleece) are deliberately not listed.
  - **Reasons are saved.** Each pick's reason is saved as `products.rank_reason`, and the picks hold ranks 1–3.
  - **Storage stays minimal.** Product photos copied for earlier picks are deleted on a rerun unless an ad uses them.
- **Images.** "Hero" means an image with no `variant_ids`. These come first, and studio cutouts are the fallback. Every image is fetched as `src + ?width=1080&format=jpg`. Shopify's CDN ignores `format=jpg` for GIFs and returns the GIF (checked 2026-10-26), so `.gif` sources use `format=png`, which does flatten the first frame, and `sharp` re-encodes the result to JPEG. `width` never upscales: the GIF cutouts stay 720×960.
- **Brand.** Firecrawl `scrape(url, { formats: ['branding', 'markdown'] })` supplies colors, fonts, logo, personality and the page text. The homepage `<title>`, meta description, JSON-LD and `/meta.json` supply the value proposition and claims. They're always fetched, because they're where Shopify stores put their strongest claims.
  - **Logo order:** Firecrawl's logo, then JSON-LD `Organization.logo`, then the first header `<img>` whose `src` contains `logo` (`logo_pink.png` for Loopy). Never the favicon or `og:image`, which for Loopy is a dark Shopify placeholder.
  - **Without Firecrawl:** the key is missing or the call fails, so colors fall back to the logo's dominant color on white, and the review card lets the user fix them.
  - **Model:** the LLM step uses `llm()` from `lib/llm.ts` (Claude Sonnet 5.5, called directly on Anthropic). A `generateText` call with `Output.object` then produces `{ voice, valueProp, audience, claims[] }`, where `claims` must be substrings of scraped text and are validated in code. The match ignores case, whitespace, curly quotes, word-joining hyphens, ®/™, markdown formatting, a trailing period and a leading article, and nothing else.
  - **One fact per claim:** each claim is a short phrase (2–12 words) holding one fact, so the copy writer cites exactly the fact it uses.
  - **Promotions are rejected even when verbatim:** prices, "% off", "buy X get Y", shipping thresholds and codes. They're time-limited, and offer copy may only use a real `compare_at_price` (§5).
  - **Rejected claims** are kept with their reason (`not_verbatim`, `promotion`, `too_short`) in `brand_kits.raw` for debugging, never shown as claims.

---

## 4. Supabase schema

Enums:
```sql
create type brand_status   as enum ('researching','draft','confirmed');
create type campaign_goal  as enum ('sale','launch','evergreen','seasonal');
create type ad_angle       as enum ('benefit','social_proof','offer','aesthetic','guarantee');
create type variant_status as enum ('generating','draft','approved','rejected','failed');
create type asset_kind     as enum ('logo','product_image','ad_render','ad_raw');
create type feedback_scope as enum ('ad','campaign');
```

| Table | Columns | Notes |
|---|---|---|
| `brand_kits` | `id uuid pk`, `owner_id uuid null` (auth later), `store_url`, `domain unique`, `name`, `logo_asset_id → assets`, `colors jsonb` (`{primary,secondary,accent,background,text}`), `fonts text[]`, `voice jsonb` (`{adjectives[], sample}`), `value_prop`, `audience`, `claims text[]`, `claim_groups jsonb` (`[{topic, claims[]}]`, migration 0002), `short_name` (what ads call the brand, migration 0002), `raw jsonb` (Firecrawl scrape cache + meta, for debugging), `status brand_status`, `created_at` | Each domain is researched once, and a rerun refreshes it |
| `products` | `id uuid pk`, `brand_kit_id → brand_kits`, `shopify_id bigint`, `handle`, `title`, `product_type`, `tags text[]` (filtered), `price numeric`, `compare_at_price numeric null`, `available bool` (ranking and the Swap picker only offer available products), `description`, `images jsonb` (`[{id,src,position,isHero}]`, URLs only; `id` is Shopify's image id, used in the Storage path), `rank int`, `rank_reason`, `profile jsonb null` (category, mode, use, setting, features; migration 0004, §5 Product profile) | `unique(brand_kit_id, shopify_id)`. Images stay as CDN URLs until used |
| `campaigns` | `id uuid pk`, `brand_kit_id`, `owner_id null`, `name`, `status campaign_status` (`briefing` → `active`, migration 0003), `source_url` (what was pasted), `goal campaign_goal null` (set on confirm), `product_ids uuid[]`, `chat jsonb` (UIMessage[] for reload), `created_at` | Created when research starts. A check constraint requires goal and products once `active` |
| `ads` | `id uuid pk`, `campaign_id`, `product_id`, `angle ad_angle`, `source_asset_id → assets` (the product photo used), `current_variant_id → ad_variants null`, `created_at` | An ad is a concept: one product × one angle |
| `ad_variants` | `id uuid pk`, `ad_id`, `campaign_id` (denormalized for Realtime filtering), `parent_variant_id null`, `version int`, `headline`, `cta`, `prompt text` (exact prompt sent), `model`, `fal_request_id`, `asset_id → assets null`, `status variant_status`, `error`, `text_check jsonb null` (vision check result), `cost_usd numeric`, `created_at` | Each render is one row. Approval happens per variant |
| `assets` | `id uuid pk`, `brand_kit_id`, `kind asset_kind`, `storage_path`, `source_url` (Shopify or fal), `width`, `height`, `mime`, `created_at` | Every file in Storage has exactly one row |
| `feedback` | `id uuid pk`, `campaign_id`, `scope feedback_scope`, `ad_id null` (when scope = ad), `variant_id null` (the variant it was given on), `text`, `active bool default true`, `created_at` | Campaign rules can be switched off from the UI |

Realtime is enabled for the grid in the M1 migration:
```sql
alter publication supabase_realtime add table ad_variants;
```

**Realtime readiness (found in M1).** A channel's `SUBSCRIBED` status only means it joined. On a cold Realtime the Postgres change feed comes up a moment later, and Realtime never replays changes made before then. The M1 check missed its first update this way. So the grid in M4:
1. waits for the channel's `system` message with `extension: 'postgres_changes', status: 'ok'`,
2. then fetches the campaign's `ad_variants` rows,
3. then applies Realtime changes on top.

Fetching after the feed is live means a tile that finished in between is still picked up.

**Keys and RLS.** The project uses Supabase's new API keys:
- **`SUPABASE_SECRET_KEY` (`sb_secret_…`):** maps to `service_role`, which bypasses RLS. It is only read in `lib/supabase/server.ts`, which imports `server-only`.
- **`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`):** maps to `anon`. It's used by the browser client for reads and the Realtime grid.

RLS is enabled on every table, with select-only policies for `anon` and `authenticated`:
- `brand_kits` and `campaigns` use `owner_id is null or owner_id = auth.uid()`.
- Child tables inherit through an `exists` on their parent: `products` and `assets` via `brand_kits`; `ads`, `ad_variants` and `feedback` via `campaigns`.

There are no write policies, and insert/update/delete are also revoked from `anon` and `authenticated`, so only the server writes. Adding Auth later means populating `owner_id` and dropping the `is null` clause.

**Storage.** One public-read bucket, `ads`, created in the migration (PNG, JPEG and WebP only, 20 MB per file), with server-only writes:
```
ads/brands/{brandKitId}/logo.png
ads/brands/{brandKitId}/products/{productId}/{shopifyImageId}.jpg   # only images actually used
ads/campaigns/{campaignId}/{adId}/{variantId}.raw.png               # fal output, copied immediately
ads/campaigns/{campaignId}/{adId}/{variantId}.png                   # final 1080×1920 with logo
```

---

## 5. Image generation

**Bake-off (M0, 45 min max, about $3).** `scripts/bakeoff.ts` runs every combination of the inputs and models below, with the same prompt and copy, 2 runs each, and writes a local `bakeoff.html` grid.

Inputs:
- **A.** Black Bows hero (`hero-images-bows1.jpg`): a hand with the loop and a busy pattern.
- **B.** Lavender Pearl studio cutout: an iridescent finish, testing the fallback path.

Models:

| Model | Endpoint | Price (fal, checked 2026-10-25) |
|---|---|---|
| Nano Banana 2.1 edit | `google/nano-banana-2.1/edit` | about $0.06 at 2K |
| Nano Banana Pro edit | `fal-ai/nano-banana-pro/edit` | $0.15 |
| Seedream 5.0 Lite edit | `fal-ai/bytedance/seedream/v5/lite/edit` | about $0.035 |

Each output is scored 0–2 on:
1. **Product fidelity**, judged against the source: pattern, loop, camera cutout. This is the gate.
2. **Text exactness**: the headline and CTA spelled exactly.
3. **Layout**: 9:16 and the text in the safe zone.
4. **Latency**
5. **Cost**

The winner is the highest score among models with fidelity 2 on both inputs. If no model reaches fidelity 2, M4 builds the composite path.

**Result (run 2026-10-26, 12/12 ok, about $0.98): Nano Banana Pro edit.** It was the only model with fidelity 2 on all four outputs. Nano Banana 2.1 failed the gate (1 on each input: a grey loop, a rainbow-shifted finish). Seedream 5.0 Lite passed but tied Pro at 20/28; it got fidelity mostly by pasting the source photo, and it put the headline in the logo zone in 3 of 4 renders. Pro's one failure was a headline rendered twice. A model passed the fidelity gate, so the composite fallback is not built. Full scores are in `bakeoff/scores.json`, and the reasoning is in NOTES.md. Two findings became M4 work: the vision text check is now core (below), and the logo safe zone needs a verified fix (below).

Model parameters:
- **Nano Banana:** `aspect_ratio: '9:16'`, `resolution: '2K'`, `output_format: 'png'`.
- **Seedream:** `image_size: { width: 1440, height: 2560 }`. The OpenAPI schema (checked 2026-10-26) gives a native range of 2560×1440 to 4096×4096 pixels, so 1152×2048 would be rescaled; 1440×2560 is the smallest native 9:16.

**Prompt template (`lib/prompt.ts`).**
```
Create a full-screen vertical 9:16 mobile ad (portrait interstitial) for {brand.shortName}.

PRODUCT — use the reference image exactly. The {profile.category} "{product.title}" must keep its exact look:
- {profile.features[0..4]}          ← read from the actual photo (below)
Match the photo exactly in proportions, colors and finish.
Do not redraw, restyle or add products. Only this one {profile.category} appears.
{profile.inUsePhoto ? "Keep the interaction from the photo: {profile.use}." : per-mode placement line}

SCENE — {angleScene}. Palette: {colors.primary}, {colors.secondary}, {colors.background}.
Mood: {voice.adjectives}. Leave the top 12% clear (logo goes there).

TEXT — render exactly these two strings, spelled exactly, nothing else:
  Headline (large, top third, bold rounded sans): "{headline}"
  Button (pill, bottom 15%, {colors.primary} fill, white text): "{cta}"
No other words, prices, logos or watermarks.

{brandRules}      ← campaign-level feedback, as "Always/Never…" lines
{revisionNotes}   ← ad-level feedback for this ad's lineage, newest last
```

**Product profile (added after M7, `lib/profile.ts`).** The template above first hard-coded Loopy: "the phone case … finger loop and camera cutout". On a shoe or a coffee bag that tells the model to keep parts that don't exist. So each product gets a profile, made once by a Claude Haiku 5.5 vision call that sees the ad's actual source photo plus the Shopify `title`, `product_type` and `tags`, and cached in `products.profile` (migration 0004):
- `category`: what it is ("phone case", "running shoes", "bag of coffee").
- `mode`: `held` (in a hand), `worn` (on a body) or `placed` (set in a room). Scenes that depend on it have one line per mode.
- `use`: how a person uses it ("the phone held securely by the case's finger loop"), used in benefit scenes and, when the photo already shows it in use, as the interaction to keep.
- `setting`: one of a fixed list of rooms, so a scene never reads "in a bright anywhere".
- `features`: 3–5 concrete visual features to preserve (pattern, colors, shape, label, distinctive parts).
- `inUsePhoto`: replaces `isHero`, which meant "no variant_ids" and only implied a hand on Loopy.

It runs during research for the 3 picks, and on first generation for a product swapped in later. If the call fails, the profile falls back to `product_type` and generic fidelity wording, and isn't cached. The text and defect check say "the product", not "the phone case".

**Copy candidates (added before M5).** Each draft is 3 headline candidates. The claim guardrails below run on each one, and a second, cheap call (Claude Haiku 5.5) scores the survivors 1–5 against a rubric and picks the best:
- specific to the design or claim;
- benefit-led;
- natural grammar;
- no invented words;
- short.

Under 4 out of 5, the judge's critique goes back for another round, up to 3. The rubric came from reviewing M4's round: "Checkered cocoa for every season's story" said nothing, "loop-ably" isn't a word, and "keep phone close" drops a word.

**Copy.** `lib/copy.ts` calls `generateText` with `output: Output.object(...)` (AI SDK 7 deprecates `generateObject`) with the brand kit, product and angle and returns `{ headline (≤6 words), cta (≤3 words), claimIds: number[] }`.

**Claim groups.** Claims come grouped by topic (`brand_kits.claim_groups`), because sites repeat a promise in several wordings ("lifetime warranty", "Lifetime Loopy® Guarantee"). Copy generation:
- cites at most one claim per group in an ad;
- assigns groups across a round, so two ads in the same round don't lean on the same fact;
- only reuses a group once every group has been used.

Two guardrails are enforced in code:
- Any number in the headline must appear verbatim in a cited claim.
- `offer` copy may only quote `price` or `compare_at_price` exactly.

- Trailing punctuation isn't part of a number ("since 2012, …").
- A trigger word must be used the way the claim uses it: a claim of "risk-free returns" allows "risk-free", not "free" on its own. "Try Loopy Free for 30 Days" passed the first version of the check, and a risk-free trial isn't free.
- Each ad gets a different suggested CTA, and the copy writer sees the round's other headlines, so a round doesn't repeat one button or line.
- The writer gets up to 3 drafts in the planned angle before falling back to aesthetic with no claims. A fallback ad takes the next unused setting.

**Claim check for non-numeric claims.** The headline and CTA are scanned for trigger words from a fixed lexicon: `warranty, guarantee, lifetime, free, returns, reviews, rated, #1, best, proven, prevents, never, original, trusted, since`. Every trigger word that appears must also appear in a claim the copy writer cited (`claimIds`), and that claim must itself be a verbatim substring of the scraped site text. A headline saying "Lifetime warranty" passes only if it cites the site's "lifetime warranty" claim. Otherwise the copy is rewritten once and then dropped back to the `aesthetic` angle.

The model renders the text, as the brief requires.

**Copy-only edits.** Reusing the original source photo and seed with a changed prompt would not reproduce the same image. So when only the copy changes, the **previous variant's `.raw.png`** (the render before the logo is added) is sent as the only reference image with an edit prompt:
```
Edit this ad image. Replace the headline text "{old.headline}" with "{new.headline}" and the
button text "{old.cta}" with "{new.cta}", same font, size, color and position.
Keep everything else pixel-identical: product, hand, background, layout, colors. Change nothing else.
```
The result goes through the same post-processing, including the logo. If the edited render visibly drifts, the user can approve it anyway, revert to the previous version, or run a full regenerate.

**Post-process (`lib/generate.ts`):**
1. Download the fal output immediately and store it as the `.raw.png` asset.
2. **Vision text check (core, not stretch).** See below. A failed check counts as an error for step 6.
3. Resize and crop to 1080×1920 with `sharp`. Pro returns 1536×2752, which is slightly taller than 9:16, so the crop removes about 21px of height before resizing.
4. Composite the real logo on a white pill beside the detected CTA, so the logo is never AI-drawn.
5. Upload the final `.png`, create its `assets` row, and set the variant to `draft` with `ads.current_variant_id` pointing to it.
6. On error, retry once with a fresh fal call. A variant gets at most one retry in total, whether the cause is a fal error or a failed text check, which keeps the worst case (2 × ~50s render + 2 checks) well inside the 300s budget. After that, mark the variant `failed` with the reason and show a Retry button on the tile.

**Vision text check.** The bake-off showed Pro rendering the headline twice in 1 of 4 runs, and a marketer would never run that ad, so every render is checked before it can reach `draft`. The check runs on the `.raw.png`, before the logo is composited, so the real logo isn't counted as extra text. A cheap vision model (`llm('claude-haiku-5-5')`, Claude Haiku 5.5) gets the image and returns structured output (`generateText` + `Output.object`): `{ adText: string[], productText: string[], sceneText: string[] }`. That's every legible piece of text, split into overlaid ad copy, text printed on the product itself (the "loopy" loop emboss, the p mark) and legible words on props. The pass rule is enforced in code, not by the model:
- `adText` contains the headline exactly once and the CTA exactly once, and nothing else. Comparison ignores case and collapses whitespace, because the model may style the CTA in caps, but letters and punctuation must match.
- `sceneText` is empty. Illegible pseudo-lettering on props, as seen in the bake-off, isn't reported and doesn't fail.
- `productText` is ignored, because it belongs to the real product.

On a mismatch the reason is stored, for example `text_check: headline appears 2×` or `text_check: extra text "SALE"`. The full check result is saved in `ad_variants.text_check jsonb` so the drawer can show why a version failed. A check costs a fraction of a cent and takes a few seconds.

**Scene variety.** In the bake-off almost every render was the same pink and mint flat-lay with lipsticks and makeup brushes, and a round of 6 like that reads as one ad six times. Two causes were in the setup: all 12 renders used the `aesthetic` angle, and the `Palette:` line sat inside SCENE, so it read as "make the scene pink and mint". In M4:
1. **One distinct scene direction per angle in `ANGLE_SCENES` (`lib/prompt.ts`)**, each naming a setting, framing and props that the others don't use:
   - `benefit`: the phone in a hand mid-action (walking, commuting, taking a photo), showing the loop grip in use, outdoor or urban light.
   - `social_proof`: a clean, bright studio with the product front and center and a simple row of five rating stars as a graphic element. Only used when the brand kit has a verbatim reviews claim, because stars imply a rating claim (PLAN.md §5 claim check).
   - `offer`: a bold color-block set with strong graphic shapes, energetic and promotional.
   - `aesthetic`: a seasonal styled scene chosen from the product's own look and season, for example autumn knitwear and a café table for a dark print, or spring florals for a pastel case. Not a default makeup flat-lay.
   - `guarantee`: a calm, premium scene that suggests durability (stone, wood, soft daylight).
2. **Palette moves out of SCENE.** It applies to the headline, the button and small accents, and the scene keeps its own natural colors: "Use {colors} for the headline, button and small accents only; the scene keeps its own natural colors."
3. **Two ads in one round with the same angle get different scenes.** `generateAds` passes a variation index, and each angle has 2 scene options, so two `aesthetic` ads for different products don't share a set.
4. **Ban the failure mode that was seen.** The prompt adds: "A real photograph, not a template: no color bands, frames, stickers or collage." Pro run 2 (color bands) and Seedream run 2 (sticker collage) both failed that way.
5. **Verify with the safe-zone re-run.** The 2 re-run Pro renders use two different angles, and they are judged on both the 12% line and whether the scenes are clearly different.

**Logo safe zone. Result (M4): the logo moved to a badge beside the CTA.**
- **The experiment failed twice over.** With the hard-constraint wording, both re-run Pro renders still crossed the 12% line. Worse, both painted a solid color bar to "keep the band empty", which is exactly the template look we ban.
- **The new layout.** The prompt now only asks for a narrow, centered button and a clear bottom-left corner. It never says "empty", which is what invited the bar. Two more renders confirmed no bands and a clear corner.
- **Placing the badge.** Post-processing finds the actual CTA pill (the brand primary in the bottom 22%) and puts the logo, on a white pill, beside it, or centered above it when there's no room. The model ignored the 40% width in 4 of 6 ads in the Loopy round.
- **Screenshots:** `docs/screenshots/m4-safezone-*.jpg`.

The original plan, kept for the record:
1. Strengthen the wording in `lib/prompt.ts`: state the zone as a hard constraint ("The top 12% of the image must contain only background: no text, no product, no hands. The headline starts below that line."), and repeat it in the TEXT section next to the headline position.
2. Re-run 2 Pro renders with `npm run bakeoff -- --only nbpro --input A --tag safezone` (one per angle, see Scene variety; the script hard-codes `aesthetic` today, so M4 adds an `--angles benefit,aesthetic` option that sets one angle per run) and check them against the same 12% line overlay used to score the bake-off.
3. If either render still crosses the line, stop fighting the model and move the logo. The proposal is a small logo centered just above the CTA pill in the bottom zone, where every model already placed the CTA reliably, with the prompt reserving that strip. The decision and its evidence go into NOTES.md and this section.

**Composite fallback (built only if the bake-off shows drift).** The model generates the scene and text with a blank product area. `sharp` then overlays the untouched product photo, masked with rounded corners and a drop shadow, into that area. Exact product fidelity costs some realism.

---

## 6. How feedback is stored and used

| Level | Where it comes from | Stored as | Injected into |
|---|---|---|---|
| **Ad** | "Make the bows one warmer", tile feedback box, or `reviseAd` | `feedback {scope:'ad', ad_id, variant_id, text}` | `{revisionNotes}` for **later variants of that ad only**. The builder walks the `parent_variant_id` chain and includes the notes oldest to newest, so v3 still honors v2's note |
| **Campaign** | "Never use dark backgrounds", or `addBrandRule` | `feedback {scope:'campaign', active:true, text}` | `{brandRules}` for **every new variant in the campaign**, including new products and angles. A "Rules" panel above the grid lists them with toggles |

Before saving, the agent rewrites free text into a short imperative ("Use warmer, golden-hour lighting"). The original text is kept in the chat. Each variant stores the exact `prompt` it was generated with, so the drawer can show which feedback produced it. That is the visible proof that feedback changed the next generation.

---

**How versions render (M5/M6, `lib/manage.ts`).** Every change makes a new `ad_variants` row (`parent_variant_id` → the version it came from), and the job picks its reference images from the kind of change:

| Change | Prompt | References | From |
|---|---|---|---|
| Edit copy (tile or `editCopy`) | PLAN §5 "edit this ad image… change nothing else" | previous raw render only | grid, chat |
| Ad feedback (`reviseAd`) | base prompt + current brand rules + this ad's notes, oldest first, asking for a change visible at a glance | previous raw render, then the product photo | grid, chat |
| Regenerate (`regenerateAd`) | base prompt + current brand rules + this ad's notes | product photo | grid, chat |

- **Typed copy follows the same rules.** Copy the marketer types goes through the same claim guardrails, and may cite any approved claim.
- **The version drawer derives each version's origin** from that data: original, copy edited, which note produced it, or regenerated.
- **Approve and reject act on the latest finished version.** Download is served by `/api/download/[variantId]` for approved versions only.
- **The Rules panel above the grid** lists campaign rules with toggles. It refetches when the chat changes, so a rule added in chat appears without a reload.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The model redraws the product (pattern drift) | Bake-off fidelity gate, explicit "use reference exactly" prompt, composite fallback |
| Misspelled, doubled or extra text | Short copy (≤6 and ≤3 words), quoted strings, Pro chosen in the bake-off, and the core vision text check: headline and CTA exactly once each with no other text, else retry once, then `failed` with the reason |
| fal latency, or the function killed mid-job | `after()` jobs within `maxDuration 300`, per-variant rows with Realtime, and the 5-minute stuck-variant sweep, which first asks fal for the result by `fal_request_id` and otherwise marks the variant `failed` with Retry |
| fal URLs expire | Copy into Storage before marking the variant done. The DB never stores a fal URL as the asset |
| 6.7 MB catalog / LLM context | Slimmed server side, top 20 candidates sent as one-liners, internal tags filtered |
| GIF variant images | `?format=png` for `.gif` sources (the CDN ignores `format=jpg` for GIFs), then `sharp` to JPEG |
| Semi-transparent or iridescent cases look wrong | Prefer hero shots, which show the case on a phone in a hand. The bake-off includes an iridescent product |
| Invented claims or fake discounts | `claims` must be substrings of the site, and offer copy only uses real `compare_at_price` |
| Firecrawl fails or returns a weak result | Fall back to parsing the homepage HTML (title, meta, logo `<img>`, JSON-LD). The user can edit everything in the review card |
| Runaway cost from the chat ("make 50 more") | Cap of 8 variants per `generateAds` call and 40 per campaign, with the cost per variant tracked in `ad_variants.cost_usd` |
| AI Elements deprecation (end of Nov 2026) | The components are vendored source. Flag it in the note |
| iCloud-synced `~/Desktop` restarts dev-server file watchers | The project lives in `~/code/ploy-ads`, outside iCloud, from before scaffolding |
| Headline overlaps the logo zone (6/12 in the bake-off) | Hard-constraint safe-zone wording, verified with 2 re-run Pro renders in M4; if it still fails, move the logo to the bottom strip above the CTA |
| Edit-in-place copy changes drift the image | The previous render is the only reference, with a "change nothing else" prompt. Revert and full regenerate are always available |

---

## 8. Build order (about 6 hours, each milestone testable alone)

| # | Milestone | Time | Done when |
|---|---|---|---|
| M0 | Bake-off script, pick model | 45m | `npm run bakeoff` writes `bakeoff.html` with 12 outputs, the winner is written into `lib/generate.ts`, and the decision is recorded in NOTES |
| M1 | Scaffold Next + Tailwind + AI Elements, Supabase migration (including the Realtime publication on `ad_variants`), bucket, `.env.example` | 30m | `npx supabase db reset` runs clean, a test upload or download through `assets` works, and an `ad_variants` update shows up in a Realtime subscription. `npm run verify:m1` runs all three, plus a check that the publishable key can't write |
| M2 | `lib/shopify.ts` + `lib/brand.ts` | 50m | `npm run research -- loopycases.com` prints the brand kit, top 3 products with reasons, and goal. A non-Shopify URL prints `not_shopify`. `npm test` covers the tag filter, ranking and claim check |
| M3 | Chat route + `researchStore` + `confirmBrief` review card | 60m | In the browser, a URL leads to streamed research and then the editable card. Generate creates the campaign row and the agent continues |
| M4 | `generateAds` + `lib/generate.ts` + Realtime grid + vision text check + safe-zone fix | 95m | Generate fills 6 tiles as they finish. Files appear at the Storage paths. Every `draft` variant has a passing `text_check`, and a forced text mismatch (a stubbed check) retries once and then shows `failed` with the reason. 2 re-run Pro renders clear the logo zone, or the logo has moved to the bottom strip. The 6 ads in a round show visibly different scenes (no two share a setting), and none uses color bands, frames or a collage layout. A forced fal error shows `failed` and Retry, and a row backdated to 6 minutes old is swept to `failed (timeout)` on reload |
| M5 | Manage: approve, reject, edit copy, download, version drawer | 30m | Edit copy creates v2 from v1's raw render with only the text changed, approve enables download, and statuses persist across a reload |
| M6 | Feedback: `reviseAd`, `addBrandRule`, Rules panel, `listAds` | 30m | "Warmer" on one ad changes only that ad's v2 prompt. "Never dark backgrounds" appears in the next generation's prompt for every ad |
| M7 | Deploy to Vercel + submission note | 30m | The production URL works end to end on loopycases.com, and the note covers every decision from this plan |

If time runs short, cut from the bottom: the version drawer (keep the version counter), then the Rules panel toggles (rules still apply).

---

## 9. Out of scope

- Non-Shopify stores (Firecrawl-only product extraction)
- Real AppLovin or ad-network upload, budgets, bidding, targeting, performance data
- Video ads, other aspect ratios, carousels
- Auth, multi-user, teams, roles (the schema is ready for it)
- Localization and multi-language copy
- Variant-level targeting (a specific phone model per ad)
- A/B test orchestration or automatic optimization from results
- Billing and quota UI beyond the hard caps
- Full catalog sync and webhooks from Shopify (research is on demand)
