import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createAuthEmailHandler } from "./handler.ts";

Deno.serve(
  createAuthEmailHandler({
    getEnv: (name) => Deno.env.get(name),
  }),
);
