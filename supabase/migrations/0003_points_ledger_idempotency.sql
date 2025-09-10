-- 0003: Idempotency for points_ledger
-- Prevent duplicate credits/debits when Shopify retries deliveries.

-- Unique reason per member: "order:<id>" / "refund:<id>" / "redeem:<rid>" etc.
create unique index if not exists uq_points_ledger_member_reason
  on public.points_ledger (member_id, reason);

-- Optional helpers
create index if not exists idx_points_ledger_reason_prefix
  on public.points_ledger (reason);

-- (No RLS changes needed; your 0001 already restricts writes to service_role.)
