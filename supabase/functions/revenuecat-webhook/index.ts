// RevenueCat tells us here about App Store / Google Play purchases of the £2.99 unlock.
// The phone app logs in to RevenueCat with the Party List (Supabase) user id, so
// event.app_user_id is the user to unlock. Deployed with --no-verify-jwt; every request
// must carry the shared secret set as the webhook's Authorization header in RevenueCat.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ENTITLEMENT = "premium";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const secret = Deno.env.get("REVENUECAT_WEBHOOK_AUTH");
  if (!secret) return new Response("not configured", { status: 503 });
  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(auth, secret)) return new Response("unauthorized", { status: 401 });

  const { event } = await req.json().catch(() => ({ event: null }));
  if (!event) return new Response("bad body", { status: 400 });

  // the purchase may arrive under an alias; use whichever id is a Supabase user id
  const ids: string[] = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])].filter(Boolean);
  const userId = ids.find((id) => UUID.test(id));
  if (!userId) return new Response(JSON.stringify({ ignored: "no user id" }), { status: 200 });

  const entitled = (event.entitlement_ids ?? []).includes(ENTITLEMENT) || event.entitlement_id === ENTITLEMENT;
  const source = event.store === "PLAY_STORE" ? "play_store" : "app_store";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (entitled && ["INITIAL_PURCHASE", "NON_RENEWING_PURCHASE", "UNCANCELLATION", "TRANSFER", "RENEWAL"].includes(event.type)) {
    const { error } = await admin.from("entitlements").upsert({
      user_id: userId, premium: true, source,
      purchased_at: new Date(event.purchased_at_ms ?? Date.now()).toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) { console.error("entitlement upsert failed", error.message); return new Response("db error", { status: 500 }); }
  } else if (event.type === "CANCELLATION" && event.cancel_reason === "CUSTOMER_SUPPORT") {
    // a refund through Apple / Google: take Premium away again
    await admin.from("entitlements").update({ premium: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId).in("source", ["app_store", "play_store"]);
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
