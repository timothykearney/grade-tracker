// Pure grade math: no DOM. Shared by the dashboard and the tests.

/** Assignments that count toward the grade right now. */
const isGraded = (a) => !a.exempt && a.score != null && a.max > 0;
/** Assignments still to come (no score yet). */
export const isRemaining = (a) => !a.exempt && a.score == null && a.max > 0;

/**
 * Merge scraped class data with the user's config overrides.
 * Config may set: level, credits, excludeFromGpa, categories (weights).
 */
export function mergeClass(cls, config) {
  const o = config.classes?.[cls.id] ?? {};
  return {
    level: 'regular',
    credits: 1,
    excludeFromGpa: false,
    ...cls,
    ...o,
    categories: o.categories ?? cls.categories ?? [],
  };
}

/**
 * Compute a class percentage.
 * `scores` optionally overrides assignment scores by index (used for what-if scenarios),
 * so ungraded assignments can be filled with hypothetical results.
 *
 * Weighted classes: each category's pct = earned / possible, then the weighted mean of
 * categories that have at least one graded assignment (weights re-normalised, as Aspen does).
 * Classes with no category weights are total-points.
 */
export function classGrade(cls, scores = null) {
  const weights = new Map(cls.categories.filter((c) => c.weight > 0).map((c) => [c.name, c.weight]));
  const weighted = weights.size > 0;
  const cats = new Map();

  cls.assignments.forEach((a, i) => {
    const score = scores?.has(i) ? scores.get(i) : a.score;
    if (a.exempt || score == null || !(a.max > 0)) return;
    const key = weighted ? a.category : 'All';
    if (weighted && !weights.has(key)) return; // category with 0 weight doesn't count
    const c = cats.get(key) ?? { name: key, earned: 0, possible: 0, count: 0 };
    c.earned += score;
    c.possible += a.max;
    c.count += 1;
    cats.set(key, c);
  });

  let pct = null;
  if (weighted) {
    let wSum = 0, acc = 0;
    for (const [name, w] of weights) {
      const c = cats.get(name);
      if (!c) continue;
      acc += w * (c.earned / c.possible);
      wSum += w;
    }
    if (wSum > 0) pct = (acc / wSum) * 100;
  } else {
    const c = cats.get('All');
    if (c) pct = (c.earned / c.possible) * 100;
  }

  const byCategory = weighted
    ? [...weights].map(([name, weight]) => {
        const c = cats.get(name);
        return { name, weight, count: c?.count ?? 0, pct: c ? (c.earned / c.possible) * 100 : null };
      })
    : [{ name: 'Total points', weight: null, count: cats.get('All')?.count ?? 0, pct }];

  return { pct, weighted, byCategory };
}

export function letterFor(pct, scale) {
  if (pct == null) return null;
  const r = Math.round(pct * 100) / 100; // avoid 89.99999 float noise
  return (scale.find((s) => r >= s.min) ?? scale[scale.length - 1]).letter;
}

/** GPA across classes. `pctOf(cls)` returns that class's percentage (current or projected). */
export function gpa(classes, config, pctOf, { weighted = true } = {}) {
  let pts = 0, cr = 0;
  for (const cls of classes) {
    if (cls.excludeFromGpa || !(cls.credits > 0)) continue;
    const pct = pctOf(cls);
    if (pct == null) continue;
    const scaleName = weighted ? cls.level : config.unweightedScale;
    const scale = config.gpaScales[scaleName] ?? config.gpaScales[config.unweightedScale];
    pts += scale[letterFor(pct, config.gradeScale)] * cls.credits;
    cr += cls.credits;
  }
  return cr > 0 ? pts / cr : null;
}

/** Running class grade after each graded date: [{date, pct}]. */
export function timeline(cls) {
  const graded = cls.assignments
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => isGraded(a) && a.date)
    .sort((x, y) => x.a.date.localeCompare(y.a.date));
  const out = [];
  const included = new Map();
  const blank = new Map(cls.assignments.map((_, i) => [i, null]));
  for (let k = 0; k < graded.length; k++) {
    included.set(graded[k].i, graded[k].a.score);
    if (k + 1 < graded.length && graded[k + 1].a.date === graded[k].a.date) continue;
    const scores = new Map([...blank, ...included]);
    out.push({ date: graded[k].a.date, pct: classGrade(cls, scores).pct });
  }
  return out;
}

/**
 * Rolling average: mean percentage of the last `n` graded assignments, compared with the
 * class grade before them. Returns { pct, delta } or null.
 */
export function recentAverage(cls, n) {
  const graded = cls.assignments.filter((a) => isGraded(a) && a.date).sort((x, y) => x.date.localeCompare(y.date));
  if (graded.length === 0) return null;
  const last = graded.slice(-n);
  const pct = (last.reduce((s, a) => s + a.score / a.max, 0) / last.length) * 100;
  return { pct, count: last.length };
}

/**
 * Projected grade if remaining assignments get `defaultPct`, except those in `overrides`
 * (Map index -> pct). With no remaining work this equals the current grade.
 */
export function project(cls, defaultPct, overrides = new Map()) {
  const scores = new Map();
  cls.assignments.forEach((a, i) => {
    if (!isRemaining(a)) return;
    const p = overrides.has(i) ? overrides.get(i) : defaultPct;
    if (p != null) scores.set(i, (p / 100) * a.max);
  });
  return classGrade(cls, scores).pct;
}

/**
 * The average % needed on remaining (non-overridden) work to finish at or above `target`.
 * Returns { pct } (may be <= 0 if already locked in), or { impossible: true }, or null if
 * there is no remaining work to change the outcome.
 */
export function neededFor(cls, target, overrides = new Map()) {
  const free = cls.assignments.some((a, i) => isRemaining(a) && !overrides.has(i));
  if (!free) return null;
  const at = (p) => project(cls, p, overrides);
  if (at(0) >= target) return { pct: 0, locked: true };
  if (at(100) < target) return { impossible: true };
  let lo = 0, hi = 100;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target) hi = mid; else lo = mid;
  }
  return { pct: hi };
}
