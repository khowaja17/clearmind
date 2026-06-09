import { supabase } from "./supabaseClient.js";

// ---- auth ----------------------------------------------------------------

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  // Token may be stale (common on iOS after backgrounding) — try a silent refresh.
  const { data: r } = await supabase.auth.refreshSession();
  return r?.session || null;
}

export async function signInWithGoogle() {
  if (!supabase) return;
  const redirectTo = window.location.origin + import.meta.env.BASE_URL;
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, queryParams: { prompt: "select_account" } },
  });
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// cb receives (session | null, eventName)
export function onAuthChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    cb(session || null, event);
  });
  return () => data.subscription.unsubscribe();
}

// ---- data ----------------------------------------------------------------

export async function cloudLoad(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("app_state")
    .select("data, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) { console.warn("[clearmind] cloudLoad:", error.message); return null; }
  return data || null;
}

export async function cloudSave(userId, blob) {
  if (!supabase || !userId) return null;
  const ts = new Date().toISOString();
  const { error } = await supabase
    .from("app_state")
    .upsert(
      { user_id: userId, data: blob, updated_at: ts },
      { onConflict: "user_id" }
    );
  if (error) { console.warn("[clearmind] cloudSave:", error.message); return null; }
  return ts; // return the timestamp we wrote so callers can track it
}

// ---- realtime ------------------------------------------------------------
// Subscribe to changes on this user's row. Calls cb(newData, updatedAt)
// whenever another device writes. Returns unsubscribe fn.
export function subscribeRealtime(userId, cb) {
  if (!supabase || !userId) return () => {};
  const channel = supabase
    .channel(`appstate_${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "app_state",
      filter: `user_id=eq.${userId}`,
    }, (payload) => {
      const row = payload.new;
      if (row && row.data) cb(row.data, row.updated_at);
    })
    .subscribe((status) => {
      console.log("[clearmind] realtime:", status);
    });
  return () => supabase.removeChannel(channel);
}
