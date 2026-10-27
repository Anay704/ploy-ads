-- M2 review decisions (NOTES.md, M2).
-- short_name: what ad prompts call the brand ("Loopy"); name keeps the site's exact form
-- ("Loopy®Cases") for display. Both are editable in the review card.
-- claim_groups: claims grouped by topic ([{topic, claims[]}]) so copy generation uses one
-- claim per group and two ads in a round don't lean on the same fact.
alter table brand_kits
  add column short_name   text,
  add column claim_groups jsonb not null default '[]';
