// run: node test/todo.test.js
const assert = require("node:assert/strict");
const T = require("../ui/todo.js");

// dates
assert.equal(T.shiftDay("2024-01-31", 1), "2024-02-01");
assert.equal(T.shiftDay("2024-03-01", -1), "2024-02-29");
assert.equal(T.shiftDay("2023-03-01", -1), "2023-02-28");
assert.equal(T.shiftDay("2023-12-31", 1), "2024-01-01");
assert.equal(T.shiftDay("2024-01-15", 30), "2024-02-14");
assert.equal(T.localISO(new Date(2024, 0, 1, 0, 30)), "2024-01-01");
assert.equal(T.localISO(new Date(2024, 11, 31, 23, 59)), "2024-12-31");
assert.equal(T.parse("2024-05-09").getDate(), 9);

// add / toggle / remove
let tasks = [];
let r = T.add(tasks, "  write tests ", "2024-05-01");
assert.equal(r.task.text, "write tests");
tasks = r.tasks;
tasks = T.add(tasks, "ship", "2024-05-02").tasks;
assert.equal(T.add(tasks, "   ", "2024-05-01"), null);
assert.equal(tasks.length, 2);
assert.equal(T.byDate(tasks, "2024-05-01").length, 1);
assert.equal(T.byDate(tasks, "2024-05-03").length, 0);
const a = tasks[0].id;
tasks = T.toggle(tasks, a);
assert.equal(tasks[0].done, true);
assert.equal(T.toggle(tasks, "nope"), null);
tasks = T.toggle(tasks, a);
assert.equal(tasks[0].done, false);
assert.equal(T.remove(tasks, "nope"), null);
tasks = T.remove(tasks, a);
assert.equal(tasks.length, 1);

// rename
const base = [
  { id: "a", text: "A", date: "d1", done: false },
  { id: "b", text: "B", date: "d1", done: false },
  { id: "c", text: "C", date: "d1", done: false },
  { id: "x", text: "X", date: "d2", done: false },
];
let t = T.rename(base, "a", "  Alpha ");
assert.equal(t[0].text, "Alpha");
assert.equal(base[0].text, "A", "input not mutated");
assert.equal(T.rename(base, "a", "   "), null);
assert.equal(T.rename(base, "nope", "z"), null);
assert.equal(T.rename(base, "a", "A"), null);

// move
const order = (ts, d) => T.byDate(ts, d).map((x) => x.id).join("");
t = T.move(base, "c", "d1", "a");
assert.equal(order(t, "d1"), "cab");
t = T.move(t, "c", "d1", null);
assert.equal(order(t, "d1"), "abc");
t = T.move(t, "a", "d1", "c");
assert.equal(order(t, "d1"), "bac");
assert.equal(T.move(t, "c", "d1", null), null);
assert.equal(T.move(t, "b", "d1", "a"), null);
assert.equal(T.move(t, "a", "d1", "a"), null);
assert.equal(T.move(t, "nope", "d1", null), null);
t = T.move(t, "b", "d2", "x");
assert.equal(order(t, "d2"), "bx");
assert.equal(order(t, "d1"), "ac");
t = T.move(t, "a", "d2", null);
assert.equal(order(t, "d2"), "bxa");
t = T.move(t, "c", "d3", null);
assert.equal(order(t, "d3"), "c");
assert.equal(T.byDate(t, "d3")[0].date, "d3");
assert.equal(t[t.length - 1].id, "c", "an empty day goes to the end of the list");
t = T.move(t, "x", "d2", "c"); // beforeId on another date: end of the day
assert.equal(order(t, "d2"), "bax");
t = T.move(t, "b", "d2", "ghost");
assert.equal(order(t, "d2"), "axb");
assert.equal(t.length, 4);

// carry
const cr = [
  { id: "1", text: "one", date: "y", done: false },
  { id: "2", text: "two", date: "y", done: true },
  { id: "3", text: "three", date: "y", done: false },
  { id: "4", text: "today", date: "t", done: false },
];
let c = T.carry(cr, "y", "t");
assert.equal(order(c, "y"), "2", "done tasks stay");
assert.equal(order(c, "t"), "413", "open ones go to the end of the target day");
assert.equal(T.carry(c, "y", "t"), null, "nothing open left");
assert.equal(T.carry(cr, "t", "t"), null);
assert.equal(T.carry(cr, "empty", "t"), null);
assert.deepEqual(T.openCounts(cr), { y: 2, t: 1 });

// month grid
let g = T.monthGrid(2026, 10); // November 2026 starts on a Sunday
assert.equal(g.length, 42);
assert.equal(g[0], "2026-10-26");
assert.equal(g[6], "2026-11-01");
assert.equal(g[g.length - 1], "2026-12-06");
g = T.monthGrid(2026, 1); // February 2026 starts on Sunday, 28 days
assert.equal(g.length, 35);
g = T.monthGrid(2027, 1); // February 2027 starts on Monday, 28 days
assert.equal(g.length, 28);
assert.equal(g[0], "2027-02-01");

// import / export
const good = { id: "i1", text: " hi ", date: "2024-02-29", done: false };
assert.equal(T.isTask(good), true);
assert.equal(T.isTask({ ...good, date: "2023-02-29" }), false);
assert.equal(T.isTask({ ...good, text: "  " }), false);
assert.equal(T.isTask({ ...good, done: "no" }), false);
assert.equal(T.isTask(null), false);
let p = T.parseImport(JSON.stringify([good, { bad: 1 }, good]));
assert.equal(p.tasks.length, 1);
assert.equal(p.tasks[0].text, "hi");
assert.equal(p.skipped, 2);
p = T.parseImport(JSON.stringify({ app: "ducktiv", version: 1, tasks: [good] })); // ducktiv export
assert.equal(p.tasks.length, 1);
p = T.parseImport(T.exportJSON([good]));
assert.equal(p.tasks[0].id, "i1");
assert.throws(() => T.parseImport("{}"));
assert.throws(() => T.parseImport("nope"));
const m = T.mergeTasks([{ ...good, text: "old" }, { id: "z", text: "z", date: "2024-01-01", done: false }], [{ ...good, text: "new" }, { id: "n", text: "n", date: "2024-01-02", done: true }]);
assert.deepEqual(m.map((x) => x.id), ["i1", "z", "n"]);
assert.equal(m[0].text, "new");

// stored doc
assert.deepEqual(T.normalize(null).tasks, []);
assert.deepEqual(T.normalize({ tasks: "x" }).tasks, []);
assert.equal(T.normalize({ tasks: [good, { id: 1 }] }).tasks.length, 1);
assert.equal(T.normalize(undefined).win.w, 340);
assert.equal(T.normalize({ win: { w: 400, top: false } }).win.top, false);
assert.equal(T.normalize({ win: { w: 400 } }).win.h, 480);

console.log("ok");
