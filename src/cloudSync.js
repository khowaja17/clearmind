import { supabase } from "./supabaseClient.js";

export async function getSession() {
  if (!supabase) return null;
  // First try getting the current session; if the token is stale, attempt a silent refresh.
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  // Token may have been evicted on iOS — try refreshing before giving up.
  const { data: refreshed } = await supabase.auth.refreshSession();
  return refreshed?.session || null;
}

export async function signInWithGoogle() {
  if (!supabase) return;
  const redirectTo = window.location.origin + import.meta.env.BASE_URL;
  await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export function onAuthChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    // TOKEN_REFRESHED is a silent background event — don't trigger a full reconcile,
    // just update the session reference. Only SIGNED_IN triggers reconcile.
    cb(session || null, event);
  });
  return () => data.subscription.unsubscribe();
}

export async function cloudLoad(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("app_state")
    .select("data, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) { console.warn("cloudLoad error", error.message); return null; }
  return data || null;
}

export async function cloudSave(userId, blob) {
  if (!supabase || !userId) return false;
  const { error } = await supabase
    .from("app_state")
    .upsert(
      { user_id: userId, data: blob, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  if (error) { console.warn("cloudSave error", error.message); return false; }
  return true;
}
