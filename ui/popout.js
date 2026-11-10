// The todo pop-out window: a draggable, resizable card with its own "keep on top" pin.
// Shares tasks with the island through todos.json (Rust emits "todos" to the other windows on every save).
(async () => {
const T = window.__TAURI__;
const invoke = (c, a) => T.core.invoke(c, a);
const win = T.window.getCurrentWindow();
const { h, ic, paint, Todo, TodoUI } = window;

let doc = Todo.normalize(null), view = "days", root = null, day = Todo.localISO(new Date());
const ui = { addDate: null, sel: null, month: null };
const load = async () => { try { return Todo.normalize(JSON.parse(await invoke("load_todos"))); } catch (_) { return Todo.normalize(null); } };
const save = () => invoke("save_todos", { text: JSON.stringify(doc) });
const same = (a, b) => JSON.stringify(a.tasks) === JSON.stringify(b.tasks);
// take a newer document; re-render only when the tasks differ (geometry saves must not redraw)
function take(next) {
  const changed = !same(doc, next);
  doc = next;
  pin.classList.toggle("on", doc.win.top);
  if (changed && !TodoUI.dragging && root) root.refresh();
}

const ctx = { get: () => doc.tasks, set: (n) => { doc.tasks = n; save(); }, ui };
const title = h("span", { class: "ttl", "data-tauri-drag-region": "" }, "Todo");
const swap = h("button", { class: "ibtn", onclick: () => { view = view === "days" ? "plan" : "days"; build(); } });
const pin = h("button", { class: "ibtn pinbtn", title: "Keep on top", onclick: async () => {
  doc.win.top = !doc.win.top;
  pin.classList.toggle("on", doc.win.top);
  await invoke("todo_top", { on: doc.win.top });
  save();
} }, ic("pin", 15));
const body = h("div", { class: "pbody" });

async function close() {
  clearTimeout(geoT);
  const cur = await load(); // keep the newest tasks, only flip the flag
  cur.win = { ...cur.win, open: false };
  doc = cur;
  await save();
  await invoke("todo_window", { open: false });
}

function build() {
  root = view === "days" ? TodoUI.days(ctx) : TodoUI.plan(ctx);
  body.replaceChildren(root);
  title.textContent = view === "days" ? "Todo" : "Plan";
  swap.title = view === "days" ? "Month plan" : "Todo list";
  swap.replaceChildren(ic(view === "days" ? "calendar" : "checkbox", 17));
}

// position and size are remembered (position in physical pixels, size in logical ones)
let geoT = 0;
function geo() {
  clearTimeout(geoT);
  geoT = setTimeout(async () => {
    const [p, s, sf] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
    const cur = await load();
    cur.win = { ...cur.win, x: p.x, y: p.y, w: Math.round(s.width / sf), h: Math.round(s.height / sf) };
    take(cur);
    save();
  }, 500);
}

// resize grip. Done by hand: strip_frame removes WS_THICKFRAME (the title-bar flash fix), which can break the native resize drag
const grip = h("div", { class: "grip", title: "Resize" });
grip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const sx = e.screenX, sy = e.screenY, w0 = innerWidth, h0 = innerHeight, Size = (T.dpi || T.window).LogicalSize;
  let raf = 0, next = null;
  const move = (ev) => {
    if (!grip.hasPointerCapture(ev.pointerId)) return;
    next = new Size(Math.max(280, w0 + ev.screenX - sx), Math.max(240, h0 + ev.screenY - sy));
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; win.setSize(next).catch(() => {}); });
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", () => grip.removeEventListener("pointermove", move), { once: true });
});
document.getElementById("pop").append(
  h("div", { class: "hdr", "data-tauri-drag-region": "" },
    h("div", { class: "l", "data-tauri-drag-region": "" }, title),
    h("div", { class: "r" }, swap, pin, h("button", { class: "ibtn", title: "Close", onclick: close }, ic("x", 17)))),
  body, grip);

let cfg = null;
try { cfg = JSON.parse(await invoke("load_config")); } catch (_) {}
paint((cfg && cfg.settings) || {});
doc = await load();
pin.classList.toggle("on", doc.win.top);
build();
await invoke("todo_ready");

T.event.listen("cfg", (e) => { try { paint(JSON.parse(e.payload.text).settings || {}); } catch (_) {} });
T.event.listen("todos", (e) => { if (e.payload.from !== "todo") take(Todo.normalize(JSON.parse(e.payload.text))); });
win.onMoved(geo);
win.onResized(geo);
win.onCloseRequested((e) => { e.preventDefault(); close(); });
setInterval(() => { const d = Todo.localISO(new Date()); if (d !== day) { day = d; root.refresh(); } }, 60000);
document.addEventListener("contextmenu", (e) => e.preventDefault());
})();
