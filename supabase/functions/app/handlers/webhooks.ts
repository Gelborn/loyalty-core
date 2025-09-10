import { supa, getOrCreateMemberWithUser } from "../lib/db.ts";
import { verifyShopifyWebhook } from "../lib/crypto.ts";

const API_SECRET = Deno.env.get("SHOPIFY_API_SECRET")!;
const SHOP_DOMAIN = (Deno.env.get("SHOP_DOMAIN") || "").toLowerCase();

// Require POINTS_MULTIPLIER secret
const pmRaw = Deno.env.get("POINTS_MULTIPLIER");
if (!pmRaw) {
  throw new Error("Missing required secret: POINTS_MULTIPLIER");
}
const POINTS_MULTIPLIER = Number(pmRaw);
if (!Number.isFinite(POINTS_MULTIPLIER) || POINTS_MULTIPLIER <= 0) {
  throw new Error("Invalid POINTS_MULTIPLIER: must be a positive number");
}

// Log multiplier once at boot
console.log(JSON.stringify({ src: "webhooks", event: "config", POINTS_MULTIPLIER }));

function isFinalPaidOrder(payload: any) {
  const financial = (payload?.financial_status || "").toLowerCase();
  const cancelled = payload?.cancelled_at != null;
  return financial === "paid" && !cancelled;
}

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ src: "webhooks", event, ...data }));
}

/** Compute refund points using fields Shopify may send; supports partial refunds. */
async function computeRefundPoints(payload: any): Promise<number> {
  const totalSet = payload?.total_refund_set?.shop_money?.amount ?? payload?.total_refund ?? null;
  if (totalSet != null) {
    const n = Math.floor(Math.abs(Number(totalSet) || 0));
    if (n > 0) return n;
  }

  const txs = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const txSum = txs
    .filter((t: any) => String(t?.kind).toLowerCase() === "refund")
    .reduce((acc: number, t: any) => acc + Math.abs(Number(t?.amount || 0)), 0);
  if (txSum > 0) return Math.floor(txSum);

  const items = Array.isArray(payload?.refund_line_items) ? payload.refund_line_items : [];
  const itemSum = items.reduce((acc: number, it: any) => {
    const q = Number(it?.quantity || 0);
    const price = Number(it?.line_item?.price || 0);
    return acc + q * price;
  }, 0);

  return Math.floor(Math.abs(itemSum));
}

export async function handleWebhooks(req: Request) {
  const topic = req.headers.get("X-Shopify-Topic") || "";
  const shopHeader = (req.headers.get("X-Shopify-Shop-Domain") || "").toLowerCase();
  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256") || "";
  const deliveryId = req.headers.get("X-Shopify-Webhook-Id") || "";

  log("request.received", { topic, shopHeader, deliveryId, hasHmac: Boolean(hmacHeader) });

  if (shopHeader !== SHOP_DOMAIN) {
    log("reject.unknown_shop", { expected: SHOP_DOMAIN, got: shopHeader });
    return new Response("Unknown shop", { status: 401 });
  }

  const { ok, raw } = await verifyShopifyWebhook(req, API_SECRET);
  if (!ok) {
    log("reject.invalid_hmac", { deliveryId, hmacPrefix: hmacHeader.slice(0, 8) });
    return new Response("Invalid HMAC", { status: 401 });
  }

  let payload: any = {};
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    log("reject.bad_json", { deliveryId });
    return new Response("Bad JSON", { status: 400 });
  }

  const payloadStr = JSON.stringify(payload);
  log("payload.raw", { topic, deliveryId, len: payloadStr.length, preview: payloadStr.slice(0, 500) });

  const email = (payload?.email || payload?.customer?.email || "").toLowerCase();
  log("payload.parsed", {
    topic,
    emailPresent: Boolean(email),
    orderId: payload?.id ?? null,
    financial_status: payload?.financial_status ?? null,
    cancelled_at: payload?.cancelled_at ?? null,
  });

  try {
    if (topic.startsWith("orders/")) {
      if (!email) {
        log("orders.skip.no_email", { deliveryId });
        return new Response("ok", { status: 200 });
      }

      if (!isFinalPaidOrder(payload)) {
        log("orders.skip.not_final_paid", {
          financial_status: payload?.financial_status,
          cancelled_at: payload?.cancelled_at,
          deliveryId,
        });
        return new Response("ok", { status: 200 });
      }

      const { member } = await getOrCreateMemberWithUser(email);
      const rawAmount = Number(payload?.total_price) || 0;
      const amount = Math.floor(rawAmount * POINTS_MULTIPLIER);
      const reason = `order:${payload.id}`;

      if (amount > 0) {
        const { error } = await supa.from("points_ledger").insert({
          member_id: member.id,
          delta_points: amount,
          reason,
          meta: payload,
        });
        if (error) {
          if ((error as any).code === "23505") {
            log("orders.duplicate", { member_id: member.id, reason, deliveryId });
          } else {
            log("orders.insert_error", { err: error.message, reason, member_id: member.id });
            return new Response("Insert error", { status: 500 });
          }
        } else {
          log("orders.credited", { member_id: member.id, rawAmount, amount, reason });
        }
      } else {
        log("orders.skip.zero_amount", { orderId: payload?.id });
      }

    } else if (topic === "refunds/create") {
      const orderId = String(payload?.order_id || "");
      if (!orderId) {
        log("refunds.skip.no_order_id", { deliveryId });
        return new Response("ok", { status: 200 });
      }

      let memberId: string | null = null;
      {
        const { data: credited, error } = await supa
          .from("points_ledger")
          .select("member_id")
          .eq("reason", `order:${orderId}`)
          .limit(1)
          .maybeSingle();

        if (error) {
          log("refunds.lookup_error", { err: error.message, orderId, deliveryId });
          return new Response("Lookup error", { status: 500 });
        }

        memberId = credited?.member_id ?? null;
        log("refunds.resolve", { orderId, memberIdFound: Boolean(memberId) });
      }

      if (!memberId) {
        log("refunds.skip.cannot_resolve_member", { orderId, deliveryId });
        return new Response("ok", { status: 200 });
      }

      const rawRefund = await computeRefundPoints(payload);
      const amount = Math.floor(rawRefund * POINTS_MULTIPLIER);
      const reason = `refund:${payload.id}`;

      if (amount > 0) {
        const { error } = await supa.from("points_ledger").insert({
          member_id: memberId,
          delta_points: -amount,
          reason,
          meta: payload,
        });
        if (error) {
          if ((error as any).code === "23505") {
            log("refunds.duplicate", { member_id: memberId, reason, deliveryId });
          } else {
            log("refunds.insert_error", { err: error.message, reason, member_id: memberId });
            return new Response("Insert error", { status: 500 });
          }
        } else {
          log("refunds.debited", { member_id: memberId, rawRefund, amount, reason });
        }
      } else {
        log("refunds.skip.zero_amount", { refundId: payload?.id, orderId });
      }

    } else {
      log("topic.ignored", { topic, deliveryId });
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    log("handler.exception", { err: (e as Error).message, topic, deliveryId });
    return new Response("Server error", { status: 500 });
  }
}
