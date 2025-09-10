-- 0004: Qualify columns to avoid "column reference cost_points is ambiguous"
-- - Keeps the same function signatures from 0002
-- - Fully-qualifies all table columns with aliases
-- - No behavior change besides removing ambiguity

-- Begin a redemption (qualified)
create or replace function public.redeem_begin(
  p_member_id uuid,
  p_reward_id uuid
)
returns table (redemption_id uuid, cost_points int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points int;
  v_cost   int;
  v_redemption_id uuid;
begin
  -- serialize for this member
  perform 1
  from public.loyalty_members m
  where m.id = p_member_id
  for update;

  -- current balance
  select coalesce(sum(l.delta_points), 0)::int
    into v_points
  from public.points_ledger l
  where l.member_id = p_member_id;

  -- reward cost (must be active) - fully qualified
  select r.cost_points
    into v_cost
  from public.rewards r
  where r.id = p_reward_id
    and r.active is true;

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
  values (p_member_id, -v_cost, 'redeem:' || v_redemption_id, jsonb_build_object('reward_id', p_reward_id));

  -- return id + cost (keep original signature)
  redemption_id := v_redemption_id;
  cost_points   := v_cost;
  return next;
end;
$$;

-- Commit a redemption (qualified)
create or replace function public.redeem_commit(
  p_redemption_id uuid,
  p_discount_code text,
  p_price_rule_id text
)
returns void
language sql
set search_path = public
as $$
  update public.redemptions r
     set discount_code = p_discount_code,
         shopify_price_rule_id = p_price_rule_id,
         status = 'issued'
   where r.id = p_redemption_id
     and r.status = 'pending';
$$;

-- Cancel redemption (qualified)
create or replace function public.redeem_cancel(
  p_redemption_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member uuid;
  v_cost   int;
begin
  -- find the earlier deduction we made in redeem_begin
  select l.member_id, -l.delta_points
    into v_member, v_cost
  from public.points_ledger l
  where l.reason = 'redeem:' || p_redemption_id
  limit 1;

  -- if not found, still flip status
  if v_member is null then
    update public.redemptions r
       set status = 'canceled'
     where r.id = p_redemption_id
       and r.status = 'pending';
    return;
  end if;

  -- compensate points
  insert into public.points_ledger (member_id, delta_points, reason, meta)
  values (v_member, v_cost, 'redeem_cancel:' || p_redemption_id, '{}'::jsonb);

  -- mark canceled
  update public.redemptions r
     set status = 'canceled'
   where r.id = p_redemption_id
     and r.status = 'pending';
end;
$$;
