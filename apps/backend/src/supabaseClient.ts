import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

let clientInstance: SupabaseClient | undefined;

/**
 * Initializes the Supabase client and caches it.
 */
export function initializeSupabase(config: SupabaseConfig): SupabaseClient {
  clientInstance = createClient(config.url, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return clientInstance;
}

/**
 * Returns the cached Supabase client instance, or undefined if not initialized.
 */
export function getSupabaseClient(): SupabaseClient | undefined {
  return clientInstance;
}
