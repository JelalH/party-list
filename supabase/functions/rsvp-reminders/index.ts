// Emails every guest who said "yes" a reminder the day before the event (UK date). Run daily by
// pg_cron (see schema.sql). Sends each guest at most one reminder, so extra calls send nothing new.
// shortcut: anyone can trigger it (deployed --no-verify-jwt), harmless because it is idempotent; add a secret if it ever does more.
// Needs secret RESEND_API_KEY (Resend, domain tuex.site); EMAIL_FROM is optional.
import { createClient } from "jsr:@supabase/supabase-js@2";

type Person = { id: string; name: string; email?: string; code?: string };
type Event = { id: string; title: string; date?: string; time?: string; place?: string; hostEmail?: string; hostPhone?: string; people: Person[] };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async () => {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return Response.json({ skipped: "RESEND_API_KEY not set" });
  const from = Deno.env.get("EMAIL_FROM") ?? "Party List <reminders@tuex.site>";
  const site = "https://partylist.tuex.site/";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD

  const { data: due } = await db.from("rsvps").select("token, user_id, event_id, person_id").eq("answer", "yes").is("reminded_at", null);
  const owners = [...new Set((due ?? []).map((r) => r.user_id))];
  const { data: lists } = owners.length ? await db.from("party_lists").select("user_id, data").in("user_id", owners) : { data: [] };
  const byOwner = new Map((lists ?? []).map((l) => [l.user_id, (l.data?.events ?? []) as Event[]]));

  let sent = 0;
  for (const r of due ?? []) {
    const ev = byOwner.get(r.user_id)?.find((e) => e.id === r.event_id);
    const guest = ev?.people.find((p) => p.id === r.person_id);
    if (!ev || ev.date !== tomorrow || !guest?.email) continue;
    const first = guest.name.trim().split(/\s+/)[0];
    const link = `${site}rsvp.html?t=${r.token}`;
    const host = [ev.hostEmail, ev.hostPhone].filter(Boolean).join(" · ");
    const lines = [
      `Hi ${first}, just a reminder: ${ev.title} is tomorrow${ev.time ? ` at ${ev.time}` : ""}${ev.place ? `, ${ev.place}` : ""}.`
        + `${guest.code ? ` Your entry code is ${guest.code}.` : ""} See you there!`,
      `Can't make it after all? Change your answer: ${link}`,
      ...(host ? [`Questions? Contact the host: ${host}`] : []),
    ];
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: guest.email, subject: `Tomorrow: ${ev.title}`, text: lines.join("\n\n"),
        html: lines.map((l) => `<p>${esc(l).replace(esc(link), `<a href="${link}">${esc(link)}</a>`)}</p>`).join("") }),
    });
    if (!res.ok) { console.error("resend", res.status, await res.text()); continue; }   // not marked, so a later run the same day retries it
    await db.from("rsvps").update({ reminded_at: new Date().toISOString() }).eq("token", r.token);
    sent++;
  }
  return Response.json({ sent, checked: due?.length ?? 0, for: tomorrow });
});
