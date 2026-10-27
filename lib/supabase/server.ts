// Server-side Supabase client, authenticated with the secret key (service_role, bypasses RLS).
// `server-only` makes any import from a Client Component a build error, so the secret key
// can never be bundled for the browser. Scripts run under tsx with --conditions=react-server
// for the same reason.
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export type Db = SupabaseClient<Database>;

let client: Db | undefined;

export function supabaseServer(): Db {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example).');
  // No user sessions on the server: there is no Auth, and a shared client must not hold one.
  client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export const BUCKET = 'ads';
