import "server-only";

import { createClient } from "@supabase/supabase-js";

function requireServerEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }

  return value;
}

export function createSupabaseServiceClient() {
  const supabaseUrl = requireServerEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseSecretKey = requireServerEnv("SUPABASE_SECRET_KEY");

  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}