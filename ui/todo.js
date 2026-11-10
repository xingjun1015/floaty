// Pure todo logic (no DOM). Every mutator takes the tasks array and returns a NEW array,
// or null when nothing would change, so callers skip the write.
// Order within a day is the order of the array. Dates are local "YYYY-MM-DD" strings.
(() => {
const Todo = {};
const pad = (n) => String(n).padStart(2, "0");

Todo.localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// local-time constructor with day overflow; never parse a date-only string with new Date(str) (that is UTC)
Todo.parse = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
Todo.shiftDay = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return Todo.localISO(new Date(y, m - 1, d + n)); };

Todo.add = (tasks, text, date) => {
  text = String(text).trim();
  if (!text) return null;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const task = { id, text, date, done: false };
  return { tasks: [...tasks, task], task };
};
Todo.toggle = (tasks, id) => (tasks.some((t) => t.id === id) ? tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) : null);
Todo.rename = (tasks, id, text) => {
  text = String(text).trim();
  const t = tasks.find((x) => x.id === id);
  if (!text || !t || t.text === text) return null;
  return tasks.map((x) => (x === t ? { ...x, text } : x));
};
// beforeId null, missing, or on another date means the end of that day
Todo.move = (tasks, id, date, beforeId = null) => {
  const t = tasks.find((x) => x.id === id);
  if (!t || beforeId === id) return null;
  const rest = tasks.filter((x) => x !== t);
  let i = beforeId == null ? -1 : rest.findIndex((x) => x.id === beforeId && x.date === date);
  if (i < 0) {
    i = rest.findLastIndex((x) => x.date === date) + 1;
    if (i === 0) i = rest.length;
  }
  const next = [...rest.slice(0, i), { ...t, date }, ...rest.slice(i)];
  if (t.date === date && next.every((x, k) => x.id === tasks[k].id)) return null;
  return next;
};
Todo.remove = (tasks, id) => (tasks.some((t) => t.id === id) ? tasks.filter((t) => t.id !== id) : null);
// open tasks of day `from` go to the end of day `to`
Todo.carry = (tasks, from, to) => {
  if (from === to || !tasks.some((t) => t.date === from && !t.done)) return null;
  const moved = tasks.filter((t) => t.date === from && !t.done).map((t) => ({ ...t, date: to }));
  return [...tasks.filter((t) => !(t.date === from && !t.done)), ...moved];
};
Todo.byDate = (tasks, date) => tasks.filter((t) => t.date === date);
Todo.openCounts = (tasks) => { const o = {}; for (const t of tasks) if (!t.done) o[t.date] = (o[t.date] || 0) + 1; return o; };

// Monday-first grid of ISO dates for a month (m is 0-based): 5 or 6 rows of 7
Todo.monthGrid = (y, m) => {
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const rows = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7);
  return Array.from({ length: rows * 7 }, (_, i) => Todo.localISO(new Date(y, m, 1 - lead + i)));
};

// ---- import / export / validation
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const validDate = (s) => {
  const m = typeof s === "string" && ISO.exec(s);
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
};
Todo.isTask = (t) => !!t && typeof t === "object" && typeof t.id === "string" && t.id !== "" &&
  typeof t.text === "string" && t.text.trim() !== "" && validDate(t.date) && typeof t.done === "boolean";
Todo.exportJSON = (tasks) => JSON.stringify({ app: "floaty-todo", version: 1, tasks }, null, 2);
// accepts the export envelope (Floaty or ducktiv) or a bare array; throws on anything else.
// Rows that are not valid tasks, and duplicate ids (last wins), count as skipped.
Todo.parseImport = (text) => {
  const v = JSON.parse(text);
  const rows = Array.isArray(v) ? v : v && Array.isArray(v.tasks) ? v.tasks : null;
  if (!rows) throw new Error("No task list found");
  const byId = new Map();
  for (const r of rows) if (Todo.isTask(r)) byId.set(r.id, { id: r.id, text: r.text.trim(), date: r.date, done: r.done });
  return { tasks: [...byId.values()], skipped: rows.length - byId.size };
};
// incoming wins on equal id, existing order kept, new ids appended
Todo.mergeTasks = (existing, incoming) => {
  const inc = new Map(incoming.map((t) => [t.id, t]));
  const seen = new Set();
  const out = existing.map((t) => { const n = inc.get(t.id); if (!n) return t; seen.add(t.id); return n; });
  return [...out, ...incoming.filter((t) => !seen.has(t.id))];
};

// ---- stored document: { v, tasks, win }. A missing or corrupt file gives an empty doc.
Todo.WIN = { open: false, x: null, y: null, w: 340, h: 480, top: true };
Todo.normalize = (raw) => {
  const r = raw && typeof raw === "object" ? raw : {};
  const win = { ...Todo.WIN, ...(r.win && typeof r.win === "object" ? r.win : {}) };
  return { v: 1, tasks: Array.isArray(r.tasks) ? r.tasks.filter(Todo.isTask) : [], win };
};

if (typeof module === "object") module.exports = Todo; else window.Todo = Todo;
})();
