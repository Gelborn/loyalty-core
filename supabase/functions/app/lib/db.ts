import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!; // for verifying JWTs

export const supa: SupabaseClient = createClient(SUPABASE_URL, SRV_KEY);

/** Admin REST: find an auth user by email (fallback path only). */
async function adminGetUserByEmail(email: string) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`;
  const resp = await fetch(url, {
    headers: {
      apikey: SRV_KEY,
      authorization: `Bearer ${SRV_KEY}`,
      "content-type": "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(`getUserByEmail failed: ${resp.status} ${await resp.text()}`);
  }
  const json = (await resp.json()) as any;
  const arr = Array.isArray(json) ? json : json?.users ?? [];
  return (arr[0] ?? null) as { id: string; email?: string } | null;
}

/** Admin REST: create a confirmed auth user (primary path). */
async function adminCreateConfirmedUser(email: string) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SRV_KEY,
      authorization: `Bearer ${SRV_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!resp.ok) {
    // When email already exists, Supabase returns 422; we handle that at call site.
    const msg = await resp.text();
    throw new Error(`createUser failed: ${resp.status} ${msg}`);
  }
  return (await resp.json()) as { id: string; email?: string };
}

/**
 * STRICT & SIMPLE:
 * - If a loyalty_member with this email exists -> return it (no merges).
 * - Else create a *confirmed* Auth user (fallback to lookup if it already exists in Auth),
 *   then insert loyalty_members { email, user_id }.
 * - Handle concurrent inserts by catching duplicate and reading by email.
 * Returns { userId, member }.
 */
export async function getOrCreateMemberWithUser(emailRaw: string) {
  const email = emailRaw.toLowerCase();

  // 1) Email is canonical for membership
  const { data: existing, error: exErr } = await supa
    .from("loyalty_members")
    .select("*")
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  if (exErr) throw new Error(exErr.message || "Failed to query loyalty_members by email");
  if (existing) {
    return { userId: existing.user_id as string | undefined, member: existing };
  }

  // 2) Create a new Auth user (confirmed). If it already exists in Auth, fallback to fetch.
  let userId: string;
  try {
    const created = await adminCreateConfirmedUser(email);
    userId = created.id;
  } catch (_e) {
    // Most likely 422 "User already registered" – fallback to fetch id
    const found = await adminGetUserByEmail(email);
    if (!found?.id) throw _e; // truly failed
    userId = found.id;
  }

  // 3) Insert the member; if a race inserts first, read by email
  try {
    const ins = await supa
      .from("loyalty_members")
      .insert({ email, user_id: userId })
      .select("*")
      .single();
    if (ins.error) throw ins.error;
    return { userId, member: ins.data };
  } catch (e: any) {
    const code = e?.code || "";
    if (code === "23505" || String(e?.message || "").includes("duplicate key")) {
      const { data: again } = await supa
        .from("loyalty_members")
        .select("*")
        .eq("email", email)
        .limit(1)
        .maybeSingle();
      if (again) return { userId: again.user_id as string ?? userId, member: again };
    }
    throw e;
  }
}

/** Verify a JWT and return its user (editor-only check; not used for writes) */
export async function getUserFromJWT(jwt: string) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

/** Convenience: balance for member_id */
export async function balanceFor(memberId: string) {
  return supa.from("member_balances").select("points").eq("member_id", memberId).single();
}
