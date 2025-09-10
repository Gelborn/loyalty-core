import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!; // for verifying JWTs

export const supa: SupabaseClient = createClient(SUPABASE_URL, SRV_KEY);

/**
 * Ensure a confirmed Auth user and a loyalty_member row for the email.
 * - If Auth user doesn't exist -> create (email confirmed)
 * - If member doesn't exist -> insert with user_id
 * Returns { userId, member }
 */
export async function getOrCreateMemberWithUser(emailRaw: string) {
  const email = emailRaw.toLowerCase();

  // 1) Look up existing member first (fast-path)
  const { data: existingMember } = await supa
    .from("loyalty_members")
    .select("*")
    .eq("email", email)
    .limit(1)
    .maybeSingle();

  let userId: string | undefined = existingMember?.user_id;

  // 2) Ensure Auth user exists (admin)
  if (!userId) {
    const admin = createClient(SUPABASE_URL, SRV_KEY);
    const got = await admin.auth.admin.getUserByEmail(email);
    if (got.data?.user) {
      userId = got.data.user.id;
    } else {
      const created = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
      });
      if (created.error || !created.data.user) {
        throw new Error(created.error?.message || "Failed to create auth user");
      }
      userId = created.data.user.id;
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
    return { userId, member: ins.data };
  }

  // 4) Backfill user_id on existing member if needed
  if (!existingMember.user_id && userId) {
    await supa.from("loyalty_members")
      .update({ user_id: userId })
      .eq("id", existingMember.id);
  }

  return { userId, member: { ...existingMember, user_id: userId } };
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
