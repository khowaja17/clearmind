import { createClient } from "@supabase/supabase-js";

// Anon key is PUBLIC by design — RLS on the database is the actual security layer.
// If either value is missing the app runs in pure-local mode; sync UI is hidden.
const url  = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (url && anon)
  ? createClient(url, anon, {
      auth: {
        persistSession:    true,
        autoRefreshToken:  true,
        detectSessionInUrl: true,
        // PKCE survives iOS backgrounding better than implicit flow tokens.
        flowType:    "pkce",
        storage:     typeof window !== "undefined" ? window.localStorage : undefined,
        storageKey:  "clearmind-auth",
      },
      // Keep the realtime websocket alive with a heartbeat so it reconnects
      // after the iOS radio goes to sleep.
      realtime: {
        params: { eventsPerSecond: 2 },
        heartbeatIntervalMs: 30_000,
        reconnectAfterMs: (tries) => Math.min(1000 * 2 ** tries, 30_000),
      },
    })
  : null;

export const syncEnabled = !!supabase;
