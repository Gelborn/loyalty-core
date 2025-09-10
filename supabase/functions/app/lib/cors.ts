// lib/cors.ts
export function corsHeaders(req?: Request) {
  // Reflete o que o browser pediu no preflight
  const acrh = req?.headers.get("Access-Control-Request-Headers") ?? "";
  const allowHeaders = acrh || "Authorization, Content-Type, x-client-info, apikey";

  return {
    "Access-Control-Allow-Origin": "*",            // PoC aberta
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,  // ecoa os headers pedidos
    "Access-Control-Max-Age": "86400",
  };
}

export function withCors(resp: Response, req?: Request) {
  const res = new Response(resp.body, resp);
  const h = corsHeaders(req);
  Object.entries(h).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

export function preflight(req: Request) {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { status: 200, headers: corsHeaders(req) });
}
