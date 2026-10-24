import {
  mergeClass, classGrade, letterFor, gpa, timeline, recentAverage, project, neededFor, isRemaining,
} from './grades.js?v=6fbada2433';
import { unseal } from './vault.js?v=6fbada2433';
import { expectedAssignments } from './expected.js?v=6fbada2433';
import { aggregate, weekStart, addDays, monthsBetween } from './calendar.js?v=6fbada2433';

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

let data, config, expected = {};
const state = {
  studentId: null,
  periods: {}, // studentId -> selected grading period key
  sort: store.get('sort') ?? 'period',
  whatIf: { on: false, pct: 85, mode: 'flat' },
  overrides: new Map(), // "classId:index" -> pct
  filters: new Map(), // classId -> { q, cat, status }
  cal: { classId: '', sel: null }, // calendar filter and selected day/week ({ kind, key })
  extras: store.get('extras') ?? {}, // classId -> [{ name, category, max, pct }] hypothetical assignments
};
const saveExtras = () => store.set('extras', state.extras);

const getJson = (u) => fetch(u, { cache: 'no-cache' }).then((r) => {
  if (!r.ok) throw Object.assign(new Error(`${u}: ${r.status}`), { status: r.status });
  return r.json();
});

// Published site: data.enc.json holds { data, config, expected } encrypted with the family passphrase.
// Local dev: falls back to the plain files.
async function load() {
  let box = null;
  try { box = await getJson('data.enc.json'); } catch (e) { if (e.status !== 404) throw e; }
  if (box) {
    ({ data, config, expected = {} } = await unlock(box));
  } else {
    [data, config, expected] = await Promise.all([
      getJson('data/grades.json'), getJson('config.json'), getJson('expected.json').catch(() => ({})),
    ]);
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
  addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
  renderStudents();
  renderTerms();
  render();
}

// ---------- derived values ----------

const student = () => data.students.find((s) => s.id === state.studentId);
const displayName = (s) => config.students?.[s.id]?.displayName ?? s.name.split(' ')[0];
const letter = (pct) => letterFor(pct, config.gradeScale);

/** A class ready for display: Aspen assignments, then pending expected ones, then this browser's what-ifs. */
function prepare(c) {
  const m = mergeClass(c, config);
  // A finished quarter's ungraded items will never be graded: show them as not scored.
  if (m.final) m.assignments = m.assignments.map((a) => (a.score == null && !a.exempt ? { ...a, exempt: true, unscored: true } : a));
  // Planning (expected work, what-ifs) only applies to the period still in progress.
  const exp = m.final ? [] : expectedAssignments(m.assignments, expected[c.id]);
  const extras = m.final ? [] : (state.extras[c.id] ?? []).map((e, j) => ({ ...e, score: null, extra: j }));
  return {
    ...m,
    realCount: m.assignments.length,
    extraStart: m.assignments.length + exp.length,
    assignments: [...m.assignments, ...exp, ...extras],
  };
}

function classes() {
  const sel = selectedPeriod();
  const list = student().classes.filter((c) => periodOf(c) === sel).map(prepare);
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
  (state.extras[cls.id] ?? []).forEach((e, j) => { if (e.pct != null) m.set(cls.extraStart + j, e.pct); });
  return m;
}

function assumedPct(cls) {
  if (state.whatIf.mode === 'recent') return recentAverage(cls, config.recentCount ?? 5)?.pct ?? state.whatIf.pct;
  return state.whatIf.pct;
}

const today = () => new Date().toLocaleDateString('en-CA');
const termInfo = (id) => config.calendar?.terms.find((t) => t.id === id);
const semesterInfo = (name) => config.calendar?.semesters.find((x) => x.name === name);
/** Grading period an entry belongs to: a quarter id ("Term 1") or a semester name. */
const periodOf = (c) => c.periodKey ?? c.semester ?? c.term;
const periodName = (key) => termInfo(key)?.name ?? key;
const periodEnd = (key) => termInfo(key)?.end ?? semesterInfo(key)?.end;
const periodLabel = (cls) => `${periodName(periodOf(cls))}${cls.final ? ' (final)' : ''}`;
const hasGrades = (c) => c.assignments.some((a) => a.score != null && !a.exempt);

/** This student's grading periods, in calendar order. */
function periodsOf() {
  const order = config.calendar?.terms.map((t) => t.id) ?? [];
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.indexOf(semesterInfo(k)?.terms[0] ?? '') + 0.5);
  return [...new Set(student().classes.map(periodOf))].sort((a, b) => rank(a) - rank(b));
}
const periodIsFinal = (key) => student().classes.filter((c) => periodOf(c) === key).every((c) => c.final);

/**
 * The period shown: the user's pick, else the current period once it has any grades,
 * else the latest period that has grades (so a brand-new quarter doesn't open empty).
 */
function selectedPeriod() {
  const keys = periodsOf();
  const pick = state.periods[state.studentId];
  if (keys.includes(pick)) return pick;
  const graded = (k) => student().classes.some((c) => periodOf(c) === k && hasGrades(c));
  const current = keys.find((k) => !periodIsFinal(k)) ?? keys[keys.length - 1];
  return graded(current) ? current : [...keys].reverse().find(graded) ?? current;
}

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
  // Round to hundredths first, as Aspen does, so 91.4499… shows as 91.5 like Aspen's 91.45.
  return `<span class="pill g-${l}">${l}<span class="pct">${(Math.round(pct * 100) / 100).toFixed(1)}</span></span>`;
}

function sparkline(points, big = false) {
  const w = big ? 560 : innerWidth >= 1400 ? 180 : innerWidth >= 1000 ? 130 : 96, h = big ? 150 : 28, pad = big ? 8 : 3;
  const size = big ? `width="100%" viewBox="0 0 ${w} ${h}"` : `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"`;
  if (points.length < 2) return big ? '<p class="note">Not enough graded work for a trend yet.</p>' : `<svg class="spark" width="${w}" height="${h}"></svg>`;
  // Scale to the data (min 10-pt span) so movement is visible; dashed lines mark letter cutoffs.
  const vals = points.map((p) => Math.min(p.pct, 100));
  let lo = Math.min(...vals) - 2, hi = Math.max(...vals) + 2;
  if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
  const x = (i) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const bottom = big ? 18 : pad; // room for the date labels on the big chart
  const y = (v) => pad + (1 - (Math.min(v, hi) - lo) / (hi - lo)) * (h - pad - bottom);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join('');
  const refs = config.gradeScale.filter((s) => s.min > lo && s.min < hi)
    .map((s) => `<line class="ref" x1="0" x2="${w}" y1="${y(s.min)}" y2="${y(s.min)}"/>${big
      ? `<text class="axis" x="${pad}" y="${y(s.min) - 3}">${s.letter} ${s.min}%</text>` : ''}`).join('');
  const last = points[points.length - 1];
  const ends = big ? `<text class="axis" x="${pad}" y="${h - 1}">${fmtDate(points[0].date)}</text>
    <text class="axis" x="${w - pad}" y="${h - 1}" text-anchor="end">${fmtDate(last.date)} · ${last.pct.toFixed(1)}%</text>` : '';
  const dots = big ? points.map((p, i) => `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(p.pct).toFixed(1)}" r="1.8"><title>${fmtDate(p.date)}: ${p.pct.toFixed(1)}%</title></circle>`).join('') : '';
  return `<svg class="spark${big ? ' big' : ''}" ${size} aria-hidden="${!big}">${refs}
    <path class="line" d="${d}"/>${dots}<circle class="t-${letter(last.pct)}" fill="currentColor" cx="${x(points.length - 1)}" cy="${y(last.pct)}" r="${big ? 4 : 2.6}"/>${ends}</svg>`;
}

function renderStudents() {
  // Side borders identify whose dashboard this is.
  document.documentElement.style.setProperty('--kid', config.students?.[state.studentId]?.color ?? 'transparent');
  $('#students').innerHTML = data.students.map((s) =>
    `<button type="button" role="tab" data-id="${esc(s.id)}" aria-selected="${s.id === state.studentId}">${esc(displayName(s))}</button>`).join('');
}

function renderTerms() {
  const keys = periodsOf();
  const cur = selectedPeriod();
  const el = $('#term');
  el.hidden = keys.length < 2;
  el.innerHTML = keys.map((k) => `<button type="button" data-period="${esc(k)}" aria-pressed="${k === cur}">
    ${esc(periodName(k))}<span class="muted">${periodIsFinal(k) ? ' · final' : ' · current'}</span></button>`).join('');
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
  const sel = selectedPeriod();
  const periodCard = periodIsFinal(sel)
    ? stat(`${esc(periodName(sel))} ended`, fmtDate(periodEnd(sel)), null, 'final grades')
    : gp ? stat(`${esc(gp.name)} ends`, fmtDate(gp.end), null,
      gp.days > 0 ? `${gp.days} day${gp.days === 1 ? '' : 's'} left` : gp.days === 0 ? 'today' : 'ended') : '';
  $('#summary').innerHTML = periodCard +
    stat('GPA', fmtGpa(w), fmtGpa(gpa(list, config, projected)), 'weighted') +
    stat('Unweighted', fmtGpa(u), fmtGpa(gpa(list, config, projected, { weighted: false })), '4.0 scale') +
    stat('Classes', list.length, null, !graded.length ? 'no grades yet' : below ? `<span class="t-C">${below} below B</span>` : 'all A/B') +
    stat('Missing', `<span class="${missing ? 't-F' : ''}">${missing}</span>`, null, `${remaining} open or expected`);
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
  const exp = cls.extraStart - cls.realCount;
  return `
  <div class="cls" data-id="${esc(cls.id)}">
    <a class="row" href="#class/${encodeURIComponent(cls.id)}">
      <div><div class="name">${esc(cls.name)}${lvl ? `<span class="level">${lvl}</span>` : ''}${missingCount(cls) ? `<span class="flag">${missingCount(cls)} missing</span>` : ''}</div>
        <div class="meta">${meta}${exp ? ` · ${exp} expected` : ''}</div></div>
      <div class="c-spark">${sparkline(timeline(cls))}</div>
      <div class="c-recent recent" title="Class grade from only the last ${recent?.count ?? 0} graded assignments, using the category weights">
        ${recent ? `<span class="t-${letter(recent.pct)}">${recent.pct.toFixed(0)}%</span> <span class="arrow">${arrow}</span>` : '—'}</div>
      <div class="c-now right">${pill(g.pct)}</div>
      ${state.whatIf.on ? `<div class="right">${pill(projected(cls))}</div>` : ''}
    </a>
  </div>`;
}

const STATUS = {
  graded: { label: 'Graded', tag: '' },
  missing: { label: 'Missing', tag: '<span class="flag">missing</span>' },
  open: { label: 'Open', tag: '<span class="chip">open</span>' },
  expected: { label: 'Expected', tag: '<span class="chip chip-exp">expected</span>' },
  whatif: { label: 'What-if', tag: '<span class="chip">what-if</span>' },
  exempt: { label: 'Exempt', tag: '<span class="tag">exempt</span>' },
  unscored: { label: 'Not scored', tag: '<span class="tag">not scored</span>' },
};
function statusOf(a) {
  if (a.extra != null) return 'whatif';
  if (a.expected) return 'expected';
  if (a.exempt) return a.unscored ? 'unscored' : 'exempt';
  if (a.missing) return 'missing';
  return a.score == null ? 'open' : 'graded';
}

function renderClassPage(cls) {
  const g = classGrade(cls);
  const ov = overridesFor(cls);
  const f = state.filters.get(cls.id) ?? { q: '', cat: '', status: '' };
  const gp = gradingPeriod();
  const lvl = { honors: 'Honors', ap: 'AP / Advanced' }[cls.level];

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

  const indexed = cls.assignments.map((a, i) => ({ a, i, st: statusOf(a) }));
  const remaining = indexed.filter(({ a }) => isRemaining(a));
  const open = remaining.filter(({ i }) => !ov.has(i));
  const openPts = open.reduce((n, { a }) => n + a.max, 0);
  const floor = project(cls, 0, ov), ceiling = project(cls, 100, ov);
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
    ? `Based on ${open.length} open, expected or what-if assignment${open.length === 1 ? '' : 's'} (${openPts} pts)${ov.size ? ', plus the scores you set' : ''}.
       Scoring 0–100% on ${open.length === 1 ? 'it' : 'them'} lands between <strong>${floor.toFixed(1)}%</strong> and <strong>${ceiling.toFixed(1)}%</strong>.`
    : 'No open work to plan against yet. Add expected assignments below.';

  const catAvg = new Map(g.byCategory.map((c) => [c.name, c.pct]));
  const cats = [...new Set(cls.assignments.map((a) => a.category).filter(Boolean))];
  const q = f.q.toLowerCase();
  const match = ({ a, st }) => (!f.cat || a.category === f.cat) && (!f.status || st === f.status) && (!q || a.name.toLowerCase().includes(q));
  const upcoming = remaining.filter(match).sort((x, y) => (x.a.date ?? '9999').localeCompare(y.a.date ?? '9999'));
  const past = indexed.filter((r) => !isRemaining(r.a) && match(r)).sort((x, y) => (y.a.date ?? '').localeCompare(x.a.date ?? ''));
  const counts = {};
  for (const { st } of indexed) counts[st] = (counts[st] ?? 0) + 1;

  const row = ({ a, i, st }) => {
    const pct = a.score != null && a.max ? (a.score / a.max) * 100 : null;
    const l = letter(pct);
    const tShort = cls.semester && termInfo(a.term)?.short;
    const late = (st === 'expected' || st === 'open') && a.date && a.date < today();
    const input = isRemaining(a) ? `<input class="pct-in ${ov.has(i) ? 'set' : ''}" type="number" min="0" max="120" step="1"
        data-act="override" data-i="${i}" ${a.extra != null ? `data-j="${a.extra}"` : ''} value="${ov.has(i) ? ov.get(i) : ''}"
        placeholder="${Math.round(assumedPct(cls))}" aria-label="Assumed % on ${esc(a.name)}">` : '';
    return `<tr class="st-${st}">
      <td class="nowrap muted">${fmtDate(a.date) || '—'}${tShort ? ` <span class="tag">${tShort}</span>` : ''}</td>
      <td>${esc(a.name)} ${STATUS[st].tag}${late ? ` <span class="tag">${st === 'expected' ? 'date passed; not in Aspen yet' : 'past due, ungraded'}</span>` : ''}
        ${a.note ? `<div class="tag">${esc(a.note)}</div>` : ''}
        <div class="tag cat-sm">${esc(a.category ?? '')}</div></td>
      <td class="hide-sm">${esc(a.category ?? '')}${isRemaining(a) && catAvg.get(a.category) != null ? ` <span class="tag">avg ${catAvg.get(a.category).toFixed(0)}%</span>` : ''}</td>
      <td class="num nowrap">${a.score != null ? `${fmtScore(a.score)} / ${a.max}` : `<span class="muted">${a.max} pts</span>`}</td>
      <td class="num">${l && !a.exempt ? `<span class="t-${l}">${pct.toFixed(0)}%</span>` : input}</td>
      <td class="num">${a.extra != null ? `<button type="button" class="link" data-act="remove-extra" data-j="${a.extra}" aria-label="Remove what-if">×</button>` : ''}</td>
    </tr>`;
  };
  const group = (title, rows, extra = '') => rows.length
    ? `<tr class="group"><td colspan="6">${title} <span class="muted">(${rows.length})</span>${extra}</td></tr>${rows.map(row).join('')}` : '';

  const weightedCats = g.weighted ? g.byCategory.map((c) => c.name) : [];
  const statusOpts = Object.entries(STATUS).filter(([k]) => counts[k])
    .map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v.label} (${counts[k]})</option>`).join('');

  return `
  <a class="back" href="#">← All classes</a>
  <header class="cp-head">
    <div>
      <h2>${esc(cls.name)}${lvl ? ` <span class="level">${lvl}</span>` : ''}</h2>
      <div class="meta">${[cls.teacher, periodLabel(cls)].filter(Boolean).map(esc).join(' · ')}${cls.final ? ` · ended ${fmtDate(termInfo(cls.term)?.end)}` : gp ? ` · ends ${fmtDate(gp.end)} (${gp.days} days)` : ''}</div>
    </div>
    <div class="cp-grades">
      <div><div class="col-h">Now</div>${pill(g.pct)}</div>
      ${remaining.length ? `<div><div class="col-h">Projected</div>${pill(projected(cls))}</div>` : ''}
      ${cls.reportedGrade != null ? `<div><div class="col-h">Aspen</div><span class="pill none">${cls.reportedGrade.toFixed(1)}</span></div>` : ''}
    </div>
  </header>
  ${cls.reportedGrade != null && g.pct != null && Math.abs(cls.reportedGrade - g.pct) > 0.5
    ? `<p class="note">Aspen shows ${cls.reportedGrade.toFixed(1)}%. This teacher may weight some assignments individually, so projections here are approximate.</p>` : ''}

  <div class="cp-top">
    <section class="card"><h3>Running grade</h3>${sparkline(timeline(cls), true)}</section>
    <section class="card">
      <h3>${g.weighted ? 'Category weights' : 'Grading'}</h3>
      <table><thead><tr><th>Category</th><th class="num">Weight</th><th class="num">Average</th><th class="num">#</th></tr></thead>
      <tbody>${catRows}</tbody></table>
      ${uncounted.length ? `<p class="note">Not counted toward the grade (0% weight): ${uncounted.map(esc).join(', ')}</p>` : ''}
    </section>
    <section class="card">
      <h3>What it takes to finish with…</h3>
      <table><tbody>${targets}</tbody></table>
      <p class="note">${targetNote}</p>
    </section>
  </div>

  <section class="card">
    <h3>All assignments</h3>
    <div class="filters">
      <input type="search" placeholder="Search assignments" value="${esc(f.q)}" data-act="q" aria-label="Search assignments">
      <select data-act="cat" aria-label="Category"><option value="">All categories</option>
        ${cats.map((c) => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select data-act="status" aria-label="Status"><option value="">All statuses</option>${statusOpts}</select>
    </div>
    <div class="table-scroll"><table class="asg">
      <thead><tr><th>Date</th><th>Assignment</th><th class="hide-sm">Category</th><th class="num">Score</th><th class="num">%</th><th></th></tr></thead>
      <tbody>
        ${group('Coming up', upcoming, ov.size ? ` · <button type="button" class="link" data-act="clear">clear scores</button>` : '')}
        ${group('Graded and past', past)}
        ${upcoming.length + past.length ? '' : '<tr><td colspan="6" class="muted">No matching assignments.</td></tr>'}
      </tbody></table></div>
    <p class="note">Type a % next to anything coming up to try a scenario. Blank ones assume ${state.whatIf.mode === 'recent' ? 'the recent average' : `${state.whatIf.pct}%`} (the What-if slider).</p>
  </section>

  <section class="card">
    <h3>Plan for work that isn't posted yet</h3>
    <form class="filters add-extra" data-act="add-extra">
      <input type="text" name="name" placeholder="Quick what-if (e.g. Unit 4 Test)" aria-label="Assignment name">
      ${weightedCats.length ? `<select name="category" aria-label="Category">${weightedCats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>` : ''}
      <input class="pct-in" type="number" name="max" min="1" step="1" value="100" aria-label="Points"> <span class="check">pts</span>
      <button type="submit" class="btn">Add what-if</button>
    </form>
    <p class="note">What-ifs stay in this browser only. To add an <strong>expected</strong> assignment that everyone sees and that stays until Aspen posts it, ask Claude or run:<br>
      <code>npm run expect -- add ${esc(cls.id)} "Unit 4 Test" --points 100${weightedCats.length ? ` --category "${esc(weightedCats[0])}"` : ''} --date 11/5</code></p>
  </section>`;
}

// ---------- calendar ----------

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fmtLong = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function calCell(b, label, attrs, extraClass = '') {
  if (!b) return `<div class="day none ${extraClass}"><span class="dnum">${label}</span></div>`;
  const l = letter(b.pct);
  return `<button type="button" class="day g-${l} ${extraClass}" ${attrs}
      title="${b.n} assignment${b.n === 1 ? '' : 's'}${b.missing ? `, ${b.missing} missing` : ''}">
    <span class="dnum">${label}</span><span class="dpct">${Math.round(b.pct)}%</span>
    <span class="dn">${b.n}${b.missing ? ' <span class="dmiss">•</span>' : ''}</span></button>`;
}

function renderCalendar() {
  const all = student().classes.map((c) => mergeClass(c, config));
  if (state.cal.classId && !all.some((c) => c.id === state.cal.classId)) state.cal.classId = '';
  const t = today();
  const picked = state.cal.classId ? all.filter((c) => c.id === state.cal.classId) : all;
  // Some teachers date standards scores at the end of the term; leave graded-but-future items out.
  let future = 0;
  const scope = picked.map((c) => ({ ...c, assignments: c.assignments.filter((a) => {
    const later = a.date > t && a.score != null && !a.exempt;
    if (later) future++;
    return !later;
  }) }));
  const { days, weeks } = aggregate(scope);
  const filter = `<select data-act="cal-class" aria-label="Class"><option value="">All classes</option>
    ${[...new Map(all.map((c) => [c.id, c])).values()].map((c) => `<option value="${esc(c.id)}" ${c.id === state.cal.classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
  const head = `<div class="cal-bar"><h2>Grades by due date</h2>${filter}</div>
    <p class="note">Each day is the plain average of every assignment due that day, with every assignment counting equally (points and category weights ignored). Missing work counts as 0%; exempt and ungraded work is left out. ▲/▼ compare a week with the one before.${future
      ? ` ${future} graded item${future === 1 ? ' is' : 's are'} dated in the future (often standards scores dated at term end) and ${future === 1 ? "isn't" : "aren't"} shown.` : ''}</p>`;
  if (!days.size) return `${head}<div class="empty">No graded work yet.</div>`;

  const first = [...days.keys()].sort()[0];
  const ranked = [...weeks.entries()].filter(([, b]) => b.n >= 3).sort((a, b) => a[1].pct - b[1].pct);
  const span = (k, b) => `<button type="button" class="link" data-act="cal-sel" data-kind="week" data-key="${k}">week of ${fmtDate(k)}</button> (${b.pct.toFixed(0)}%, ${b.n})`;
  const extremes = ranked.length >= 2
    ? `<p class="cal-ext">Strongest: ${span(...ranked[ranked.length - 1])} · Weakest: ${span(...ranked[0])}</p>` : '';

  const monthsHtml = monthsBetween(first, t).reverse().map((ym) => {
    const firstDay = `${ym}-01`;
    const lastDay = addDays(`${addDays(firstDay, 32).slice(0, 7)}-01`, -1); // day before the 1st of next month
    const rows = [];
    for (let mon = weekStart(firstDay); mon <= lastDay; mon = addDays(mon, 7)) {
      const cells = DOW.map((_, i) => {
        const d = addDays(mon, i);
        if (d.slice(0, 7) !== ym) return '<div class="day out"></div>';
        const cls = [d === t ? 'today' : '', d > t ? 'future' : '', i >= 5 ? 'wkend' : '',
          state.cal.sel?.kind === 'day' && state.cal.sel.key === d ? 'sel' : ''].join(' ');
        return calCell(days.get(d), Number(d.slice(8)), `data-act="cal-sel" data-kind="day" data-key="${d}"`, cls);
      }).join('');
      const w = weeks.get(mon), prev = weeks.get(addDays(mon, -7));
      const delta = w && prev ? w.pct - prev.pct : null;
      const arrow = delta == null ? '' : delta > 2 ? `<span class="wdelta up">▲${Math.round(delta)}</span>` : delta < -2 ? `<span class="wdelta down">▼${Math.round(-delta)}</span>` : '';
      const wsel = state.cal.sel?.kind === 'week' && state.cal.sel.key === mon ? 'sel' : '';
      const week = w
        ? `<button type="button" class="day week g-${letter(w.pct)} ${wsel}" data-act="cal-sel" data-kind="week" data-key="${mon}" title="Week of ${fmtDate(mon)}: ${w.n} assignments">
            <span class="dnum">Week</span><span class="dpct">${Math.round(w.pct)}%</span><span class="dn">${w.n} ${arrow}</span></button>`
        : '<div class="day week none"><span class="dnum">Week</span></div>';
      rows.push(cells + week);
    }
    const label = new Date(`${firstDay}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return `<section class="card cal-month"><h3>${label}</h3>
      <div class="cal-grid">${DOW.map((d, i) => `<div class="dow${i >= 5 ? ' wkend' : ''}">${d}</div>`).join('')}<div class="dow">Avg</div>${rows.join('')}</div></section>`;
  }).join('');

  // Detail for the selected day or week.
  let detail = '<p class="note">Click a day or a week to see the assignments behind it.</p>';
  const sel = state.cal.sel;
  const b = sel && (sel.kind === 'day' ? days.get(sel.key) : weeks.get(sel.key));
  if (b) {
    const title = sel.kind === 'day' ? fmtLong(sel.key) : `Week of ${fmtDate(sel.key)} – ${fmtDate(addDays(sel.key, 6))}`;
    const items = [...b.items].sort((x, y) => x.a.date.localeCompare(y.a.date) || x.pct - y.pct);
    detail = `<h3>${title}</h3>
      <div class="cal-sum">${pill(b.pct)} <span class="muted">${b.n} assignment${b.n === 1 ? '' : 's'}${b.missing ? ` · <span class="t-F">${b.missing} missing</span>` : ''}</span></div>
      <table><tbody>${items.map(({ classId, className, a, pct }) => `<tr>
        ${sel.kind === 'week' ? `<td class="nowrap muted">${fmtDate(a.date)}</td>` : ''}
        <td><a class="plain" href="#class/${encodeURIComponent(classId)}">${esc(className)}</a><div class="tag">${esc(a.name)}${a.missing ? ' <span class="flag">missing</span>' : ''}</div></td>
        <td class="num nowrap muted">${fmtScore(a.score)} / ${a.max}</td>
        <td class="num"><span class="t-${letter(pct)}">${Math.round(pct)}%</span></td></tr>`).join('')}</tbody></table>`;
  }
  const legend = `<div class="legend">${config.gradeScale.map((g) => `<span class="pill g-${g.letter}">${g.letter}</span>`).join('')}
    <span class="muted">daily average · • = includes missing work</span></div>`;
  return `${head}${extremes}<div class="cal-cols"><div>${legend}${monthsHtml}</div><aside class="card cal-detail">${detail}</aside></div>`;
}

function currentClassId() {
  const m = location.hash.match(/^#class\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function render() {
  const id = currentClassId();
  if (id && !student().classes.some((c) => c.id === id)) {
    const owner = data.students.find((s) => s.classes.some((c) => c.id === id));
    if (owner) { state.studentId = owner.id; renderStudents(); renderTerms(); }
  }
  let cls = id && student().classes.find((c) => c.id === id && periodOf(c) === selectedPeriod());
  if (id && !cls) {
    cls = student().classes.filter((c) => c.id === id).pop();
    if (cls) { state.periods[state.studentId] = periodOf(cls); renderTerms(); }
  }
  const page = $('#classpage');
  document.body.classList.toggle('on-class', Boolean(cls));
  page.hidden = !cls;
  if (cls) page.innerHTML = renderClassPage(prepare(cls));

  const onCal = location.hash === '#calendar';
  document.body.classList.toggle('on-cal', onCal);
  $('#calpage').hidden = !onCal;
  if (onCal) $('#calpage').innerHTML = renderCalendar();
  for (const a of document.querySelectorAll('#views a')) a.setAttribute('aria-current', String((a.getAttribute('href') === '#calendar') === onCal));

  const list = classes();
  renderSummary(list);
  $('#whatif').classList.toggle('on', state.whatIf.on);
  $('#whatif-recent').classList.toggle('active', state.whatIf.mode === 'recent');
  $('#whatif-out').textContent = state.whatIf.mode === 'recent' ? 'recent' : `${state.whatIf.pct}%`;
  const el = $('#classes');
  el.classList.toggle('whatif-active', state.whatIf.on);
  const head = `<div class="row head-row col-h" aria-hidden="true"><div>Class</div><div>Trend</div>
    <div class="right">Last ${config.recentCount ?? 5}</div><div class="right">Now</div>${state.whatIf.on ? '<div class="right">Projected</div>' : ''}</div>`;
  const none = list.length && !list.some(hasGrades)
    ? `<div class="empty-note">No grades posted for ${esc(periodName(selectedPeriod()))} yet.${periodsOf().length > 1 ? ' Earlier periods are in the toggle above.' : ''}</div>` : '';
  el.innerHTML = list.length ? none + head + list.map(renderRow).join('') : '<div class="empty">No classes for this period.</div>';

  const updated = data.updated ? new Date(data.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
  $('#foot').innerHTML = `<span>Updated ${esc(updated)}${data.source === 'sample' ? ' · sample data' : ''}</span>
    <span>${esc(student().school ?? '')}${store.get('passphrase') ? ' <button type="button" class="link" id="forget">Forget passphrase on this device</button>' : ''}</span>`;
  $('#forget')?.addEventListener('click', () => { store.set('passphrase', null); location.reload(); });
}

// Re-render the class page without losing focus in its search box.
function rerenderPage(focusSel) {
  render();
  if (!focusSel) return;
  const input = $(`#classpage ${focusSel}`);
  input?.focus();
  if (input?.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
}

// ---------- events ----------

$('#students').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  state.studentId = b.dataset.id;
  store.set('student', state.studentId);
  const url = new URL(location.href);
  url.searchParams.set('student', displayName(student()).toLowerCase());
  url.hash = location.hash === '#calendar' ? '#calendar' : '';
  state.cal = { classId: '', sel: null };
  history.replaceState(null, '', url);
  renderStudents();
  renderTerms();
  render();
});

$('#term').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-period]');
  if (!b) return;
  state.periods[state.studentId] = b.dataset.period;
  renderTerms();
  render();
});
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

const cp = $('#classpage');
const pageId = () => currentClassId();
const fil = (id) => {
  if (!state.filters.has(id)) state.filters.set(id, { q: '', cat: '', status: '' });
  return state.filters.get(id);
};

cp.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const id = pageId();
  if (t.dataset.act === 'clear') {
    for (const k of [...state.overrides.keys()]) if (k.startsWith(`${id}:`)) state.overrides.delete(k);
    for (const x of state.extras[id] ?? []) x.pct = null;
    saveExtras();
    render();
  } else if (t.dataset.act === 'remove-extra') {
    state.extras[id].splice(Number(t.dataset.j), 1);
    if (!state.extras[id].length) delete state.extras[id];
    saveExtras();
    render();
  }
});

cp.addEventListener('input', (e) => {
  if (e.target.dataset.act !== 'q') return;
  fil(pageId()).q = e.target.value;
  rerenderPage('input[data-act="q"]');
});

cp.addEventListener('change', (e) => {
  const t = e.target;
  const id = pageId();
  if (t.dataset.act === 'cat') { fil(id).cat = t.value; render(); }
  if (t.dataset.act === 'status') { fil(id).status = t.value; render(); }
  if (t.dataset.act === 'override') {
    const pct = t.value === '' ? null : Math.max(0, Math.min(120, Number(t.value)));
    if (t.dataset.j != null) {
      state.extras[id][Number(t.dataset.j)].pct = pct;
      saveExtras();
    } else {
      const key = `${id}:${t.dataset.i}`;
      if (pct == null) state.overrides.delete(key); else state.overrides.set(key, pct);
    }
    render();
  }
});

cp.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-act="add-extra"]');
  if (!form) return;
  e.preventDefault();
  const id = pageId();
  const fd = new FormData(form);
  const max = Number(fd.get('max'));
  if (!(max > 0)) return;
  const category = fd.get('category') ?? null;
  (state.extras[id] ??= []).push({ name: String(fd.get('name') || '').trim() || `What-if ${category ?? 'assignment'}`, category, max, pct: null });
  saveExtras();
  render();
});

const calEl = $('#calpage');
calEl.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act="cal-sel"]');
  if (!t) return;
  const same = state.cal.sel?.kind === t.dataset.kind && state.cal.sel.key === t.dataset.key;
  state.cal.sel = same ? null : { kind: t.dataset.kind, key: t.dataset.key };
  render();
  if (state.cal.sel && innerWidth < 1100) $('#calpage .cal-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
calEl.addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'cal-class') return;
  state.cal = { classId: e.target.value, sel: null };
  render();
});

load().catch((err) => {
  $('#classes').innerHTML = `<div class="empty">Couldn't load grades: ${esc(err.message)}</div>`;
});
