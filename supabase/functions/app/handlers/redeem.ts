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

  // Body
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

  // (Optional fast path) show current balance; the real check happens inside redeem_begin
  const { data: bal } = await balanceFor(member.id);
  if ((bal?.points || 0) < reward.cost_points)
    return json({ error: "Not enough points" }, 400, origin);

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

  // === Phase 1: begin DB transaction (locks member, verifies balance, deducts points, creates pending redemption)
  const begin = await supa.rpc("redeem_begin", {
    p_member_id: member.id,
    p_reward_id: reward.id,
  });
  if (begin.error) return json({ error: begin.error.message }, 400, origin);
  const row = (begin.data || [])[0];
  const redemption_id: string | undefined = row?.redemption_id;
  if (!redemption_id) return json({ error: "Redeem begin failed" }, 500, origin);

  // === External call: create single-use code under reusable rule
  const code = `LOYAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    await createDiscountCode(priceRuleId!, code);

    // === Phase 2 (commit): mark issued + record code + rule id
    const commit = await supa.rpc("redeem_commit", {
      p_redemption_id: redemption_id,
      p_discount_code: code,
      p_price_rule_id: String(priceRuleId),
    });
    if (commit.error) {
      // best-effort compensation
      await supa.rpc("redeem_cancel", { p_redemption_id: redemption_id });
      return json({ error: "Commit failed" }, 500, origin);
    }

    return json({ code }, 200, origin);
  } catch (e) {
    // compensation: restore points & cancel redemption
    await supa.rpc("redeem_cancel", { p_redemption_id: redemption_id }).catch(() => {});
    return json({ error: "Discount creation failed" }, 502, origin);
  }
}
