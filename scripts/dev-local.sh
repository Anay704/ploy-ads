#!/usr/bin/env bash
# Runs the app against the local Supabase stack (npx supabase start) instead of the hosted
# project in .env.local. Real env vars win over .env.local in Next, so only the three Supabase
# values change; FAL, Firecrawl and Anthropic keys still come from .env.local.
set -euo pipefail
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|PUBLISHABLE_KEY|SECRET_KEY)=')"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" SUPABASE_SECRET_KEY="$SECRET_KEY"
exec npx next dev "$@"
