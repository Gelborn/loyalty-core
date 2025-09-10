import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { handlePing } from "./handlers/ping.ts";
import { handleWebhooks } from "./handlers/webhooks.ts";
import { handleRedeem } from "./handlers/redeem.ts";

serve({
  "/app/ping": (_req) => handlePing(),
  "/app/webhooks": (req) =>
    req.method === "POST" ? handleWebhooks(req) : new Response("Method Not Allowed", { status: 405 }),
  "/app/redeem": (req) =>
    req.method === "POST" ? handleRedeem(req) : new Response("Method Not Allowed", { status: 405 }),
  "*": () => new Response("Not Found", { status: 404 }),
});
