-- Kaizen <-> TickTick: vínculos (somente o servidor lê; tokens nunca vão para o navegador)
create table if not exists public.tt_links (
  person text primary key,
  user_id uuid not null,
  access_token text not null,
  project_id text,
  project_name text,
  updated_at timestamptz default now()
);
alter table public.tt_links enable row level security;
revoke all on public.tt_links from anon, authenticated;

-- sincronização automática a cada 5 minutos
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('kaizen-ticktick') where exists (select 1 from cron.job where jobname = 'kaizen-ticktick');
select cron.schedule(
  'kaizen-ticktick',
  '*/5 * * * *',
  $$select net.http_post(
      url := 'https://ovdzhlwaiydskaysivtl.supabase.co/functions/v1/ticktick',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"action":"poll"}'::jsonb,
      timeout_milliseconds := 120000
  )$$
);
