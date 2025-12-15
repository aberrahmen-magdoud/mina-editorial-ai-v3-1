-- Supabase SQL migration for admin session and audit logging
create table if not exists public.admin_sessions (
  session_hash text primary key,
  user_id uuid null,
  email text null,
  ip text null,
  user_agent text null,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  updated_at timestamptz
);

create table if not exists public.admin_audit (
  id text primary key,
  user_id uuid null,
  email text null,
  action text null,
  route text null,
  method text null,
  status int null,
  detail jsonb null,
  created_at timestamptz
);

create index if not exists admin_audit_created_at_idx on public.admin_audit (created_at);
create index if not exists admin_audit_action_idx on public.admin_audit (action);
create index if not exists admin_audit_user_id_idx on public.admin_audit (user_id);
