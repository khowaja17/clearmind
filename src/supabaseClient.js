import { createClient } from "@supabase/supabase-js";

const url  = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (url && anon)
  ? createClient(url, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storageKey: "clearmind-auth",
      },
      realtime: {
        heartbeatIntervalMs: 30_000,
        reconnectAfterMs: (n) => Math.min(1000 * 2 ** n, 30_000),
      },
    })
  : null;

export const syncEnabled = !!supabase;
