import { supa, getOrCreateMemberWithUser } from "../lib/db.ts";
import { verifyShopifyWebhook } from "../lib/crypto.ts";

const API_SECRET = Deno.env.get("SHOPIFY_API_SECRET")!;
const SHOP_DOMAIN = (Deno.env.get("SHOP_DOMAIN") || "").toLowerCase();

function isFinalPaidOrder(payload: any) {
  const financial = (payload?.financial_status || "").toLowerCase();
  const cancelled = payload?.cancelled_at != null;
  return financial === "paid" && !cancelled;
}

function log(event: string, data: Record<string, unknown> = {}) {
  // Single-line JSON for easy filtering in Supabase logs
  console.log(JSON.stringify({ src: "webhooks", event, ...data }));
}

export async function handleWebhooks(req: Request) {
  const topic = req.headers.get("X-Shopify-Topic") || "";
  const shopHeader = (req.headers.get("X-Shopify-Shop-Domain") || "").toLowerCase();
  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256") || "";
  const deliveryId = req.headers.get("X-Shopify-Webhook-Id") || ""; // useful for tracing in Shopify

  // Basic headers log (safe)
  log("request.received", {
    topic,
    shopHeader,
    deliveryId,
    hasHmac: Boolean(hmacHeader),
  });

  // 1) Verify shop domain early
  if (shopHeader !== SHOP_DOMAIN) {
    log("reject.unknown_shop", { expected: SHOP_DOMAIN, got: shopHeader });
    return new Response("Unknown shop", { status: 401 });
  }

  // 2) Verify HMAC (use RAW body)
  const { ok, raw } = await verifyShopifyWebhook(req, API_SECRET);
  if (!ok) {
    // avoid printing secrets; show only prefix of header for debugging
    log("reject.invalid_hmac", { deliveryId, hmacPrefix: hmacHeader.slice(0, 8) });
    return new Response("Invalid HMAC", { status: 401 });
  }

  // 3) Parse payload safely
  let payload: any = {};
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    log("reject.bad_json", { deliveryId });
    return new Response("Bad JSON", { status: 400 });
  }

  // log the payload
  const payloadStr = JSON.stringify(payload);
  log("payload.raw", {
    topic,
    deliveryId,
    len: payloadStr.length,
    preview: payloadStr.slice(0, 500) // avoid logging megabytes; trim after 500 chars
  });

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

      // only credit when final/paid (your rule)
      if (!isFinalPaidOrder(payload)) {
        log("orders.skip.not_final_paid", {
          financial_status: payload?.financial_status,
          cancelled_at: payload?.cancelled_at,
          deliveryId,
        });
        return new Response("ok", { status: 200 });
      }

      const { member } = await getOrCreateMemberWithUser(email);
      const amount = Math.floor(Number(payload?.total_price) || 0);
      const reason = `order:${payload.id}`;

      if (amount > 0) {
        const { error } = await supa.from("points_ledger").insert({
          member_id: member.id,
          delta_points: amount,
          reason,
          meta: payload,
        });
        if (error) {
          // Idempotency: unique violation → duplicate delivery, safe to ignore
          if ((error as any).code === "23505") {
            log("orders.duplicate", { member_id: member.id, reason, deliveryId });
          } else {
            log("orders.insert_error", { err: error.message, reason, member_id: member.id });
            return new Response("Insert error", { status: 500 });
          }
        } else {
          log("orders.credited", { member_id: member.id, amount, reason });
        }
      } else {
        log("orders.skip.zero_amount", { orderId: payload?.id });
      }
    } else if (topic === "refunds/create") {
      if (!email) {
        log("refunds.skip.no_email", { deliveryId });
        return new Response("ok", { status: 200 });
      }

      const { member } = await getOrCreateMemberWithUser(email);
      // Refund payloads sometimes have string amounts; ensure positive integer points
      const rawAmt = Number(payload?.transactions?.[0]?.amount || 0);
      const amount = Math.floor(Math.abs(rawAmt));
      const reason = `refund:${payload.id}`;

      if (amount > 0) {
        const { error } = await supa.from("points_ledger").insert({
          member_id: member.id,
          delta_points: -amount,
          reason,
          meta: payload,
        });
        if (error) {
          if ((error as any).code === "23505") {
            log("refunds.duplicate", { member_id: member.id, reason, deliveryId });
          } else {
            log("refunds.insert_error", { err: error.message, reason, member_id: member.id });
            return new Response("Insert error", { status: 500 });
          }
        } else {
          log("refunds.debited", { member_id: member.id, amount, reason });
        }
      } else {
        log("refunds.skip.zero_amount", { refundId: payload?.id });
      }
    } else {
      // Not one of the topics we handle → 200 so Shopify doesn’t retry
      log("topic.ignored", { topic, deliveryId });
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    log("handler.exception", { err: (e as Error).message, topic, deliveryId });
    return new Response("Server error", { status: 500 });
  }
}
