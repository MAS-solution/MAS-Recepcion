'use strict';
// MAS Recepción — camiones programados → recibidos (con foto de factura) → ingresados en Gescom.
// Todo el estado vive en Supabase; esta página es estática (GitHub Pages).

const cfg = window.MAS_CONFIG;
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const TZ = 'America/Argentina/Buenos_Aires';
const DIAS_HISTORIAL = 60;

const st = { sesion: null, perfil: null, camiones: [], nombres: {}, tab: null, canal: null, urls: {}, mes: null, diaSel: null,
  roturas: [], ingresos: [], articulos: null, rc: { prov: '', q: '', sel: null }, filtroProv: '', filtroHist: '' };
let sb;

// ---------- Utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoyART = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function fmtFecha(iso) {
  if (!iso) return '';
  const hoy = hoyART();
  if (iso === hoy) return 'Hoy';
  if (iso === sumarDias(hoy, 1)) return 'Mañana';
  if (iso === sumarDias(hoy, -1)) return 'Ayer';
  const d = new Date(iso + 'T12:00:00Z');
  return new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' }).format(d);
}
const fmtHora = (ts) => ts ? new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts)) : '';
const nombre = (id) => st.nombres[id] || '—';
const esAdmin = () => st.perfil && st.perfil.rol === 'admin';

function toast(msg, mal = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (mal ? ' mal' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, mal ? 6000 : 3500);
}
const errorMsg = (e) => (e && (e.message || e.error_description)) || String(e);

// ---------- Arranque ----------
async function iniciar() {
  document.getElementById('empresa-nombre').textContent = cfg.EMPRESA_NOMBRE || '';
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('TU-PROYECTO')) {
    $app.innerHTML = '<div class="card"><h3>Falta configurar</h3><p class="meta">Completá <span class="mono">config.js</span> con la URL y la anon key del proyecto de Supabase (ver README).</p></div>';
    return;
  }
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t && t !== st.tab) { st.tab = t; render(); } });
  sb.auth.onAuthStateChange((_evento, sesion) => {
    const antes = st.sesion && st.sesion.user.id;
    st.sesion = sesion;
    if ((sesion && sesion.user.id) !== antes) entrar();
  });
  const { data } = await sb.auth.getSession();
  st.sesion = data.session;
  entrar();
}

async function entrar() {
  if (st.canal) { sb.removeChannel(st.canal); st.canal = null; }
  if (!st.sesion) { st.perfil = null; renderTopbar(); renderLogin(); return; }
  const { data: perfil, error } = await sb.from('perfiles').select('*').eq('id', st.sesion.user.id).maybeSingle();
  if (error || !perfil) {
    st.perfil = null; renderTopbar();
    $app.innerHTML = `<div class="card"><h3>Usuario sin perfil</h3><p class="meta">Tu usuario (${esc(st.sesion.user.email)}) todavía no tiene rol asignado. Pedile al administrador que lo dé de alta.</p></div>`;
    return;
  }
  st.perfil = perfil;
  const t = location.hash.slice(1);
  st.tab = t || 'inicio'; // sin pestaña en la URL, primero se elige la vista (Recepción o Roturas)
  renderTopbar();
  await cargar();
  st.canal = sb.channel('camiones-' + perfil.empresa)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'camiones' }, () => cargar())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'roturas' }, () => cargarRoturas())
    .subscribe();
}

async function cargar() {
  const desde = new Date(Date.now() - DIAS_HISTORIAL * 86400000).toISOString();
  const [cam, per] = await Promise.all([
    sb.from('camiones').select('*').or(`estado.in.(programado,recibido),creado_en.gte.${desde}`)
      .order('fecha_estimada', { ascending: true }).order('id', { ascending: true }),
    sb.from('perfiles').select('id,nombre'),
    cargarRoturas(false),
  ]);
  if (cam.error) { toast('No se pudo cargar: ' + errorMsg(cam.error), true); return; }
  st.camiones = cam.data || [];
  st.nombres = Object.fromEntries((per.data || []).map((p) => [p.id, p.nombre]));
  refrescar();
}

// Roturas: lo pendiente y lo ingresado (la base borra sola lo ingresado hace más de 2 meses).
async function cargarRoturas(pintar = true) {
  const [rot, ing] = await Promise.all([
    sb.from('roturas').select('*').order('cargado_en', { ascending: false }).limit(10000),
    sb.from('roturas_ingresos').select('*').order('ingresado_en', { ascending: false }),
  ]);
  if (rot.error) { if (pintar) toast('No se pudieron cargar las roturas: ' + errorMsg(rot.error), true); return; }
  st.roturas = rot.data || [];
  st.ingresos = ing.data || [];
  if (pintar) refrescar();
}

// El maestro de artículos se pide una sola vez, al entrar a Roturas (de a 1000 por el límite de Supabase).
async function cargarArticulos() {
  if (st.articulos) return;
  const todos = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from('articulos').select('codigo,descripcion,prov_codigo,proveedor')
      .eq('activo', true).order('codigo').range(desde, desde + 999);
    if (error) { toast('No se pudieron cargar los artículos: ' + errorMsg(error), true); return; }
    todos.push(...data);
    if (data.length < 1000) break;
  }
  st.articulos = todos.map((a) => ({ ...a, _q: normalizar(a.codigo + ' ' + a.descripcion) }));
  refrescar();
}

// Mientras el depósito está cargando una rotura no se redibuja la pantalla entera (perdería lo que está tipeando).
function refrescar() {
  if (st.tab === 'rot-cargar' && document.getElementById('rc-prov')) { pintarUltimas(); return; }
  render();
}

// ---------- Topbar y login ----------
function renderTopbar() {
  const el = document.getElementById('topbar-actions');
  if (!st.perfil) { el.innerHTML = st.sesion ? '<button class="icon-btn" data-accion="salir">Salir</button>' : ''; return; }
  const avisos = esAdmin() && 'PushManager' in window ? '<button class="icon-btn" data-accion="avisos" id="btn-avisos">Activar avisos</button>' : '';
  el.innerHTML = `<span class="pill">${esc(st.perfil.nombre)} · ${st.perfil.rol === 'admin' ? 'admin' : 'depósito'}</span>${avisos}<button class="icon-btn" data-accion="salir">Salir</button>`;
  if (avisos) estadoAvisos();
}

function renderLogin() {
  $app.innerHTML = `
    <form class="login" id="form-login">
      <h1>Ingresar</h1>
      <p>Recepción de camiones · ${esc(cfg.EMPRESA_NOMBRE || '')}</p>
      <div class="campo"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="campo"><label for="l-pass">Contraseña</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
      <div class="error" id="l-error" hidden></div>
      <button class="btn btn-primary btn-block" type="submit">Ingresar</button>
    </form>`;
  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: document.getElementById('l-email').value.trim(), password: document.getElementById('l-pass').value });
    btn.disabled = false;
    if (error) { const er = document.getElementById('l-error'); er.textContent = 'Email o contraseña incorrectos.'; er.hidden = false; }
  });
}

// ---------- Vistas ----------
const esRoturas = (tab) => (tab || '').startsWith('rot-');

function tabsDe() {
  const n = (estado) => st.camiones.filter((c) => c.estado === estado).length;
  if (esRoturas(st.tab)) {
    const pend = st.roturas.filter((r) => !r.ingreso_id);
    return esAdmin()
      ? [['rot-resumen', 'Pendiente', new Set(pend.map((r) => r.codigo)).size], ['rot-cargar', 'Cargar', 0], ['rot-historial', 'Historial', 0]]
      : [['rot-cargar', 'Cargar', 0], ['rot-cargadas', 'Cargadas', pend.length]];
  }
  return esAdmin()
    ? [['llegar', 'Por llegar', n('programado')], ['calendario', 'Calendario', 0], ['ingresar', 'A ingresar', n('recibido')], ['historial', 'Historial', 0]]
    : [['llegar', 'Por llegar', n('programado')], ['calendario', 'Calendario', 0], ['recibidos', 'Recibidos', 0]];
}

function render() {
  if (!st.perfil) return;
  if (st.tab === 'inicio') { $app.innerHTML = renderInicio(); return; }
  const tabs = tabsDe();
  if (!tabs.some(([id]) => id === st.tab)) st.tab = tabs[0][0];
  const hoy = hoyART();
  let html = `<div class="tabs" role="tablist"><button class="tab tab-vistas" data-accion="tab" data-tab="inicio" aria-label="Cambiar de vista">‹ ${esRoturas(st.tab) ? 'Roturas' : 'Recepción'}</button>${tabs.map(([id, txt, num]) =>
    `<button class="tab" role="tab" aria-selected="${id === st.tab}" data-accion="tab" data-tab="${id}">${txt}${num ? `<span class="num">${num}</span>` : ''}</button>`).join('')}</div>`;

  if (esRoturas(st.tab)) {
    $app.innerHTML = html + renderRoturas();
    montarRoturas();
    return;
  }
  if (st.tab === 'llegar') {
    html += `<div class="barra">${esAdmin()
      ? '<button class="btn btn-accent btn-sm" data-accion="nuevo">+ Cargar camión</button>'
      : ''}<button class="btn btn-ghost btn-sm" data-accion="no-programado">Llegó uno sin programar</button></div>`;
    const prog = st.camiones.filter((c) => c.estado === 'programado');
    const atrasados = prog.filter((c) => c.fecha_estimada < hoy);
    const deHoy = prog.filter((c) => c.fecha_estimada === hoy);
    const proximos = prog.filter((c) => c.fecha_estimada > hoy);
    if (!prog.length) html += '<p class="vacio">No hay camiones programados.</p>';
    if (atrasados.length) html += '<div class="seccion">Atrasados</div>' + atrasados.map(cardProgramado).join('');
    if (deHoy.length) html += '<div class="seccion">Llegan hoy</div>' + deHoy.map(cardProgramado).join('');
    if (proximos.length) html += '<div class="seccion">Próximos</div>' + proximos.map(cardProgramado).join('');
  } else if (st.tab === 'ingresar') {
    const rec = st.camiones.filter((c) => c.estado === 'recibido').sort((a, b) => (a.recibido_en || '').localeCompare(b.recibido_en || ''));
    html += rec.length ? rec.map(cardRecibido).join('') : '<p class="vacio">Nada pendiente de ingresar en Gescom.</p>';
  } else if (st.tab === 'recibidos') {
    const desde = sumarDias(hoy, -7);
    const rec = st.camiones.filter((c) => ['recibido', 'ingresado'].includes(c.estado) && c.recibido_en && fmtISO(c.recibido_en) >= desde)
      .sort((a, b) => b.recibido_en.localeCompare(a.recibido_en));
    html += '<div class="seccion">Últimos 7 días</div>' + (rec.length ? rec.map(cardRecibido).join('') : '<p class="vacio">Todavía no recibiste camiones esta semana.</p>');
  } else if (st.tab === 'calendario') {
    html += renderCalendario();
  } else if (st.tab === 'historial') {
    html += '<div class="campo"><input id="buscar" type="search" placeholder="Buscar proveedor o comprobante"></div><div id="lista-historial"></div>';
  }
  $app.innerHTML = html;
  if (st.tab === 'historial') {
    const inp = document.getElementById('buscar');
    inp.value = st.busqueda || '';
    inp.addEventListener('input', () => { st.busqueda = inp.value; renderHistorial(); });
    renderHistorial();
  }
  cargarFotos();
}

const fmtISO = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));

// ---------- Calendario ----------
// Cada camión cae en el día que llegó de verdad (recibido_en); si todavía no llegó, en su fecha estimada.
const diaDe = (c) => (c.recibido_en ? fmtISO(c.recibido_en) : c.fecha_estimada);
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function camionesPorDia() {
  const hoy = hoyART();
  const dias = {};
  for (const c of st.camiones) {
    if (c.estado === 'cancelado') continue;
    const d = diaDe(c);
    const x = dias[d] || (dias[d] = { total: 0, llegados: 0, programados: 0, atrasados: 0, pallets: 0, lista: [] });
    x.total++; x.lista.push(c);
    if (c.estado === 'programado') { if (d < hoy) x.atrasados++; else x.programados++; } else x.llegados++;
    if (c.bultos != null) x.pallets += Number(c.bultos); // la columna bultos guarda pallets
  }
  return dias;
}

function renderCalendario() {
  const hoy = hoyART();
  if (!st.mes) st.mes = hoy.slice(0, 7);
  const [anio, mes] = st.mes.split('-').map(Number);
  const dias = camionesPorDia();
  const enMes = Object.entries(dias).filter(([d]) => d.startsWith(st.mes));
  const sum = (k) => enMes.reduce((a, [, x]) => a + x[k], 0);
  const max = Math.max(1, ...enMes.map(([, x]) => x.total));
  const offset = (new Date(`${st.mes}-01T12:00:00Z`).getUTCDay() + 6) % 7; // lunes = 0
  const largo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();

  let celdas = '';
  for (let i = 0; i < offset; i++) celdas += '<div class="cal-dia vacio-dia"></div>';
  for (let n = 1; n <= largo; n++) {
    const iso = `${st.mes}-${String(n).padStart(2, '0')}`;
    const x = dias[iso];
    const nivel = x ? Math.ceil((x.total / max) * 4) : 0;
    const cls = ['cal-dia', `n${nivel}`, iso === hoy ? 'es-hoy' : '', iso === st.diaSel ? 'sel' : '', iso < hoy ? 'pasado' : ''].join(' ');
    const puntos = x ? [x.llegados ? '<i class="p-ok"></i>' : '', x.programados ? '<i class="p-prog"></i>' : '', x.atrasados ? '<i class="p-bad"></i>' : ''].join('') : '';
    celdas += `<button class="${cls}" data-accion="cal-dia" data-dia="${iso}" aria-label="${n}: ${x ? x.total + ' camiones' : 'sin camiones'}">
      <span class="cal-n">${n}</span>
      ${x ? `<b class="cal-total">${x.total}</b><span class="cal-bultos">${x.pallets ? x.pallets + ' pallets' : ''}</span><span class="cal-puntos">${puntos}</span>` : ''}
    </button>`;
  }

  let html = `<div class="cal-head">
      <button class="btn btn-ghost btn-sm" data-accion="cal-mes" data-delta="-1" aria-label="Mes anterior">‹</button>
      <h2>${MESES[mes - 1]} ${anio}</h2>
      <button class="btn btn-ghost btn-sm" data-accion="cal-mes" data-delta="1" aria-label="Mes siguiente">›</button>
      ${st.mes !== hoy.slice(0, 7) ? '<button class="btn btn-ghost btn-sm" data-accion="cal-hoy">Hoy</button>' : ''}
    </div>
    <div class="cal-resumen">
      <div><b>${sum('total')}</b><span>camiones</span></div>
      <div><b>${sum('llegados')}</b><span>llegaron</span></div>
      <div><b>${sum('programados') + sum('atrasados')}</b><span>por llegar</span></div>
      <div><b>${sum('pallets')}</b><span>pallets</span></div>
    </div>
    <div class="cal-grilla">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<div class="cal-sem">${d}</div>`).join('')}${celdas}</div>
    <div class="cal-ref"><span><i class="p-ok"></i>Llegó</span><span><i class="p-prog"></i>Programado</span><span><i class="p-bad"></i>Atrasado</span></div>`;

  html += '<p class="vacio">Tocá un día para ver qué camiones llegan.</p>';
  if (st.mes < sumarDias(hoy, -DIAS_HISTORIAL).slice(0, 7)) html += `<p class="meta">Los camiones ya ingresados se muestran hasta ${DIAS_HISTORIAL} días atrás.</p>`;
  return html;
}

// Detalle del día en ventana: abajo del calendario quedaba fuera de pantalla en el celu.
function modalDia(iso) {
  const x = camionesPorDia()[iso];
  abrirModal(`
    <h2>${fmtFecha(iso)}</h2>
    <p class="sub">${x ? `${x.total} ${x.total === 1 ? 'camión' : 'camiones'}${x.pallets ? ' · ' + x.pallets + ' pallets' : ''}` : 'Sin camiones este día.'}</p>
    ${x ? x.lista.map((c) => (c.estado === 'programado' ? cardProgramado(c) : cardRecibido(c))).join('') : ''}
    <div class="acciones"><button class="btn btn-ghost flex1" type="button" data-accion="cerrar">Cerrar</button></div>`);
  cargarFotos();
}

function renderHistorial() {
  const q = (st.busqueda || '').toLowerCase().trim();
  const lista = st.camiones.filter((c) => ['ingresado', 'cancelado'].includes(c.estado))
    .filter((c) => !q || [c.proveedor, c.comprobante, c.comprobante_gescom].some((x) => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.ingresado_en || b.creado_en).localeCompare(a.ingresado_en || a.creado_en));
  document.getElementById('lista-historial').innerHTML = lista.length
    ? lista.map(cardRecibido).join('') : `<p class="vacio">Sin movimientos en los últimos ${DIAS_HISTORIAL} días.</p>`;
  cargarFotos();
}

function datosCamion(c) {
  return [
    c.comprobante ? `Fact./OC <b class="mono">${esc(c.comprobante)}</b>` : '',
    c.bultos != null ? `<b>${esc(c.bultos)}</b> pallets` : '',
  ].filter(Boolean).join(' · ');
}

function cardProgramado(c) {
  const hoy = hoyART();
  const cls = c.fecha_estimada < hoy ? 'atrasado' : c.fecha_estimada === hoy ? 'hoy' : '';
  const datos = datosCamion(c);
  return `<article class="card ${cls}">
    <div class="card-top"><div><h3>${esc(c.proveedor)}</h3>
      <div class="meta">${fmtFecha(c.fecha_estimada)}${datos ? ' · ' + datos : ''}</div></div>
      <span class="badge ${cls === 'atrasado' ? 'b-bad' : 'b-programado'}">${cls === 'atrasado' ? 'Atrasado' : 'Programado'}</span></div>
    ${c.observacion ? `<div class="obs">${esc(c.observacion)}</div>` : ''}
    <div class="acciones">
      <button class="btn btn-accent ${esAdmin() ? 'btn-sm' : 'btn-grande'}" data-accion="recibir" data-id="${c.id}">Recibido</button>
      ${esAdmin() ? `<button class="btn btn-ghost btn-sm" data-accion="editar" data-id="${c.id}">Editar</button>
                     <button class="btn btn-ghost btn-sm" data-accion="cancelar" data-id="${c.id}">Cancelar</button>` : ''}
    </div></article>`;
}

function cardRecibido(c) {
  const badge = { recibido: ['b-recibido', 'Falta ingresar'], ingresado: ['b-ingresado', 'Ingresado'], cancelado: ['b-cancelado', 'Cancelado'] }[c.estado] || ['b-programado', c.estado];
  const datos = datosCamion(c);
  const lineas = [];
  if (c.recibido_en) lineas.push(`Recibió <b>${esc(nombre(c.recibido_por))}</b> · ${fmtHora(c.recibido_en)}`);
  if (c.ingresado_en) lineas.push(`Ingresó <b>${esc(nombre(c.ingresado_por))}</b> · ${fmtHora(c.ingresado_en)}${c.comprobante_gescom ? ` · Gescom <b class="mono">${esc(c.comprobante_gescom)}</b>` : ''}`);
  if (c.estado === 'cancelado') lineas.push(`Programado para ${fmtFecha(c.fecha_estimada)}`);
  return `<article class="card">
    <div class="card-top"><div><h3>${esc(c.proveedor)}</h3>${datos ? `<div class="meta">${datos}</div>` : ''}</div>
      <span class="badge ${badge[0]}">${badge[1]}</span></div>
    <div class="meta">${lineas.join('<br>')}</div>
    ${c.no_programado || c.con_diferencias ? `<div class="acciones">${c.no_programado ? '<span class="badge b-accent">Sin programar</span>' : ''}${c.con_diferencias ? '<span class="badge b-bad">Con diferencias</span>' : ''}</div>` : ''}
    ${c.recepcion_obs ? `<div class="obs">${esc(c.recepcion_obs)}</div>` : ''}
    ${c.fotos_eliminadas_en ? `<div class="meta">Fotos eliminadas el ${fmtHora(c.fotos_eliminadas_en)} (se guardan 2 meses)</div>` : ''}
    ${c.fotos && c.fotos.length ? `<div class="fotos">${c.fotos.map((f) => `<a target="_blank" rel="noopener" data-foto="${esc(f)}"><img alt="Foto de la factura" data-foto="${esc(f)}"></a>`).join('')}</div>` : ''}
    ${esAdmin() && c.estado === 'recibido' ? `<div class="acciones">
        <div class="campo campo-inline"><input id="gescom-${c.id}" placeholder="Nº comprobante en Gescom (opcional)" inputmode="numeric"></div>
        <button class="btn btn-ok btn-sm" data-accion="ingresado" data-id="${c.id}">Ingresado en Gescom</button></div>` : ''}
  </article>`;
}

// Las fotos están en un bucket privado: se piden URLs firmadas (1 hora) y se cachean.
async function cargarFotos() {
  const nodos = [...document.querySelectorAll('[data-foto]')];
  const faltan = [...new Set(nodos.map((n) => n.dataset.foto))].filter((p) => !st.urls[p] || st.urls[p].vence < Date.now());
  if (faltan.length) {
    const { data } = await sb.storage.from('facturas').createSignedUrls(faltan, 3600);
    for (const d of data || []) if (d.signedUrl) st.urls[d.path] = { url: d.signedUrl, vence: Date.now() + 3500 * 1000 };
  }
  for (const n of document.querySelectorAll('[data-foto]')) {
    const u = st.urls[n.dataset.foto];
    if (!u) continue;
    if (n.tagName === 'IMG') n.src = u.url; else n.href = u.url;
  }
}

// ---------- Inicio: elegir vista ----------
function renderInicio() {
  const camiones = st.camiones.filter((c) => c.estado === (esAdmin() ? 'recibido' : 'programado')).length;
  const roturas = st.roturas.filter((r) => !r.ingreso_id).length;
  return `<h1 class="inicio-tit">¿Qué vas a hacer?</h1>
    <button class="modulo" data-accion="tab" data-tab="${esAdmin() && camiones ? 'ingresar' : 'llegar'}">
      <span class="modulo-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3v4h-7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg></span>
      <span class="modulo-txt"><b>Recepción</b><span>Camiones por llegar y recibidos con foto de la factura</span></span>
      ${camiones ? `<span class="num">${camiones}</span>` : ''}
    </button>
    <button class="modulo" data-accion="tab" data-tab="${esAdmin() ? 'rot-resumen' : 'rot-cargar'}">
      <span class="modulo-ico rot" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M12 3v6l-3 3 3 3v6"/></svg></span>
      <span class="modulo-txt"><b>Roturas</b><span>${esAdmin() ? 'Suma por artículo de lo que cargó el depósito' : 'Cargar mercadería rota por proveedor y artículo'}</span></span>
      ${roturas ? `<span class="num">${roturas}</span>` : ''}
    </button>`;
}

// ---------- Roturas ----------
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sumaU = (lista) => lista.reduce((a, r) => a + r.cantidad, 0);
const fmtU = (n) => `${n.toLocaleString('es-AR')} u.`;

function provNombre(pcod) {
  const x = (st.articulos || []).find((a) => a.prov_codigo === pcod) || st.roturas.find((r) => r.prov_codigo === pcod);
  return x ? x.proveedor : pcod;
}

function proveedoresArticulos() {
  const m = new Map();
  for (const a of st.articulos || []) m.set(a.prov_codigo, a.proveedor);
  return [...m].sort((a, b) => a[1].localeCompare(b[1]));
}

// Suma por SKU de lo pendiente (opcionalmente de un proveedor). Guarda los ids para el "Ingresado en Gescom".
function resumen(lista) {
  const m = new Map();
  for (const r of lista) {
    const x = m.get(r.codigo) || m.set(r.codigo, { codigo: r.codigo, descripcion: r.descripcion, proveedor: r.proveedor, unidades: 0, cargas: 0, ultima: '' }).get(r.codigo);
    x.unidades += r.cantidad; x.cargas++;
    if (r.cargado_en > x.ultima) x.ultima = r.cargado_en;
  }
  return [...m.values()].sort((a, b) => a.proveedor.localeCompare(b.proveedor) || a.descripcion.localeCompare(b.descripcion));
}
const pendientes = (prov) => st.roturas.filter((r) => !r.ingreso_id && (!prov || r.prov_codigo === prov));

function filaCarga(r) {
  const puede = !r.ingreso_id && (esAdmin() || r.cargado_por === st.sesion.user.id);
  return `<div class="carga">
    <div class="flex1"><b>${esc(r.descripcion)}</b>
      <div class="meta"><span class="mono">${esc(r.codigo)}</span> · ${esc(r.proveedor)} · ${fmtHora(r.cargado_en)} · ${esc(nombre(r.cargado_por))}</div></div>
    <div class="carga-der"><b class="mono">${fmtU(r.cantidad)}</b>
      ${puede ? `<button class="btn btn-ghost btn-sm" data-accion="rot-borrar" data-rot="${r.id}">Borrar</button>` : ''}</div>
  </div>`;
}

function selectProv(id, valor, opciones, todos) {
  return `<select id="${id}" class="sel-filtro">${todos ? `<option value="">${todos}</option>` : ''}${opciones.map(([cod, txt]) =>
    `<option value="${esc(cod)}"${cod === valor ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select>`;
}

function renderRoturas() {
  if (st.tab === 'rot-cargar') {
    if (!st.articulos) { cargarArticulos(); return '<p class="vacio">Cargando artículos…</p>'; }
    if (!st.articulos.length) return '<p class="vacio">Todavía no hay artículos cargados. Avisale al administrador.</p>';
    return `<div class="campo"><label for="rc-prov">Proveedor</label>
        ${selectProv('rc-prov', st.rc.prov, proveedoresArticulos(), 'Elegí el proveedor')}</div>
      <div id="rc-zona"></div>
      <div class="seccion">Tus últimas cargas pendientes</div><div id="rc-ultimas"></div>`;
  }
  if (st.tab === 'rot-cargadas') {
    const pend = pendientes();
    return `<p class="meta">Lo que cargaste y todavía no se ingresó en Gescom. Si te equivocaste, borralo y cargalo de nuevo.</p>
      ${pend.length ? pend.map(filaCarga).join('') : '<p class="vacio">No hay roturas pendientes.</p>'}`;
  }
  if (st.tab === 'rot-resumen') {
    const provs = new Map();
    for (const r of pendientes()) provs.set(r.prov_codigo, [r.proveedor, (provs.get(r.prov_codigo) || [0, 0])[1] + 1]);
    if (st.filtroProv && !provs.has(st.filtroProv)) provs.set(st.filtroProv, [provNombre(st.filtroProv), 0]);
    const ops = [...provs].sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([c, [n, k]]) => [c, `${n} (${k})`]);
    const pend = pendientes(st.filtroProv);
    const filas = resumen(pend);
    return `<div class="barra">${selectProv('rr-prov', st.filtroProv, ops, `Todos los proveedores (${pendientes().length})`)}</div>
      <div class="cal-resumen rot-kpi">
        <div><b>${filas.length}</b><span>${filas.length === 1 ? 'artículo' : 'artículos'}</span></div>
        <div><b>${sumaU(pend).toLocaleString('es-AR')}</b><span>unidades</span></div>
        <div><b>${pend.length}</b><span>cargas</span></div>
      </div>
      ${filas.length ? `<div class="acciones rot-acc">
          <button class="btn btn-ok flex1" data-accion="rot-ingresar">Ingresado en Gescom</button>
          <button class="btn btn-ghost" data-accion="rot-csv">Descargar CSV</button></div>
        <div class="lista-sku">${filas.map((f) => `<button class="sku" data-accion="rot-sku" data-codigo="${esc(f.codigo)}">
            <span class="flex1"><b>${esc(f.descripcion)}</b><span class="meta"><span class="mono">${esc(f.codigo)}</span>${st.filtroProv ? '' : ' · ' + esc(f.proveedor)} · ${f.cargas} ${f.cargas === 1 ? 'carga' : 'cargas'} · última ${fmtHora(f.ultima)}</span></span>
            <b class="mono sku-u">${fmtU(f.unidades)}</b></button>`).join('')}</div>`
        : '<p class="vacio">No hay roturas pendientes de ingresar.</p>'}`;
  }
  if (st.tab === 'rot-historial') {
    const provs = new Map(st.roturas.filter((r) => r.ingreso_id).map((r) => [r.prov_codigo, r.proveedor]));
    const lista = st.ingresos.filter((i) => !st.filtroHist || st.roturas.some((r) => r.ingreso_id === i.id && r.prov_codigo === st.filtroHist));
    return `<div class="barra">${selectProv('rh-prov', st.filtroHist, [...provs].sort((a, b) => a[1].localeCompare(b[1])), 'Todos los proveedores')}</div>
      ${lista.length ? lista.map(cardIngreso).join('') : `<p class="vacio">Sin ingresos en los últimos ${DIAS_HISTORIAL} días.</p>`}
      <p class="meta">El historial se guarda ${DIAS_HISTORIAL} días.</p>`;
  }
  return '';
}

function filasIngreso(i) {
  return st.roturas.filter((r) => r.ingreso_id === i.id && (!st.filtroHist || r.prov_codigo === st.filtroHist));
}

function cardIngreso(i) {
  const rs = filasIngreso(i);
  return `<article class="card">
    <div class="card-top"><div><h3>${i.prov_codigo ? esc(provNombre(i.prov_codigo)) : 'Todos los proveedores'}</h3>
      <div class="meta">Ingresó <b>${esc(nombre(i.ingresado_por))}</b> · ${fmtHora(i.ingresado_en)}${i.comprobante ? ` · Gescom <b class="mono">${esc(i.comprobante)}</b>` : ''}</div></div>
      <span class="badge b-ingresado">Ingresado</span></div>
    <div class="meta"><b>${resumen(rs).length}</b> ${resumen(rs).length === 1 ? 'artículo' : 'artículos'} · <b>${sumaU(rs).toLocaleString('es-AR')}</b> unidades</div>
    <div class="acciones"><button class="btn btn-ghost btn-sm" data-accion="rot-ver-ingreso" data-ing="${i.id}">Ver detalle</button></div>
  </article>`;
}

function montarRoturas() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('rr-prov', 'change', (e) => { st.filtroProv = e.target.value; render(); });
  on('rh-prov', 'change', (e) => { st.filtroHist = e.target.value; render(); });
  on('rc-prov', 'change', (e) => { st.rc = { prov: e.target.value, q: '', sel: null }; pintarZona(true); });
  if (document.getElementById('rc-prov')) { pintarZona(false); pintarUltimas(); }
}

function pintarZona(foco) {
  const z = document.getElementById('rc-zona');
  if (!st.rc.prov) { z.innerHTML = '<p class="vacio">Elegí el proveedor para buscar el artículo.</p>'; return; }
  const a = st.rc.sel && st.articulos.find((x) => x.codigo === st.rc.sel);
  if (a) {
    const ya = sumaU(pendientes().filter((r) => r.codigo === a.codigo));
    z.innerHTML = `<form id="rc-form" class="card rc-sel">
        <h3>${esc(a.descripcion)}</h3><div class="meta"><span class="mono">${esc(a.codigo)}</span> · ${esc(a.proveedor)}</div>
        ${ya ? `<div class="obs">Ya hay ${fmtU(ya)} pendientes de este artículo.</div>` : ''}
        <div class="campo rc-cant"><label for="rc-cant">Unidades rotas</label><input id="rc-cant" type="number" min="1" step="1" inputmode="numeric" required></div>
        <div class="error" id="rc-error" hidden></div>
        <div class="acciones"><button class="btn btn-accent flex1" type="submit">Cargar rotura</button><button class="btn btn-ghost" type="button" data-accion="rc-otro">Cambiar artículo</button></div>
        <p class="meta">Se guarda con la fecha y hora de ahora.</p>
      </form>`;
    document.getElementById('rc-form').addEventListener('submit', guardarRotura);
    document.getElementById('rc-cant').focus();
    return;
  }
  z.innerHTML = `<div class="campo"><label for="rc-buscar">Artículo</label>
      <input id="rc-buscar" type="search" placeholder="Código o descripción" autocomplete="off" enterkeyhint="search"></div>
    <div id="rc-res" class="lista-sku"></div>`;
  const inp = document.getElementById('rc-buscar');
  inp.value = st.rc.q;
  inp.addEventListener('input', () => { st.rc.q = inp.value; pintarResultados(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const r = buscar();
    const exacto = r.find((x) => x.codigo === inp.value.trim());
    if (exacto || r.length === 1) elegirArticulo((exacto || r[0]).codigo);
  });
  pintarResultados();
  if (foco) inp.focus();
}

function buscar() {
  const palabras = normalizar(st.rc.q).split(/\s+/).filter(Boolean);
  return st.articulos.filter((a) => a.prov_codigo === st.rc.prov && palabras.every((p) => a._q.includes(p)))
    .sort((a, b) => a.descripcion.localeCompare(b.descripcion));
}

function pintarResultados() {
  const r = buscar(), MAX = 40;
  document.getElementById('rc-res').innerHTML = !r.length ? '<p class="vacio">No hay artículos con ese código o descripción.</p>'
    : r.slice(0, MAX).map((a) => `<button class="sku" type="button" data-accion="rc-elegir" data-codigo="${esc(a.codigo)}">
        <span class="flex1"><b>${esc(a.descripcion)}</b><span class="meta mono">${esc(a.codigo)}</span></span></button>`).join('')
      + (r.length > MAX ? `<p class="meta">Hay ${r.length} artículos: escribí para achicar la lista.</p>` : '');
}

function elegirArticulo(codigo) { st.rc.sel = codigo; pintarZona(true); }

async function guardarRotura(e) {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true;
  const cant = Number(document.getElementById('rc-cant').value);
  const { data, error } = await sb.rpc('cargar_rotura', { p_codigo: st.rc.sel, p_cantidad: cant });
  btn.disabled = false;
  if (error) { const er = document.getElementById('rc-error'); er.textContent = errorMsg(error); er.hidden = false; return; }
  if (!st.roturas.some((r) => r.id === data.id)) st.roturas.unshift(data);
  toast(`Cargado: ${fmtU(data.cantidad)} de ${data.descripcion}`);
  st.rc.sel = null; st.rc.q = '';
  pintarZona(true); pintarUltimas();
}

function pintarUltimas() {
  const el = document.getElementById('rc-ultimas');
  if (!el) return;
  const mias = pendientes().filter((r) => r.cargado_por === st.sesion.user.id).slice(0, 15);
  el.innerHTML = mias.length ? mias.map(filaCarga).join('') : '<p class="vacio">Todavía no cargaste roturas pendientes.</p>';
}

function modalSku(codigo) {
  const rs = pendientes(st.filtroProv).filter((r) => r.codigo === codigo);
  if (!rs.length) return;
  abrirModal(`<h2>${esc(rs[0].descripcion)}</h2>
    <p class="sub"><span class="mono">${esc(codigo)}</span> · ${esc(rs[0].proveedor)} · ${fmtU(sumaU(rs))} en ${rs.length} ${rs.length === 1 ? 'carga' : 'cargas'}</p>
    ${rs.map(filaCarga).join('')}
    <div class="acciones"><button class="btn btn-ghost flex1" type="button" data-accion="cerrar">Cerrar</button></div>`);
}

function modalIngresarRoturas() {
  const pend = pendientes(st.filtroProv);
  if (!pend.length) return;
  const ids = pend.map((r) => r.id);
  abrirModal(`<h2>Ingresado en Gescom</h2>
    <p class="sub">${st.filtroProv ? esc(provNombre(st.filtroProv)) : 'Todos los proveedores'} · ${resumen(pend).length} ${resumen(pend).length === 1 ? 'artículo' : 'artículos'} · ${fmtU(sumaU(pend))}</p>
    <form id="form-ing-rot">
      <p class="meta">Estas cargas salen de "Pendiente" y el contador arranca de cero. Quedan en el historial ${DIAS_HISTORIAL} días.</p>
      <div class="campo"><label for="ir-comp">Nº comprobante en Gescom (opcional)</label><input id="ir-comp" inputmode="numeric"></div>
      <div class="error" id="ir-error" hidden></div>
      <div class="acciones"><button class="btn btn-ok flex1" type="submit">Confirmar</button><button class="btn btn-ghost" type="button" data-accion="cerrar">Cancelar</button></div>
    </form>`);
  document.getElementById('form-ing-rot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.rpc('ingresar_roturas', { p_ids: ids, p_prov_codigo: st.filtroProv || null, p_comprobante: document.getElementById('ir-comp').value });
    btn.disabled = false;
    if (error) { const er = document.getElementById('ir-error'); er.textContent = errorMsg(error); er.hidden = false; return; }
    cerrarModal(); toast('Listo: marcado como ingresado, el pendiente arranca de cero.'); cargarRoturas();
  });
}

function modalIngreso(id) {
  const i = st.ingresos.find((x) => x.id === id);
  if (!i) return;
  const filas = resumen(filasIngreso(i));
  abrirModal(`<h2>${i.prov_codigo ? esc(provNombre(i.prov_codigo)) : 'Todos los proveedores'}</h2>
    <p class="sub">Ingresado ${fmtHora(i.ingresado_en)}${i.comprobante ? ' · Gescom ' + esc(i.comprobante) : ''} · ${fmtU(filas.reduce((a, f) => a + f.unidades, 0))}</p>
    <div class="lista-sku">${filas.map((f) => `<div class="sku"><span class="flex1"><b>${esc(f.descripcion)}</b><span class="meta"><span class="mono">${esc(f.codigo)}</span> · ${esc(f.proveedor)}</span></span><b class="mono sku-u">${fmtU(f.unidades)}</b></div>`).join('')}</div>
    <div class="acciones"><button class="btn btn-ghost flex1" type="button" data-accion="rot-csv" data-ing="${i.id}">Descargar CSV</button><button class="btn btn-ghost flex1" type="button" data-accion="cerrar">Cerrar</button></div>`);
}

// CSV con ; y BOM para que Excel lo abra bien con acentos.
function descargarCsv(ingId) {
  const i = ingId && st.ingresos.find((x) => x.id === ingId);
  const filas = resumen(i ? filasIngreso(i) : pendientes(st.filtroProv));
  const prov = i ? i.prov_codigo : st.filtroProv;
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const txt = '﻿' + ['Código;Descripción;Proveedor;Unidades', ...filas.map((f) => [q(f.codigo), q(f.descripcion), q(f.proveedor), f.unidades].join(';'))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' }));
  a.download = `roturas-${st.perfil.empresa}${prov ? '-' + prov : ''}-${i ? fmtISO(i.ingresado_en) : hoyART()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Modales ----------
function abrirModal(html) { $modal.innerHTML = `<div class="modal-caja" role="dialog" aria-modal="true">${html}</div>`; $modal.hidden = false; }
function cerrarModal() { $modal.hidden = true; $modal.innerHTML = ''; }
$modal.addEventListener('click', (e) => { if (e.target === $modal) cerrarModal(); });

function proveedoresConocidos() {
  return [...new Set(st.camiones.map((c) => c.proveedor))].sort((a, b) => a.localeCompare(b));
}

function modalCamion(c) {
  const p = proveedoresConocidos();
  abrirModal(`
    <h2>${c ? 'Editar camión' : 'Cargar camión'}</h2><p class="sub">Lo ve el depósito en "Por llegar".</p>
    <form id="form-camion">
      <div class="campo"><label for="f-prov">Proveedor</label><input id="f-prov" list="lista-prov" required value="${esc(c && c.proveedor)}"></div>
      <datalist id="lista-prov">${p.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="fila">
        <div class="campo"><label for="f-fecha">Llega</label><input id="f-fecha" type="date" required value="${esc((c && c.fecha_estimada) || hoyART())}"></div>
        ${c ? '' : '<div class="campo"><label for="f-cant">Camiones</label><input id="f-cant" type="number" min="1" max="30" step="1" inputmode="numeric" required value="1"></div>'}
      </div>
      <div class="campo"><label for="f-bultos">${c ? 'Pallets' : 'Pallets (total)'}</label><input id="f-bultos" type="number" min="0" step="1" inputmode="numeric" value="${esc(c && c.bultos)}"><p class="meta" id="f-reparto" hidden></p></div>
      <div class="campo"><label for="f-comp">Nº factura / orden (si lo sabés)</label><input id="f-comp" value="${esc(c && c.comprobante)}"></div>
      <div class="campo"><label for="f-obs">Observación</label><textarea id="f-obs" rows="2">${esc(c && c.observacion)}</textarea></div>
      <div class="error" id="f-error" hidden></div>
      <div class="acciones"><button class="btn btn-primary flex1" type="submit">Guardar</button><button class="btn btn-ghost" type="button" data-accion="cerrar">Cancelar</button></div>
    </form>`);
  // Varios camiones del mismo proveedor: se crea uno por camión (cada uno se recibe con su factura) y los pallets se reparten.
  const cantidad = () => (c ? 1 : Math.max(1, Math.min(30, Number(document.getElementById('f-cant').value) || 1)));
  const reparto = () => {
    const v = document.getElementById('f-bultos').value, n = cantidad();
    if (v === '') return Array(n).fill(null);
    const t = Number(v), base = Math.floor(t / n);
    return Array.from({ length: n }, (_, i) => base + (i < t % n ? 1 : 0));
  };
  const verReparto = () => {
    const el = document.getElementById('f-reparto'), n = cantidad(), r = reparto();
    el.hidden = n < 2 || r[0] == null;
    if (!el.hidden) el.textContent = `${n} camiones: ${[...new Set(r)].length === 1 ? `${r[0]} pallets cada uno` : r.join(' + ') + ' pallets'}`;
  };
  if (!c) for (const id of ['f-cant', 'f-bultos']) document.getElementById(id).addEventListener('input', verReparto);
  document.getElementById('form-camion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = {
      proveedor: document.getElementById('f-prov').value.trim(),
      fecha_estimada: document.getElementById('f-fecha').value,
      bultos: document.getElementById('f-bultos').value === '' ? null : Number(document.getElementById('f-bultos').value),
      comprobante: document.getElementById('f-comp').value.trim() || null,
      observacion: document.getElementById('f-obs').value.trim() || null,
    };
    const btn = e.submitter; btn.disabled = true;
    const n = cantidad();
    const r = c ? await sb.from('camiones').update(datos).eq('id', c.id)
                : await sb.from('camiones').insert(reparto().map((b) => ({ ...datos, bultos: b, empresa: st.perfil.empresa })));
    btn.disabled = false;
    if (r.error) { const er = document.getElementById('f-error'); er.textContent = errorMsg(r.error); er.hidden = false; return; }
    cerrarModal(); toast(c ? 'Camión actualizado' : n > 1 ? `${n} camiones cargados` : 'Camión cargado'); cargar();
  });
}

function modalRecibir(c) {
  const fotos = [];
  abrirModal(`
    <h2>${c ? 'Recibir camión' : 'Camión sin programar'}</h2>
    <p class="sub">${c ? `${esc(c.proveedor)}${c.comprobante ? ' · ' + esc(c.comprobante) : ''}` : 'Cargá los datos y la foto de la factura.'}</p>
    <form id="form-recibir">
      ${c ? '' : `
        <div class="campo"><label for="r-prov">Proveedor</label><input id="r-prov" list="lista-prov" required></div>
        <datalist id="lista-prov">${proveedoresConocidos().map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        <div class="fila">
          <div class="campo"><label for="r-comp">Nº factura</label><input id="r-comp"></div>
          <div class="campo"><label for="r-bultos">Pallets</label><input id="r-bultos" type="number" min="0" step="1" inputmode="numeric"></div>
        </div>`}
      <input id="r-file" type="file" accept="image/*" capture="environment" hidden>
      <button type="button" class="foto-btn" id="r-foto">Sacar foto de la factura</button>
      <div class="fotos" id="r-previas"></div>
      <label class="check"><input type="checkbox" id="r-dif"> Hubo diferencias (faltantes, roturas, vencimientos cortos)</label>
      <div class="campo"><label for="r-obs">Comentario</label><textarea id="r-obs" rows="2" placeholder="Opcional"></textarea></div>
      <div class="error" id="r-error" hidden></div>
      <div class="acciones"><button class="btn btn-accent flex1" type="submit" id="r-ok" disabled>Confirmar recepción</button><button class="btn btn-ghost" type="button" data-accion="cerrar">Cancelar</button></div>
    </form>`);
  const $file = document.getElementById('r-file');
  const $prev = document.getElementById('r-previas');
  const $ok = document.getElementById('r-ok');
  const $btnFoto = document.getElementById('r-foto');
  const pintar = () => {
    $prev.innerHTML = fotos.map((f, i) => `<div class="prev"><img src="${f.url}" alt="Foto ${i + 1}"><button type="button" data-quitar="${i}" aria-label="Quitar foto">×</button></div>`).join('');
    $ok.disabled = fotos.length === 0;
    $btnFoto.textContent = fotos.length ? 'Agregar otra foto' : 'Sacar foto de la factura';
  };
  $btnFoto.addEventListener('click', () => $file.click());
  $file.addEventListener('change', async () => {
    const f = $file.files[0]; $file.value = '';
    if (!f) return;
    try { const blob = await comprimir(f); fotos.push({ blob, url: URL.createObjectURL(blob) }); pintar(); }
    catch (e) { toast('No se pudo leer la foto: ' + errorMsg(e), true); }
  });
  $prev.addEventListener('click', (e) => {
    const b = e.target.closest('[data-quitar]'); if (!b) return;
    const [q] = fotos.splice(Number(b.dataset.quitar), 1); URL.revokeObjectURL(q.url); pintar();
  });
  document.getElementById('form-recibir').addEventListener('submit', async (e) => {
    e.preventDefault();
    const er = document.getElementById('r-error'); er.hidden = true;
    $ok.disabled = true; $ok.textContent = 'Subiendo fotos…';
    try {
      const rutas = [];
      for (const f of fotos) {
        const ruta = `${st.perfil.empresa}/${hoyART()}/${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from('facturas').upload(ruta, f.blob, { contentType: 'image/jpeg' });
        if (error) throw error;
        rutas.push(ruta);
      }
      $ok.textContent = 'Guardando…';
      const dif = document.getElementById('r-dif').checked;
      const obs = document.getElementById('r-obs').value;
      const r = c
        ? await sb.rpc('marcar_recibido', { p_id: c.id, p_fotos: rutas, p_diferencias: dif, p_obs: obs })
        : await sb.rpc('recibir_no_programado', {
            p_proveedor: document.getElementById('r-prov').value, p_comprobante: document.getElementById('r-comp').value,
            p_bultos: document.getElementById('r-bultos').value === '' ? null : Number(document.getElementById('r-bultos').value),
            p_fotos: rutas, p_diferencias: dif, p_obs: obs });
      if (r.error) throw r.error;
      sb.functions.invoke('notificar', { body: { camion_id: r.data.id } }).catch(() => {});
      fotos.forEach((f) => URL.revokeObjectURL(f.url));
      cerrarModal(); toast('Recepción registrada. Ya le avisamos al administrador.'); cargar();
    } catch (err) {
      er.textContent = errorMsg(err); er.hidden = false;
      $ok.disabled = false; $ok.textContent = 'Confirmar recepción';
    }
  });
}

// Achica la foto (lado mayor 1600 px, JPEG 80%): se lee bien la factura y sube rápido con datos móviles.
async function comprimir(file) {
  const img = await createImageBitmap(file);
  const escala = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * escala);
  canvas.height = Math.round(img.height * escala);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((ok, mal) => canvas.toBlob((b) => (b ? ok(b) : mal(new Error('sin imagen'))), 'image/jpeg', 0.8));
}

// ---------- Avisos push (solo admin) ----------
function base64aBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

async function estadoAvisos() {
  const btn = document.getElementById('btn-avisos');
  if (!btn || !('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === 'granted') btn.hidden = true;
}

async function activarAvisos() {
  try {
    if (!cfg.VAPID_PUBLIC_KEY || cfg.VAPID_PUBLIC_KEY.startsWith('TU-')) throw new Error('Falta VAPID_PUBLIC_KEY en config.js');
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') { toast('Sin permiso no te puedo avisar. Habilitalo en la configuración del navegador.', true); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64aBytes(cfg.VAPID_PUBLIC_KEY) }));
    const j = sub.toJSON();
    const { error } = await sb.from('push_subs').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, usuario: st.sesion.user.id }, { onConflict: 'endpoint' });
    if (error) throw error;
    toast('Listo: te va a llegar un aviso cada vez que reciban un camión.');
    estadoAvisos();
  } catch (e) {
    toast('No se pudieron activar los avisos: ' + errorMsg(e), true);
  }
}

// ---------- Acciones ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-accion]');
  if (!el) return;
  const id = el.dataset.id ? Number(el.dataset.id) : null;
  const c = id ? st.camiones.find((x) => x.id === id) : null;
  switch (el.dataset.accion) {
    case 'tab': st.tab = el.dataset.tab; history.replaceState(null, '', '#' + st.tab); render(); break;
    case 'salir': await sb.auth.signOut(); break;
    case 'avisos': activarAvisos(); break;
    case 'cerrar': cerrarModal(); break;
    case 'nuevo': modalCamion(null); break;
    case 'cal-dia': st.diaSel = el.dataset.dia; render(); modalDia(st.diaSel); break;
    case 'cal-mes': {
      const [a, m] = (st.mes || hoyART().slice(0, 7)).split('-').map(Number);
      st.mes = new Date(Date.UTC(a, m - 1 + Number(el.dataset.delta), 1)).toISOString().slice(0, 7);
      st.diaSel = null; render(); break;
    }
    case 'cal-hoy': st.mes = hoyART().slice(0, 7); st.diaSel = null; render(); break;
    case 'editar': if (c) modalCamion(c); break;
    case 'recibir': if (c) modalRecibir(c); break;
    case 'no-programado': modalRecibir(null); break;
    case 'rc-elegir': elegirArticulo(el.dataset.codigo); break;
    case 'rc-otro': st.rc.sel = null; pintarZona(true); break;
    case 'rot-sku': modalSku(el.dataset.codigo); break;
    case 'rot-ingresar': modalIngresarRoturas(); break;
    case 'rot-csv': descargarCsv(el.dataset.ing ? Number(el.dataset.ing) : null); break;
    case 'rot-ver-ingreso': modalIngreso(Number(el.dataset.ing)); break;
    case 'rot-borrar': {
      // Dos toques: el primero pide confirmación (no usamos confirm() del navegador).
      if (!el.dataset.seguro) { el.dataset.seguro = '1'; el.textContent = '¿Borrar?'; el.classList.add('btn-peligro'); setTimeout(() => { if (el.isConnected) { delete el.dataset.seguro; el.textContent = 'Borrar'; el.classList.remove('btn-peligro'); } }, 4000); break; }
      el.disabled = true;
      const rid = Number(el.dataset.rot);
      const { error } = await sb.from('roturas').delete().eq('id', rid);
      if (error) { el.disabled = false; toast(errorMsg(error), true); break; }
      st.roturas = st.roturas.filter((r) => r.id !== rid);
      toast('Carga borrada');
      if (!$modal.hidden) { const r = el.closest('.carga'); if (r) r.remove(); }
      refrescar();
      break;
    }
    case 'cancelar': {
      if (!c) break;
      el.disabled = true;
      const { error } = await sb.from('camiones').update({ estado: 'cancelado' }).eq('id', c.id).eq('estado', 'programado');
      if (error) { el.disabled = false; toast(errorMsg(error), true); } else { toast('Camión cancelado'); cargar(); }
      break;
    }
    case 'ingresado': {
      if (!c) break;
      el.disabled = true;
      const comp = (document.getElementById('gescom-' + c.id) || {}).value || '';
      const { error } = await sb.rpc('marcar_ingresado', { p_id: c.id, p_comprobante: comp });
      if (error) { el.disabled = false; toast(errorMsg(error), true); } else { toast('Marcado como ingresado'); cargar(); }
      break;
    }
  }
});

iniciar();
