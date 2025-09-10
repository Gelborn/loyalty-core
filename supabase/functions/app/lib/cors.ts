const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function allowOrigin(origin: string | null) {
  if (!origin) return null;
  if (ALLOWED.length === 0) return origin;        // allow any if none configured
  return ALLOWED.includes(origin) ? origin : null;
}

export function corsHeaders(origin: string | null) {
  const allowed = allowOrigin(origin);
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, x-client-info, apikey",
    "Access-Control-Allow-Credentials": "true",
  };
}

export function withCors(resp: Response, origin: string | null) {
  const h = corsHeaders(origin);
  const res = new Response(resp.body, resp);
  Object.entries(h).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

export function preflight(req: Request) {
  if (req.method !== "OPTIONS") return null;
  const headers = corsHeaders(req.headers.get("origin"));
  return new Response("ok", { status: 200, headers });
}
