// Edge Function "notificar": cuando el depósito marca un camión como recibido, la app la llama y
// esta manda una notificación push a los admins de esa empresa.
//
// Secrets necesarios (Supabase → Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase solo.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { camion_id } = await req.json();
    const url = Deno.env.get('SUPABASE_URL')!;

    // Con el token del usuario: la seguridad por fila asegura que solo vea camiones de su empresa.
    const comoUsuario = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: c, error } = await comoUsuario.from('camiones').select('*').eq('id', camion_id).single();
    if (error || !c) return json({ ok: false, error: 'Camión no encontrado' }, 404);
    if (c.estado !== 'recibido') return json({ ok: false, error: 'El camión no está recibido' }, 400);

    const sistema = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: admins } = await sistema.from('perfiles').select('id').eq('rol', 'admin').eq('empresa', c.empresa);
    const ids = (admins ?? []).map((a) => a.id);
    if (!ids.length) return json({ ok: true, enviados: 0 });
    const { data: subs } = await sistema.from('push_subs').select('*').in('usuario', ids);

    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
    const partes = [c.no_programado ? 'Sin programar' : null, c.comprobante ? `Fact. ${c.comprobante}` : null,
                    c.con_diferencias ? '⚠ Con diferencias' : null].filter(Boolean);
    const payload = JSON.stringify({
      title: `Camión recibido · ${c.proveedor}`,
      body: partes.length ? partes.join(' · ') : 'Falta ingresarlo en Gescom',
      tag: `camion-${c.id}`,
      url: './#ingresar',
    });

    let enviados = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        enviados++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await sistema.from('push_subs').delete().eq('endpoint', s.endpoint);
      }
    }
    return json({ ok: true, enviados });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
