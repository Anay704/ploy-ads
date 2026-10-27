-- M3: a campaign row exists from the moment research starts, so the chat has somewhere to be
-- saved and a reload mid-research restores it. It is 'briefing' until the marketer clicks
-- Generate on the review card (confirmBrief), which fills in goal and products and makes it
-- 'active'.
create type campaign_status as enum ('briefing', 'active');

alter table campaigns
  add column status     campaign_status not null default 'briefing',
  add column source_url text,                 -- what the marketer pasted: a store or a product URL
  alter column goal drop not null;            -- unknown until the brief is confirmed

alter table campaigns
  add constraint campaigns_active_has_brief check (status = 'briefing' or (goal is not null and cardinality(product_ids) > 0));
