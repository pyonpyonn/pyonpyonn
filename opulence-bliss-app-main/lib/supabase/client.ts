// SETUP: code "lib/supabase/client.ts"
//
// One shared browser client. Every component calling createClient() gets the
// same instance, so there's only ever one auth manager per tab.

import { createBrowserClient } from "@supabase/ssr";

type Client = ReturnType<typeof createBrowserClient>;

let client: Client | undefined;

export function createClient(): Client {
  if (client) return client;

  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!
  );

  return client;
}