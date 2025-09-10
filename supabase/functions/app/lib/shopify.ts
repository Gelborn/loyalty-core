const SHOP_DOMAIN = Deno.env.get("SHOP_DOMAIN")!;
const ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN")!;

// ---------- utils

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ src: "shopify", event, ...data }));
}

function asNegString(n: number): string {
  // Shopify espera valor negativo como string ("-10.0")
  const num = Number(n);
  return (num > 0 ? -num : num).toFixed(2);
}

async function readBodySafe(resp: Response) {
  const text = await resp.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null as unknown };
  }
}

async function shopifyFetch(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ parsed: any; rawText: string }> {
  const url = `https://${SHOP_DOMAIN}/admin/api/2024-10/${path.replace(/^\/+/, "")}`;
  const { json, ...rest } = init;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": ADMIN_TOKEN,
    ...(init.headers as Record<string, string> | undefined),
  };

  const body = json !== undefined ? JSON.stringify(json) : init.body;

  log("request", {
    method: (rest.method || "GET").toUpperCase(),
    url,
    hasBody: Boolean(body),
    bodyPreview: body ? String(body).slice(0, 500) : undefined,
  });

  const resp = await fetch(url, { ...rest, headers, body });
  const { text, json: parsed } = await readBodySafe(resp);

  log("response", {
    url,
    status: resp.status,
    ok: resp.ok,
    bodyPreview: text.slice(0, 800),
  });

  if (!resp.ok) {
    // 👇 Parentetizado para evitar erro de precedência no Deno v2
    const primary =
      (parsed as any)?.errors ?? (parsed as any)?.error ?? text;
    const message = (primary && String(primary).trim().length > 0)
      ? primary
      : `HTTP ${resp.status}`;

    const err = new Error(
      typeof message === "string" ? message : JSON.stringify(message),
    );
    (err as any).status = resp.status;
    throw err;
  }

  return { parsed, rawText: text };
}

// ---------- public API

export async function createPriceRule(
  title: string,
  rulePayload: Record<string, unknown>,
): Promise<string> {
  // Normaliza valor negativo quando vier nesses campos
  const rp: Record<string, unknown> = { ...rulePayload };
  if (typeof rp.value === "number") rp.value = asNegString(rp.value as number);
  if (typeof rp.value === "string") {
    const n = Number(rp.value);
    if (!Number.isNaN(n)) rp.value = asNegString(n);
  }

  const { parsed } = await shopifyFetch("price_rules.json", {
    method: "POST",
    json: {
      price_rule: {
        title,
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        customer_selection: "all",
        starts_at: new Date().toISOString(),
        usage_limit: null,
        once_per_customer: false,
        ...rp,
      },
    },
  });

  const id = parsed?.price_rule?.id;
  if (!id) throw new Error("Price rule creation returned no id");
  return String(id);
}

export async function createDiscountCode(priceRuleId: string | number, code: string): Promise<void> {
  await shopifyFetch(`price_rules/${priceRuleId}/discount_codes.json`, {
    method: "POST",
    json: { discount_code: { code } },
  });
}
