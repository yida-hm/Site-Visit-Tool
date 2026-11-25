'use strict';
/*
 * HM Site Visit - phone capture prototype.
 * Plain browser code: no build step, no libraries, works offline once loaded.
 *
 * Data lives in the phone's IndexedDB until a visit is exported as a .zip
 * (visit.json + photos/) into the project's OneDrive folder.
 * File formats are described in README.md.
 */

// ------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const CATEGORIES = ['Progress', 'Defect', 'Query', 'H&S'];
const PHOTO_MAX = 2560;   // longest edge of a saved photo, in pixels
const svgIcon = d => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  plus: svgIcon('<path d="M12 5v14M5 12h14"/>'),
  cloud: svgIcon('<path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 9.1 4.5 4.5 0 0 1 17 18z"/><path d="M12 16v-5M9.8 13l2.2-2.2 2.2 2.2"/>'),
  building: svgIcon('<path d="M4 20V6l8-3v17M12 9l8 2v9M3 20h18M7.5 8.5v0M7.5 12v0M7.5 15.5v0M16 14v0M16 17v0"/>'),
};
const CAMERA_SVG ='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------ storage (IndexedDB)
let dbPromise;
function db() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('hm-sitevisit', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('plans', { keyPath: 'key' }).createIndex('project', 'projectId');
      d.createObjectStore('visits', { keyPath: 'id' }).createIndex('project', 'projectId');
      d.createObjectStore('observations', { keyPath: 'id' }).createIndex('visit', 'visitId');
      d.createObjectStore('photos', { keyPath: 'id' }).createIndex('visit', 'visitId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idb = {
  get: async (s, k) => req((await db()).transaction(s).objectStore(s).get(k)),
  all: async s => req((await db()).transaction(s).objectStore(s).getAll()),
  by: async (s, index, k) => req((await db()).transaction(s).objectStore(s).index(index).getAll(k)),
  put: async (s, v) => req((await db()).transaction(s, 'readwrite').objectStore(s).put(v)),
  del: async (s, k) => req((await db()).transaction(s, 'readwrite').objectStore(s).delete(k)),
};

// ------------------------------------------------------------ app state
const S = {
  project: null,      // project record
  visit: null,        // visit record
  plans: [],          // plan records of the project (image blobs included)
  plan: null,         // plan being shown
  obs: [],            // observations of this visit
  photos: new Map(),  // observation id -> [photo records]
  sel: null,          // id of the observation open in the sheet
  view: null,         // PlanView
  busy: 0,            // photos being processed
};
const urls = new Map();   // blob -> object URL cache
function urlFor(key, blob) {
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}
function dropUrl(key) { if (urls.has(key)) { URL.revokeObjectURL(urls.get(key)); urls.delete(key); } }

// ------------------------------------------------------------ project packs
function b64ToBlob(b64, mime) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

async function importPack(pack) {
  if (!pack || pack.format !== 'hm-sitepack' || !pack.project || !Array.isArray(pack.plans))
    throw new Error('This is not a site visit project file.');
  const pid = pack.project.id;
  const plans = [];
  for (const p of pack.plans) {
    const blob = p.image.blob || b64ToBlob(p.image.data, p.image.mime || 'image/png');
    await idb.put('plans', {
      key: pid + '|' + p.id, projectId: pid, id: p.id, name: p.name, level: p.level || '',
      image: blob, width: p.image.width, height: p.image.height,
      transform: p.transform || null, rooms: p.rooms || [],
    });
    dropUrl('plan:' + pid + '|' + p.id);
    plans.push({ id: p.id, name: p.name });
  }
  await idb.put('projects', Object.assign({}, pack.project, { plans, importedAt: new Date().toISOString() }));
  return pid;
}

// A made-up two-storey building so the app can be tried without Revit.
async function demoPack() {
  const W = 2000, H = 1400;
  const layouts = [
    ['Ground Floor', '0', [
      ['01', 'Entrance Lobby', 100, 100, 400, 350], ['02', 'Reception', 500, 100, 300, 350], ['03', 'Office', 800, 100, 400, 350],
      ['04', 'Meeting Room', 1200, 100, 350, 350], ['05', 'Stair 1', 1550, 100, 350, 350], ['06', 'Corridor', 100, 450, 1800, 180],
      ['07', 'Main Hall', 100, 630, 800, 670], ['08', 'Kitchen', 900, 630, 400, 670], ['09', 'WCs', 1300, 630, 250, 670], ['10', 'Plant Room', 1550, 630, 350, 670]]],
    ['First Floor', '1', [
      ['01', 'Classroom 1', 100, 100, 480, 350], ['02', 'Classroom 2', 580, 100, 480, 350], ['03', 'Classroom 3', 1060, 100, 490, 350],
      ['04', 'Stair 1', 1550, 100, 350, 350], ['05', 'Corridor', 100, 450, 1800, 180], ['06', 'Library', 100, 630, 700, 670],
      ['07', 'Staff Room', 800, 630, 450, 670], ['08', 'Store', 1250, 630, 300, 670], ['09', 'WCs', 1550, 630, 350, 670]]],
  ];
  const plans = [];
  for (const [name, lvl, rooms] of layouts) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#222'; g.lineWidth = 6; g.fillStyle = '#444'; g.textAlign = 'center';
    for (const [num, rname, x, y, w, h] of rooms) {
      g.strokeRect(x, y, w, h);
      g.font = '600 30px sans-serif'; g.fillText(rname, x + w / 2, y + h / 2 - 6);
      g.font = '26px sans-serif'; g.fillText(lvl + '.' + num, x + w / 2, y + h / 2 + 30);
    }
    g.lineWidth = 12; g.strokeRect(100, 100, 1800, 1200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    plans.push({
      id: 'demo-' + lvl, name, level: lvl,
      image: { blob, width: W, height: H },
      transform: { a: 0.05, b: 0, c: 0, d: -0.05, e: 0, f: 70 },
      rooms: rooms.map(([num, rname, x, y, w, h]) => ({ id: 'demo-' + lvl + '-' + num, number: lvl + '.' + num, name: rname, polygon: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] })),
    });
  }
  return { format: 'hm-sitepack', version: 1, project: { id: 'demo', number: '0000', name: 'Demo Building' }, plans };
}

// ------------------------------------------------------------ screens: home
async function showHome() {
  S.project = S.visit = S.plan = null; closeSheet(true);
  localStorage.removeItem('sv.last');
  const projects = (await idb.all('projects')).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const hasDemo = projects.some(p => p.id === 'demo');
  $('#app').innerHTML = `
    <header class="bar brand"><img class="logo" src="brand/hm-logo.png" alt=""><img class="wordmark" src="brand/hm-wordmark.png" alt="Holmes Miller"></header>
    <div class="scroll">
      <div class="hero"><small>Site Visit</small><h1>Projects</h1></div>
      ${projects.length ? '' : '<p class="muted empty">No projects on this phone yet. Add one that has been sent from Revit, or try the demo.</p>'}
      ${projects.map(p => `
        <button class="card" data-project="${esc(p.id)}">
          <span class="tile">${ICON.building}</span>
          <div class="grow"><b>${esc(p.name)}</b><small>${esc(p.number || '')} &middot; ${p.plans.length} level${p.plans.length === 1 ? '' : 's'}</small></div>
          <span class="chev">&rsaquo;</span>
        </button>`).join('')}
      <button class="primary big" data-act="add">${ICON.cloud}<span>Add project from OneDrive</span></button>
      ${hasDemo ? '' : `<button class="link" data-act="demo">Try the demo project</button>`}
      <p class="muted">Projects are sent from Revit as a single file in the project's <i>Site Visits</i> folder. Pick that file here.</p>
    </div>`;
}

// ------------------------------------------------------------ screens: project
async function showProject(pid) {
  closeSheet(true);
  localStorage.removeItem('sv.last');
  const project = await idb.get('projects', pid);
  if (!project) return showHome();
  S.project = project; S.visit = null;
  const visits = (await idb.by('visits', 'project', pid)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const counts = new Map();
  for (const v of visits) counts.set(v.id, (await idb.by('observations', 'visit', v.id)).length);
  const todays = visits.find(v => v.date === todayISO());
  $('#app').innerHTML = `
    <header class="bar light"><button class="back text" data-act="home">&lsaquo;<span>Projects</span></button></header>
    <div class="scroll">
      <div class="hero"><small>${esc(project.number || '')}</small><h1>${esc(project.name)}</h1></div>
      <button class="primary big" data-act="${todays ? 'continue' : 'start'}" data-visit="${todays ? esc(todays.id) : ''}">
        ${CAMERA_SVG}<span>${todays ? "Continue today's visit" : "Start today's visit"}</span></button>
      ${todays ? `<button class="link" data-act="start">${ICON.plus}<span>Start a new visit</span></button>` : ''}
      ${visits.length ? '<h2>Visits</h2>' : ''}
      ${visits.map(v => `
        <button class="card" data-visit="${esc(v.id)}" data-act="continue">
          <div class="grow"><b>${fmtDate(v.date)}, ${new Date(v.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${v.exportedAt ? '<span class="tag">sent</span>' : ''}</b>
          <small>${counts.get(v.id)} location${counts.get(v.id) === 1 ? '' : 's'} recorded</small></div>
          <span class="chev">&rsaquo;</span>
        </button>`).join('')}
      <h2>Project</h2>
      <div class="group">
        <button class="plain" data-act="add">Update plans from OneDrive<span class="chev">&rsaquo;</span></button>
        <button class="plain danger" data-act="remove-project">Remove project from this phone</button>
      </div>
    </div>`;
}

async function startVisit() {
  const v = { id: uid(), projectId: S.project.id, date: todayISO(), startedAt: new Date().toISOString(), exportedAt: null };
  await idb.put('visits', v);
  return openVisit(v.id);
}

// ------------------------------------------------------------ screens: visit (plan + pins)
async function openVisit(visitId, planId) {
  const visit = await idb.get('visits', visitId);
  if (!visit) return showHome();
  S.visit = visit;
  S.project = await idb.get('projects', visit.projectId);
  const all = await idb.by('plans', 'project', visit.projectId);
  S.plans = S.project.plans.map(m => all.find(p => p.id === m.id)).filter(Boolean);
  S.obs = (await idb.by('observations', 'visit', visitId)).sort((a, b) => a.seq - b.seq);
  S.photos = new Map();
  for (const p of (await idb.by('photos', 'visit', visitId)).sort((a, b) => a.takenAt.localeCompare(b.takenAt))) {
    if (!S.photos.has(p.observationId)) S.photos.set(p.observationId, []);
    S.photos.get(p.observationId).push(p);
  }
  S.sel = null;
  renderVisit(planId);
}

function renderVisit(planId) {
  $('#app').innerHTML = `
    <header class="bar"><button class="back" data-act="project">&lsaquo;</button>
      <div class="title"><b>${esc(S.project.name)}</b><small>Visit ${fmtDate(S.visit.date)}</small></div>
      <button data-act="list">List</button></header>
    <nav class="levels" id="levels"></nav>
    <main class="plan" id="planvp">
      <div class="stage"><img alt=""><svg></svg></div>
      <div class="pins" id="pins"></div>
      <div class="hint" id="hint">Tap the plan where you are standing</div>
      <button class="fitbtn" data-act="fit" title="Fit plan">&#x2922;</button>
    </main>
    <footer class="bar bottom"><div class="stats" id="stats"></div>
      <button class="primary" data-act="finish">Finish &amp; send</button></footer>`;
  S.view = new PlanView($('#planvp'), onPlanTap, positionPins);
  setPlan(planId && S.plans.some(p => p.id === planId) ? planId : (S.plans[0] && S.plans[0].id));
}

function setPlan(planId) {
  S.plan = S.plans.find(p => p.id === planId) || null;
  renderLevels();
  if (!S.plan) return;
  localStorage.setItem('sv.last', JSON.stringify({ visitId: S.visit.id, planId }));
  S.view.setImage(urlFor('plan:' + S.plan.key, S.plan.image), S.plan.width, S.plan.height);
  renderRooms(); renderPins(); renderStats();
}

function renderLevels() {
  $('#levels').innerHTML = S.plans.map(p => {
    const n = S.obs.filter(o => o.planId === p.id).length;
    return `<button data-plan="${esc(p.id)}" class="${S.plan && p.id === S.plan.id ? 'on' : ''}">${esc(p.name)}${n ? `<span class="n">${n}</span>` : ''}</button>`;
  }).join('');
}

function coveredRoomIds() { return new Set(S.obs.filter(o => o.roomId && (S.photos.get(o.id) || []).length).map(o => o.roomId)); }

function renderRooms() {
  const svg = $('#planvp svg'), p = S.plan, covered = coveredRoomIds();
  svg.setAttribute('viewBox', `0 0 ${p.width} ${p.height}`);
  svg.setAttribute('width', p.width); svg.setAttribute('height', p.height);
  svg.innerHTML = p.rooms.map(r => `<polygon class="${covered.has(r.id) ? 'covered' : ''}" points="${r.polygon.map(q => q.join(',')).join(' ')}"/>`).join('');
}

function renderPins() {
  $('#pins').innerHTML = S.obs.filter(o => o.planId === S.plan.id).map(o =>
    `<button class="pin${o.id === S.sel ? ' sel' : ''}${(S.photos.get(o.id) || []).length ? '' : ' empty'}" data-obs="${esc(o.id)}"><span>${o.seq}</span></button>`).join('');
  positionPins();
  $('#hint').hidden = S.obs.length > 0;
}

function positionPins() {
  if (!S.view || !S.plan || !$('#pins')) return;
  for (const el of $('#pins').children) {
    const o = S.obs.find(x => x.id === el.dataset.obs);
    if (!o) continue;
    const [sx, sy] = S.view.toScreen(o.x, o.y);
    el.style.left = sx + 'px'; el.style.top = sy + 'px';
  }
}

// Slide the plan up if the open sheet would hide the selected pin.
function revealPin(o) {
  const sheet = $('#sheet');
  if (!S.view || sheet.hidden || !o || !S.plan || o.planId !== S.plan.id) return;
  const vp = S.view.vp.getBoundingClientRect(), top = sheet.getBoundingClientRect().top;
  const sy = S.view.toScreen(o.x, o.y)[1] + vp.top;
  const limit = top - 24, min = vp.top + 60;
  if (sy > limit) { S.view.y -= sy - Math.max(min, limit - 40); S.view.apply(); }
}

function renderStats() {
  const nPhotos = [...S.photos.values()].reduce((s, a) => s + a.length, 0);
  const total = totalRooms();
  $('#stats').textContent = `${nPhotos} photo${nPhotos === 1 ? '' : 's'}` + (total ? ` · ${coveredRoomIds().size} of ${total} rooms` : '');
}

// ------------------------------------------------------------ plan view: pan, pinch-zoom, tap
class PlanView {
  constructor(vp, onTap, onChange) {
    this.vp = vp; this.stage = $('.stage', vp); this.img = $('img', vp);
    this.onTap = onTap; this.onChange = onChange;
    this.s = 1; this.x = 0; this.y = 0; this.w = 1; this.h = 1;
    this.pts = new Map(); this.gesture = null;
    vp.addEventListener('pointerdown', e => this.down(e));
    vp.addEventListener('pointermove', e => this.move(e));
    vp.addEventListener('pointerup', e => this.up(e));
    vp.addEventListener('pointercancel', e => { this.pts.delete(e.pointerId); this.gesture = null; });
    vp.addEventListener('wheel', e => { e.preventDefault(); this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.2 : 1 / 1.2); }, { passive: false });
    window.addEventListener('resize', () => this.onChange());
  }
  setImage(url, w, h) {
    this.w = w; this.h = h; this.img.src = url; this.img.width = w; this.img.height = h;
    this.stage.style.width = w + 'px'; this.stage.style.height = h + 'px';
    this.fit();
  }
  fit() {
    const r = this.vp.getBoundingClientRect();
    this.s = Math.min(r.width / this.w, r.height / this.h) * 0.96;
    this.minS = this.s * 0.6; this.maxS = Math.max(this.s * 10, 3);
    this.x = (r.width - this.w * this.s) / 2; this.y = (r.height - this.h * this.s) / 2;
    this.apply();
  }
  apply() { this.stage.style.transform = `translate(${this.x}px,${this.y}px) scale(${this.s})`; this.onChange(); }
  toScreen(px, py) { return [px * this.s + this.x, py * this.s + this.y]; }
  toImage(cx, cy) { const r = this.vp.getBoundingClientRect(); return [(cx - r.left - this.x) / this.s, (cy - r.top - this.y) / this.s]; }
  zoomAt(cx, cy, f) {
    const r = this.vp.getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
    const ns = Math.min(this.maxS, Math.max(this.minS, this.s * f)), k = ns / this.s;
    this.x = px - (px - this.x) * k; this.y = py - (py - this.y) * k; this.s = ns;
    this.apply();
  }
  down(e) {
    if (e.target.closest('.pin, .fitbtn')) return;
    this.vp.setPointerCapture(e.pointerId);
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pts.size === 1) this.gesture = { x0: e.clientX, y0: e.clientY, t0: Date.now(), moved: false, pinched: false };
    else if (this.gesture) this.gesture.pinched = true;
  }
  move(e) {
    const p = this.pts.get(e.pointerId);
    if (!p || !this.gesture) return;
    if (this.pts.size === 1) {
      this.x += e.clientX - p.x; this.y += e.clientY - p.y;
      if (Math.hypot(e.clientX - this.gesture.x0, e.clientY - this.gesture.y0) > 8) this.gesture.moved = true;
      p.x = e.clientX; p.y = e.clientY;
      this.apply();
    } else if (this.pts.size === 2) {
      const [a, b] = [...this.pts.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y), m0 = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      p.x = e.clientX; p.y = e.clientY;
      const d1 = Math.hypot(a.x - b.x, a.y - b.y), m1 = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      this.x += m1[0] - m0[0]; this.y += m1[1] - m0[1];
      if (d0 > 0) this.zoomAt(m1[0], m1[1], d1 / d0); else this.apply();
    }
  }
  up(e) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    const g = this.gesture;
    if (this.pts.size === 0) {
      this.gesture = null;
      if (g && !g.moved && !g.pinched && Date.now() - g.t0 < 600) {
        const [ix, iy] = this.toImage(e.clientX, e.clientY);
        this.onTap(ix, iy, e.pointerType === 'touch');
      }
    }
  }
}

// ------------------------------------------------------------ observations
function polygonArea(pg) {
  let a = 0;
  for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) a += pg[j][0] * pg[i][1] - pg[i][0] * pg[j][1];
  return Math.abs(a) / 2;
}
// A room can sit inside another room's outline (a lift within circulation), so the smallest match wins.
function findRoom(plan, x, y) {
  let best = null, bestArea = Infinity;
  for (const r of plan.rooms) {
    const pg = r.polygon; let inside = false;
    for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
      const [xi, yi] = pg[i], [xj, yj] = pg[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) { const a = polygonArea(pg); if (a < bestArea) { best = r; bestArea = a; } }
  }
  return best;
}
// Rooms can appear on more than one plan (a GA plan and its part plans); count each once.
function totalRooms() { return new Set(S.plans.flatMap(p => p.rooms.map(r => r.id))).size; }

function onPlanTap(x, y, viaTouch) {
  const plan = S.plan;
  if (!plan || x < 0 || y < 0 || x > plan.width || y > plan.height) { closeSheet(); return; }
  closeSheet();
  const room = findRoom(plan, x, y);
  const o = {
    id: uid(), visitId: S.visit.id, projectId: S.project.id,
    seq: S.obs.reduce((m, q) => Math.max(m, q.seq), 0) + 1,
    planId: plan.id, planName: plan.name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
    roomId: room ? room.id : null, roomNumber: room ? room.number : '', roomName: room ? room.name : '',
    note: '', category: '', createdAt: new Date().toISOString(),
  };
  S.obs.push(o); S.sel = o.id;
  // The camera has to be opened inside the tap itself, before anything asynchronous, or phones refuse it.
  if (viaTouch) $('#cam').click();
  idb.put('observations', o);
  renderPins(); renderLevels(); renderSheet(); revealPin(o);
}

function selected() { return S.obs.find(o => o.id === S.sel) || null; }

function openObs(id) {
  if (S.sel && S.sel !== id) closeSheet();
  const o = S.obs.find(q => q.id === id);
  if (!o) return;
  if (!S.plan || S.plan.id !== o.planId) setPlan(o.planId);
  S.sel = id; renderPins(); renderSheet(); revealPin(o);
}

function renderSheet() {
  const o = selected(), sheet = $('#sheet');
  if (!o) return hideSheet();
  const plan = S.plans.find(p => p.id === o.planId);
  const keepNote = sheet.dataset.obs === o.id && $('textarea', sheet) ? $('textarea', sheet).value : o.note;
  sheet.dataset.obs = o.id;
  sheet.innerHTML = `
    <div class="sheet-head">
      <span class="num">${o.seq}</span>
      <select id="room">
        <option value="">${plan && plan.rooms.length ? 'No room (external / other)' : esc(o.planName)}</option>
        ${(plan ? plan.rooms : []).slice().sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }))
          .map(r => `<option value="${esc(r.id)}"${r.id === o.roomId ? ' selected' : ''}>${esc(r.number)} ${esc(r.name)}</option>`).join('')}
      </select>
      <button data-act="done">Done</button>
    </div>
    <div class="photos">${photosHtml(o)}</div>
    <textarea id="note" rows="3" placeholder="What did you see? Tap the microphone on the keyboard to dictate.">${esc(keepNote)}</textarea>
    <div class="chips">
      ${CATEGORIES.map(c => `<button data-cat="${esc(c)}" class="${o.category === c ? 'on' : ''}">${esc(c)}</button>`).join('')}
      <span class="spacer"></span>
      <button class="danger" data-act="delete-obs">Delete</button>
    </div>`;
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
}

function photosHtml(o) {
  const photos = S.photos.get(o.id) || [], some = photos.length || S.busy;
  return `
      ${some ? '' : `<button class="camera wide" data-act="camera">${CAMERA_SVG}<span>Take photo</span></button>`}
      ${photos.map(p => `<img src="${urlFor('thumb:' + p.id, p.thumb)}" data-photo="${esc(p.id)}" alt="">`).join('')}
      ${S.busy ? '<div class="busy">Saving&hellip;</div>' : ''}
      ${some ? `<button class="camera" data-act="camera">${CAMERA_SVG}<span>Another</span></button>` : ''}
      <button data-act="library"><span>From</span><span>library</span></button>`;
}

// Refresh only the photo strip, so a note being typed keeps its cursor and keyboard.
function renderSheetPhotos() {
  const o = selected(), strip = $('#sheet .photos');
  if (!o || !strip || $('#sheet').dataset.obs !== o.id) return renderSheet();
  strip.innerHTML = photosHtml(o);
}

function hideSheet() {
  const sheet = $('#sheet');
  sheet.hidden = true; sheet.innerHTML = ''; delete sheet.dataset.obs;
  document.body.classList.remove('sheet-open');
}

let noteTimer;
function saveNote() {
  const o = selected(), ta = $('#note');
  if (!o || !ta) return;
  o.note = ta.value; idb.put('observations', o);
}

async function deleteObs(id) {
  const i = S.obs.findIndex(o => o.id === id);
  if (i < 0) return;
  for (const p of S.photos.get(id) || []) { await idb.del('photos', p.id); dropUrl('thumb:' + p.id); dropUrl('full:' + p.id); }
  S.photos.delete(id);
  await idb.del('observations', id);
  S.obs.splice(i, 1);
  // keep numbering continuous
  for (let k = 0; k < S.obs.length; k++) if (S.obs[k].seq !== k + 1) { S.obs[k].seq = k + 1; await idb.put('observations', S.obs[k]); }
}

// Closing the sheet throws away a pin that has neither a photo nor a note (an accidental tap).
function closeSheet(silent) {
  clearTimeout(noteTimer);
  const o = selected();
  if (o) {
    saveNote();
    S.sel = null;
    if (!S.busy && !(S.photos.get(o.id) || []).length && !o.note.trim()) deleteObs(o.id).then(() => { if (S.visit && !silent) { renderPins(); renderLevels(); } });
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  hideSheet();
  if (S.visit && S.plan && !silent) { renderPins(); renderLevels(); }
}

// ------------------------------------------------------------ photos
function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That file could not be read as a photo.')); };
    img.src = url;
  });
}
function scaled(img, max, quality) {
  const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(b => r({ blob: b, w: c.width, h: c.height }), 'image/jpeg', quality));
}

async function addPhotos(obsId, files) {
  const o = S.obs.find(q => q.id === obsId);
  if (!o || !files.length) return;
  S.busy += files.length; if (S.sel === obsId) renderSheetPhotos();
  for (const f of files) {
    try {
      const img = await loadImage(f);
      const full = await scaled(img, PHOTO_MAX, 0.85), thumb = await scaled(img, 320, 0.7);
      const p = {
        id: uid(), observationId: obsId, visitId: o.visitId, blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h,
        takenAt: new Date(f.lastModified && Date.now() - f.lastModified < 6e5 ? f.lastModified : Date.now()).toISOString(),
        originalTime: f.lastModified ? new Date(f.lastModified).toISOString() : null,
      };
      await idb.put('photos', p);
      if (!S.photos.has(obsId)) S.photos.set(obsId, []);
      S.photos.get(obsId).push(p);
    } catch (err) { toast(err.message || 'Photo could not be saved'); }
    S.busy--;
  }
  if (S.visit && S.visit.id === o.visitId) {
    if (S.sel === obsId) renderSheetPhotos();
    renderPins(); renderRooms(); renderStats();
  }
}

function showPhoto(photoId) {
  const o = selected(); if (!o) return;
  const p = (S.photos.get(o.id) || []).find(q => q.id === photoId); if (!p) return;
  const ov = $('#overlay');
  ov.className = 'overlay photo'; ov.hidden = false;
  ov.innerHTML = `<img src="${urlFor('full:' + p.id, p.blob)}" alt="">
    <div class="tools"><button data-act="delete-photo" data-photo="${esc(p.id)}">Delete photo</button><button data-act="close-overlay">Close</button></div>`;
}
function closeOverlay() { const ov = $('#overlay'); ov.hidden = true; ov.innerHTML = ''; ov.className = 'overlay'; }

// ------------------------------------------------------------ list of observations
function showList() {
  closeSheet();
  $('#app').innerHTML = `
    <header class="bar"><button class="back" data-act="plan">&lsaquo;</button>
      <div class="title"><b>${S.obs.length} location${S.obs.length === 1 ? '' : 's'}</b><small>Visit ${fmtDate(S.visit.date)}</small></div></header>
    <div class="scroll">
      ${S.obs.length ? '' : '<p class="muted">Nothing recorded yet. Go back and tap the plan.</p>'}
      ${S.obs.map(o => {
        const ph = S.photos.get(o.id) || [];
        return `<button class="card" data-goto="${esc(o.id)}">
          <span class="seq">${o.seq}</span>
          ${ph.length ? `<img class="thumb" src="${urlFor('thumb:' + ph[0].id, ph[0].thumb)}" alt="">` : ''}
          <div class="grow"><b>${esc(o.roomNumber ? o.roomNumber + ' ' + o.roomName : o.planName)}</b>
          <small>${esc(o.planName)} &middot; ${ph.length} photo${ph.length === 1 ? '' : 's'}${o.category ? ' &middot; ' + esc(o.category) : ''}</small>
          ${o.note ? `<div class="muted">${esc(o.note.length > 90 ? o.note.slice(0, 90) + '…' : o.note)}</div>` : ''}</div>
        </button>`;
      }).join('')}
    </div>`;
}

// ------------------------------------------------------------ export (zip -> OneDrive)
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// Minimal .zip writer (files stored uncompressed - photos are already compressed).
async function makeZip(entries) {
  const parts = [], central = [], enc = new TextEncoder(), now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), size = e.blob.size, crc = crc32(new Uint8Array(await e.blob.arrayBuffer()));
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

function toModel(plan, x, y) {
  const t = plan && plan.transform;
  if (!t) return null;
  const r = v => Math.round(v * 1e4) / 1e4;
  return [r(t.a * x + t.c * y + t.e), r(t.b * x + t.d * y + t.f)];
}

async function buildExport(by) {
  const entries = [], observations = [];
  for (const o of S.obs) {
    const ps = S.photos.get(o.id) || [];
    if (!ps.length && !o.note.trim()) continue;
    const plan = S.plans.find(p => p.id === o.planId);
    const files = ps.map((p, i) => `photos/${pad(o.seq, 3)}-${i + 1}.jpg`);
    ps.forEach((p, i) => entries.push({ name: files[i], blob: p.blob }));
    observations.push({
      id: o.id, seq: o.seq, planId: o.planId, planName: o.planName,
      x: o.x, y: o.y, model: toModel(plan, o.x, o.y),
      roomId: o.roomId, roomNumber: o.roomNumber, roomName: o.roomName,
      category: o.category, note: o.note.trim(), createdAt: o.createdAt,
      photos: ps.map((p, i) => ({ file: files[i], takenAt: p.takenAt, width: p.w, height: p.h })),
    });
  }
  const exportedAt = new Date().toISOString();
  const doc = {
    format: 'hm-sitevisit', version: 1,
    project: { id: S.project.id, number: S.project.number || '', name: S.project.name },
    visit: { id: S.visit.id, date: S.visit.date, startedAt: S.visit.startedAt, exportedAt, by },
    observations,
  };
  entries.unshift({ name: 'visit.json', blob: new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }) });
  const zip = await makeZip(entries);
  const stamp = S.visit.date + ' ' + pad(new Date(S.visit.startedAt).getHours()) + pad(new Date(S.visit.startedAt).getMinutes());
  const name = `${(S.project.number || S.project.name).replace(/[\\/:*?"<>|]/g, '-')} Site Visit ${stamp}.zip`;
  return { file: new File([zip], name, { type: 'application/zip' }), count: observations.length, exportedAt };
}

let pendingExport = null;
function showFinish() {
  closeSheet();
  const nObs = S.obs.filter(o => (S.photos.get(o.id) || []).length || o.note.trim()).length;
  const nPhotos = [...S.photos.values()].reduce((s, a) => s + a.length, 0);
  const total = totalRooms();
  const ov = $('#overlay'); ov.className = 'overlay'; ov.hidden = false; pendingExport = null;
  ov.innerHTML = `<div class="dialog">
    <h3>Finish &amp; send</h3>
    <p>${nObs} location${nObs === 1 ? '' : 's'}, ${nPhotos} photo${nPhotos === 1 ? '' : 's'}${total ? `, ${coveredRoomIds().size} of ${total} rooms covered` : ''}.</p>
    <label class="muted" for="by">Your name</label>
    <input id="by" type="text" value="${esc(localStorage.getItem('sv.name') || '')}" autocomplete="name">
    <p class="muted" id="finish-msg">The visit is packed into one file. Save it to the project's <i>Site Visits</i> folder in OneDrive.</p>
    <div class="row"><button data-act="close-overlay">Not yet</button>
      <button class="primary" data-act="prepare" ${nObs ? '' : 'disabled'}>Prepare file</button></div>
  </div>`;
}

async function prepareExport(btn) {
  const by = $('#by').value.trim(); localStorage.setItem('sv.name', by);
  btn.disabled = true; btn.textContent = 'Packing…';
  try {
    pendingExport = await buildExport(by);
    const mb = (pendingExport.file.size / 1048576).toFixed(1);
    $('#finish-msg').textContent = `Ready: ${pendingExport.file.name} (${mb} MB).`;
    btn.textContent = 'Save to OneDrive'; btn.dataset.act = 'send'; btn.disabled = false;
  } catch (err) {
    btn.textContent = 'Prepare file'; btn.disabled = false; toast('Could not pack the visit: ' + (err.message || err));
  }
}

async function sendExport() {
  if (!pendingExport) return;
  const { file, exportedAt } = pendingExport;
  let done = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); done = true; }
    catch (err) { if (err && err.name === 'AbortError') return; }   // cancelled: leave the dialog open
  }
  if (!done) {   // browsers that cannot share files: download instead
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  S.visit.exportedAt = exportedAt; await idb.put('visits', S.visit);
  closeOverlay();
  toast(done ? 'Visit sent. It stays on this phone until you remove it.' : 'Visit saved to Downloads. Move it to the Site Visits folder.', 5000);
}

// ------------------------------------------------------------ events
const isTextField = el => el && el.matches && el.matches('textarea, input[type=text]');
document.addEventListener('click', async e => {
  // Belt and braces for iPhones: a tap on a text box always gives it the keyboard.
  if (isTextField(e.target)) { if (document.activeElement !== e.target) e.target.focus(); return; }
  const t = e.target.closest('[data-act],[data-project],[data-plan],[data-obs],[data-cat],[data-photo],[data-goto]');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.project) return showProject(d.project);
    if (d.plan) { closeSheet(); return setPlan(d.plan); }
    if (d.obs) return openObs(d.obs);
    if (d.goto) { renderVisit(S.obs.find(o => o.id === d.goto).planId); return openObs(d.goto); }
    if (d.cat) {
      const o = selected(); if (!o) return;
      o.category = o.category === d.cat ? '' : d.cat; saveNote(); idb.put('observations', o);
      for (const b of document.querySelectorAll('#sheet [data-cat]')) b.classList.toggle('on', b.dataset.cat === o.category);
      return;
    }
    if (d.photo && !d.act) return showPhoto(d.photo);
    switch (d.act) {
      case 'home': return showHome();
      case 'add': return $('#pack').click();
      case 'demo': await importPack(await demoPack()); return showProject('demo');
      case 'start': return startVisit();
      case 'continue': return openVisit(d.visit);
      case 'project': closeSheet(true); return showProject(S.project.id);
      case 'plan': return renderVisit(S.plan && S.plan.id);
      case 'list': return showList();
      case 'fit': return S.view.fit();
      case 'done': return closeSheet();
      case 'camera': return $('#cam').click();
      case 'library': return $('#lib').click();
      case 'delete-obs': {
        const o = selected(); if (!o) return;
        const n = (S.photos.get(o.id) || []).length;
        if (n && !confirm(`Delete location ${o.seq} and its ${n} photo${n === 1 ? '' : 's'}?`)) return;
        S.sel = null; hideSheet();
        await deleteObs(o.id); renderPins(); renderLevels(); renderRooms(); renderStats(); return;
      }
      case 'delete-photo': {
        const o = selected(); if (!o || !confirm('Delete this photo?')) return;
        const list = S.photos.get(o.id) || [], i = list.findIndex(p => p.id === d.photo);
        if (i >= 0) { await idb.del('photos', d.photo); dropUrl('thumb:' + d.photo); dropUrl('full:' + d.photo); list.splice(i, 1); }
        closeOverlay(); renderSheetPhotos(); renderPins(); renderRooms(); renderStats(); return;
      }
      case 'close-overlay': return closeOverlay();
      case 'finish': return showFinish();
      case 'prepare': return prepareExport(t);
      case 'send': return sendExport();
      case 'remove-project': {
        const visits = await idb.by('visits', 'project', S.project.id);
        const unsent = visits.filter(v => !v.exportedAt).length;
        if (!confirm(`Remove "${S.project.name}" and its ${visits.length} visit${visits.length === 1 ? '' : 's'} from this phone?` + (unsent ? `\n\n${unsent} visit${unsent === 1 ? ' has' : 's have'} not been sent and will be lost.` : ''))) return;
        for (const v of visits) {
          for (const p of await idb.by('photos', 'visit', v.id)) await idb.del('photos', p.id);
          for (const o of await idb.by('observations', 'visit', v.id)) await idb.del('observations', o.id);
          await idb.del('visits', v.id);
        }
        for (const p of await idb.by('plans', 'project', S.project.id)) { dropUrl('plan:' + p.key); await idb.del('plans', p.key); }
        await idb.del('projects', S.project.id);
        return showHome();
      }
    }
  } catch (err) { console.error(err); toast(err.message || String(err)); }
});

document.addEventListener('input', e => {
  if (e.target.id === 'note') { clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 400); }
});
// When the keyboard closes, iPhones can leave the page shifted up; put it back.
document.addEventListener('focusout', e => {
  if (isTextField(e.target)) setTimeout(() => { if (!isTextField(document.activeElement)) window.scrollTo(0, 0); }, 80);
});
document.addEventListener('change', e => {
  if (e.target.id !== 'room') return;
  const o = selected(); if (!o) return;
  const plan = S.plans.find(p => p.id === o.planId), r = plan && plan.rooms.find(q => q.id === e.target.value);
  o.roomId = r ? r.id : null; o.roomNumber = r ? r.number : ''; o.roomName = r ? r.name : '';
  idb.put('observations', o); renderRooms(); renderStats();
});

for (const id of ['cam', 'lib']) $('#' + id).addEventListener('change', e => {
  const files = [...e.target.files]; e.target.value = '';
  if (S.sel) addPhotos(S.sel, files);
});
$('#pack').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { toast('Reading project…', 20000); const pid = await importPack(JSON.parse(await f.text())); toast('Project added'); showProject(pid); }
  catch (err) { toast(err instanceof SyntaxError ? 'That file is not a site visit project file.' : (err.message || String(err)), 5000); }
});

// ------------------------------------------------------------ start-up
(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // Phones sometimes reload the page while the camera is open; go straight back to where the user was.
  let last = null;
  try { last = JSON.parse(localStorage.getItem('sv.last') || 'null'); } catch (e) { /* ignore */ }
  if (last && last.visitId && await idb.get('visits', last.visitId)) return openVisit(last.visitId, last.planId);
  showHome();
})();

// Used for testing from the browser console.
window.__sv = { S, idb, addPhotos, onPlanTap, buildExport, importPack };
