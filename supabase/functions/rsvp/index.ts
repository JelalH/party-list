// Public RSVP endpoint for guests (no sign-in): the random token in their emailed link is the key.
//   GET  ?t=<token>            -> { name, title, date, time, place, answer }
//   POST { t, answer: yes|no } -> records the answer
// Deploy with --no-verify-jwt.
import { createClient } from "jsr:@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const token = req.method === "POST" ? body.t : new URL(req.url).searchParams.get("t");
  if (typeof token !== "string" || !UUID.test(token)) return json({ error: "bad_token" }, 400);

  const { data: r } = await db.from("rsvps").select("user_id, event_id, person_id, answer").eq("token", token).maybeSingle();
  if (!r) return json({ error: "not_found" }, 404);
  // the event and guest live in the host's saved list
  const { data: list } = await db.from("party_lists").select("data").eq("user_id", r.user_id).maybeSingle();
  const ev = list?.data?.events?.find((e: { id: string }) => e.id === r.event_id);
  const guest = ev?.people?.find((p: { id: string }) => p.id === r.person_id);
  if (!ev || !guest) return json({ error: "not_found" }, 404);   // host deleted the event or the guest

  if (req.method === "POST") {
    if (body.answer !== "yes" && body.answer !== "no") return json({ error: "bad_answer" }, 400);
    const { error } = await db.from("rsvps").update({ answer: body.answer, answered_at: new Date().toISOString() }).eq("token", token);
    return error ? json({ error: "save_failed" }, 500) : json({ answer: body.answer });
  }
  return json({ name: guest.name, title: ev.title, date: ev.date, time: ev.time, place: ev.place, answer: r.answer,
    hostEmail: ev.hostEmail || "", hostPhone: ev.hostPhone || "" });
});
