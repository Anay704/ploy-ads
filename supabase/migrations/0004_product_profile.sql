-- Per-product profile for the image prompt (lib/profile.ts): category, held/worn/placed, how it
-- looks in use, and the 3-5 visual features read from the actual photo. Filled once per product
-- by a vision call, during research for the picks and on first generation for a swapped-in one.
alter table products add column profile jsonb;
