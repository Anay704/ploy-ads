// Download an approved ad (PLAN.md §1 step 4: download appears once approved). The route checks
// approval, then redirects to Storage with a download filename. It doesn't stream the file
// itself: a final render is ~5 MB and Vercel functions cap a response at 4.5 MB.

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

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const name = [v.campaigns?.brand_kits?.short_name, v.ads?.products?.title, v.ads?.angle, `v${v.version}`].filter(Boolean).map((x) => slug(String(x))).join('-');
  // Storage sets Content-Disposition: attachment with this name when ?download= is present.
  const url = db.storage.from(BUCKET).getPublicUrl(v.render.storage_path, { download: `${name}.png` }).data.publicUrl;
  return Response.redirect(url, 302);
}
