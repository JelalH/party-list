// Starts a Stripe Checkout for the £2.99 lifetime Premium unlock.
// Called by the web app with the signed-in user's token; returns { url } to redirect to.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://partylist.tuex.site",
  "https://jelalh.github.io",
  "http://localhost:5178",
];
const PRICE_PENCE = 299;

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

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return json({ error: "payments_not_configured" }, 503, headers);

  // who is asking
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401, headers);

  const { data: ent } = await supabase.from("entitlements").select("premium").eq("user_id", user.id).maybeSingle();
  if (ent?.premium) return json({ error: "already_premium" }, 409, headers);

  // only send people back to our own site
  let returnUrl = ALLOWED_ORIGINS[0] + "/";
  try {
    const body = await req.json();
    const u = new URL(body?.returnUrl);
    if (ALLOWED_ORIGINS.includes(u.origin)) returnUrl = u.origin + u.pathname;
  } catch { /* use default */ }

  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "gbp",
    "line_items[0][price_data][unit_amount]": String(PRICE_PENCE),
    "line_items[0][price_data][product_data][name]": "Party List Premium (lifetime)",
    "line_items[0][price_data][product_data][description]": "Unlimited guests across every event. One payment, no subscription.",
    client_reference_id: user.id,
    "metadata[user_id]": user.id,
    "payment_intent_data[metadata][user_id]": user.id,
    success_url: returnUrl + "?paid=1",
    cancel_url: returnUrl,
  });
  if (user.email) form.set("customer_email", user.email);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const session = await res.json();
  if (!res.ok) {
    console.error("stripe error", session?.error?.message);
    return json({ error: "stripe_error" }, 502, headers);
  }
  return json({ url: session.url }, 200, headers);
});
