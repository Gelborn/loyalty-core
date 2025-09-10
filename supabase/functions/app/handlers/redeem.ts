import { supa, getUserFromJWT, balanceFor } from "../lib/db.ts";
import { createDiscountCode, createPriceRule } from "../lib/shopify.ts";
import { preflight, withCors } from "../lib/cors.ts";

function json(data: unknown, status = 200) {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export async function handleRedeem(req: Request) {
  // ✅ CORS preflight sempre com headers
  const pf = preflight(req);
  if (pf) return withCors(pf);

  // Require JWT
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "Unauthorized" }, 401);

  const user = await getUserFromJWT(token);
  if (!user) return json({ error: "Unauthorized" }, 401);

  // Body
  const body = await req.json().catch(() => ({}));
  const reward_id = String(body.reward_id || "");
  if (!reward_id) return json({ error: "Missing reward_id" }, 400);

  // Resolve member by user_id
  const { data: member, error: mErr } = await supa
    .from("loyalty_members")
    .select("*")
    .eq("user_id", user.id)
    .single();
  if (mErr || !member) return json({ error: "Member not found" }, 404);

  // Load reward
  const { data: reward, error: rErr } = await supa
    .from("rewards")
    .select("*")
    .eq("id", reward_id)
    .eq("active", true)
    .single();
  if (rErr || !reward) return json({ error: "Invalid reward" }, 400);

  // Fast-path balance check (o lock real ocorre no redeem_begin)
  const { data: bal } = await balanceFor(member.id);
  if ((bal?.points || 0) < reward.cost_points)
    return json({ error: "Not enough points" }, 400);

  // Ensure (ou cria) price rule 1x por reward
  let priceRuleId = (reward.shopify_price_rule_id as string) || null;
  if (!priceRuleId) {
    const rulePayload =
      reward.discount_type === "percentage"
        ? { value_type: "percentage", value: `-${reward.discount_value}` }
        : {
            value_type: "fixed_amount",
            value: `-${reward.discount_value}`,
            allocation_method: "across",
          };
    priceRuleId = await createPriceRule(`${reward.name}`, rulePayload);
    await supa
      .from("rewards")
      .update({ shopify_price_rule_id: String(priceRuleId) })
      .eq("id", reward.id);
  }

  // === Phase 1: begin
  const begin = await supa.rpc("redeem_begin", {
    p_member_id: member.id,
    p_reward_id: reward.id,
  });
  if (begin.error) return json({ error: begin.error.message }, 400);

  const row = (begin.data || [])[0];
  const redemption_id: string | undefined = row?.redemption_id;
  if (!redemption_id) return json({ error: "Redeem begin failed" }, 500);

  // === Cria discount code único
  const code = `LOYAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    await createDiscountCode(priceRuleId!, code);

    // === Phase 2: commit
    const commit = await supa.rpc("redeem_commit", {
      p_redemption_id: redemption_id,
      p_discount_code: code,
      p_price_rule_id: String(priceRuleId),
    });
    if (commit.error) {
      await supa.rpc("redeem_cancel", { p_redemption_id: redemption_id }).catch(() => {});
      return json({ error: "Commit failed" }, 500);
    }

    return json({ code }, 200);
  } catch (err) {
    await supa.rpc("redeem_cancel", { p_redemption_id: redemption_id }).catch(() => {});
    return json({ error: `Discount creation failed: ${(err as Error).message}` }, 502);
  }
}
