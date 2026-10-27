-- M1 schema (PLAN.md §4). Single demo user, no Auth: the server writes with the secret key
-- (service_role, which bypasses RLS); browsers only read, through the publishable key (anon).

-- ── Enums ────────────────────────────────────────────────────────────────────
create type brand_status   as enum ('researching','draft','confirmed');
create type campaign_goal  as enum ('sale','launch','evergreen','seasonal');
create type ad_angle       as enum ('benefit','social_proof','offer','aesthetic','guarantee');
create type variant_status as enum ('generating','draft','approved','rejected','failed');
create type asset_kind     as enum ('logo','product_image','ad_render','ad_raw');
create type feedback_scope as enum ('ad','campaign');

-- ── Tables ───────────────────────────────────────────────────────────────────
-- brand_kits ↔ assets and ads ↔ ad_variants reference each other, so those two
-- foreign keys are added after both sides exist.

create table brand_kits (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid,                                   -- null until Auth exists
  store_url     text not null,
  domain        text not null unique,                   -- each domain researched once; a rerun refreshes it
  name          text,
  logo_asset_id uuid,                                   -- fk added below
  colors        jsonb,                                  -- {primary,secondary,accent,background,text}
  fonts         text[] not null default '{}',
  voice         jsonb,                                  -- {adjectives[], sample}
  value_prop    text,
  audience      text,
  claims        text[] not null default '{}',           -- each a verbatim substring of the site
  raw           jsonb,                                  -- Firecrawl + meta, for debugging
  status        brand_status not null default 'researching',
  created_at    timestamptz not null default now()
);

create table products (
  id               uuid primary key default gen_random_uuid(),
  brand_kit_id     uuid not null references brand_kits on delete cascade,
  shopify_id       bigint not null,
  handle           text not null,
  title            text not null,
  product_type     text,
  tags             text[] not null default '{}',        -- already filtered of internal tags
  price            numeric(10,2) not null,
  compare_at_price numeric(10,2),                       -- only a real value here allows offer copy
  available        boolean not null default true,
  description      text,
  images           jsonb not null default '[]',         -- [{src,position,isHero}], CDN URLs only
  rank             int,
  rank_reason      text,
  created_at       timestamptz not null default now(),
  unique (brand_kit_id, shopify_id)
);

create table assets (
  id           uuid primary key default gen_random_uuid(),
  brand_kit_id uuid not null references brand_kits on delete cascade,
  kind         asset_kind not null,
  storage_path text not null unique,                    -- path inside the "ads" bucket
  source_url   text,                                    -- Shopify or fal origin, never served
  width        int,
  height       int,
  mime         text,
  created_at   timestamptz not null default now()
);

alter table brand_kits
  add constraint brand_kits_logo_asset_id_fkey
  foreign key (logo_asset_id) references assets on delete set null;

create table campaigns (
  id           uuid primary key default gen_random_uuid(),
  brand_kit_id uuid not null references brand_kits on delete cascade,
  owner_id     uuid,
  name         text,
  goal         campaign_goal not null,
  product_ids  uuid[] not null default '{}',
  chat         jsonb not null default '[]',             -- UIMessage[] so a reload restores the chat
  created_at   timestamptz not null default now()
);

create table ads (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references campaigns on delete cascade,
  product_id         uuid not null references products on delete cascade,
  angle              ad_angle not null,
  source_asset_id    uuid references assets on delete set null,  -- the product photo used
  current_variant_id uuid,                                       -- fk added below
  created_at         timestamptz not null default now()
);

create table ad_variants (
  id                uuid primary key default gen_random_uuid(),
  ad_id             uuid not null references ads on delete cascade,
  campaign_id       uuid not null references campaigns on delete cascade,  -- denormalized for the Realtime filter
  parent_variant_id uuid references ad_variants on delete set null,
  version           int not null default 1,
  headline          text not null,
  cta               text not null,
  prompt            text,                               -- the exact prompt sent to fal
  model             text,
  fal_request_id    text,                               -- lets the stuck sweep recover a finished job
  asset_id          uuid references assets on delete set null,  -- final render; never a fal URL
  status            variant_status not null default 'generating',
  error             text,
  text_check        jsonb,                              -- vision check result (PLAN.md §5)
  cost_usd          numeric(10,4),
  created_at        timestamptz not null default now(),
  unique (ad_id, version)
);

alter table ads
  add constraint ads_current_variant_id_fkey
  foreign key (current_variant_id) references ad_variants on delete set null;

create table feedback (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns on delete cascade,
  scope       feedback_scope not null,
  ad_id       uuid references ads on delete cascade,
  variant_id  uuid references ad_variants on delete set null,
  text        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  -- ad feedback must name its ad; campaign rules must not
  constraint feedback_scope_matches_ad check ((scope = 'ad') = (ad_id is not null))
);

-- ── Indexes (foreign keys used in filters, plus the stuck-variant sweep) ──────
create index products_brand_kit_rank_idx on products (brand_kit_id, rank);
create index assets_brand_kit_idx        on assets (brand_kit_id);
create index campaigns_brand_kit_idx     on campaigns (brand_kit_id);
create index ads_campaign_idx            on ads (campaign_id);
create index ad_variants_campaign_idx    on ad_variants (campaign_id);
create index ad_variants_ad_idx          on ad_variants (ad_id);
create index ad_variants_generating_idx  on ad_variants (created_at) where status = 'generating';
create index feedback_campaign_idx       on feedback (campaign_id, scope) where active;

-- ── Row level security ───────────────────────────────────────────────────────
-- Read-only for browsers. Ownership lives on brand_kits and campaigns; child tables
-- inherit it through their parent. There are no insert/update/delete policies, so
-- only the server's secret key can write. Adding Auth later means populating owner_id
-- and dropping the "owner_id is null" clause.

alter table brand_kits  enable row level security;
alter table products    enable row level security;
alter table assets      enable row level security;
alter table campaigns   enable row level security;
alter table ads         enable row level security;
alter table ad_variants enable row level security;
alter table feedback    enable row level security;

create policy "read own brand kits" on brand_kits for select to anon, authenticated
  using (owner_id is null or owner_id = (select auth.uid()));

create policy "read own campaigns" on campaigns for select to anon, authenticated
  using (owner_id is null or owner_id = (select auth.uid()));

create policy "read products of own brand kits" on products for select to anon, authenticated
  using (exists (select 1 from brand_kits b where b.id = brand_kit_id));

create policy "read assets of own brand kits" on assets for select to anon, authenticated
  using (exists (select 1 from brand_kits b where b.id = brand_kit_id));

-- These subqueries are themselves filtered by the parent's RLS policy above.
create policy "read ads of own campaigns" on ads for select to anon, authenticated
  using (exists (select 1 from campaigns c where c.id = campaign_id));

create policy "read variants of own campaigns" on ad_variants for select to anon, authenticated
  using (exists (select 1 from campaigns c where c.id = campaign_id));

create policy "read feedback of own campaigns" on feedback for select to anon, authenticated
  using (exists (select 1 from campaigns c where c.id = campaign_id));

-- Belt and braces: browsers never write, even if a permissive policy is added by mistake.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────────────
-- The grid subscribes to ad_variants changes filtered by campaign_id. Realtime checks
-- the subscriber's select policy before delivering each change.
alter publication supabase_realtime add table ad_variants;

-- ── Storage ──────────────────────────────────────────────────────────────────
-- One public-read bucket. No storage.objects policies for anon/authenticated, so
-- uploads only work with the secret key. Paths are listed in PLAN.md §4.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ads', 'ads', true, 20971520, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;
