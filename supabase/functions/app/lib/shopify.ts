const SHOP_DOMAIN = Deno.env.get("SHOP_DOMAIN")!;
const ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN")!;

export async function createPriceRule(title: string, rulePayload: Record<string, unknown>) {
  const resp = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-10/price_rules.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": ADMIN_TOKEN },
    body: JSON.stringify({
      price_rule: {
        title,
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        customer_selection: "all",
        starts_at: new Date().toISOString(),
        usage_limit: null, // unlimited for the rule; each code can still be single-use
        ...rulePayload
      }
    }),
  });
  if (!resp.ok) throw new Error("Price rule failed");
  const j = await resp.json();
  return j?.price_rule?.id as string;
}

export async function createDiscountCode(priceRuleId: string, code: string) {
  const resp = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-10/price_rules/${priceRuleId}/discount_codes.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": ADMIN_TOKEN },
    body: JSON.stringify({ discount_code: { code } }),
  });
  if (!resp.ok) throw new Error("Discount code failed");
}
