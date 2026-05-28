import { supabase } from "./supabaseClient.js";

// All functions no-op gracefully (return null/false) when supabase is null,
// so the app behaves exactly as a local-only app when sync isn't configured.

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function signInWithGoogle() {
  if (!supabase) return;
  // Return to the app's own URL after the Google round-trip. BASE_URL is "/clearmind/"
  // in production, so this resolves to the exact whitelisted redirect URL.
  const redirectTo = window.location.origin + import.meta.env.BASE_URL;
  await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Subscribe to auth changes; returns an unsubscribe fn.
export function onAuthChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session || null));
  return () => data.subscription.unsubscribe();
}

// Fetch the user's cloud row. Returns { data, updated_at } or null if none/none-configured.
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

// Upsert the user's whole state blob. Stamps updated_at server-side via now().
export async function cloudSave(userId, blob) {
  if (!supabase || !userId) return false;
  const { error } = await supabase
    .from("app_state")
    .upsert({ user_id: userId, data: blob, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) { console.warn("cloudSave error", error.message); return false; }
  return true;
}
