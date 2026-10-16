// Expected assignments: work you know is coming that Aspen doesn't list yet.
// Stored in site/expected.json as { "<class id>": [{ name, category, max, date, note }] }.
// Shared by the dashboard and `npm run expect`.

/** Loose name key so "Unit 3 Test" matches "unit 3 test" or "Unit-3 Test". */
export const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Split a class's expected list into items still pending and items Aspen has now posted
 * (same name, compared loosely). `assignments` must be the scraped ones only.
 */
export function splitExpected(assignments, list = []) {
  const posted = new Set(assignments.map((a) => nameKey(a.name)));
  const pending = [], matched = [];
  for (const e of list) (posted.has(nameKey(e.name)) ? matched : pending).push(e);
  return { pending, matched };
}

/** Pending expected items as assignment objects (ungraded, so they count as remaining work). */
export function expectedAssignments(assignments, list) {
  return splitExpected(assignments, list).pending.map((e) => ({
    name: e.name,
    category: e.category ?? null,
    max: e.max,
    date: e.date ?? null,
    ...(e.note ? { note: e.note } : {}),
    score: null,
    expected: true,
  }));
}
