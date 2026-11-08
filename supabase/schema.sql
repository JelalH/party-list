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
