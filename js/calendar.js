// Calendar aggregation: every graded assignment counts equally (mean of score/max), grouped by
// due date and by week. Missing work counts as 0%; exempt, unscored and ungraded work is left out.
// Pure: no DOM. Shared by the dashboard and the tests.

/** Monday of the week containing `iso` (YYYY-MM-DD), as YYYY-MM-DD. */
export function weekStart(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const counts = (a) => !a.exempt && a.score != null && a.max > 0 && a.date;

/**
 * @param classes [{ id, name, assignments }]
 * @returns {{ days: Map<date, Bucket>, weeks: Map<monday, Bucket> }}
 *   Bucket = { pct, n, missing, items: [{ classId, className, a, pct }] }
 */
export function aggregate(classes) {
  const days = new Map(), weeks = new Map();
  const add = (map, key, item) => {
    const b = map.get(key) ?? { sum: 0, n: 0, missing: 0, items: [] };
    b.sum += item.pct; b.n += 1; b.missing += item.a.missing ? 1 : 0; b.items.push(item);
    map.set(key, b);
  };
  for (const c of classes) {
    for (const a of c.assignments) {
      if (!counts(a)) continue;
      const item = { classId: c.id, className: c.name, a, pct: (a.score / a.max) * 100 };
      add(days, a.date, item);
      add(weeks, weekStart(a.date), item);
    }
  }
  for (const map of [days, weeks]) for (const b of map.values()) b.pct = b.sum / b.n;
  return { days, weeks };
}

/** Months (YYYY-MM) from the first dated item through `until`, inclusive. */
export function monthsBetween(firstIso, untilIso) {
  const out = [];
  let [y, m] = firstIso.slice(0, 7).split('-').map(Number);
  const [ey, em] = untilIso.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
