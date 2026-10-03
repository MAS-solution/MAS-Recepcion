-- MAS Recepción — esquema de Supabase.
-- Se corre una sola vez en el SQL Editor del proyecto (es idempotente: se puede volver a correr).
--
-- Flujo: el admin carga los camiones que van a llegar (programado) → el depósito marca "Recibido"
-- con foto de la factura (recibido) → al admin le llega una notificación y marca "Ingresado en Gescom" (ingresado).

-- ---------- Perfiles (rol y empresa de cada usuario) ----------
create table if not exists public.perfiles (
  id      uuid primary key references auth.users(id) on delete cascade,
  nombre  text not null,
  rol     text not null check (rol in ('admin', 'deposito')),
  empresa text not null default '611'
);

-- ---------- Camiones ----------
create table if not exists public.camiones (
  id                 bigint generated always as identity primary key,
  empresa            text not null default '611',
  proveedor          text not null,
  fecha_estimada     date not null,
  comprobante        text,            -- nº de factura / orden, si se conoce de antemano
  bultos             numeric,
  observacion        text,
  estado             text not null default 'programado'
                     check (estado in ('programado', 'recibido', 'ingresado', 'cancelado')),
  no_programado      boolean not null default false,  -- llegó sin estar cargado
  creado_por         uuid references auth.users(id) default auth.uid(),
  creado_en          timestamptz not null default now(),
  recibido_por       uuid references auth.users(id),
  recibido_en        timestamptz,
  con_diferencias    boolean not null default false,  -- faltantes, roturas, vencimientos cortos
  recepcion_obs      text,
  fotos              text[] not null default '{}',     -- rutas en el bucket privado "facturas"
  ingresado_por      uuid references auth.users(id),
  ingresado_en       timestamptz,
  comprobante_gescom text,
  fotos_eliminadas_en timestamptz              -- las fotos se borran solas a los 2 meses (función limpiar-fotos)
);
alter table public.camiones add column if not exists fotos_eliminadas_en timestamptz;
create index if not exists camiones_empresa_estado on public.camiones (empresa, estado, fecha_estimada);

-- ---------- Suscripciones push (una por celular/navegador) ----------
create table if not exists public.push_subs (
  endpoint  text primary key,
  usuario   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh    text not null,
  auth      text not null,
  creado_en timestamptz not null default now()
);

-- ---------- Helpers ----------
create or replace function public.mi_rol() returns text
  language sql stable security definer set search_path = public
  as $$ select rol from perfiles where id = auth.uid() $$;

create or replace function public.mi_empresa() returns text
  language sql stable security definer set search_path = public
  as $$ select empresa from perfiles where id = auth.uid() $$;

create or replace function public.hoy_art() returns date
  language sql stable
  as $$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date $$;

-- ---------- Seguridad por fila ----------
alter table public.perfiles  enable row level security;
alter table public.camiones  enable row level security;
alter table public.push_subs enable row level security;

drop policy if exists perfiles_select on public.perfiles;
create policy perfiles_select on public.perfiles for select to authenticated
  using (empresa = public.mi_empresa());

drop policy if exists camiones_select on public.camiones;
create policy camiones_select on public.camiones for select to authenticated
  using (empresa = public.mi_empresa());

-- Solo el admin carga, edita y borra. El depósito cambia estados únicamente vía las funciones de abajo.
drop policy if exists camiones_insert on public.camiones;
create policy camiones_insert on public.camiones for insert to authenticated
  with check (public.mi_rol() = 'admin' and empresa = public.mi_empresa());

drop policy if exists camiones_update on public.camiones;
create policy camiones_update on public.camiones for update to authenticated
  using (public.mi_rol() = 'admin' and empresa = public.mi_empresa())
  with check (empresa = public.mi_empresa());

drop policy if exists camiones_delete on public.camiones;
create policy camiones_delete on public.camiones for delete to authenticated
  using (public.mi_rol() = 'admin' and empresa = public.mi_empresa());

drop policy if exists push_subs_propias on public.push_subs;
create policy push_subs_propias on public.push_subs for all to authenticated
  using (usuario = auth.uid()) with check (usuario = auth.uid());

-- ---------- Cambios de estado ----------
create or replace function public.marcar_recibido(p_id bigint, p_fotos text[], p_diferencias boolean, p_obs text)
  returns public.camiones language plpgsql security definer set search_path = public as $$
declare c camiones;
begin
  if public.mi_rol() is null then raise exception 'Usuario sin perfil'; end if;
  if coalesce(array_length(p_fotos, 1), 0) = 0 then raise exception 'Falta la foto de la factura'; end if;
  update camiones
     set estado = 'recibido', recibido_por = auth.uid(), recibido_en = now(), fotos = p_fotos,
         con_diferencias = coalesce(p_diferencias, false), recepcion_obs = nullif(trim(p_obs), '')
   where id = p_id and estado = 'programado' and empresa = public.mi_empresa()
  returning * into c;
  if c.id is null then raise exception 'El camión no existe o ya fue recibido'; end if;
  return c;
end $$;

-- Llegó un camión que nadie había cargado: el depósito lo da de alta ya recibido.
create or replace function public.recibir_no_programado(p_proveedor text, p_comprobante text, p_bultos numeric,
                                                        p_fotos text[], p_diferencias boolean, p_obs text)
  returns public.camiones language plpgsql security definer set search_path = public as $$
declare c camiones;
begin
  if public.mi_rol() is null then raise exception 'Usuario sin perfil'; end if;
  if nullif(trim(p_proveedor), '') is null then raise exception 'Falta el proveedor'; end if;
  if coalesce(array_length(p_fotos, 1), 0) = 0 then raise exception 'Falta la foto de la factura'; end if;
  insert into camiones (empresa, proveedor, fecha_estimada, comprobante, bultos, estado, no_programado,
                        recibido_por, recibido_en, fotos, con_diferencias, recepcion_obs)
  values (public.mi_empresa(), trim(p_proveedor), public.hoy_art(), nullif(trim(p_comprobante), ''), p_bultos,
          'recibido', true, auth.uid(), now(), p_fotos, coalesce(p_diferencias, false), nullif(trim(p_obs), ''))
  returning * into c;
  return c;
end $$;

create or replace function public.marcar_ingresado(p_id bigint, p_comprobante text)
  returns public.camiones language plpgsql security definer set search_path = public as $$
declare c camiones;
begin
  if public.mi_rol() <> 'admin' then raise exception 'Solo el administrador marca el ingreso'; end if;
  update camiones
     set estado = 'ingresado', ingresado_por = auth.uid(), ingresado_en = now(),
         comprobante_gescom = nullif(trim(p_comprobante), '')
   where id = p_id and estado = 'recibido' and empresa = public.mi_empresa()
  returning * into c;
  if c.id is null then raise exception 'El camión no existe o no está recibido'; end if;
  return c;
end $$;

revoke execute on function public.marcar_recibido(bigint, text[], boolean, text) from public, anon;
revoke execute on function public.recibir_no_programado(text, text, numeric, text[], boolean, text) from public, anon;
revoke execute on function public.marcar_ingresado(bigint, text) from public, anon;
grant execute on function public.marcar_recibido(bigint, text[], boolean, text) to authenticated;
grant execute on function public.recibir_no_programado(text, text, numeric, text[], boolean, text) to authenticated;
grant execute on function public.marcar_ingresado(bigint, text) to authenticated;

-- La usa la función limpiar-fotos (con service_role) después de borrar archivos del bucket.
create or replace function public.marcar_fotos_eliminadas(p_rutas text[])
  returns integer language sql security definer set search_path = public as $$
  with u as (
    update camiones set fotos = '{}', fotos_eliminadas_en = now()
     where fotos && p_rutas
    returning 1)
  select count(*)::int from u $$;
revoke execute on function public.marcar_fotos_eliminadas(text[]) from public, anon, authenticated;

-- ---------- Fotos de facturas: bucket PRIVADO, carpeta por empresa ----------
insert into storage.buckets (id, name, public) values ('facturas', 'facturas', false)
  on conflict (id) do update set public = false;

drop policy if exists facturas_subir on storage.objects;
create policy facturas_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'facturas' and (storage.foldername(name))[1] = public.mi_empresa());

drop policy if exists facturas_ver on storage.objects;
create policy facturas_ver on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and (storage.foldername(name))[1] = public.mi_empresa());

-- ---------- Tiempo real: la lista se actualiza sola en todos los celulares ----------
do $$ begin
  alter publication supabase_realtime add table public.camiones;
exception when duplicate_object then null; end $$;
