// Deletes the signed-in person's account and everything in it (App Store rule 5.1.1(v):
// apps that create accounts must let people delete them from inside the app).
// The saved lists and the Premium flag go with it: both tables cascade from auth.users.
// A Premium purchase is still tied to the person's Apple / Google account, so if they come
// back and tap "Restore purchase", RevenueCat sends a TRANSFER and Premium is restored.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://partylist.tuex.site",
  "https://jelalh.github.io",
  "http://localhost:5178",
];

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const headers = cors(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "method" }, 405, headers);

  // who is asking: only ever delete the account the token belongs to
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401, headers);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) return json({ error: "delete_failed" }, 500, headers);
  return json({ deleted: true }, 200, headers);
});
