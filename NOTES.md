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
1. **The vision text check is core, not stretch.** 1 doubled headline in 4 Pro runs is a small sample, but a marketer would never run that ad, and nothing else in the pipeline would catch it. Every render is now checked by `anthropic/claude-haiku-5-5`: the headline and CTA must each appear exactly once, with no other legible text. On a mismatch the variant retries once, then becomes `failed` with the reason (PLAN.md §5).
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
