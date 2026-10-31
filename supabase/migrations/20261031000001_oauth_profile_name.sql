-- Google sign-in: take the profile name from `full_name`, falling back to
-- `name` (Google provides both; other providers may send only `name`).
-- Only affects accounts created from now on; existing rows are unchanged.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
                                nullif(btrim(new.raw_user_meta_data->>'name'), ''), ''), 120))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;
