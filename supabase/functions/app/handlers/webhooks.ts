import { supa, getOrCreateMemberWithUser } from "../lib/db.ts";
import { verifyShopifyWebhook } from "../lib/crypto.ts";

const API_SECRET = Deno.env.get("SHOPIFY_API_SECRET")!;
const SHOP_DOMAIN = (Deno.env.get("SHOP_DOMAIN") || "").toLowerCase();

function isFinalPaidOrder(payload: any) {
  // You can tune this rule. Common safe rule: paid and not cancelled.
  const financial = (payload?.financial_status || "").toLowerCase();
  const cancelled = payload?.cancelled_at != null;
  return financial === "paid" && !cancelled;
}

export async function handleWebhooks(req: Request) {
  const shopHeader = (req.headers.get("X-Shopify-Shop-Domain") || "").toLowerCase();
  if (shopHeader !== SHOP_DOMAIN) return new Response("Unknown shop", { status: 401 });

  const { ok, raw } = await verifyShopifyWebhook(req, API_SECRET);
  if (!ok) return new Response("Invalid HMAC", { status: 401 });

  const topic = req.headers.get("X-Shopify-Topic") || "";
  const payload = JSON.parse(new TextDecoder().decode(raw));
  const email = (payload?.email || payload?.customer?.email || "").toLowerCase();

  if (topic.startsWith("orders/")) {
    if (!email) return new Response("ok", { status: 200 });
    // Credit only when final/paid
    if (!isFinalPaidOrder(payload)) return new Response("ok", { status: 200 });

    const { member } = await getOrCreateMemberWithUser(email);
    const amount = Math.floor(Number(payload?.total_price) || 0);
    if (amount > 0) {
      await supa.from("points_ledger").insert({
        member_id: member.id,
        delta_points: amount,
        reason: `order:${payload.id}`,
        meta: payload,
      });
    }
  } else if (topic === "refunds/create") {
    if (!email) return new Response("ok", { status: 200 });
    const { member } = await getOrCreateMemberWithUser(email);
    const amount = Math.floor(Number(payload?.transactions?.[0]?.amount || 0));
    if (amount > 0) {
      await supa.from("points_ledger").insert({
        member_id: member.id,
        delta_points: -amount,
        reason: `refund:${payload.id}`,
        meta: payload,
      });
    }
  }

  return new Response("ok", { status: 200 });
}
