// Stripe tells us here when a Premium checkout has been paid (or refunded).
// Deployed with --no-verify-jwt: Stripe can't send a Supabase token, so every
// request is checked against the Stripe signing secret instead.
import { createClient } from "jsr:@supabase/supabase-js@2";

const TOLERANCE_SECONDS = 300;

async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verify(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = await hmacHex(secret, `${t}.${raw}`);
  return sigs.some((s) => safeEqual(s, expected));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 503 });

  const raw = await req.text();
  if (!(await verify(raw, req.headers.get("Stripe-Signature"), secret))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object;
    const userId = s.client_reference_id || s.metadata?.user_id;
    if (userId && s.payment_status === "paid") {
      const { error } = await admin.from("entitlements").upsert({
        user_id: userId, premium: true, source: "stripe",
        purchased_at: new Date((s.created ?? Date.now() / 1000) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (error) { console.error("entitlement upsert failed", error.message); return new Response("db error", { status: 500 }); }
    }
  } else if (event.type === "charge.refunded") {
    // full refund: take Premium away again (metadata comes from the payment intent)
    const c = event.data.object;
    let userId = c.metadata?.user_id;
    if (!userId && c.payment_intent) {
      const pi = await fetch(`https://api.stripe.com/v1/payment_intents/${c.payment_intent}`, {
        headers: { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}` },
      }).then((r) => r.json()).catch(() => null);
      userId = pi?.metadata?.user_id;
    }
    if (userId && c.refunded) {
      await admin.from("entitlements").update({ premium: false, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("source", "stripe");
    }
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
