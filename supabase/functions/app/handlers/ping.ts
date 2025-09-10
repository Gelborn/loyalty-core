import { supa } from "../lib/db.ts";

export async function handlePing() {
  // Optional no-op to keep connections warm
  await supa.rpc("now").catch(() => {});
  return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
    headers: { "Content-Type": "application/json" },
  });
}
