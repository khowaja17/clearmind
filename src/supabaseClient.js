import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (url && anon)
  ? createClient(url, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // PKCE is more resilient on iOS PWAs — the code verifier survives
        // storage eviction better than implicit flow tokens.
        flowType: "pkce",
        // Store the session in both localStorage and a cookie-style fallback
        // so iOS doesn't wipe it when the PWA is backgrounded.
        storage: typeof window !== "undefined" ? window.localStorage : undefined,
        storageKey: "clearmind-auth",
      },
    })
  : null;

export const syncEnabled = !!supabase;
