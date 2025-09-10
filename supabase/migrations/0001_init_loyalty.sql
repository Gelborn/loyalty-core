-- Extensions
create extension if not exists citext;

-- =========================
-- Core tables
-- =========================

create table public.loyalty_members (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  created_at timestamptz default now()
);

create table public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.loyalty_members(id) on delete cascade,
  delta_points integer not null, -- +earn / -spend / -refund
  reason text not null,          -- "order:123", "refund:456", "redeem:CODE"
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table public.rewards (
  id uuid primary key default gen_random_uuid(),
  name text not null,                  -- e.g., "10% OFF"
  cost_points integer not null,        -- e.g., 100
  discount_type text not null check (discount_type in ('percentage','fixed_amount')),
  discount_value numeric not null,     -- 10 for 10% ; 25 for R$25
  active boolean default true
);

create table public.redemptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.loyalty_members(id) on delete cascade,
  reward_id uuid not null references public.rewards(id),
  discount_code text not null unique,
  shopify_price_rule_id text,
  created_at timestamptz default now()
);

-- =========================
-- View (reads balance; RLS flows through with security_invoker)
-- =========================
create view public.member_balances
with (security_invoker = on) as
select
  m.id as member_id,
  m.email,
  coalesce(sum(l.delta_points), 0)::int as points
from public.loyalty_members m
left join public.points_ledger l on l.member_id = m.id
group by m.id;

-- Optional seed
insert into public.rewards (name, cost_points, discount_type, discount_value)
values ('10% OFF', 100, 'percentage', 10);

-- =========================
-- RLS & Policies
-- =========================
alter table public.loyalty_members enable row level security;
alter table public.points_ledger  enable row level security;
alter table public.rewards        enable row level security;
alter table public.redemptions    enable row level security;

-- READ (SELECT) for app users (anon + authenticated).
-- If you want to restrict to authenticated only, remove 'anon' below.
create policy "read_select_users_loyalty_members"
  on public.loyalty_members for select
  to anon, authenticated
  using (true);

create policy "read_select_users_points_ledger"
  on public.points_ledger for select
  to anon, authenticated
  using (true);

create policy "read_select_users_rewards"
  on public.rewards for select
  to anon, authenticated
  using (true);

create policy "read_select_users_redemptions"
  on public.redemptions for select
  to anon, authenticated
  using (true);

-- WRITE (ALL) only for service_role
create policy "write_service_role_loyalty_members"
  on public.loyalty_members for all
  to service_role
  using (true) with check (true);

create policy "write_service_role_points_ledger"
  on public.points_ledger for all
  to service_role
  using (true) with check (true);

create policy "write_service_role_rewards"
  on public.rewards for all
  to service_role
  using (true) with check (true);

create policy "write_service_role_redemptions"
  on public.redemptions for all
  to service_role
  using (true) with check (true);

-- (Optional but nice) lock down privileges at SQL level too.
revoke all on table public.loyalty_members from anon, authenticated;
revoke all on table public.points_ledger  from anon, authenticated;
revoke all on table public.rewards        from anon, authenticated;
revoke all on table public.redemptions    from anon, authenticated;

grant select on table public.loyalty_members to anon, authenticated;
grant select on table public.points_ledger  to anon, authenticated;
grant select on table public.rewards        to anon, authenticated;
grant select on table public.redemptions    to anon, authenticated;

-- Views use underlying table policies; granting select is sufficient:
grant select on table public.member_balances to anon, authenticated;
