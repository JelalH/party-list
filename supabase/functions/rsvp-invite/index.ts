// Emails a guest their RSVP link from Party List (called by the signed-in host with { event_id, person_id }).
// The guest's details come from the host's saved list, so the app saves before calling this.
// Replies go to the event's host contact email, or the host's account email.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://partylist.tuex.site", "https://jelalh.github.io", "http://localhost:5178"];
const DAILY_CAP = 100;   // invites per host per 24h, so the sending domain can't be used for bulk mail
const SITE = "https://partylist.tuex.site/";

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("Origin")), "Content-Type": "application/json" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ error: "email_not_configured" }, 503);

  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401);
  const { event_id, person_id } = await req.json().catch(() => ({}));
  if (typeof event_id !== "string" || typeof person_id !== "string") return json({ error: "bad_request" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await db.from("rsvps").select("token", { count: "exact", head: true }).eq("user_id", user.id).gte("invited_at", since);
  if ((count ?? 0) >= DAILY_CAP) return json({ error: "daily_limit" }, 429);

  // shared events: read as the user, so only the host and co-hosts get through
  const { data: shared } = await asUser.from("shared_events").select("data").eq("id", event_id).maybeSingle();
  const { data: list } = shared ? { data: null } : await db.from("party_lists").select("data").eq("user_id", user.id).maybeSingle();
  const ev = shared?.data ?? list?.data?.events?.find((e: { id: string }) => e.id === event_id);
  const guest = ev?.people?.find((p: { id: string }) => p.id === person_id);
  const to = String(guest?.email ?? "").trim();
  if (!ev || !guest) return json({ error: "not_saved_yet" }, 409);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "bad_email" }, 400);

  const { data: row, error } = await db.from("rsvps")
    .upsert({ user_id: user.id, event_id, person_id, invited_at: new Date().toISOString() }, { onConflict: "user_id,event_id,person_id" })
    .select("token").single();
  if (error) return json({ error: "save_failed" }, 500);

  const link = `${SITE}rsvp.html?t=${row.token}`;
  const when = [ev.date && new Date(ev.date + "T00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }), ev.time, ev.place]
    .filter(Boolean).join(" · ");
  const host = [ev.hostEmail, ev.hostPhone].filter(Boolean).join(" · ");
  const lines = [
    `Hi ${guest.name.trim().split(/\s+/)[0]}, you're invited to ${ev.title}${when ? ` (${when})` : ""}.`,
    `Can you make it? Tap to answer: ${link}`,
    ...(guest.code ? [`Your entry code is ${guest.code}. Show it at the door.`] : []),
    ...(host ? [`Questions? Contact the host: ${host}`] : []),
  ];
  const replyTo = ev.hostEmail || user.email;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("EMAIL_FROM") ?? "Party List <invites@tuex.site>", to, ...(replyTo ? { reply_to: replyTo } : {}),
      subject: `Can you make it to ${ev.title}?`, text: lines.join("\n\n"),
      html: lines.map((l) => `<p>${esc(l).replace(esc(link), `<a href="${link}">${esc(link)}</a>`)}</p>`).join(""),
    }),
  });
  if (!res.ok) { console.error("resend", res.status, await res.text()); return json({ error: "send_failed" }, 502); }
  return json({ sent: true, to });
});
