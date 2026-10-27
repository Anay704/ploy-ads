// Image generation: prompt → fal → post-process → Storage → DB (PLAN.md §5).
// M0 fixes the model; M4 adds the pipeline (text check, crop, logo, Storage, retries).

// Bake-off winner (2026-10-26, see NOTES.md and bakeoff/scores.json): the only model with
// product fidelity 2 on every output. Nano Banana 2.1 drifted the product; Seedream 5.0 Lite
// passed fidelity but pasted the photo and kept putting the headline in the logo zone.
export const IMAGE_MODEL = {
  name: 'Nano Banana Pro edit',
  endpoint: 'fal-ai/nano-banana-pro/edit',
  usdPerImage: 0.15,
  input: (prompt: string, imageUrls: string[]) => ({
    prompt,
    image_urls: imageUrls,
    aspect_ratio: '9:16',
    resolution: '2K',
    output_format: 'png',
  }),
} as const;

// Pro returns 1536×2752 at 2K, slightly taller than 9:16; post-process crops then resizes to this.
export const AD_SIZE = { width: 1080, height: 1920 } as const;
