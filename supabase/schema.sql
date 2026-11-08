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
