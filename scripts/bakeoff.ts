// M0 model bake-off (PLAN.md §5): 3 fal models × 2 inputs × 2 runs, same prompt and copy.
// Writes full renders to bakeoff/out/, thumbnails to bakeoff/thumbs/, raw timings to
// bakeoff/results.json, and a review grid to bakeoff.html.
//
//   npm run bakeoff               generate everything, then write the HTML
//   npm run bakeoff -- --html     re-render bakeoff.html only (e.g. after editing scores.json)
//   npm run bakeoff -- --only nbpro --input A --tag safezone
//                                 a filtered re-run, written to results-<tag>.json and
//                                 bakeoff-<tag>.html so the original 12 are never overwritten

import { fal } from '@fal-ai/client';
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildPrompt } from '../lib/prompt';
import { IMAGE_MODEL } from '../lib/generate';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'bakeoff');
const RUNS = 2;

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const TAG = arg('tag');
const RESULTS_FILE = path.join(DIR, TAG ? `results-${TAG}.json` : 'results.json');
const HTML_FILE = path.join(ROOT, TAG ? `bakeoff-${TAG}.html` : 'bakeoff.html');

type Model = { key: string; name: string; endpoint: string; usd: number; input: (prompt: string, imageUrl: string) => object };

const MODELS: Model[] = [
  {
    key: 'nb21',
    name: 'Nano Banana 2.1 edit',
    endpoint: 'google/nano-banana-2.1/edit',
    usd: 0.06,
    input: (prompt, url) => ({ prompt, image_urls: [url], aspect_ratio: '9:16', resolution: '2K', output_format: 'png' }),
  },
  // The winner now lives in lib/generate.ts; re-runs use the exact config the app ships.
  {
    key: 'nbpro',
    name: IMAGE_MODEL.name,
    endpoint: IMAGE_MODEL.endpoint,
    usd: IMAGE_MODEL.usdPerImage,
    input: (prompt, url) => IMAGE_MODEL.input(prompt, [url]),
  },
  {
    key: 'sd5',
    name: 'Seedream 5.0 Lite edit',
    endpoint: 'fal-ai/bytedance/seedream/v5/lite/edit',
    usd: 0.035,
    // The OpenAPI schema gives a native range of 2560×1440 to 4096×4096 pixels, so
    // 1152×2048 (PLAN's first guess) would be rescaled. 1440×2560 is the smallest native 9:16.
    input: (prompt, url) => ({ prompt, image_urls: [url], image_size: { width: 1440, height: 2560 }, output_format: 'png' }),
  },
];

// Black Bows is a white case with a black bow print. Shopify's CDN ignores format=jpg for
// GIFs and returns the GIF; format=png does flatten the first frame, so GIFs are fetched as PNG.
const INPUTS = [
  {
    key: 'A',
    label: 'Black Bows hero (hand + loop, busy pattern)',
    title: 'Black Bows',
    isHero: true,
    src: 'https://cdn.shopify.com/s/files/1/0199/7596/files/hero-images-bows1.jpg?v=1732602408',
  },
  {
    key: 'B',
    label: 'Lavender Pearl studio cutout (iridescent)',
    title: 'Lavender Pearl',
    isHero: false,
    src: 'https://cdn.shopify.com/s/files/1/0199/7596/files/17-Lavender-Pearl.gif?v=1790173284',
  },
];

// Copy is fixed so text exactness is comparable (5 words, within the ≤6-word limit).
// Colors are the most-used hexes in loopycases.com's CSS, standing in until M2's brand kit.
const COPY = { headline: 'Style you can hold onto', cta: 'Shop Now' };
const BRAND = {
  brandName: 'Loopy',
  colors: { primary: '#F88A8A', secondary: '#8FE8B3', background: '#FFFFFF' },
  voiceAdjectives: ['playful', 'confident', 'trendy'],
};

type Result = {
  id: string;
  model: string;
  input: string;
  run: number;
  ok: boolean;
  file?: string;
  thumb?: string;
  width?: number;
  height?: number;
  latencyS?: number;
  usd: number;
  requestId?: string;
  error?: string;
};

function sourceUrl(src: string) {
  const fmt = /\.gif\?/i.test(src) ? 'png' : 'jpg';
  return `${src}&width=1080&format=${fmt}`;
}

async function fetchBuffer(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function prepareSources() {
  await mkdir(path.join(DIR, 'sources'), { recursive: true });
  const urls: Record<string, string> = {};
  for (const inp of INPUTS) {
    // Re-encode as JPEG locally too, so every model gets the same bytes whatever the CDN sends.
    const jpg = await sharp(await fetchBuffer(sourceUrl(inp.src))).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
    await writeFile(path.join(DIR, 'sources', `${inp.key}.jpg`), jpg);
    urls[inp.key] = await fal.storage.upload(new Blob([jpg], { type: 'image/jpeg' }));
    console.log(`source ${inp.key} uploaded`);
  }
  return urls;
}

async function runOne(m: Model, inp: (typeof INPUTS)[number], run: number, imageUrl: string): Promise<Result> {
  const id = `${m.key}_${inp.key}_${run}${TAG ? `-${TAG}` : ''}`;
  const prompt = buildPrompt({ ...BRAND, productTitle: inp.title, isHero: inp.isHero, angle: 'aesthetic', ...COPY });
  const base = { id, model: m.key, input: inp.key, run, usd: m.usd };
  const t0 = Date.now();
  try {
    const { data, requestId } = await fal.subscribe(m.endpoint, { input: m.input(prompt, imageUrl) as never });
    const latencyS = (Date.now() - t0) / 1000;
    const url = (data as { images?: { url: string }[] }).images?.[0]?.url;
    if (!url) throw new Error(`no image in response: ${JSON.stringify(data).slice(0, 300)}`);
    // Download right away: fal URLs expire.
    const buf = await fetchBuffer(url);
    const meta = await sharp(buf).metadata();
    const file = `out/${id}.png`;
    const thumb = `thumbs/${id}.jpg`;
    await writeFile(path.join(DIR, file), buf);
    await sharp(buf).resize({ width: 540 }).jpeg({ quality: 85 }).toFile(path.join(DIR, thumb));
    console.log(`✓ ${id} ${latencyS.toFixed(1)}s ${meta.width}×${meta.height}`);
    return { ...base, ok: true, file, thumb, width: meta.width, height: meta.height, latencyS, requestId };
  } catch (e) {
    const err = e as { message?: string; body?: unknown };
    const error = `${err.message ?? e}${err.body ? ' ' + JSON.stringify(err.body).slice(0, 400) : ''}`;
    console.log(`✗ ${id} ${error}`);
    return { ...base, ok: false, latencyS: (Date.now() - t0) / 1000, error };
  }
}

type Score = { fidelity: number; text: number; layout: number; notes: string };
// scores.json is filled in by hand after looking at each render next to its source.
type Scores = { rubric?: string; models: Record<string, { latency: number; cost: number; notes: string }>; outputs: Record<string, Score> };

async function writeHtml() {
  const results: Result[] = JSON.parse(await readFile(RESULTS_FILE, 'utf8'));
  const models = MODELS.filter((m) => results.some((r) => r.model === m.key));
  const inputs = INPUTS.filter((i) => results.some((r) => r.input === i.key));
  const scoresPath = path.join(DIR, 'scores.json');
  const all: Scores = existsSync(scoresPath) ? JSON.parse(await readFile(scoresPath, 'utf8')) : { models: {}, outputs: {} };
  const scores = all.outputs;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const prompt = (k: string) => {
    const inp = INPUTS.find((i) => i.key === k)!;
    return buildPrompt({ ...BRAND, productTitle: inp.title, isHero: inp.isHero, angle: 'aesthetic', ...COPY });
  };

  const cell = (r: Result | undefined) => {
    if (!r) return '<td class="cell missing">not run</td>';
    const s = scores[r.id];
    const score = s
      ? `<div class="score">fidelity <b>${s.fidelity}</b> · text <b>${s.text}</b> · layout <b>${s.layout}</b></div><div class="notes">${esc(s.notes)}</div>`
      : '<div class="notes">not scored yet</div>';
    const meta = `<div class="meta">run ${r.run} · ${r.latencyS?.toFixed(1)}s · $${r.usd.toFixed(3)}${r.width ? ` · ${r.width}×${r.height}` : ''}</div>`;
    if (!r.ok) return `<td class="cell"><div class="err">failed: ${esc(r.error ?? '')}</div>${meta}</td>`;
    return `<td class="cell"><a href="bakeoff/${r.file}" target="_blank"><img src="bakeoff/${r.thumb}" alt="${r.id}"></a>${meta}${score}</td>`;
  };

  const summary = models.map((m) => {
    const rs = results.filter((r) => r.model === m.key);
    const ok = rs.filter((r) => r.ok);
    const lat = ok.map((r) => r.latencyS!).sort((a, b) => a - b);
    const sc = ok.map((r) => scores[r.id]).filter(Boolean);
    const avg = (f: (s: Score) => number) => (sc.length ? (sc.reduce((a, s) => a + f(s), 0) / sc.length).toFixed(2) : '–');
    const minFid = (k: string) => {
      const v = ok.filter((r) => r.input === k).map((r) => scores[r.id]?.fidelity).filter((x) => x !== undefined) as number[];
      return v.length ? Math.min(...v) : '–';
    };
    const ms = all.models[m.key];
    const sum = sc.reduce((a, s) => a + s.fidelity + s.text + s.layout, 0) + (ms ? ms.latency + ms.cost : 0);
    const gate = [minFid('A'), minFid('B')].every((v) => v === 2);
    return `<tr><td>${m.name}<br><code>${m.endpoint}</code></td><td>${ok.length}/${rs.length}</td><td class="${gate ? 'pass' : 'fail'}">${minFid('A')} / ${minFid('B')}</td><td>${avg((s) => s.fidelity)}</td><td>${avg((s) => s.text)}</td><td>${avg((s) => s.layout)}</td><td>${lat.length ? `${lat[0].toFixed(0)}–${lat[lat.length - 1].toFixed(0)}s` : '–'} (${ms?.latency ?? '–'})</td><td>$${m.usd.toFixed(3)} (${ms?.cost ?? '–'})</td><td><b>${sc.length ? sum : '–'}</b>${gate ? '' : ' (fails gate)'}</td><td class="notes">${esc(ms?.notes ?? '')}</td></tr>`;
  }).join('\n');

  const rows = inputs.map((inp) => {
    const cols = models.map((m) =>
      Array.from({ length: RUNS }, (_, i) => cell(results.find((r) => r.model === m.key && r.input === inp.key && r.run === i + 1))).join(''),
    ).join('');
    return `<tr><th class="src"><div>${inp.key}. ${esc(inp.label)}</div><img src="bakeoff/sources/${inp.key}.jpg" alt="source ${inp.key}"></th>${cols}</tr>`;
  }).join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>fal bake-off</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#fafafa;color:#222}
table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px;vertical-align:top;background:#fff}
.grid img{width:200px;display:block;border-radius:6px}.src img{width:200px}.src{width:200px;font-weight:600;text-align:left}
.cell{width:200px}.meta{color:#666;font-size:12px;margin-top:4px}.score{margin-top:4px}.notes{font-size:12px;color:#444;margin-top:2px}
.pass{background:#e7f7ec}.fail{background:#fdeaea}.err{color:#b00;font-size:12px;word-break:break-word;width:200px}pre{background:#fff;border:1px solid #ddd;padding:12px;white-space:pre-wrap;max-width:900px}
</style></head><body>
<h1>fal bake-off (M0)</h1>
<p>Copy: headline <b>"${esc(COPY.headline)}"</b>, CTA <b>"${esc(COPY.cta)}"</b>. Scores are 0–2; fidelity is judged against the source photo and is the gate. Click a thumbnail for the full render.</p>${all.rubric ? `<p class="notes">${esc(all.rubric)}</p>` : ''}
<h2>Summary</h2>
<table><tr><th>Model</th><th>OK</th><th>Min fidelity A / B</th><th>Avg fidelity</th><th>Avg text</th><th>Avg layout</th><th>Latency (score)</th><th>$/image (score)</th><th>Total (4 outputs × 3 criteria, plus latency and cost; max 28)</th><th>Notes</th></tr>${summary}</table>
<h2>Outputs</h2>
<table class="grid"><tr><th>Source</th>${models.map((m) => `<th colspan="${RUNS}">${m.name}</th>`).join('')}</tr>${rows}</table>
<h2>Prompts</h2>${inputs.map((i) => `<h3>${i.key}</h3><pre>${esc(prompt(i.key))}</pre>`).join('')}
</body></html>`;
  await writeFile(HTML_FILE, html);
  console.log(`wrote ${path.basename(HTML_FILE)} (${Object.keys(scores).length} scored)`);
}

async function main() {
  if (process.argv.includes('--html')) return writeHtml();
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is not set. Add it to .env.local (see .env.example).');
  fal.config({ credentials: process.env.FAL_KEY });
  await mkdir(path.join(DIR, 'out'), { recursive: true });
  await mkdir(path.join(DIR, 'thumbs'), { recursive: true });

  const only = arg('only');
  const onlyInput = arg('input');
  // A filtered run without a tag would overwrite results.json, which holds the scored 12.
  if ((only || onlyInput) && !TAG) throw new Error('A filtered run needs --tag <name> so it does not overwrite results.json.');
  const models = MODELS.filter((m) => !only || m.key === only);
  const inputs = INPUTS.filter((i) => !onlyInput || i.key === onlyInput);
  const urls = await prepareSources();
  const jobs = models.flatMap((m) => inputs.flatMap((inp) => Array.from({ length: RUNS }, (_, i) => () => runOne(m, inp, i + 1, urls[inp.key]))));
  console.log(`running ${jobs.length} generations…`);
  // All jobs in parallel, like M4's six parallel jobs, so latency reflects real queueing.
  const results = await Promise.all(jobs.map((j) => j()));
  await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
  const spent = results.filter((r) => r.ok).reduce((a, r) => a + r.usd, 0);
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok, about $${spent.toFixed(2)}`);
  await writeHtml();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
