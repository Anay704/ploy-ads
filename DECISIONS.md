# Ploy Ads: decisions and lessons

[Live app](https://ploy-ads.vercel.app) · [Code](https://github.com/Anay704/ploy-ads)

## Product and UX

I wanted a marketer to paste a store URL and get ads they could review. I scoped research to Shopify stores with a readable catalog. Product photos and details come from Shopify; Firecrawl supplies brand information and site text. Claude infers the voice and audience, and claims must appear in the scraped text before ads can use them.

Claude Code proposed two approval steps before generation. I cut that to one editable review card because I wanted people to reach their first ad sooner. The default round uses a best seller, a new product and a seasonal pick where available, with two angles each. Clearance comes last. Holidays less than 14 days away are skipped because the campaign needs time to ramp.

Feedback on an ad guides its next version, while a campaign rule applies to future ads across the campaign. Earlier versions stay available for comparison and approval.

## What testing on other stores taught me

Death Wish would have advertised socks, so picks now start with the brand’s core product category. Gymshark tagged almost everything “most-loved”; tags covering most of the catalog are now ignored when ranking. Brooklinen’s newest pick was clearance stock, which led me to add its clearance tags. For Allbirds, the seasonal pick was flip-flops in November, so seasonal picks now have to fit the season. Testing real stores exposed assumptions that had passed on Loopy.

## Generation decisions

I chose fal’s Nano Banana Pro after comparing 12 renders across three models. I rejected the model with the highest overall score because it changed product details. It renders the headline and CTA into the image. A vision check can trigger one retry, then sharp crops the result to 1080 × 1920 and adds the real logo.

A round of six cost about $0.90 in image generation before retries and took about 80 seconds.

## System design

Next.js runs on Vercel, with AI SDK streaming and AI Elements for chat; Claude uses the Anthropic API directly.
Supabase Postgres saves campaigns and their related records, while Storage holds the photos and ads; fal outputs are copied there immediately.
Generation runs in `after()` within Vercel’s 300-second limit, and Supabase Realtime updates the grid. The [diagram](https://excalidraw.com/#json=tDoYJO2OFaP5tLGpZdOjz,vjJ943SbWpSdCY3MNb_bxA) shows the connections.

## How I worked

Claude Code handled the build from planning through deployment. I used Claude chat to help draft prompts and review outputs before approving them. I made the calls on the approval flow and product picks, and checked the results across stores.

## Five-store coverage

Loopy Cases, Death Wish Coffee and Allbirds each produced six ads. Brooklinen and Gymshark completed research and showed the review card. Three stores have full rounds, and two stopped at the brief because I chose not to buy more image credit.

## Limits and next steps

Testing beyond Loopy revealed that the prompts assumed every product was a phone case. I replaced that assumption with a product profile: one vision call reads each product photo and lists the features to preserve. Scenes now adapt to whether the product is held, worn or placed. Death Wish and Allbirds were generated after the profile change.

The demo has public data and no login. Before opening it to customers, I would add account isolation and a durable job queue with spending limits. I would measure time to first approved ad and cost per approved ad.

**For reviewers:** Generating new ads on the live site needs fal image credit, so a credit error means the balance needs topping up. Research and the review card still work.

I wrote this note myself and used an AI tool to fix grammar/structuring so that it is better and cohesive. 
