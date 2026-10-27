// M1 "done when" checks (PLAN.md §8), against whichever Supabase .env.local points at:
//   1. Storage + assets: upload a PNG to the "ads" bucket with the secret key, record it in
//      `assets`, and download it back through the public URL.
//   2. Realtime: subscribe to ad_variants with the publishable key (as the browser grid
//      will), update a row with the secret key, and wait for the change to arrive.
//   3. RLS: the publishable key can read but cannot write rows or upload files.
// Everything it creates hangs off one brand kit for the domain "m1-verify.test" and is
// deleted at the end, unless --keep is passed.
//
//   npm run verify:m1
//   npm run verify:m1 -- --keep

import sharp from 'sharp';
import { supabaseServer, BUCKET } from '../lib/supabase/server';
import { supabaseBrowser } from '../lib/supabase/client';

const DOMAIN = 'm1-verify.test';
const keep = process.argv.includes('--keep');
const db = supabaseServer();
const anon = supabaseBrowser();

function ok(msg: string) {
  console.log(`✓ ${msg}`);
}

// Typed over the whole response because supabase-js returns a union ({data, error: null} |
// {data: null, error}), from which TS 5 infers `never` for a bare `T | null` parameter.
function must<R extends { data: unknown; error: { message: string } | null }>(res: R, what: string): NonNullable<R['data']> {
  if (res.error || res.data === null) throw new Error(`${what}: ${res.error?.message ?? 'no data'}`);
  return res.data as NonNullable<R['data']>;
}

async function cleanup() {
  const kits = must(await db.from('brand_kits').select('id').eq('domain', DOMAIN), 'find old test kit');
  for (const k of kits) {
    const files = must(await db.storage.from(BUCKET).list(`brands/${k.id}`), 'list test files');
    if (files.length) await db.storage.from(BUCKET).remove(files.map((f) => `brands/${k.id}/${f.name}`));
    must(await db.from('brand_kits').delete().eq('id', k.id).select('id'), 'delete test kit'); // cascades
  }
}

async function main() {
  await cleanup(); // a previous --keep run leaves rows behind; start clean

  // ── 1. Storage upload and download through `assets` ──────────────────────────
  const kit = must(
    await db.from('brand_kits').insert({ store_url: `https://${DOMAIN}`, domain: DOMAIN, name: 'M1 verify', status: 'draft' }).select().single(),
    'insert brand kit',
  );
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#F88A8A' } }).png().toBuffer();
  const path = `brands/${kit.id}/logo.png`;
  must(await db.storage.from(BUCKET).upload(path, png, { contentType: 'image/png', upsert: true }), 'upload');
  const asset = must(
    await db.from('assets').insert({ brand_kit_id: kit.id, kind: 'logo', storage_path: path, width: 64, height: 64, mime: 'image/png' }).select().single(),
    'insert asset',
  );
  must(await db.from('brand_kits').update({ logo_asset_id: asset.id }).eq('id', kit.id).select('id'), 'link logo');
  ok(`uploaded ${path} and recorded asset ${asset.id}`);

  const publicUrl = db.storage.from(BUCKET).getPublicUrl(asset.storage_path).data.publicUrl;
  const res = await fetch(publicUrl);
  const back = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !back.equals(png)) throw new Error(`public download mismatch (${res.status}, ${back.length} bytes)`);
  ok(`downloaded it back through the public URL, ${back.length} bytes, identical`);

  // ── 2. Realtime update on ad_variants ────────────────────────────────────────
  const product = must(
    await db.from('products').insert({ brand_kit_id: kit.id, shopify_id: 1, handle: 'test', title: 'Test case', price: 39.99 }).select().single(),
    'insert product',
  );
  const campaign = must(await db.from('campaigns').insert({ brand_kit_id: kit.id, goal: 'evergreen', product_ids: [product.id] }).select().single(), 'insert campaign');
  const ad = must(await db.from('ads').insert({ campaign_id: campaign.id, product_id: product.id, angle: 'aesthetic' }).select().single(), 'insert ad');
  const variant = must(
    await db.from('ad_variants').insert({ ad_id: ad.id, campaign_id: campaign.id, headline: 'Style you can hold onto', cta: 'Shop Now' }).select().single(),
    'insert variant',
  );

  let onChange: (row: { status: string }) => void = () => {};
  const received = new Promise<{ status: string }>((resolve) => (onChange = resolve));
  // SUBSCRIBED only means the channel joined. On a cold Realtime the Postgres change feed
  // comes up later, and changes made before then are never delivered (no replay). Realtime
  // sends a system message once the feed is live, so wait for that instead.
  const subscribed = new Promise<void>((resolve, reject) => {
    anon
      .channel(`verify-${campaign.id}`)
      .on('system', {}, (msg: { extension?: string; status?: string; message?: string }) => {
        if (msg.extension !== 'postgres_changes') return;
        if (msg.status === 'ok') resolve();
        else reject(new Error(`Realtime postgres_changes: ${msg.message}`));
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ad_variants', filter: `campaign_id=eq.${campaign.id}` }, (payload) =>
        onChange(payload.new as { status: string }),
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`Realtime ${status}: ${err?.message ?? ''}`));
      });
  });
  await subscribed;
  ok('subscribed to ad_variants with the publishable key, change feed live');

  const t0 = Date.now();
  must(await db.from('ad_variants').update({ status: 'draft' }).eq('id', variant.id).select('id'), 'update variant');
  const row = await Promise.race([
    received,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no Realtime event within 15s')), 15_000)),
  ]);
  await anon.removeAllChannels();
  if (row.status !== 'draft') throw new Error(`expected status draft, got ${row.status}`);
  ok(`Realtime delivered the update in ${Date.now() - t0}ms, carrying status '${row.status}'`);

  // ── 3. RLS: publishable key reads but cannot write ───────────────────────────
  const seen = must(await anon.from('ad_variants').select('id').eq('id', variant.id), 'anon read');
  if (seen.length !== 1) throw new Error('anon cannot read the variant');
  const write = await anon.from('ad_variants').update({ status: 'approved' }).eq('id', variant.id).select('id');
  if (!write.error && write.data?.length) throw new Error('anon was able to update a row');
  const upload = await anon.storage.from(BUCKET).upload(`brands/${kit.id}/anon.png`, png, { contentType: 'image/png' });
  if (!upload.error) throw new Error('anon was able to upload a file');
  ok('publishable key can read, but cannot update rows or upload files');

  if (keep) console.log(`kept test data (brand kit ${kit.id}); the next run cleans it up`);
  else {
    await cleanup();
    ok('cleaned up test data');
  }
  console.log('\nM1 checks passed.');
}

main()
  .then(() => process.exit(0)) // the Realtime socket would otherwise keep the process alive
  .catch((e) => {
    console.error(`✗ ${e.message ?? e}`);
    process.exit(1);
  });
