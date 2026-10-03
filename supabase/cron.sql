-- Limpieza nocturna de fotos (03:30 hora Argentina = 06:30 UTC).
-- Requiere las extensiones pg_cron y pg_net (Database → Extensions) y el secret CRON_SECRET cargado en
-- Edge Functions → Secrets. Reemplazar <REF> y <CRON_SECRET> antes de correr (NO commitear el secret).
select cron.unschedule('limpiar-fotos') where exists (select 1 from cron.job where jobname = 'limpiar-fotos');
select cron.schedule('limpiar-fotos', '30 6 * * *', $$
  select net.http_post(
    url := 'https://<REF>.supabase.co/functions/v1/limpiar-fotos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb
  );
$$);
