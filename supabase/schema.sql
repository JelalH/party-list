-- One saved guest list per signed-in person.
create table if not exists public.party_lists (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.party_lists enable row level security;

-- Each person can only ever see and change their own list.
drop policy if exists "own list: read"   on public.party_lists;
drop policy if exists "own list: insert" on public.party_lists;
drop policy if exists "own list: update" on public.party_lists;
drop policy if exists "own list: delete" on public.party_lists;

create policy "own list: read"   on public.party_lists for select to authenticated using (user_id = (select auth.uid()));
create policy "own list: insert" on public.party_lists for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own list: update" on public.party_lists for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own list: delete" on public.party_lists for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.party_lists to authenticated;
revoke all on public.party_lists from anon;

-- Premium (lifetime unlock). Only the payment webhooks (service role) write here;
-- people can read their own row.
create table if not exists public.entitlements (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  premium      boolean not null default false,
  source       text,            -- 'stripe' | 'app_store' | 'play_store'
  purchased_at timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.entitlements enable row level security;
drop policy if exists "own entitlement: read" on public.entitlements;
create policy "own entitlement: read" on public.entitlements for select to authenticated using (user_id = (select auth.uid()));
grant select on public.entitlements to authenticated;
revoke all on public.entitlements from anon;

-- Free plan: 20 people across all events. Enforced here too, not just in the app.
create or replace function public.party_people_count(d jsonb) returns int language sql immutable as $$
  select (case when jsonb_typeof(d->'events') = 'array'
    then coalesce((select sum(case when jsonb_typeof(e->'people') = 'array' then jsonb_array_length(e->'people') else 0 end) from jsonb_array_elements(d->'events') e), 0)
    else case when jsonb_typeof(d->'people') = 'array' then jsonb_array_length(d->'people') else 0 end end)::int $$;

create or replace function public.enforce_free_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare n int := public.party_people_count(new.data); old_n int := 0;
begin
  if tg_op = 'UPDATE' then old_n := public.party_people_count(old.data); end if;
  -- only block growth past 20; shrinking an over-limit list is always allowed
  if n > 20 and n > old_n and not exists (select 1 from public.entitlements where user_id = new.user_id and premium) then
    raise exception 'free_limit: % guests needs Premium', n using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists party_lists_free_limit on public.party_lists;
create trigger party_lists_free_limit before insert or update on public.party_lists for each row execute function public.enforce_free_limit();

-- RSVPs: a guest answers yes / no through an emailed link (edge function `rsvp`, token = the link key).
-- Hosts read and create their own rows; only the service role (edge functions) writes answers.
create table if not exists public.rsvps (
  token       uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event_id    text not null,
  person_id   text not null,
  answer      text check (answer in ('yes', 'no')),
  answered_at timestamptz,
  reminded_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, event_id, person_id)
);
alter table public.rsvps enable row level security;
drop policy if exists "own rsvps: read"   on public.rsvps;
drop policy if exists "own rsvps: insert" on public.rsvps;
drop policy if exists "own rsvps: update" on public.rsvps;
create policy "own rsvps: read"   on public.rsvps for select to authenticated using (user_id = (select auth.uid()));
create policy "own rsvps: insert" on public.rsvps for insert to authenticated with check (user_id = (select auth.uid()));
-- upsert needs update; a host could only fake answers on their own list, so that's harmless
create policy "own rsvps: update" on public.rsvps for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on public.rsvps to authenticated;
revoke all on public.rsvps from anon;

-- Day-before reminder emails for guests who said yes (edge function `rsvp-reminders`), 09:00 UTC daily.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('rsvp-reminders') where exists (select 1 from cron.job where jobname = 'rsvp-reminders');
select cron.schedule('rsvp-reminders', '0 9 * * *',
  $$select net.http_post(url := 'https://xdgrovfkdtvovryyybie.supabase.co/functions/v1/rsvp-reminders', body := '{}'::jsonb)$$);
alter table public.rsvps add column if not exists invited_at timestamptz;   -- when Party List last emailed the invite (daily cap)

-- Co-hosts: an event the host shares lives here (one row per event) so every co-host can read and edit it.
-- The app merges guest by guest (each guest carries a change time `u`, deletions are kept in `removed`),
-- and writes with an optimistic version check so two phones at the door don't overwrite each other.
create table if not exists public.shared_events (
  id         text primary key,                 -- the event's own id from the app
  owner      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null,
  version    int not null default 1,
  join_token uuid not null default gen_random_uuid(),   -- the invite link's key
  updated_at timestamptz not null default now()
);
create table if not exists public.event_members (
  event_id  text not null references public.shared_events (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
alter table public.shared_events enable row level security;
alter table public.event_members enable row level security;

-- owner or co-host of an event (security definer so the policies below don't recurse)
create or replace function public.can_edit_event(eid text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shared_events where id = eid and owner = (select auth.uid()))
      or exists (select 1 from public.event_members where event_id = eid and user_id = (select auth.uid())) $$;

drop policy if exists "shared: read"   on public.shared_events;
drop policy if exists "shared: create" on public.shared_events;
drop policy if exists "shared: edit"   on public.shared_events;
drop policy if exists "shared: delete" on public.shared_events;
create policy "shared: read"   on public.shared_events for select to authenticated using (public.can_edit_event(id));
create policy "shared: create" on public.shared_events for insert to authenticated with check (owner = (select auth.uid()));
create policy "shared: edit"   on public.shared_events for update to authenticated using (public.can_edit_event(id)) with check (public.can_edit_event(id));
create policy "shared: delete" on public.shared_events for delete to authenticated using (owner = (select auth.uid()));
revoke all on public.shared_events from anon, authenticated;
grant select, insert, delete on public.shared_events to authenticated;
grant update (data, version, updated_at) on public.shared_events to authenticated;   -- nobody can change owner or the invite key

drop policy if exists "members: read"  on public.event_members;
drop policy if exists "members: leave" on public.event_members;
create policy "members: read"  on public.event_members for select to authenticated using (public.can_edit_event(event_id));
create policy "members: leave" on public.event_members for delete to authenticated
  using (user_id = (select auth.uid()) or exists (select 1 from public.shared_events s where s.id = event_id and s.owner = (select auth.uid())));
revoke all on public.event_members from anon, authenticated;
grant select, delete on public.event_members to authenticated;   -- joining only through join_event()

-- accept an invite link: adds the signed-in person as a co-host, returns the event id
create or replace function public.join_event(token uuid) returns text language plpgsql security definer set search_path = public as $$
declare eid text; owner_id uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select id, owner into eid, owner_id from public.shared_events where join_token = token;
  if eid is null then raise exception 'invite_not_found' using errcode = 'P0002'; end if;
  if owner_id <> auth.uid() then
    if (select count(*) from public.event_members where event_id = eid) >= 10 then raise exception 'too_many_cohosts'; end if;
    insert into public.event_members (event_id, user_id) values (eid, auth.uid()) on conflict do nothing;
  end if;
  return eid;
end $$;
revoke all on function public.join_event(uuid) from public, anon;
grant execute on function public.join_event(uuid) to authenticated;

-- free plan still applies to shared events (counted against the host)
create or replace function public.enforce_shared_free_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare n int := coalesce(jsonb_array_length(case when jsonb_typeof(new.data->'people') = 'array' then new.data->'people' end), 0);
        old_n int := 0;
begin
  if tg_op = 'UPDATE' then old_n := coalesce(jsonb_array_length(case when jsonb_typeof(old.data->'people') = 'array' then old.data->'people' end), 0); end if;
  if n > 20 and n > old_n and not exists (select 1 from public.entitlements where user_id = new.owner and premium) then
    raise exception 'free_limit: % guests needs Premium', n using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists shared_events_free_limit on public.shared_events;
create trigger shared_events_free_limit before insert or update on public.shared_events for each row execute function public.enforce_shared_free_limit();

-- co-hosts see the RSVP answers for a shared event, whoever sent the invite
drop policy if exists "shared rsvps: read" on public.rsvps;
create policy "shared rsvps: read" on public.rsvps for select to authenticated using (public.can_edit_event(event_id));

-- the owner check is done on the row itself: inside an INSERT ... RETURNING the new row isn't visible to can_edit_event() yet
drop policy if exists "shared: read" on public.shared_events;
drop policy if exists "shared: edit" on public.shared_events;
create policy "shared: read" on public.shared_events for select to authenticated using (owner = (select auth.uid()) or public.can_edit_event(id));
create policy "shared: edit" on public.shared_events for update to authenticated
  using (owner = (select auth.uid()) or public.can_edit_event(id)) with check (owner = (select auth.uid()) or public.can_edit_event(id));