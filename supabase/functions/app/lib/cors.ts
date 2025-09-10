export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-client-info, apikey",
  };
}

export function withCors(resp: Response) {
  const h = corsHeaders();
  const res = new Response(resp.body, resp);
  Object.entries(h).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

export function preflight(req: Request) {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { status: 200, headers: corsHeaders() });
}
