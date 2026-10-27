// M2: run store research end to end, without the agent, and print what the review card will show.
//   npm run research -- loopycases.com
//   npm run research -- https://loopycases.com/products/black-bows
//   npm run research -- loopycases.com --fresh   ignore the cached Firecrawl scrape

import { research } from '../lib/research';

async function main() {
  const url = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!url) throw new Error('usage: npm run research -- <store or product URL>');
  const t0 = Date.now();
  const result = await research(url, (step) => console.log(`${step.status === 'done' ? '✓' : '…'} ${step.label}`), {
    freshScrape: process.argv.includes('--fresh'),
  });

  if ('error' in result) {
    console.log(`\n${result.error}: ${result.url}`);
    console.log("We currently support Shopify stores. This one doesn't expose a Shopify catalog.");
    return;
  }

  const k = result.brandKit;
  console.log(`\nBRAND KIT  (brand_kits.id ${result.brandKitId})`);
  console.log(`  name        ${k.name}   (in ad prompts: ${k.shortName})`);
  console.log(`  logo        ${k.logoUrl ?? 'none'}  [from ${k.sources.logo}]`);
  console.log(`  colors      ${k.colors ? Object.entries(k.colors).map(([n, v]) => `${n} ${v}`).join(' · ') : 'none'}  [from ${k.sources.colors}]`);
  console.log(`  fonts       ${k.fonts.join(', ') || 'none'}`);
  console.log(`  voice       ${k.voice.adjectives.join(', ')}: "${k.voice.sample}"`);
  console.log(`  value prop  ${k.valueProp}`);
  console.log(`  audience    ${k.audience}`);
  console.log(`  claims      ${k.claimGroups.length ? k.claimGroups.map((g) => `[${g.topic}] ${g.claims.map((c) => `"${c}"`).join(' · ')}`).join('\n              ') : 'none'}`);
  if (k.rejectedClaims.length) console.log(`  rejected    ${k.rejectedClaims.map((r) => `"${r.claim}"  (${r.reason})`).join('\n              ')}`);
  console.log(`  firecrawl   ${k.sources.firecrawl}`);

  console.log(`\nTOP 3 PRODUCTS  (of ${result.catalogCount} in the catalog)`);
  result.recommended.forEach((p, i) => {
    const price = p.compareAtPrice ? `$${p.price} (was $${p.compareAtPrice})` : `$${p.price}`;
    console.log(`  ${i + 1}. ${p.title}  ${price}`);
    console.log(`     why: ${p.reason}`);
    console.log(`     photo: ${p.imageUrl}`);
  });

  if (result.skipped.length) console.log(`\n  skipped: ${result.skipped.map((s) => `${s.title}: ${s.reason}`).join('\n           ')}`);
  console.log(`\nSUGGESTED GOAL  ${result.suggestedGoal}`);
  console.log(`\nWHAT THE AGENT WILL SEE (top ${result.candidates.length} candidates)`);
  for (const c of result.candidates) console.log(`  ${c}`);
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  // Gateway errors carry the useful message in the response body; the stack is noise here.
  const body = (e as { cause?: { responseBody?: string } }).cause?.responseBody;
  let detail = (e as Error).message;
  try {
    if (body) detail = JSON.parse(body).error?.message ?? detail;
  } catch {}
  console.error(`\n✗ research failed: ${detail}`);
  process.exit(1);
});
