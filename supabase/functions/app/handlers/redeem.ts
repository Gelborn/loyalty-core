import { supa, getUserFromJWT, balanceFor } from "../lib/db.ts";
import { createDiscountCode, createPriceRule } from "../lib/shopify.ts";
import { preflight, withCors } from "../lib/cors.ts";

function json(data: unknown, status = 200, origin: string | null = null) {
  return withCors(
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    origin
  );
}

export async function handleRedeem(req: Request) {
  // CORS preflight
  const pf = preflight(req);
  if (pf) return pf;

  const origin = req.headers.get("origin");

  // Require JWT
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "Unauthorized" }, 401, origin);

  const user = await getUserFromJWT(token);
  if (!user) return json({ error: "Unauthorized" }, 401, origin);

  const body = await req.json().catch(() => ({}));
  const reward_id = String(body.reward_id || "");
  if (!reward_id) return json({ error: "Missing reward_id" }, 400, origin);

  // Resolve member by user_id
  const { data: member, error: mErr } = await supa
    .from("loyalty_members")
    .select("*")
    .eq("user_id", user.id)
    .single();
  if (mErr || !member) return json({ error: "Member not found" }, 404, origin);

  // Load reward
  const { data: reward, error: rErr } = await supa
    .from("rewards")
    .select("*")
    .eq("id", reward_id)
    .eq("active", true)
    .single();
  if (rErr || !reward) return json({ error: "Invalid reward" }, 400, origin);

  // Balance check
  const { data: bal } = await balanceFor(member.id);
  const points = (bal?.points || 0) as number;
  if (points < reward.cost_points) return json({ error: "Not enough points" }, 400, origin);

  // Ensure (or create) price rule once per reward
  let priceRuleId = reward.shopify_price_rule_id as string | null;
  if (!priceRuleId) {
    const rulePayload =
      reward.discount_type === "percentage"
        ? { value_type: "percentage", value: `-${reward.discount_value}` }
        : { value_type: "fixed_amount", value: `-${reward.discount_value}`, allocation_method: "across" };

    priceRuleId = await createPriceRule(`${reward.name}`, rulePayload);
    await supa.from("rewards")
      .update({ shopify_price_rule_id: String(priceRuleId) })
      .eq("id", reward.id);
  }

  // Create a single-use code under the reusable rule
  const code = `LOYAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await createDiscountCode(priceRuleId!, code);

  // Deduct points and record redemption
  const led = await supa.from("points_ledger").insert({
    member_id: member.id,
    delta_points: -reward.cost_points,
    reason: `redeem:${code}`,
    meta: { reward_id }
  });
  if (led.error) return json({ error: led.error.message }, 500, origin);

  await supa.from("redemptions").insert({
    member_id: member.id,
    reward_id,
    discount_code: code,
    shopify_price_rule_id: String(priceRuleId)
  });

  return json({ code }, 200, origin);
}
