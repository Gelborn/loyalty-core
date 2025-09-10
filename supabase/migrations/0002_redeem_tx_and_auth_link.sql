-- 0002: auth link, reusable price rules, two-phase redeem (pending → issued/canceled)
-- Safe, incremental changes on top of your 0001.

-- 1) Link loyalty_members to auth.users
alter table public.loyalty_members
  add column if not exists user_id uuid unique;

-- 2) Reusable price rule per reward
alter table public.rewards
  add column if not exists shopify_price_rule_id text;

-- 3) Two-phase redemption
-- 3a) make discount_code nullable (filled at commit)
alter table public.redemptions
  alter column discount_code drop not null;

-- 3b) add status with check + default
alter table public.redemptions
  add column if not exists status text
    default 'pending';

-- ensure check constraint (create if missing)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'redemptions_status_check'
  ) then
    alter table public.redemptions
      add constraint redemptions_status_check
      check (status in ('pending','issued','canceled'));
  end if;
end$$;

-- 4) Helpful indexes
create index if not exists idx_points_ledger_member on public.points_ledger (member_id);
create index if not exists idx_redemptions_member   on public.redemptions (member_id);
create index if not exists idx_rewards_active       on public.rewards (active);

-- 5) Transactional helpers (RPCs)

-- Begin a redemption:
--  - lock member row (serializes competing redemptions)
--  - compute balance
--  - ensure balance >= cost
--  - insert redemptions(status='pending')
--  - deduct points via ledger: reason 'redeem:<redemption_id>'
-- Returns (redemption_id, cost_points)
create or replace function public.redeem_begin(p_member_id uuid, p_reward_id uuid)
returns table (redemption_id uuid, cost_points int)
language plpgsql
as $$
declare
  v_points int;
  v_cost   int;
  v_redemption_id uuid;
begin
  -- serialize for this member
  perform 1 from public.loyalty_members where id = p_member_id for update;

  -- current balance
  select coalesce(sum(delta_points),0)::int
    into v_points
  from public.points_ledger
  where member_id = p_member_id;

  -- reward cost (must be active)
  select cost_points
    into v_cost
  from public.rewards
  where id = p_reward_id
    and active = true;

  if v_cost is null then
    raise exception 'Invalid or inactive reward %', p_reward_id using errcode = '22023';
  end if;

  if v_points < v_cost then
    raise exception 'Insufficient points: have %, need %', v_points, v_cost using errcode = 'P0001';
  end if;

  -- create pending redemption
  insert into public.redemptions (member_id, reward_id, status)
  values (p_member_id, p_reward_id, 'pending')
  returning id into v_redemption_id;

  -- deduct points now (atomic within this tx)
  insert into public.points_ledger (member_id, delta_points, reason, meta)
  values (p_member_id, -v_cost, 'redeem:'||v_redemption_id, jsonb_build_object('reward_id', p_reward_id));

  return query select v_redemption_id, v_cost;
end;
$$;

-- Commit a redemption after creating the external code
create or replace function public.redeem_commit(
  p_redemption_id uuid,
  p_discount_code text,
  p_price_rule_id text
)
returns void
language sql
as $$
  update public.redemptions r
     set discount_code = p_discount_code,
         shopify_price_rule_id = p_price_rule_id,
         status = 'issued'
   where r.id = p_redemption_id
     and r.status = 'pending';
$$;

-- Cancel redemption on failure (adds compensating ledger entry)
create or replace function public.redeem_cancel(p_redemption_id uuid)
returns void
language plpgsql
as $$
declare
  v_member uuid;
  v_cost int;
begin
  -- find the earlier deduction we made in redeem_begin
  select l.member_id, -l.delta_points
    into v_member, v_cost
  from public.points_ledger l
  where l.reason = 'redeem:'||p_redemption_id
  limit 1;

  -- if not found, still flip status
  if v_member is null then
    update public.redemptions
       set status = 'canceled'
     where id = p_redemption_id
       and status = 'pending';
    return;
  end if;

  -- compensate points
  insert into public.points_ledger (member_id, delta_points, reason, meta)
  values (v_member, v_cost, 'redeem_cancel:'||p_redemption_id, '{}'::jsonb);

  -- mark canceled
  update public.redemptions
     set status = 'canceled'
   where id = p_redemption_id
     and status = 'pending';
end;
$$;

-- RLS: no changes required here; writes are already service_role-only per 0001.
