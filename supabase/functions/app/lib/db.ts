import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!; // for verifying JWTs

export const supa: SupabaseClient = createClient(SUPABASE_URL, SRV_KEY);

/** Admin REST: find an auth user by email (works across SDK/runtime versions) */
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
  const json = await resp.json() as any;
  const arr = Array.isArray(json) ? json : (json?.users ?? []);
  return (arr[0] ?? null) as { id: string; email?: string } | null;
}

/** Admin REST: create a confirmed auth user */
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
    throw new Error(`createUser failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as { id: string; email?: string };
}

/**
 * Ensure a confirmed Auth user and a loyalty_member row for the email.
 * - If Auth user doesn't exist -> create (email confirmed)
 * - If member doesn't exist -> insert with user_id
 * Returns { userId, member }
 */
export async function getOrCreateMemberWithUser(emailRaw: string) {
  const email = emailRaw.toLowerCase();

  // 1) Look up existing member first (fast-path)
  const { data: existingMember, error: exErr } = await supa
    .from("loyalty_members")
    .select("*")
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  if (exErr) throw new Error(exErr.message || "Failed to query loyalty_members");

  let userId: string | undefined = existingMember?.user_id;

  // 2) Ensure Auth user exists (via Admin REST)
  if (!userId) {
    const found = await adminGetUserByEmail(email);
    if (found?.id) {
      userId = found.id;
    } else {
      const created = await adminCreateConfirmedUser(email);
      userId = created.id;
    }
  }

  // 3) Ensure member exists with user_id
  if (!existingMember) {
    const ins = await supa
      .from("loyalty_members")
      .insert({ email, user_id: userId })
      .select("*")
      .single();
    if (ins.error) throw new Error(ins.error.message);
    return { userId: userId!, member: ins.data };
  }

  // 4) Backfill user_id on existing member if needed
  if (!existingMember.user_id && userId) {
    const upd = await supa
      .from("loyalty_members")
      .update({ user_id: userId })
      .eq("id", existingMember.id)
      .select("*")
      .single();
    if (upd.error) throw new Error(upd.error.message);
    return { userId: userId!, member: upd.data };
  }

  return { userId: userId!, member: { ...existingMember, user_id: userId } };
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
