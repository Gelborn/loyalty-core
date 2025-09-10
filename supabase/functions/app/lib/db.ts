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
  const json = (await resp.json()) as any;
  const arr = Array.isArray(json) ? json : json?.users ?? [];
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
 * Race-safe across concurrent webhooks:
 * - Ensures (or creates) Auth user
 * - Prefers lookup by user_id (canonical)
 * - Attaches user_id to existing email row if needed
 * - Inserts if truly new, with retry on unique constraint
 * Returns { userId, member }
 */
export async function getOrCreateMemberWithUser(emailRaw: string) {
  const email = emailRaw.toLowerCase();

  // 1) ensure we have an auth user id
  let userId: string | null = null;
  const found = await adminGetUserByEmail(email);
  userId = found?.id ?? null;
  if (!userId) {
    const created = await adminCreateConfirmedUser(email);
    userId = created.id;
  }

  // 2) authoritative: lookup by user_id first (handles concurrent inserts)
  {
    const { data: byUser, error } = await supa
      .from("loyalty_members")
      .select("*")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message || "Failed to query loyalty_members by user_id");

    if (byUser) {
      // best-effort email sync (ignore if unique conflict)
      if (byUser.email !== email) {
        const upd = await supa
          .from("loyalty_members")
          .update({ email })
          .eq("id", byUser.id)
          .select("*")
          .single();
        if (!upd.error) return { userId, member: upd.data };
      }
      return { userId, member: byUser };
    }
  }

  // 3) if none by user_id, see if we already have a row for this email
  {
    const { data: byEmail, error } = await supa
      .from("loyalty_members")
      .select("*")
      .eq("email", email)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message || "Failed to query loyalty_members by email");

    if (byEmail) {
      // attach user_id if missing
      if (!byEmail.user_id) {
        const upd = await supa
          .from("loyalty_members")
          .update({ user_id: userId })
          .eq("id", byEmail.id)
          .select("*")
          .single();
        if (upd.error) throw new Error(upd.error.message);
        return { userId, member: upd.data };
      }
      // row already linked to some user_id; return it
      return { userId: byEmail.user_id as string, member: byEmail };
    }
  }

  // 4) truly new → insert; handle race with retry on unique violation
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
    const msg = String(e?.message || "");
    if (code === "23505" || msg.includes("duplicate key value")) {
      // someone else inserted; read by user_id now
      const { data: byUser, error } = await supa
        .from("loyalty_members")
        .select("*")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (byUser) {
        if (byUser.email !== email) {
          const upd = await supa
            .from("loyalty_members")
            .update({ email })
            .eq("id", byUser.id)
            .select("*")
            .single();
          if (!upd.error) return { userId, member: upd.data };
        }
        return { userId, member: byUser };
      }
      // fallback: read by email if that was the conflicting key
      const { data: byEmail } = await supa
        .from("loyalty_members")
        .select("*")
        .eq("email", email)
        .limit(1)
        .maybeSingle();
      if (byEmail) return { userId: byEmail.user_id as string ?? userId!, member: byEmail };
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
