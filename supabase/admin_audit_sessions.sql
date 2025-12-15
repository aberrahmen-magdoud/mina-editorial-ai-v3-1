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
  created_at timestamptz default now(),
  action text,
  route text,
  method text,
  status integer,
  user_id uuid null,
  email text null,
  detail jsonb
);

create index if not exists admin_audit_created_at_idx on public.admin_audit (created_at);
create index if not exists admin_audit_action_idx on public.admin_audit (action);
create index if not exists admin_audit_user_id_idx on public.admin_audit (user_id);

alter table if exists public.generations
  add column if not exists model text,
  add column if not exists provider text,
  add column if not exists latency_ms integer,
  add column if not exists input_chars integer,
  add column if not exists output_chars integer,
  add column if not exists meta jsonb;
