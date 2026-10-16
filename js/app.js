import {
  mergeClass, classGrade, letterFor, gpa, timeline, recentAverage, project, neededFor, isRemaining,
} from './grades.js';
import { unseal } from './vault.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtPct = (p) => (p == null ? '—' : `${p.toFixed(1)}%`);
const fmtGpa = (g) => (g == null ? '—' : g.toFixed(2));
const fmtDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const fmtScore = (n) => (Number.isInteger(n) ? n : n.toFixed(1));

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`grades:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`grades:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

let data, config;
const state = {
  studentId: null,
  term: 'all',
  sort: store.get('sort') ?? 'period',
  whatIf: { on: false, pct: 85, mode: 'flat' },
  overrides: new Map(), // "classId:index" -> pct
  open: new Set(),
  filters: new Map(), // classId -> { q, cat, missing }
  extras: store.get('extras') ?? {}, // classId -> [{ name, category, max, pct }] hypothetical assignments
};
const saveExtras = () => store.set('extras', state.extras);

const getJson = (u) => fetch(u, { cache: 'no-cache' }).then((r) => {
  if (!r.ok) throw Object.assign(new Error(`${u}: ${r.status}`), { status: r.status });
  return r.json();
});

// Published site: data.enc.json holds { data, config } encrypted with the family passphrase.
// Local dev: falls back to the plain files.
async function load() {
  let box = null;
  try { box = await getJson('data.enc.json'); } catch (e) { if (e.status !== 404) throw e; }
  if (box) {
    ({ data, config } = await unlock(box));
  } else {
    [data, config] = await Promise.all([getJson('data/grades.json'), getJson('config.json')]);
  }
  start();
}

async function unlock(box) {
  const saved = store.get('passphrase');
  if (saved) {
    try { return await unseal(box, saved); } catch { store.set('passphrase', null); }
  }
  document.body.classList.add('locked');
  const form = $('#lock');
  form.hidden = false;
  form.querySelector('input[type=password]').focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = form.elements.pass.value;
      const msg = form.querySelector('.lock-msg');
      msg.textContent = 'Unlocking…';
      try {
        const out = await unseal(box, pass);
        if (form.elements.remember.checked) store.set('passphrase', pass);
        form.hidden = true;
        document.body.classList.remove('locked');
        resolve(out);
      } catch {
        msg.textContent = "That passphrase didn't work.";
        form.elements.pass.select();
      }
    });
  });
}

function start() {
  const fromUrl = new URLSearchParams(location.search).get('student')?.toLowerCase();
  const byName = data.students.find((s) => displayName(s).toLowerCase() === fromUrl)?.id;
  const ids = data.students.map((s) => s.id);
  state.studentId = [byName, fromUrl, store.get('student')].find((id) => ids.includes(id)) ?? ids[0];
  let t;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 150); });
  renderStudents();
  renderTerms();
  render();
}

// ---------- derived values ----------

const student = () => data.students.find((s) => s.id === state.studentId);
const displayName = (s) => config.students?.[s.id]?.displayName ?? s.name.split(' ')[0];
const letter = (pct) => letterFor(pct, config.gradeScale);

function classes() {
  const all = student().classes.map((c) => {
    const m = mergeClass(c, config);
    const extras = (state.extras[c.id] ?? []).map((e, j) => ({ ...e, score: null, extra: j }));
    return { ...m, realCount: m.assignments.length, assignments: [...m.assignments, ...extras] };
  });
  const list = state.term === 'all' ? all : all.filter((c) => c.term === state.term);
  const cur = (c) => classGrade(c).pct ?? 101;
  const sorters = {
    period: (a, b) => String(a.period).localeCompare(String(b.period), undefined, { numeric: true }),
    name: (a, b) => a.name.localeCompare(b.name),
    low: (a, b) => cur(a) - cur(b),
    high: (a, b) => cur(b) - cur(a),
  };
  return list.sort(sorters[state.sort] ?? sorters.period);
}

function overridesFor(cls) {
  const m = new Map();
  for (const [k, v] of state.overrides) {
    const [id, i] = k.split(':');
    if (id === cls.id) m.set(Number(i), v);
  }
  (state.extras[cls.id] ?? []).forEach((e, j) => { if (e.pct != null) m.set(cls.realCount + j, e.pct); });
  return m;
}

function assumedPct(cls) {
  if (state.whatIf.mode === 'recent') return recentAverage(cls, config.recentCount ?? 5)?.pct ?? state.whatIf.pct;
  return state.whatIf.pct;
}

const today = () => new Date().toLocaleDateString('en-CA');
const termInfo = (id) => config.calendar?.terms.find((t) => t.id === id);
const periodLabel = (cls) => cls.semester ?? termInfo(cls.term)?.name ?? cls.term;

/** The grading period that matters for this student right now: { name, end, days }. */
function gradingPeriod() {
  const cal = config.calendar;
  if (!cal) return null;
  const q = cal.terms.find((t) => t.end >= today()) ?? cal.terms[cal.terms.length - 1];
  const sem = config.students?.[state.studentId]?.gradingPeriod === 'semester' && cal.semesters.find((x) => x.terms.includes(q.id));
  const p = sem || q;
  const days = Math.round((new Date(`${p.end}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 864e5);
  return { name: p.name, end: p.end, days };
}

const projected = (cls) => project(cls, assumedPct(cls), overridesFor(cls));
const remainingCount = (cls) => cls.assignments.filter(isRemaining).length;
const missingCount = (cls) => cls.assignments.filter((a) => a.missing && !a.exempt).length;

// ---------- rendering ----------

function pill(pct) {
  const l = letter(pct);
  if (!l) return '<span class="pill none">—</span>';
  return `<span class="pill g-${l}">${l}<span class="pct">${pct.toFixed(1)}</span></span>`;
}

function sparkline(points) {
  const w = innerWidth >= 1400 ? 180 : innerWidth >= 1000 ? 130 : 96, h = 28, pad = 3;
  if (points.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  // Scale to the data (min 10-pt span) so movement is visible; dashed lines mark letter cutoffs.
  const vals = points.map((p) => Math.min(p.pct, 100));
  let lo = Math.min(...vals) - 2, hi = Math.max(...vals) + 2;
  if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
  const x = (i) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v) => pad + (1 - (Math.min(v, hi) - lo) / (hi - lo)) * (h - 2 * pad);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join('');
  const refs = config.gradeScale.filter((s) => s.min > lo && s.min < hi)
    .map((s) => `<line class="ref" x1="0" x2="${w}" y1="${y(s.min)}" y2="${y(s.min)}"/>`).join('');
  const last = points[points.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${refs}
    <path class="line" d="${d}"/><circle class="t-${letter(last.pct)}" fill="currentColor" cx="${x(points.length - 1)}" cy="${y(last.pct)}" r="2.6"/></svg>`;
}

function renderStudents() {
  $('#students').innerHTML = data.students.map((s) =>
    `<button type="button" role="tab" data-id="${esc(s.id)}" aria-selected="${s.id === state.studentId}">${esc(displayName(s))}</button>`).join('');
}

function renderTerms() {
  const terms = [...new Set(student().classes.map((c) => c.term).filter(Boolean))];
  const sel = $('#term');
  sel.hidden = terms.length < 2;
  if (!terms.includes(state.term)) state.term = 'all';
  sel.innerHTML = `<option value="all">All terms</option>` +
    terms.map((t) => `<option value="${esc(t)}" ${t === state.term ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#sort').value = state.sort;
}

function renderSummary(list) {
  const cur = (c) => classGrade(c).pct;
  const wi = state.whatIf.on;
  const stat = (label, now, proj, sub = '') => `
    <div class="stat"><div class="label">${label}</div>
      <div class="value">${now}</div>
      ${wi && proj != null ? `<div class="proj">→ ${proj} projected</div>` : `<div class="sub">${sub}</div>`}
    </div>`;
  const w = gpa(list, config, cur), u = gpa(list, config, cur, { weighted: false });
  const missing = list.reduce((n, c) => n + missingCount(c), 0);
  const graded = list.map(cur).filter((p) => p != null);
  const below = graded.filter((p) => !['A', 'B'].includes(letter(p))).length;
  const remaining = list.reduce((n, c) => n + remainingCount(c), 0);
  const gp = gradingPeriod();
  $('#summary').innerHTML =
    (gp ? stat(`${esc(gp.name)} ends`, fmtDate(gp.end), null,
      gp.days > 0 ? `${gp.days} day${gp.days === 1 ? '' : 's'} left` : gp.days === 0 ? 'today' : 'ended') : '') +
    stat('GPA', fmtGpa(w), fmtGpa(gpa(list, config, projected)), 'weighted') +
    stat('Unweighted', fmtGpa(u), fmtGpa(gpa(list, config, projected, { weighted: false })), '4.0 scale') +
    stat('Classes', list.length, null, below ? `<span class="t-C">${below} below B</span>` : 'all A/B') +
    stat('Missing', `<span class="${missing ? 't-F' : ''}">${missing}</span>`, null, `${remaining} upcoming`);
}

function renderRow(cls) {
  const g = classGrade(cls);
  const recent = recentAverage(cls, config.recentCount ?? 5);
  let arrow = '';
  if (recent && g.pct != null) {
    const delta = recent.pct - g.pct;
    arrow = delta > 2 ? '▲' : delta < -2 ? '▼' : '';
  }
  const lvl = { honors: 'H', ap: 'AP' }[cls.level];
  const meta = [cls.teacher, cls.period && `Period ${cls.period}`, periodLabel(cls)].filter(Boolean).map(esc).join(' · ');
  const open = state.open.has(cls.id);
  return `
  <div class="cls" data-id="${esc(cls.id)}">
    <button type="button" class="row" data-act="toggle" aria-expanded="${open}">
      <div><div class="name">${esc(cls.name)}${lvl ? `<span class="level">${lvl}</span>` : ''}${missingCount(cls) ? `<span class="flag">${missingCount(cls)} missing</span>` : ''}</div>
        <div class="meta">${meta}</div></div>
      <div class="c-spark">${sparkline(timeline(cls))}</div>
      <div class="c-recent recent" title="Class grade from only the last ${recent?.count ?? 0} graded assignments, using the category weights">
        ${recent ? `<span class="t-${letter(recent.pct)}">${recent.pct.toFixed(0)}%</span> <span class="arrow">${arrow}</span>` : '—'}</div>
      <div class="c-now right">${pill(g.pct)}</div>
      ${state.whatIf.on ? `<div class="right">${pill(projected(cls))}</div>` : ''}
    </button>
    ${open ? renderDetail(cls, g) : ''}
  </div>`;
}

function renderDetail(cls, g) {
  const ov = overridesFor(cls);
  const f = state.filters.get(cls.id) ?? { q: '', cat: '', missing: false };

  const catRows = g.byCategory.map((c) => {
    const l = letter(c.pct);
    return `<tr><td>${esc(c.name)}</td>
      <td class="num">${c.weight != null ? `${c.weight}%` : ''}</td>
      <td class="num" style="width:40%"><span class="${l ? `t-${l}` : 'muted'}">${fmtPct(c.pct)}</span>
        <div class="bar ${l ? `t-${l}` : ''}"><span style="width:${Math.max(0, Math.min(100, c.pct ?? 0))}%"></span></div></td>
      <td class="num muted">${c.count}</td></tr>`;
  }).join('');
  const known = new Set(g.byCategory.map((c) => c.name));
  const uncounted = g.weighted ? [...new Set(cls.assignments.slice(0, cls.realCount).map((a) => a.category))].filter((c) => c && !known.has(c)) : [];

  const remaining = cls.assignments.map((a, i) => ({ a, i })).filter(({ a }) => isRemaining(a));
  const open = remaining.filter(({ i }) => !ov.has(i));
  const openPts = open.reduce((n, { a }) => n + a.max, 0);
  const floor = project(cls, 0, ov), ceiling = project(cls, 100, ov);
  const gp = gradingPeriod();

  // For each letter: the average needed on the open (not yet scored) remaining work.
  const targets = config.gradeScale.filter((s) => s.min > 0).map((s) => {
    const n = neededFor(cls, s.min, ov);
    let txt;
    if (!n) txt = (projected(cls) ?? -1) >= s.min ? '<span class="t-A">Yes</span>, on current scores' : '<span class="muted">No, on current scores</span>';
    else if (n.impossible) txt = `<span class="muted">Not reachable with this work (tops out at ${ceiling.toFixed(1)}%)</span>`;
    else if (n.locked) txt = `<span class="t-A">Guaranteed</span> <span class="muted">(even 0% leaves ${floor.toFixed(1)}%)</span>`;
    else txt = `Average <strong>${Math.ceil(n.pct)}%</strong> or better`;
    return `<tr><td style="width:3.5em"><span class="pill g-${s.letter}">${s.letter}</span></td><td>${txt}</td></tr>`;
  }).join('');
  const targetNote = open.length
    ? `Based on the ${open.length} open assignment${open.length === 1 ? '' : 's'} below (${openPts} pts)${ov.size ? ', plus the scores you set' : ''}.
       Scoring 0–100% on ${open.length === 1 ? 'it' : 'them'} lands between <strong>${floor.toFixed(1)}%</strong> and <strong>${ceiling.toFixed(1)}%</strong>.
       Teachers keep posting work${gp ? ` until ${esc(gp.name)} ends ${fmtDate(gp.end)}` : ''}, so add expected tests below as what-ifs.`
    : 'No open work to plan against. Add the tests or projects you expect below.';
  const catAvg = new Map(g.byCategory.map((c) => [c.name, c.pct]));
  const remRows = remaining.map(({ a, i }) => `
    <tr class="upcoming"><td>${esc(a.name)} <span class="tag">${esc(a.category ?? '')}${catAvg.get(a.category) != null ? ` (avg ${catAvg.get(a.category).toFixed(0)}%)` : ''}</span>${a.extra != null ? ' <span class="tag">· what-if</span>' : ''}</td>
      <td class="num hide-sm">${a.extra != null
        ? `<button type="button" class="link" data-act="remove-extra" data-j="${a.extra}">remove</button>` : fmtDate(a.date)}</td>
      <td class="num">${a.max} pts</td>
      <td class="num"><input class="pct-in ${ov.has(i) ? 'set' : ''}" type="number" min="0" max="120" step="1"
        data-act="override" data-i="${i}" ${a.extra != null ? `data-j="${a.extra}"` : ''} value="${ov.has(i) ? ov.get(i) : ''}"
        placeholder="${Math.round(assumedPct(cls))}" aria-label="Assumed % on ${esc(a.name)}"></td></tr>`).join('');
  const weightedCats = g.weighted ? g.byCategory.map((c) => c.name) : [];
  const addForm = `
    <form class="filters add-extra" data-act="add-extra">
      <input type="text" name="name" placeholder="Add a what-if assignment (e.g. Final exam)" aria-label="Assignment name">
      ${weightedCats.length ? `<select name="category" aria-label="Category">${weightedCats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>` : ''}
      <input class="pct-in" type="number" name="max" min="1" step="1" value="100" aria-label="Points"> <span class="check">pts</span>
      <button type="submit" class="btn">Add</button>
    </form>`;

  const cats = [...new Set(cls.assignments.slice(0, cls.realCount).map((a) => a.category).filter(Boolean))];
  const q = f.q.toLowerCase();
  const shown = cls.assignments
    .filter((a) => !isRemaining(a))
    .filter((a) => (!f.cat || a.category === f.cat) && (!f.missing || a.missing) && (!q || a.name.toLowerCase().includes(q)))
    .sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''));
  const asgRows = shown.map((a) => {
    const pct = a.score != null && a.max ? (a.score / a.max) * 100 : null;
    const l = letter(pct);
    const tShort = cls.semester && termInfo(a.term)?.short;
    return `<tr><td class="hide-sm muted">${fmtDate(a.date)}${tShort ? ` <span class="tag">${tShort}</span>` : ''}</td>
      <td>${esc(a.name)}${a.missing ? '<span class="flag">missing</span>' : ''}${a.exempt ? ` <span class="tag">${a.unscored ? 'not scored' : 'exempt'}</span>` : ''}
        <div class="tag">${esc(a.category ?? '')}</div></td>
      <td class="num muted">${a.score != null ? `${fmtScore(a.score)} / ${a.max}` : ''}</td>
      <td class="num">${l && !a.exempt ? `<span class="t-${l}">${pct.toFixed(0)}%</span>` : ''}</td></tr>`;
  }).join('');

  return `
  <div class="detail"><div class="detail-cols">
    <div class="col-plan">
      <div class="grid2">
        <div>
          <h3>${g.weighted ? 'Category weights' : 'Grading'}</h3>
          <table><thead><tr><th>Category</th><th class="num">Weight</th><th class="num">Average</th><th class="num">#</th></tr></thead>
          <tbody>${catRows}</tbody></table>
          ${uncounted.length ? `<p class="note">Not counted toward the grade (0% weight): ${uncounted.map(esc).join(', ')}</p>` : ''}
          ${cls.reportedGrade != null && g.pct != null && Math.abs(cls.reportedGrade - g.pct) > 0.5
            ? `<p class="note">Aspen shows ${cls.reportedGrade.toFixed(1)}%. This teacher may weight some assignments individually, so projections here are approximate.</p>` : ''}
        </div>
        <div>
          <h3>What it takes to finish with…</h3>
          <table><tbody>${targets}</tbody></table>
          <p class="note">${targetNote}</p>
        </div>
      </div>

      <h3>Remaining work <span class="muted" style="text-transform:none;letter-spacing:0">· set a % to try a scenario</span></h3>
      ${remaining.length ? `
        <table><thead><tr><th>Assignment</th><th class="num hide-sm">Due</th><th class="num">Worth</th><th class="num">Assume %</th></tr></thead>
        <tbody>${remRows}</tbody></table>
        <p class="note">Projected: ${pill(projected(cls))}
          ${ov.size ? ` <button type="button" class="link" data-act="clear">clear scores</button>` : ''}</p>`
        : '<p class="note">Aspen lists no upcoming work for this class yet.</p>'}
      ${addForm}
    </div>

    <div class="col-history">
      <h3>Graded so far <span class="muted" style="text-transform:none;letter-spacing:0">· ${shown.length} shown</span></h3>
      <div class="filters">
        <input type="search" placeholder="Search assignments" value="${esc(f.q)}" data-act="q" aria-label="Search assignments">
        <select data-act="cat" aria-label="Category"><option value="">All categories</option>
          ${cats.map((c) => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" data-act="missing" ${f.missing ? 'checked' : ''}> Missing only</label>
      </div>
      <div class="history"><table>
        <thead><tr><th class="hide-sm">Due</th><th>Assignment</th><th class="num">Score</th><th class="num">%</th></tr></thead>
        <tbody>${asgRows || '<tr><td colspan="4" class="muted">No matching assignments.</td></tr>'}</tbody></table></div>
    </div>
  </div></div>`;
}

function render() {
  const list = classes();
  renderSummary(list);
  $('#whatif').classList.toggle('on', state.whatIf.on);
  $('#whatif-recent').classList.toggle('active', state.whatIf.mode === 'recent');
  $('#whatif-out').textContent = state.whatIf.mode === 'recent' ? 'recent' : `${state.whatIf.pct}%`;
  const el = $('#classes');
  el.classList.toggle('whatif-active', state.whatIf.on);
  const head = `<div class="row head-row col-h" aria-hidden="true"><div>Class</div><div>Trend</div>
    <div class="right">Last ${config.recentCount ?? 5}</div><div class="right">Now</div>${state.whatIf.on ? '<div class="right">Projected</div>' : ''}</div>`;
  el.innerHTML = list.length ? head + list.map(renderRow).join('') : '<div class="empty">No classes for this term.</div>';

  const updated = data.updated ? new Date(data.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
  $('#foot').innerHTML = `<span>Updated ${esc(updated)}${data.source === 'sample' ? ' · sample data' : ''}</span>
    <span>${esc(student().school ?? '')}${store.get('passphrase') ? ' <button type="button" class="link" id="forget">Forget passphrase on this device</button>' : ''}</span>`;
  $('#forget')?.addEventListener('click', () => { store.set('passphrase', null); location.reload(); });
}

// Re-render one class's detail without losing focus in its search box.
function rerenderClass(id, focusSel) {
  const cls = classes().find((c) => c.id === id);
  const node = document.querySelector(`.cls[data-id="${CSS.escape(id)}"]`);
  if (!cls || !node) return render();
  node.outerHTML = renderRow(cls);
  if (focusSel) {
    const input = document.querySelector(`.cls[data-id="${CSS.escape(id)}"] ${focusSel}`);
    input?.focus();
    if (input?.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
  }
}

// ---------- events ----------

$('#students').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  state.studentId = b.dataset.id;
  store.set('student', state.studentId);
  state.open.clear();
  const url = new URL(location.href);
  url.searchParams.set('student', displayName(student()).toLowerCase());
  history.replaceState(null, '', url);
  renderStudents();
  renderTerms();
  render();
});

$('#term').addEventListener('change', (e) => { state.term = e.target.value; render(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; store.set('sort', state.sort); render(); });
$('#whatif-on').addEventListener('change', (e) => { state.whatIf.on = e.target.checked; render(); });
$('#whatif-pct').addEventListener('input', (e) => {
  state.whatIf.pct = Number(e.target.value);
  state.whatIf.mode = 'flat';
  render();
});
$('#whatif-recent').addEventListener('click', () => {
  state.whatIf.mode = state.whatIf.mode === 'recent' ? 'flat' : 'recent';
  render();
});

const cl = $('#classes');
const fil = (id) => {
  if (!state.filters.has(id)) state.filters.set(id, { q: '', cat: '', missing: false });
  return state.filters.get(id);
};

cl.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const id = t.closest('.cls').dataset.id;
  if (t.dataset.act === 'toggle') {
    state.open.has(id) ? state.open.delete(id) : state.open.add(id);
    rerenderClass(id);
  } else if (t.dataset.act === 'clear') {
    for (const k of [...state.overrides.keys()]) if (k.startsWith(`${id}:`)) state.overrides.delete(k);
    for (const e of state.extras[id] ?? []) e.pct = null;
    saveExtras();
    render();
  } else if (t.dataset.act === 'remove-extra') {
    state.extras[id].splice(Number(t.dataset.j), 1);
    if (!state.extras[id].length) delete state.extras[id];
    saveExtras();
    render();
  }
});

cl.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.act !== 'q') return;
  const id = t.closest('.cls').dataset.id;
  fil(id).q = t.value;
  rerenderClass(id, 'input[data-act="q"]');
});

cl.addEventListener('change', (e) => {
  const t = e.target;
  const id = t.closest('.cls')?.dataset.id;
  if (!id) return;
  if (t.dataset.act === 'cat') { fil(id).cat = t.value; rerenderClass(id); }
  if (t.dataset.act === 'missing') { fil(id).missing = t.checked; rerenderClass(id); }
  if (t.dataset.act === 'override') {
    const pct = t.value === '' ? null : Math.max(0, Math.min(120, Number(t.value)));
    if (t.dataset.j != null) {
      state.extras[id][Number(t.dataset.j)].pct = pct;
      saveExtras();
    } else {
      const key = `${id}:${t.dataset.i}`;
      if (pct == null) state.overrides.delete(key); else state.overrides.set(key, pct);
    }
    if (!state.whatIf.on) { state.whatIf.on = true; $('#whatif-on').checked = true; }
    render(); // GPA projection changes too
  }
});

cl.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-act="add-extra"]');
  if (!form) return;
  e.preventDefault();
  const id = form.closest('.cls').dataset.id;
  const fd = new FormData(form);
  const max = Number(fd.get('max'));
  if (!(max > 0)) return;
  const category = fd.get('category') ?? null;
  (state.extras[id] ??= []).push({ name: String(fd.get('name') || '').trim() || `What-if ${category ?? 'assignment'}`, category, max, pct: null });
  saveExtras();
  if (!state.whatIf.on) { state.whatIf.on = true; $('#whatif-on').checked = true; }
  render();
});

load().catch((err) => {
  $('#classes').innerHTML = `<div class="empty">Couldn't load grades: ${esc(err.message)}</div>`;
});
