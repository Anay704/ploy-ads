// Browser Supabase client, authenticated with the publishable key (anon role). It can only
// read, as the RLS policies allow, and it is used for the Realtime grid subscription.
// Safe to bundle: the publishable key is meant to be public.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

let client: SupabaseClient<Database> | undefined;

export function supabaseBrowser(): SupabaseClient<Database> {
  if (client) return client;
  // Referenced literally so Next inlines them at build time.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (see .env.example).');
  client = createClient<Database>(url, key);
  return client;
}
