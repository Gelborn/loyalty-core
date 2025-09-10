export function b64(buf: ArrayBuffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  
  export function timingSafeEq(a: string, b: string) {
    if (a.length !== b.length) return false;
    let out = 0;
    for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return out === 0;
  }
  
  export async function verifyShopifyWebhook(req: Request, apiSecret: string) {
    const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256") || "";
    const raw = await req.arrayBuffer();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, raw);
    return { ok: timingSafeEq(hmacHeader, b64(mac)), raw };
  }
  