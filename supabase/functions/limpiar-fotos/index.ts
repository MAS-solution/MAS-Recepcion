// Edge Function "limpiar-fotos": borra las fotos de facturas con más de 2 meses.
// La corre todas las noches un job de pg_cron (ver supabase/cron.sql), autenticado con el secret CRON_SECRET.
//
// Las fotos se guardan como <empresa>/<YYYY-MM-DD>/<uuid>.jpg, así que se recorren las carpetas de fecha
// anteriores al corte y se borra todo (incluye fotos sueltas de recepciones que fallaron a mitad de camino).
// Excepción: no se borran fotos de camiones que siguen "recibido" (todavía no ingresados en Gescom).
import { createClient } from 'npm:@supabase/supabase-js@2';

const MESES = 2;

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('no autorizado', { status: 401 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const corte = new Date();
  corte.setMonth(corte.getMonth() - MESES);
  const corteISO = corte.toISOString().slice(0, 10);

  // Fotos que hay que conservar: camiones todavía sin ingresar.
  const { data: pendientes } = await sb.from('camiones').select('fotos').eq('estado', 'recibido');
  const conservar = new Set((pendientes ?? []).flatMap((c) => c.fotos ?? []));

  const borradas: string[] = [];
  const { data: empresas } = await sb.storage.from('facturas').list('', { limit: 1000 });
  for (const emp of empresas ?? []) {
    const { data: dias } = await sb.storage.from('facturas').list(emp.name, { limit: 1000 });
    for (const dia of dias ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia.name) || dia.name >= corteISO) continue;
      const carpeta = `${emp.name}/${dia.name}`;
      const { data: archivos } = await sb.storage.from('facturas').list(carpeta, { limit: 1000 });
      const rutas = (archivos ?? []).map((a) => `${carpeta}/${a.name}`).filter((r) => !conservar.has(r));
      if (!rutas.length) continue;
      const { error } = await sb.storage.from('facturas').remove(rutas);
      if (!error) borradas.push(...rutas);
    }
  }

  // Los camiones quedan con la marca de cuándo se borraron sus fotos (la app lo muestra).
  if (borradas.length) {
    const { error } = await sb.rpc('marcar_fotos_eliminadas', { p_rutas: borradas });
    if (error) return Response.json({ ok: false, borradas: borradas.length, error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, corte: corteISO, borradas: borradas.length });
});
