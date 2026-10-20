-- MAS Recepción — módulo Roturas (se corre después de schema.sql; es idempotente).
--
-- Flujo: el depósito elige proveedor, busca el artículo por código o descripción y carga las unidades rotas
-- (fecha y hora se ponen solas) → el admin ve la suma por SKU, filtra por proveedor y marca "Ingresado en Gescom"
-- → esas cargas salen del pendiente (el contador arranca de nuevo) y quedan en el historial 2 meses.

-- ---------- Maestro de artículos (lo llena scripts/sync_articulos.py desde Gescom, con service_role) ----------
create table if not exists public.articulos (
  empresa     text not null default '611',
  codigo      text not null,
  descripcion text not null,
  prov_codigo text not null,
  proveedor   text not null,
  activo      boolean not null default true,
  actualizado timestamptz not null default now(),
  primary key (empresa, codigo)
);
create index if not exists articulos_prov on public.articulos (empresa, prov_codigo);

-- ---------- Ingresos a Gescom (un registro cada vez que el admin marca "Ingresado") ----------
create table if not exists public.roturas_ingresos (
  id            bigint generated always as identity primary key,
  empresa       text not null default '611',
  prov_codigo   text,                 -- null = se ingresaron todos los proveedores juntos
  comprobante   text,
  ingresado_por uuid references auth.users(id) default auth.uid(),
  ingresado_en  timestamptz not null default now()
);

-- ---------- Cargas de roturas (una fila por artículo cargado) ----------
create table if not exists public.roturas (
  id          bigint generated always as identity primary key,
  empresa     text not null default '611',
  codigo      text not null,
  descripcion text not null,          -- copia del maestro al momento de cargar
  prov_codigo text not null,
  proveedor   text not null,
  cantidad    integer not null check (cantidad > 0),  -- en unidades
  cargado_por uuid references auth.users(id) default auth.uid(),
  cargado_en  timestamptz not null default now(),
  ingreso_id  bigint references public.roturas_ingresos(id) on delete cascade  -- null = pendiente
);
create index if not exists roturas_pendientes on public.roturas (empresa, prov_codigo) where ingreso_id is null;
create index if not exists roturas_ingreso on public.roturas (ingreso_id);

-- ---------- Seguridad por fila ----------
alter table public.articulos        enable row level security;
alter table public.roturas          enable row level security;
alter table public.roturas_ingresos enable row level security;

drop policy if exists articulos_select on public.articulos;
create policy articulos_select on public.articulos for select to authenticated
  using (empresa = public.mi_empresa());

drop policy if exists roturas_select on public.roturas;
create policy roturas_select on public.roturas for select to authenticated
  using (empresa = public.mi_empresa());

-- Se carga solo vía cargar_rotura(). Mientras está pendiente, quien la cargó (o el admin) la puede borrar.
drop policy if exists roturas_delete on public.roturas;
create policy roturas_delete on public.roturas for delete to authenticated
  using (empresa = public.mi_empresa() and ingreso_id is null
         and (cargado_por = auth.uid() or public.mi_rol() = 'admin'));

drop policy if exists roturas_ingresos_select on public.roturas_ingresos;
create policy roturas_ingresos_select on public.roturas_ingresos for select to authenticated
  using (empresa = public.mi_empresa());

-- ---------- Funciones ----------
create or replace function public.cargar_rotura(p_codigo text, p_cantidad integer)
  returns public.roturas language plpgsql security definer set search_path = public as $$
declare a articulos; r roturas;
begin
  if public.mi_rol() is null then raise exception 'Usuario sin perfil'; end if;
  if coalesce(p_cantidad, 0) <= 0 then raise exception 'La cantidad tiene que ser mayor a 0'; end if;
  select * into a from articulos where empresa = public.mi_empresa() and codigo = trim(p_codigo);
  if a.codigo is null then raise exception 'Artículo % no encontrado', p_codigo; end if;
  insert into roturas (empresa, codigo, descripcion, prov_codigo, proveedor, cantidad)
  values (a.empresa, a.codigo, a.descripcion, a.prov_codigo, a.proveedor, p_cantidad)
  returning * into r;
  return r;
end $$;

-- El admin pasa las cargas que está viendo (así no se lleva una que entró recién y no vio).
create or replace function public.ingresar_roturas(p_ids bigint[], p_prov_codigo text, p_comprobante text)
  returns public.roturas_ingresos language plpgsql security definer set search_path = public as $$
declare i roturas_ingresos; n int;
begin
  if public.mi_rol() <> 'admin' then raise exception 'Solo el administrador marca el ingreso'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'No hay roturas pendientes'; end if;
  insert into roturas_ingresos (empresa, prov_codigo, comprobante)
  values (public.mi_empresa(), nullif(trim(p_prov_codigo), ''), nullif(trim(p_comprobante), ''))
  returning * into i;
  update roturas set ingreso_id = i.id
   where id = any(p_ids) and ingreso_id is null and empresa = public.mi_empresa();
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Esas roturas ya fueron ingresadas'; end if;
  return i;
end $$;

revoke execute on function public.cargar_rotura(text, integer) from public, anon;
revoke execute on function public.ingresar_roturas(bigint[], text, text) from public, anon;
grant execute on function public.cargar_rotura(text, integer) to authenticated;
grant execute on function public.ingresar_roturas(bigint[], text, text) to authenticated;

-- ---------- Tiempo real ----------
do $$ begin
  alter publication supabase_realtime add table public.roturas;
exception when duplicate_object then null; end $$;

-- ---------- Historial de 2 meses: todas las noches se borra lo ingresado hace más de 60 días ----------
-- (borrar el ingreso borra sus cargas por el "on delete cascade"). Lo pendiente nunca se borra.
select cron.unschedule('limpiar-roturas') where exists (select 1 from cron.job where jobname = 'limpiar-roturas');
select cron.schedule('limpiar-roturas', '45 6 * * *',
  $$ delete from public.roturas_ingresos where ingresado_en < now() - interval '60 days' $$);
