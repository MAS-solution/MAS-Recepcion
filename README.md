# MAS Recepción

Plataforma de recepción de camiones (por ahora para **611 Logística**).

1. **Administración** carga los camiones que van a llegar: proveedor, fecha, nº de factura u orden, bultos y observación.
2. **Depósito** ve "Por llegar" en el celular y toca **Recibido**. Saca foto de la factura y marca si hubo diferencias (faltantes, roturas, vencimientos cortos). Si llega un camión que no estaba cargado, usa **"Llegó uno sin programar"**.
3. **Administración** recibe una **notificación push** con el proveedor. Revisa la foto y marca **Ingresado en Gescom**, opcionalmente con el nº de comprobante.

Estados: `programado` → `recibido` → `ingresado` (o `cancelado`). La lista se actualiza sola en todos los celulares.

## Arquitectura

- **Página estática** (`index.html`, `app.js`, `styles.css`), servida por GitHub Pages. Es una PWA instalable y usa la paleta de CobroSync.
- **Supabase** aporta:
  - login con email y contraseña;
  - Postgres con seguridad por fila (cada usuario ve solo su empresa);
  - bucket **privado** `facturas` para las fotos, que se ven con URLs firmadas de 1 hora;
  - tiempo real;
  - la Edge Function `notificar`, que manda el push.
- Las fotos se achican en el celular antes de subir (lado mayor 1600 px, JPEG 80%), unos 200–400 KB cada una.
- **Las fotos se borran solas a los 2 meses.** La Edge Function `limpiar-fotos` corre todas las noches con pg_cron. No borra las fotos de camiones que todavía no se ingresaron en Gescom, y el camión queda con la marca "Fotos eliminadas el …".
- **Nada sensible vive en este repo.** `config.js` solo tiene claves públicas (anon key y VAPID pública). Las fotos y los datos están en Supabase. La VAPID privada va como secret de Supabase.

## Puesta en marcha (una sola vez)

1. **Proyecto Supabase:**
   - crear un proyecto en <https://supabase.com>, región São Paulo;
   - en *SQL Editor*, pegar y correr `supabase/schema.sql`.
2. **Usuarios:**
   - en *Authentication → Users → Add user* crear el admin y el usuario de depósito, con email y contraseña ("Auto confirm");
   - asignarles rol en el *SQL Editor*:

   ```sql
   insert into perfiles (id, nombre, rol, empresa)
   select id, 'Administración', 'admin', '611' from auth.users where email = 'ADMIN@...';
   insert into perfiles (id, nombre, rol, empresa)
   select id, 'Depósito', 'deposito', '611' from auth.users where email = 'DEPOSITO@...';
   ```

3. **Notificaciones:**
   - en *Edge Functions → Secrets*, cargar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` (por ejemplo `mailto:tu@mail.com`);
   - desplegar la función, ya sea con `npx supabase functions deploy notificar --project-ref <ref>` o pegando `supabase/functions/notificar/index.ts` en el editor de Edge Functions del panel.
4. **Limpieza de fotos:**
   - activar las extensiones `pg_cron` y `pg_net` (*Database → Extensions*);
   - cargar el secret `CRON_SECRET` (un texto al azar);
   - desplegar la función **sin verificación de JWT**: `npx supabase functions deploy limpiar-fotos --no-verify-jwt --project-ref <ref>`;
   - correr `supabase/cron.sql`, reemplazando `<REF>` y `<CRON_SECRET>`.
5. **`config.js`:** completar `SUPABASE_URL` y `SUPABASE_ANON_KEY`, que están en *Project Settings → API*.
6. **GitHub Pages:** *Settings → Pages → Deploy from branch → main / root*.

## Uso en el celular

- Abrir la URL de Pages y **agregar a la pantalla de inicio**.
- El admin toca **Activar avisos**.
- En iPhone las notificaciones solo funcionan con la app agregada a inicio (iOS 16.4 o superior).
