import { createClient } from "@supabase/supabase-js";

// These are read from Vite env vars at build time. The anon key is PUBLIC by design —
// security comes from Row-Level Security on the database, not from hiding this key.
// If either is missing, `supabase` is null and the app runs in pure-local mode (no sync),
// so a misconfigured build can never break the working offline app.
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (url && anon)
  ? createClient(url, anon, {
      auth: {
        persistSession: true,        // keep the user signed in across reloads
        autoRefreshToken: true,
        detectSessionInUrl: true,    // completes the OAuth redirect handshake
      },
    })
  : null;

export const syncEnabled = !!supabase;
