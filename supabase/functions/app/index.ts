import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { handlePing } from "./handlers/ping.ts";
import { handleWebhooks } from "./handlers/webhooks.ts";
import { handleRedeem } from "./handlers/redeem.ts";
import { withCors, corsHeaders } from "./lib/cors.ts"; // <-- usar seu helper aberto (*)

serve({
  // Ping (GET) + preflight
  "/app/ping": (req) => {
    if (req.method === "OPTIONS") {
      return withCors(new Response("ok", { status: 200 }), req);
    }
    if (req.method === "GET") {
      return withCors(handlePing(), req);
    }
    return withCors(new Response("Method Not Allowed", { status: 405 }), req);
  },

  // Webhooks (POST) + preflight
  "/app/webhooks": async (req) => {
    if (req.method === "OPTIONS") {
      return withCors(new Response("ok", { status: 200 }), req);
    }
    if (req.method === "POST") {
      const resp = await handleWebhooks(req);
      return withCors(resp, req);
    }
    return withCors(new Response("Method Not Allowed", { status: 405 }), req);
  },

  // Redeem (POST) + preflight
  "/app/redeem": async (req) => {
    if (req.method === "OPTIONS") {
      return withCors(new Response("ok", { status: 200 }), req);
    }
    if (req.method === "POST") {
      const resp = await handleRedeem(req);
      return withCors(resp, req);
    }
    return withCors(new Response("Method Not Allowed", { status: 405 }), req);
  },

  // Catch-all:  OPTIONS (preflight global) + 404 com CORS
  "*": (req) => {
    if (req.method === "OPTIONS") {
      // Permite preflight para qualquer caminho desconhecido (evita erros em ambientes/proxies)
      return withCors(new Response("ok", { status: 200 }), req);
    }
    return withCors(new Response("Not Found", { status: 404 }), req);
  },
});
