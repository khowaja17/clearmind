import { supabase } from "./supabaseClient.js";

// ---- auth ----

export async function getSession() {
  if (!supabase) return null;
  // Try the stored session first. If stale (common on iOS after backgrounding),
  // attempt a silent refresh before giving up and showing the sign-in button.
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: refreshed } = await supabase.auth.refreshSession();
  return refreshed?.session || null;
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

// ---- data ----

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

// ---- realtime ----
// Subscribes to INSERT/UPDATE on the user's own app_state row.
// Calls onRemoteChange() whenever another device writes to the cloud.
// Returns an unsubscribe function.
//
// Why filter server-side? Without a user_id filter, every subscriber receives
// every user's row changes (all 10 of your testers). The filter pushes
// the predicate into Postgres so only the matching row fires the event.
// Supabase requires the Realtime toggle enabled on the table (done in dashboard).
export function subscribeToRemoteChanges(userId, onRemoteChange) {
  if (!supabase || !userId) return () => {};

  const channel = supabase
    .channel(`app_state_${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",              // INSERT and UPDATE both trigger a full re-pull
        schema: "public",
        table: "app_state",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        // payload.new contains the fresh row straight from Postgres.
        // We pass the whole payload so the caller can decide what to do with it.
        onRemoteChange(payload);
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[clearmind] realtime: subscribed for", userId);
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("[clearmind] realtime:", status, "— will rely on focus-sync fallback");
      }
    });

  return () => { supabase.removeChannel(channel); };
}
