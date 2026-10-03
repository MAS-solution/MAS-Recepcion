'use strict';
// MAS Recepción — camiones programados → recibidos (con foto de factura) → ingresados en Gescom.
// Todo el estado vive en Supabase; esta página es estática (GitHub Pages).

const cfg = window.MAS_CONFIG;
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const TZ = 'America/Argentina/Buenos_Aires';
const DIAS_HISTORIAL = 60;

const st = { sesion: null, perfil: null, camiones: [], nombres: {}, tab: null, canal: null, urls: {} };
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
  st.tab = t || (esAdmin() ? 'llegar' : 'llegar');
  renderTopbar();
  await cargar();
  st.canal = sb.channel('camiones-' + perfil.empresa)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'camiones' }, () => cargar())
    .subscribe();
}

async function cargar() {
  const desde = new Date(Date.now() - DIAS_HISTORIAL * 86400000).toISOString();
  const [cam, per] = await Promise.all([
    sb.from('camiones').select('*').or(`estado.in.(programado,recibido),creado_en.gte.${desde}`)
      .order('fecha_estimada', { ascending: true }).order('id', { ascending: true }),
    sb.from('perfiles').select('id,nombre'),
  ]);
  if (cam.error) { toast('No se pudo cargar: ' + errorMsg(cam.error), true); return; }
  st.camiones = cam.data || [];
  st.nombres = Object.fromEntries((per.data || []).map((p) => [p.id, p.nombre]));
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
function tabsDe() {
  const n = (estado) => st.camiones.filter((c) => c.estado === estado).length;
  return esAdmin()
    ? [['llegar', 'Por llegar', n('programado')], ['ingresar', 'A ingresar', n('recibido')], ['historial', 'Historial', 0]]
    : [['llegar', 'Por llegar', n('programado')], ['recibidos', 'Recibidos', 0]];
}

function render() {
  if (!st.perfil) return;
  const tabs = tabsDe();
  if (!tabs.some(([id]) => id === st.tab)) st.tab = tabs[0][0];
  const hoy = hoyART();
  let html = `<div class="tabs" role="tablist">${tabs.map(([id, txt, num]) =>
    `<button class="tab" role="tab" aria-selected="${id === st.tab}" data-accion="tab" data-tab="${id}">${txt}${num ? `<span class="num">${num}</span>` : ''}</button>`).join('')}</div>`;

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
    c.bultos != null ? `<b>${esc(c.bultos)}</b> bultos` : '',
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
        <div class="campo"><label for="f-bultos">Bultos (aprox.)</label><input id="f-bultos" type="number" min="0" step="1" inputmode="numeric" value="${esc(c && c.bultos)}"></div>
      </div>
      <div class="campo"><label for="f-comp">Nº factura / orden (si lo sabés)</label><input id="f-comp" value="${esc(c && c.comprobante)}"></div>
      <div class="campo"><label for="f-obs">Observación</label><textarea id="f-obs" rows="2">${esc(c && c.observacion)}</textarea></div>
      <div class="error" id="f-error" hidden></div>
      <div class="acciones"><button class="btn btn-primary flex1" type="submit">Guardar</button><button class="btn btn-ghost" type="button" data-accion="cerrar">Cancelar</button></div>
    </form>`);
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
    const r = c ? await sb.from('camiones').update(datos).eq('id', c.id)
                : await sb.from('camiones').insert({ ...datos, empresa: st.perfil.empresa });
    btn.disabled = false;
    if (r.error) { const er = document.getElementById('f-error'); er.textContent = errorMsg(r.error); er.hidden = false; return; }
    cerrarModal(); toast(c ? 'Camión actualizado' : 'Camión cargado'); cargar();
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
          <div class="campo"><label for="r-bultos">Bultos</label><input id="r-bultos" type="number" min="0" step="1" inputmode="numeric"></div>
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
    case 'editar': if (c) modalCamion(c); break;
    case 'recibir': if (c) modalRecibir(c); break;
    case 'no-programado': modalRecibir(null); break;
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
