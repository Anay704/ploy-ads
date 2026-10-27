// Download an approved ad (PLAN.md §1 step 4: download appears once approved). Served from our
// own route so the browser saves the file with a readable name instead of opening a
// cross-origin Storage URL.

import { BUCKET, supabaseServer } from '@/lib/supabase/server';

export async function GET(_req: Request, { params }: { params: Promise<{ variantId: string }> }) {
  const { variantId } = await params;
  const db = supabaseServer();
  const { data: v } = await db
    .from('ad_variants')
    .select('status, version, render:assets!ad_variants_asset_id_fkey(storage_path), ads!ad_variants_ad_id_fkey(angle, products(title)), campaigns(brand_kits(short_name))')
    .eq('id', variantId)
    .maybeSingle();
  if (!v?.render) return new Response('not found', { status: 404 });
  if (v.status !== 'approved') return new Response('approve this ad before downloading it', { status: 403 });

  const file = await db.storage.from(BUCKET).download(v.render.storage_path);
  if (file.error) return new Response('could not read the file', { status: 502 });
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const name = [v.campaigns?.brand_kits?.short_name, v.ads?.products?.title, v.ads?.angle, `v${v.version}`].filter(Boolean).map((x) => slug(String(x))).join('-');
  return new Response(file.data, {
    headers: { 'content-type': 'image/png', 'content-disposition': `attachment; filename="${name}.png"` },
  });
}
