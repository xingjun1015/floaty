(() => {
const T = window.__TAURI__;
const invoke = (c, a) => T.core.invoke(c, a);
const listen = T.event.listen;
const LABEL = T.window.getCurrentWindow().label;

const EXP_W = 340;
const MAX_PINS = 8;
const DEFAULTS = {
  dock: "b", screen: "0", opacity: 85, theme: "glass", accent: "#0a84ff", sysAccent: false, maxRows: 3,
  onTop: true, outside: true, autostart: false, autohide: false, hideFs: true, collapsed: false,
  widgets: { clock: true, battery: false, media: false, clip: false, timer: true, todo: false },
};
const ANCHOR = { tl: ["l", "t"], t: ["c", "t"], tr: ["r", "t"], l: ["l", "m"], r: ["r", "m"], bl: ["l", "b"], b: ["c", "b"], br: ["r", "b"] };
const DOCK_NAME = { tl: "Top left", t: "Top", tr: "Top right", l: "Left", r: "Right", bl: "Bottom left", b: "Bottom", br: "Bottom right" };
const KIND_HUE = { folder: 195, url: 345, cmd: 135, snippet: 280, group: 45 };
const SWATCHES = ["#0a84ff", "#bf5af2", "#ff375f", "#ff9f0a", "#30d158", "#64d2ff"];
const ITEM_COLORS = ["#ff453a", "#ff9f0a", "#ffd60a", "#30d158", "#64d2ff", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#8e8e93"];
const ICON_CHOICES = ["folder", "file", "file-text", "photo", "app-window", "link", "terminal-2", "clipboard", "folders", "music", "bolt", "clock", "home", "star", "heart", "mail", "calendar", "camera", "code", "database", "device-desktop", "download", "upload", "globe", "headphones", "key", "lock", "map-pin", "message-circle", "movie", "notebook", "phone", "printer", "rocket", "server", "shopping-cart", "tool", "user", "video", "wifi", "briefcase", "book", "bookmark", "bulb", "cloud", "coffee", "cpu", "flame", "brand-github", "brand-chrome", "brand-spotify", "brand-discord", "brand-slack", "brand-whatsapp", "brand-youtube", "brand-vscode", "brand-figma", "brand-notion", "brand-telegram"];

let cfg, view = "quick", stack = [], query = "", editing = false, addKind = "url", addTo = null;
let sm = null, smQ = "", msg = "", msgT = 0, clips = [], media = null, running = new Set(), batt = null, monList = [];
let reordering = false, hideTimer = 0, tick = 0, dialogOpen = false;
// todo module (off unless widgets.todo): the document lives in todos.json, see todoLoad()
let todo = null, todoRoot = null, todoDay = "", todoImp = null, todoBox = null;
const tdUi = { addDate: null, sel: null, month: null };
const tm = { total: 300, left: 300, running: false, end: 0, ring: false };

const $ = (id) => document.getElementById(id);
const isl = $("isl"), inn = $("in"), meas = $("meas");
let cur = null, curW = 0, swapT = 0, gridHold = null;

// ------------------------------------------------------------ helpers
const { h, ic, Todo, TodoUI } = window, paintLook = window.paint;
const uid = () => crypto.randomUUID();
const ext = (p) => (p.split(".").pop() || "").toLowerCase();
const prof = () => cfg.profiles.find((p) => p.id === cfg.active) || cfg.profiles[0];
const S = () => cfg.settings;
const isVert = () => ["l", "r"].includes(S().dock);
const fmt = (s) => { const m = Math.floor(s / 60), r = s % 60; return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r; };
const clock = () => new Date().toLocaleTimeString([], isVert() ? { hour: "2-digit", minute: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit" });
let saveT = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => invoke("save_config", { text: JSON.stringify(cfg) }), 400); };

function merge(raw) {
  const c = raw && raw.profiles ? raw : {};
  const s = c.settings || {};
  c.settings = { ...DEFAULTS, ...s, widgets: { ...DEFAULTS.widgets, ...(s.widgets || {}) } };
  if (!c.profiles || !c.profiles.length) c.profiles = [{ id: uid(), name: "Main", items: [] }];
  if (!c.profiles.some((p) => p.id === c.active)) c.active = c.profiles[0].id;
  return c;
}
function findItem(id, list = prof().items) {
  for (const it of list) {
    if (it.id === id) return { it, list };
    if (it.children) { const r = findItem(id, it.children); if (r) return r; }
  }
  return null;
}
function flat(list, out = []) {
  for (const it of list) { out.push(it); if (it.children) flat(it.children, out); }
  return out;
}
function iconName(it) {
  if (it.icon && (window.ICONS || {})[it.icon]) return it.icon;
  if (it.kind === "file") {
    const e = ext(it.path);
    if (["txt", "md", "log"].includes(e)) return "file-text";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "photo";
    if (e === "pdf") return "file-type-pdf";
    if (["zip", "7z", "rar"].includes(e)) return "file-zip";
  }
  return { folder: "folder", app: "app-window", url: "link", cmd: "terminal-2", snippet: "clipboard", group: "folders" }[it.kind] || "file";
}
function colors(it) {
  if (it.color) return { bg: `color-mix(in srgb, ${it.color} 38%, transparent)`, fg: `color-mix(in srgb, ${it.color} 45%, white)` };
  if (it.kind === "file") return { bg: "rgba(255,255,255,.25)", fg: "#fff" };
  let hue = KIND_HUE[it.kind];
  if (hue == null) { hue = 0; for (const c of it.name) hue = (hue * 31 + c.charCodeAt(0)) % 360; }
  return { bg: `hsla(${hue},75%,55%,.34)`, fg: `hsl(${hue},100%,80%)` };
}
const isTyping = () => ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement && document.activeElement.tagName);

// ------------------------------------------------------------ look + native
function applyLook() {
  const s = S();
  paintLook(s);
  const [ah, av] = ANCHOR[s.dock];
  if (isl.dataset.h !== ah || isl.dataset.v !== av) { unclip(); clipLater(); } // the island moves inside the window
  [isl.dataset.h, isl.dataset.v] = [ah, av];
}
const native = {
  dock: () => invoke("set_dock", { dock: S().dock }),
  onTop: () => invoke("set_on_top", { on: S().onTop }),
  hideFs: () => invoke("set_hide_fs", { on: S().hideFs }),
  autostart: () => invoke("set_autostart", { on: S().autostart }).catch(() => {}),
};

// ------------------------------------------------------------ island morph engine
// Build content -> measure it offscreen -> animate the island to that size -> swap content.
// The OS window never resizes here: it is a fixed transparent canvas (a resized WebView2 shows
// stale, shifted or clipped frames). A window region limits painting and clicks to the island once
// it settles, and is lifted before the island grows past it.
const WIN_W = 520; // widest pill: MAX_PINS pins + "+N" + timer
let seq = 0, islW = 0, islH = 0, clipT = 0, clipped = false;
let clipKey = "";
function unclip() {
  clearTimeout(clipT); clipT = setTimeout(applyClip, 750); clipKey = ""; // always re-clipped later
  if (!clipped) return null;
  clipped = false;
  return invoke("clip", { rect: null }).catch(() => {});
}
const morphing = () => isl.getAnimations().some((a) => a instanceof CSSTransition);
// measure the settled island and clip the window to it; never from a mid-transition frame, which would
// leave a stale, oversized region that swallows clicks meant for the desktop
function applyClip() {
  if (morphing()) { clipT = setTimeout(applyClip, 100); return; }
  clipT = 0;
  const r = isl.getBoundingClientRect(), p = 6; // room for the shadow
  const rect = [r.left - p, r.top - p, r.width + 2 * p, r.height + 2 * p], key = rect.join();
  if (clipped && key === clipKey) return;
  clipped = true; clipKey = key;
  invoke("clip", { rect }).catch(() => { clipped = false; clipKey = ""; });
}
function clipLater() { clearTimeout(clipT); clipT = setTimeout(applyClip, 750); }
// safety net: whatever happened, the region must always match the rendered island
setInterval(() => { if (!clipT && cfg) applyClip(); }, 500);
async function commit(fade) {
  if (!cfg) return;
  const my = ++seq;
  const compact = S().collapsed;
  const el = compact ? buildCompact() : buildView();
  meas.style.width = compact ? "max-content" : EXP_W + "px";
  meas.replaceChildren(el);
  const w = compact ? el.offsetWidth : EXP_W, hh = el.offsetHeight;
  curW = w;
  clearTimeout(swapT);
  if (fade) inn.style.opacity = 0;
  // the region must be gone BEFORE the island grows past it
  if (w > islW || hh > islH) { const u = unclip(); if (u) { await u; if (my !== seq) return; } }
  const resized = Math.abs(w - islW) > 2 || Math.abs(hh - islH) > 2;
  islW = w; islH = hh;
  isl.classList.toggle("compact", compact);
  isl.style.width = w + "px";
  isl.style.height = hh + "px";
  isl.style.borderRadius = (compact ? Math.min(w, hh) / 2 : 30) + "px";
  clipLater();
  // swap content once the old content has faded out; the pill is centred in the shrinking shell
  const put = () => { inn.replaceChildren(el); cur = el; inn.style.opacity = 1; };
  if (fade) swapT = setTimeout(put, resized ? 170 : 140); else put();
}
// live height change (typing in search, filtering) without rebuilding the view
function relayout() {
  if (!cur) return;
  const hh = cur.offsetHeight;
  if (hh > islH) unclip();
  islH = hh;
  isl.style.height = hh + "px";
  clipLater();
}
function softRefresh() {
  if (reordering || isTyping()) return;
  if (S().collapsed || ["quick", "media", "clip"].includes(view)) commit(false);
}

// ------------------------------------------------------------ navigation
function valid(v) {
  const [k, id] = v.split(":");
  if (k === "todo" || k === "plan") return !!(S().widgets.todo && todo);
  return !["item", "group"].includes(k) || !!findItem(id);
}
function go(v, to) { stack.push(view); view = v; if (to !== undefined) addTo = to; commit(true); }
function back() {
  let v;
  do { v = stack.pop() || "quick"; } while (!valid(v));
  view = v; commit(true);
}
function collapse() { if (S().collapsed) return; S().collapsed = true; view = "quick"; stack = []; query = ""; editing = false; save(); commit(true); }
function expand() { S().collapsed = false; view = "quick"; stack = []; save(); commit(true); }
function persist() { save(); commit(false); }
function flash(t) {
  msg = t; clearTimeout(msgT);
  msgT = setTimeout(() => { msg = ""; if (view === "quick" && !S().collapsed) softRefresh(); }, 1400);
  if (view === "quick" && !S().collapsed) commit(false);
}

// ------------------------------------------------------------ item actions
function open(it) {
  if (editing) return go("item:" + it.id);
  if (it.kind === "group") return go("group:" + it.id);
  if (it.kind === "snippet") { navigator.clipboard.writeText(it.path).catch(() => {}); return flash("Copied " + it.name); }
  const reuse = S().reuse !== false; // setting: jump to the already open window/tab instead of opening a new one
  if (it.kind === "url" && reuse) return openUrl(it);
  if (reuse && ["folder", "file", "app"].includes(it.kind)) return openTracked(it);
  invoke("launch", { kind: it.kind, path: it.path }).catch((e) => flash(String(e).slice(0, 30)));
}
// URLs: jump back to the exact browser tab we opened for this item (also after navigating to other pages), otherwise
// open the link and remember the tab. The native side keeps the tab itself; the title is only a fallback after a restart.
async function openUrl(it) {
  const cur = await invoke("focus_tab", { id: it.id, title: it.tab || "" }).catch(() => null);
  if (cur != null) {
    if (it.tabAuto && cur !== it.tab) { it.tab = cur; save(); }
    return;
  }
  await invoke("launch", { kind: "url", path: it.path }).catch((e) => flash(String(e).slice(0, 30)));
  // the new tab is in front once the browser has opened it; retry while it is still loading
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const t = await invoke("learn_tab", { id: it.id }).catch(() => null);
    if (t) { it.tab = t; it.tabAuto = true; save(); return; }
  }
}
// Folders, files and apps: jump back to the window this item opened (it survives navigating to another folder),
// otherwise launch and remember the window it creates. Explorer tabs are remembered like browser tabs.
async function openTracked(it) {
  if ((await invoke("focus_tab", { id: it.id, title: "" }).catch(() => null)) != null) return;
  if (await invoke("focus_window", { id: it.id }).catch(() => false)) return;
  const before = await invoke("window_ids").catch(() => []);
  await invoke("launch", { kind: it.kind, path: it.path }).catch((e) => flash(String(e).slice(0, 30)));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 600));
    if ((await invoke("learn_tab", { id: it.id }).catch(() => null)) != null) return;
    if (await invoke("learn_window", { id: it.id, before }).catch(() => false)) return;
  }
}
function openFromPill(it, el) {
  if (it.kind === "group") { S().collapsed = false; view = "group:" + it.id; stack = ["quick"]; save(); commit(true); return; }
  el.classList.add("pulse"); setTimeout(() => el.classList.remove("pulse"), 450);
  open(it);
}
async function addPaths(paths, target) {
  const items = await invoke("classify", { paths });
  const list = target ? target.children : prof().items;
  let n = 0;
  for (const i of items) if (!list.some((x) => x.path === i.path)) { list.push({ id: uid(), ...i }); n++; }
  save();
  if (view === "quick" || (target && view === "group:" + target.id)) commit(false);
  if (n) flash("Saved " + (n === 1 ? items[0].name : n + " items"));
}
function addItem(it, target) { (target ? target.children : prof().items).push({ id: uid(), ...it }); save(); }
function removeItem(it, list) { list.splice(list.indexOf(it), 1); persist(); }
function togglePin(it) { it.pinned = !it.pinned; persist(); }

// ------------------------------------------------------------ tiles + grid
function tile(it, getList) {
  const c = colors(it);
  const el = h("div", {
    class: "tl" + (it.exe && running.has(it.exe) ? " run" : ""), "data-id": it.id, "data-exe": it.exe || "", title: it.path || it.name,
    onclick: () => open(it),
    oncontextmenu: (e) => { e.preventDefault(); go("item:" + it.id); },
  },
  h("div", { class: "ti", style: `background:${c.bg};color:${c.fg}` }, ic(iconName(it), 22)),
  h("span", { class: "n" }, it.name),
  editing && h("span", { class: "rm", onclick: (e) => { e.stopPropagation(); removeItem(it, findItem(it.id).list); } }, ic("minus", 12)),
  editing && h("span", { class: "pinb" + (it.pinned ? " on" : ""), title: it.pinned ? "Unpin from bar" : "Pin to bar", onclick: (e) => { e.stopPropagation(); togglePin(it); } }, ic("pin", 11)),
  !editing && it.pinned && h("span", { class: "pinb on mini" }, ic("pin", 9)));
  if (getList) reorder(el, getList);
  return el;
}
function reorder(el, getList) {
  let sx = 0, sy = 0, drag = false;
  el.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; sx = e.clientX; sy = e.clientY; drag = false; el.setPointerCapture(e.pointerId); });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (!drag) { if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return; drag = true; reordering = true; el.classList.add("drag"); }
    const sibs = [...el.parentElement.querySelectorAll(".tl[data-id]")];
    const t = sibs.find((c) => {
      if (c === el) return false;
      const r = c.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (t) (sibs.indexOf(el) < sibs.indexOf(t) ? t.after(el) : t.before(el));
  });
  const end = () => {
    if (!drag) return;
    drag = false; reordering = false; el.classList.remove("drag");
    const ids = [...el.parentElement.querySelectorAll(".tl[data-id]")].map((c) => c.dataset.id);
    getList().sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    save();
    el.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { once: true, capture: true });
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
function buildGrid(list, canAdd, emptyText) {
  const cells = list.map((i) => tile(i, query ? null : () => (canAdd === "top" ? prof().items : findItem(canAdd).it.children)));
  if (canAdd && !editing && !query) {
    cells.push(h("div", { class: "tl add", onclick: () => go("add", canAdd) },
      h("div", { class: "ti" }, ic("plus", 20)), h("span", { class: "n" }, "Add")));
  }
  if (!cells.length) cells.push(h("div", { class: "empty" }, emptyText || "Nothing here"));
  return h("div", { class: "grid", style: `--rows:${S().maxRows}` }, cells);
}

// ------------------------------------------------------------ widgets
function timerLeft() { return tm.running ? Math.max(0, Math.ceil((tm.end - Date.now()) / 1000)) : tm.left; }
const timerActive = () => tm.running || tm.ring || tm.left !== tm.total;
function bars(on) { return h("span", { class: "bars" + (on ? "" : " off") }, h("i"), h("i"), h("i"), h("i")); }
function strip() {
  const w = S().widgets, out = [];
  if (w.clock) out.push(h("div", { class: "chip" }, ic("clock", 15), h("span", { "data-t": "clock" }, clock())));
  if (w.battery && batt) out.push(h("div", { class: "chip" }, ic("bolt", 15), h("span", { "data-t": "batt" }, battText())));
  if (w.media) out.push(h("div", { class: "chip click", onclick: () => go("media") }, media && media.active ? [bars(media.playing), h("span", { class: "t" }, media.title)] : [ic("music", 15), h("span", { class: "t" }, "Nothing playing")]));
  if (w.timer) out.push(h("div", { class: "chip click tmr", onclick: () => go("timer") }, ic("hourglass", 15), h("span", { "data-t": "timer" }, fmt(timerLeft()))));
  if (w.todo && todo) out.push(h("div", { class: "chip click", onclick: () => go("todo") }, ic("checkbox", 15), h("span", {}, todoText())));
  if (w.clip) out.push(h("div", { class: "chip click", onclick: () => go("clip") }, ic("clipboard", 15), h("span", {}, clips.length + " copied")));
  return out.length ? h("div", { class: "strip" }, out) : null;
}
function battText() { return Math.round(batt.level * 100) + "%" + (batt.charging ? " charging" : ""); }
function updLive() {
  const set = (sel, v) => document.querySelectorAll(sel).forEach((e) => { if (e.textContent !== v) e.textContent = v; });
  set("[data-t=clock]", clock());
  set("[data-t=timer]", fmt(timerLeft()));
  if (batt) set("[data-t=batt]", battText());
}
async function initBatt() {
  if (batt || !navigator.getBattery) return;
  batt = await navigator.getBattery();
  ["levelchange", "chargingchange"].forEach((ev) => batt.addEventListener(ev, updLive));
  softRefresh();
}
let mediaBusy = false;
async function pollMedia() {
  if (mediaBusy) return;
  mediaBusy = true;
  const m = await invoke("media_info").catch(() => null).finally(() => { mediaBusy = false; });
  if (!m) return;
  const changed = JSON.stringify(m) !== JSON.stringify(media);
  media = m;
  if (changed) softRefresh();
}
async function ctl(op) { await invoke("media_ctl", { op }); setTimeout(pollMedia, 350); }
async function pollClip() {
  const t = await invoke("read_clipboard");
  if (t && t !== clips[0]) { clips = [t, ...clips.filter((c) => c !== t)].slice(0, 20); softRefresh(); }
}
async function pollRunning() {
  if (!flat(prof().items).some((i) => i.exe)) return;
  running = new Set(await invoke("running_exes"));
  document.querySelectorAll("[data-exe]").forEach((t) => t.classList.toggle("run", !!t.dataset.exe && running.has(t.dataset.exe)));
}
function beep() {
  if (LABEL !== "main") return; // one window beeps when mirrored on several screens
  try {
    const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = .15;
    o.start(); o.stop(a.currentTime + .35); setTimeout(() => a.close(), 600);
  } catch (_) {}
}
const syncTm = () => T.event.emit("tm", { from: LABEL, tm: { total: tm.total, left: tm.left, running: tm.running, end: tm.end, ring: tm.ring } });
function afterTimer() { if (S().collapsed || view === "timer" || view === "quick") commit(false); else updLive(); }
const tmStart = () => { if (tm.left <= 0) tm.left = tm.total; tm.end = Date.now() + tm.left * 1000; tm.running = true; tm.ring = false; isl.classList.remove("ring"); syncTm(); afterTimer(); };
const tmPause = () => { tm.left = timerLeft(); tm.running = false; syncTm(); afterTimer(); };
const tmReset = () => { tm.running = false; tm.left = tm.total; tm.ring = false; isl.classList.remove("ring"); syncTm(); afterTimer(); };
function timerTick() {
  if (!tm.running || timerLeft() > 0) return;
  tm.running = false; tm.left = 0; tm.ring = true; beep();
  isl.classList.add("ring"); setTimeout(() => isl.classList.remove("ring"), 3200);
  afterTimer();
}
function globalTick() {
  tick++;
  timerTick(); updLive();
  if (todo && Todo.localISO(new Date()) !== todoDay) { todoDay = Todo.localISO(new Date()); todoChanged(); }
  if (S().widgets.clip && tick % 2 === 0) pollClip();
  if (S().widgets.media && tick % 3 === 0) pollMedia();
  if ((!S().collapsed || prof().items.some((i) => i.pinned && i.exe)) && tick % 4 === 0) pollRunning();
}

// ------------------------------------------------------------ compact pill (horizontal or vertical)
function buildCompact() {
  const w = S().widgets, items = prof().items, vert = isVert();
  const pins = items.filter((i) => i.pinned);
  const shown = pins.slice(0, MAX_PINS), more = pins.length - shown.length;
  let right = null;
  if (w.timer && timerActive()) right = h("span", { class: "tm" }, ic("hourglass", 15), h("span", { "data-t": "timer" }, fmt(timerLeft())));
  else if (w.media && media && media.active && media.playing) right = bars(true);
  else if (w.clock) right = h("span", { "data-t": "clock" }, clock());
  return h("div", { class: "cmp" + (vert ? " v" : "") },
    h("span", { class: "cg", title: "Open Floaty" }, ic("layout-grid", 16), !pins.length && !vert && h("span", {}, items.length + " items")),
    shown.map((it) => {
      const c = colors(it);
      const el = h("span", { class: "pt" + (it.exe && running.has(it.exe) ? " run" : ""), "data-exe": it.exe || "", title: it.name, style: `background:${c.bg};color:${c.fg}` }, ic(iconName(it), 16));
      el.addEventListener("click", (e) => { e.stopPropagation(); openFromPill(it, el); });
      return el;
    }),
    more > 0 && h("span", { class: "more" }, "+" + more),
    w.todo && todo && (todoOpen() > 0 || S().todoPin) && h("span", { class: "tdc", title: "Todo: open today", onclick: (e) => { e.stopPropagation(); S().collapsed = false; view = "todo"; stack = ["quick"]; save(); commit(true); } }, ic("checkbox", 15), todoOpen() || null),
    right && h("span", { class: "cr" }, right));
}

// ------------------------------------------------------------ views
function buildView() {
  if (!valid(view)) view = "quick";
  const [kind, id] = view.split(":");
  const fn = { quick: vQuick, settings: vSettings, add: vAdd, start: vStart, clip: vClip, media: vMedia, timer: vTimer, todo: vTodo, plan: vPlan, item: () => vItem(id), group: () => vGroup(id) }[kind] || vQuick;
  return h("div", { class: "view" }, fn());
}
const hdr = (left, ...right) => h("div", { class: "hdr" }, h("div", { class: "l" }, left), h("div", { class: "r" }, ...right));
const backBtn = () => h("button", { class: "ibtn", title: "Back", onclick: back }, ic("chevron-left", 18));
const editBtn = () => h("button", { class: "tx", onclick: () => { editing = !editing; commit(false); } }, editing ? "Done" : "Edit");

function vQuick() {
  const sin = h("input", { class: "sin", placeholder: "Quick access", value: query, oninput: (e) => { query = e.target.value; fillGrid(); relayout(); } });
  const left = msg ? h("span", { class: "ttl ok" }, msg) : h("label", { class: "sbox" }, ic("search", 15), sin);
  gridHold = h("div");
  fillGrid();
  return [
    hdr(left, editBtn(),
      h("button", { class: "ibtn", title: "Add", onclick: () => go("add", "top") }, ic("plus", 18)),
      h("button", { class: "ibtn", title: "Settings", onclick: () => go("settings") }, ic("settings", 17)),
      h("button", { class: "ibtn", title: "Minimize", onclick: collapse }, ic("chevron-up", 18))),
    gridHold,
    strip(),
  ];
}
function fillGrid() {
  const q = query.trim().toLowerCase();
  const list = q ? flat(prof().items).filter((i) => i.kind !== "group" && (i.name + " " + (i.path || "")).toLowerCase().includes(q)) : prof().items;
  gridHold.replaceChildren(buildGrid(list, !q && "top", q ? "No match" : "Drop files, folders or apps here, or tap +"));
}

function vGroup(id) {
  const g = findItem(id).it;
  return [
    hdr([backBtn(), h("span", { class: "ttl" }, g.name)], editBtn(), h("button", { class: "ibtn", title: "Rename or remove", onclick: () => go("item:" + id) }, ic("pencil", 16))),
    buildGrid(g.children, id, "Empty. Drop items on this card."),
  ];
}

function vAdd() {
  const f = {};
  const field = (k, ph) => (f[k] = h("input", { class: "fld", placeholder: ph }));
  // build only the active form: field() stores its input in f, so building all of them made f.val point at the snippet textarea
  const forms = {
    url: () => [field("name", "Name (optional)"), field("val", "https://example.com")],
    cmd: () => [field("name", "Name"), field("val", "Command, e.g. code C:\work")],
    snippet: () => [field("name", "Name"), (f.val = h("textarea", { class: "fld", rows: 3, placeholder: "Text to copy on click" }))],
    group: () => [field("name", "Group name")],
  };
  const target = addTo && addTo !== "top" ? (findItem(addTo) || {}).it : null;
  const make = () => {
    const name = f.name.value.trim(), val = f.val ? f.val.value.trim() : "";
    if (addKind === "group") { if (name) addItem({ kind: "group", name, children: [] }, target); return; }
    if (!val) return;
    if (addKind === "url") return addItem({ kind: "url", name: name || val.replace(/^https?:\/\//, "").split("/")[0], path: /^[a-z]+:\/\//i.test(val) ? val : "https://" + val }, target);
    if (name) addItem({ kind: addKind, name, path: val }, target);
  };
  return [
    hdr([backBtn(), h("span", { class: "ttl" }, target ? "Add to " + target.name : "Add")]),
    h("div", { class: "tabs" }, [["url", "URL"], ["cmd", "Command"], ["snippet", "Snippet"], ["group", "Group"]].map(([k, t]) =>
      h("button", { class: "btn" + (addKind === k ? " on" : ""), onclick: () => { addKind = k; commit(false); } }, t))),
    h("div", { class: "stack" }, ...forms[addKind](), h("button", { class: "btn pri", onclick: () => { make(); back(); } }, "Add")),
    h("p", { class: "muted", style: "margin-top:12px" }, "Tip: drop files, folders or apps onto the island."),
    h("div", { class: "btns" }, h("button", { class: "btn", onclick: openStart }, "Import from Start Menu")),
  ];
}
async function openStart() { go("start"); if (!sm) { sm = await invoke("start_menu").catch(() => []); if (view === "start") fillStart(); } }
let startList = null, startHave = null;
const startKey = (e) => e.path.toLowerCase();
function fillStart() {
  const q = smQ.toLowerCase();
  const rows = (sm || []).filter((e) => e.name.toLowerCase().includes(q));
  startList.replaceChildren(...rows.map((e) => {
    const done = startHave.has(startKey(e));
    return h("div", { class: "li" + (done ? " done" : ""), title: e.name, onclick: async (ev) => {
      const el = ev.currentTarget;
      if (startHave.has(startKey(e))) return;
      startHave.add(startKey(e)); el.classList.add("done");
      // Store apps have no file to classify: they open through shell:AppsFolder
      if (e.path.startsWith("shell:")) { addItem({ kind: "app", name: e.name, path: e.path }); flash("Saved " + e.name); }
      else await addPaths([e.path]);
    } }, e.name, e.store && h("span", { class: "src" }, "Store"));
  }));
  if (!sm) startList.append(h("div", { class: "muted" }, "Loading apps..."));
  else if (!rows.length) startList.append(h("div", { class: "muted" }, "No apps match"));
}
function vStart() {
  startHave = new Set(flat(prof().items).map((i) => (i.path || "").toLowerCase()));
  startList = h("div", { class: "list tall" });
  const input = h("input", { class: "fld", placeholder: "Search apps...", value: smQ, oninput: (e) => { smQ = e.target.value; fillStart(); } });
  fillStart();
  setTimeout(() => input.focus(), 350);
  return [hdr([backBtn(), h("span", { class: "ttl" }, "Start Menu")]), input, startList];
}

function vClip() {
  return [
    hdr([backBtn(), h("span", { class: "ttl" }, "Clipboard")], h("button", { class: "ibtn", title: "Clear", onclick: () => { clips = []; commit(false); } }, ic("trash", 16))),
    h("div", { class: "list" }, clips.length
      ? clips.map((t) => h("div", { class: "li", title: t, onclick: () => { navigator.clipboard.writeText(t).catch(() => {}); stack = []; view = "quick"; flash("Copied"); } }, t.replace(/\s+/g, " ").slice(0, 90)))
      : h("div", { class: "muted" }, "Nothing copied yet")),
  ];
}

function vMedia() {
  const m = media && media.active ? media : null;
  return [
    hdr([backBtn(), h("span", { class: "ttl" }, "Now playing")]),
    h("div", { class: "card" },
      h("div", { class: "mrow" }, h("div", { class: "art" }, ic("music", 24)),
        h("div", { class: "tt" }, h("div", {}, m ? m.title : "Nothing playing"), h("div", { class: "muted" }, m ? m.artist : "Start something in your player")), m && bars(m.playing)),
      m && h("div", { class: "ctrls" },
        h("button", { class: "ibtn", onclick: () => ctl("prev") }, ic("player-skip-back", 22)),
        h("button", { class: "ibtn", onclick: () => ctl("toggle") }, ic(m.playing ? "player-pause" : "player-play", 26)),
        h("button", { class: "ibtn", onclick: () => ctl("next") }, ic("player-skip-forward", 22)))),
  ];
}

function vTimer() {
  const left = timerLeft();
  return [
    hdr([backBtn(), h("span", { class: "ttl" }, "Timer")]),
    h("div", { class: "card" },
      h("div", { class: "trow" },
        h("div", {}, h("div", { class: "muted" }, tm.ring ? "Time is up" : tm.running ? "Running" : "Ready"), h("div", { class: "big", "data-t": "timer" }, fmt(left))),
        h("div", { class: "step" },
          h("button", { class: "circ o", onclick: () => (tm.running ? tmPause() : tmStart()) }, ic(tm.running ? "player-pause" : "player-play", 20)),
          h("button", { class: "circ", title: "Reset", onclick: tmReset }, ic("refresh", 18)))),
      h("div", { class: "presets" }, [1, 5, 10, 25, 45].map((m) => h("button", { class: "btn" + (tm.total === m * 60 ? " on" : ""), onclick: () => { tm.total = m * 60; tmReset(); } }, m + " min")))),
  ];
}

function vItem(id) {
  const { it, list } = findItem(id);
  const groups = flat(prof().items).filter((g) => g.kind === "group" && g.id !== it.id);
  const top = list === prof().items;
  const btn = (t, fn, cls = "") => h("button", { class: "btn " + cls, onclick: fn }, t);

  // live preview + colour / icon pickers (updated in place, no re-render)
  const prev = h("div", { class: "ti prev" });
  const paint = () => { const c = colors(it); prev.style.background = c.bg; prev.style.color = c.fg; prev.replaceChildren(ic(iconName(it), 24)); };
  paint();
  const colorBtns = [];
  const markColor = () => colorBtns.forEach(([el, v]) => el.classList.toggle("on", (it.color || "") === v));
  const pickColor = (v) => { if (v) it.color = v; else delete it.color; save(); paint(); markColor(); };
  const autoBtn = h("button", { class: "swc auto", title: "Automatic", onclick: () => pickColor("") }, ic("refresh", 11));
  colorBtns.push([autoBtn, ""]);
  const sw = h("div", { class: "sws wrap" }, autoBtn, ITEM_COLORS.map((c) => {
    const b = h("button", { class: "swc", style: `background:${c}`, title: c, onclick: () => pickColor(c) });
    colorBtns.push([b, c]);
    return b;
  }), h("input", { type: "color", class: "cpick", title: "Custom colour", value: it.color || "#0a84ff", oninput: (e) => pickColor(e.target.value) }));
  markColor();

  const iconBtns = [];
  const markIcon = () => iconBtns.forEach(([el, v]) => el.classList.toggle("on", (it.icon || "") === v));
  const pickIcon = (v) => { if (v) it.icon = v; else delete it.icon; save(); paint(); markIcon(); };
  const autoIcon = h("button", { class: "auto", title: "Automatic icon", onclick: () => pickIcon("") }, ic("refresh", 15));
  iconBtns.push([autoIcon, ""]);
  const grid = h("div", { class: "pk" }, autoIcon, ICON_CHOICES.filter((n) => (window.ICONS || {})[n]).map((n) => {
    const b = h("button", { title: n, onclick: () => pickIcon(n) }, ic(n, 18));
    iconBtns.push([b, n]);
    return b;
  }));
  markIcon();

  return [
    hdr([backBtn(), h("span", { class: "ttl" }, it.kind[0].toUpperCase() + it.kind.slice(1))]),
    h("div", { class: "scroll" },
      h("div", { class: "irow" }, prev, h("input", { class: "fld", value: it.name, onchange: (e) => { it.name = e.target.value || it.name; save(); } })),
      it.path && h("div", { class: "path" }, it.path),
      it.kind === "url" && h("div", { class: "rw col" },
        h("div", { class: "rl" }, h("div", {}, "Browser tab title"), h("div", { class: "sub" }, "Clicking jumps to the tab Floaty opened (it follows the tab when you navigate). The title is only used to find it again after a restart")),
        h("input", { class: "fld", placeholder: "Learned automatically after the first open", value: it.tab || "", onchange: (e) => { it.tab = e.target.value.trim(); delete it.tabAuto; if (!it.tab) delete it.tab; save(); } })),
      h("div", { class: "btns" },
        it.kind !== "group" && btn("Open", () => { const e = editing; editing = false; open(it); editing = e; }),
        btn(it.pinned ? "Unpin from bar" : "Pin to bar", () => { it.pinned = !it.pinned; save(); commit(false); }),
        it.kind === "app" && btn("Run as admin", () => invoke("run_admin", { path: it.path })),
        ["file", "folder", "app"].includes(it.kind) && btn("Show in folder", () => invoke("reveal", { path: it.path })),
        btn("Remove", () => { list.splice(list.indexOf(it), 1); save(); back(); }, "danger")),
      h("div", { class: "sec" }, "Colour"), sw,
      h("div", { class: "sec" }, "Icon"), grid,
      it.kind !== "group" && (groups.length > 0 || !top) && h("div", { class: "rw", style: "margin-top:12px" }, h("span", {}, "Move to"),
        h("select", { class: "fld", onchange: (e) => {
          if (!e.target.value) return;
          const to = e.target.value === "_top" ? prof().items : findItem(e.target.value).it.children;
          list.splice(list.indexOf(it), 1); to.push(it); save(); back();
        } }, h("option", { value: "" }, "..."), !top && h("option", { value: "_top" }, "Island"), groups.map((g) => h("option", { value: g.id }, g.name))))),
  ];
}

// ------------------------------------------------------------ todo + plan
const todoOpen = () => Todo.byDate(todo.tasks, Todo.localISO(new Date())).filter((t) => !t.done).length;
function todoText() {
  const all = Todo.byDate(todo.tasks, Todo.localISO(new Date())).length, n = todoOpen();
  return n ? n + " to do" : all ? "All done" : "No tasks";
}
async function todoLoad() {
  if (todo) return;
  try { todo = Todo.normalize(JSON.parse(await invoke("load_todos"))); } catch (_) { todo = Todo.normalize(null); }
  todoDay = Todo.localISO(new Date());
}
const todoSave = () => invoke("save_todos", { text: JSON.stringify(todo) }).catch(() => {});
// tasks changed somewhere (another window, midnight): redraw what shows them
function todoChanged() {
  if (!todo || S().collapsed) return softRefresh();
  if ((view === "todo" || view === "plan") && todoRoot) { todoRoot.refresh(); relayout(); } else softRefresh();
}
const todoCtx = () => ({ get: () => todo.tasks, set: (n) => { todo.tasks = n; todoSave(); }, ui: tdUi, after: relayout });
async function popOut() {
  todo.win.open = true;
  await todoSave(); // the new window loads what is on disk
  invoke("todo_window", { open: true, geo: todo.win }).catch((e) => flash(String(e).slice(0, 30)));
}
async function todoOff() {
  if (todo && todo.win.open) { todo.win.open = false; await todoSave(); }
  invoke("todo_window", { open: false }).catch(() => {});
  todo = null; todoRoot = null; todoImp = null;
  if (["todo", "plan"].includes(view)) { view = "quick"; stack = []; }
}
const popBtn = () => h("button", { class: "ibtn", title: "Open in its own window", onclick: popOut }, ic("external-link", 16));
function vTodo() {
  todoRoot = TodoUI.days(todoCtx());
  const pinned = !!S().todoPin;
  return [hdr([backBtn(), h("span", { class: "ttl" }, "Todo")],
    h("button", { class: "ibtn" + (pinned ? " on" : ""), title: pinned ? "Unpin from bar" : "Pin to bar (always show when collapsed)", onclick: () => { S().todoPin = !pinned; save(); commit(false); } }, ic("pin", 16)),
    h("button", { class: "ibtn", title: "Month plan", onclick: () => go("plan") }, ic("calendar", 17)), popBtn()), todoRoot];
}
function vPlan() {
  todoRoot = TodoUI.plan(todoCtx());
  return [hdr([backBtn(), h("span", { class: "ttl" }, "Plan")], popBtn()), todoRoot];
}
// settings: export / import rows (filled live so toggling the module needs no rebuild of the page)
function fillTodoData() {
  if (!todoBox) return;
  const btn = (t, fn, cls = "") => h("button", { class: "btn " + cls, onclick: fn }, t);
  const rows = [];
  if (S().widgets.todo && todo) {
    rows.push(h("div", { class: "rw" }, btn("Export tasks", exportTodos), btn("Import tasks", importTodos)));
    if (todoImp) {
      rows.push(h("div", { class: "rw col" },
        h("div", { class: "rl" }, h("div", {}, todoImp.tasks.length + " valid" + (todoImp.skipped ? ", " + todoImp.skipped + " skipped" : "")), h("div", { class: "sub" }, "Merge keeps your tasks and updates matching ones; replace discards the current list")),
        h("div", { class: "btns", style: "margin-top:0" },
          btn("Merge", () => { todo.tasks = Todo.mergeTasks(todo.tasks, todoImp.tasks); todoImported("Merged"); }),
          btn("Replace", () => { todo.tasks = todoImp.tasks; todoImported("Replaced"); }, "danger"),
          btn("Cancel", () => { todoImp = null; fillTodoData(); relayout(); }))));
    }
  }
  todoBox.replaceChildren(...rows);
  todoBox.style.display = rows.length ? "" : "none";
}
function todoImported(t) { todoImp = null; todoSave(); fillTodoData(); relayout(); flash(t + " tasks"); }
async function exportTodos() {
  dialogOpen = true;
  try {
    const dest = await T.dialog.save({ defaultPath: "floaty-todos.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (dest) await invoke("export_todos", { dest, text: Todo.exportJSON(todo.tasks) });
  } catch (e) { console.error(e); } finally { dialogOpen = false; }
}
async function importTodos() {
  dialogOpen = true;
  try {
    const src = await T.dialog.open({ filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!src) return;
    todoImp = Todo.parseImport(await invoke("import_todos", { src }));
  } catch (e) { todoImp = null; flash("Not a task list"); } finally { dialogOpen = false; }
  fillTodoData(); relayout();
}

// ------------------------------------------------------------ settings
function vSettings() {
  const s = S();
  const set = (k, v) => { s[k] = v; save(); };
  const grp = (title, icon, ...rows) => h("section", { class: "grp" }, h("div", { class: "gh" }, ic(icon, 14), h("span", {}, title)), h("div", { class: "gb" }, ...rows));
  const row = (label, sub, control, cls = "") => h("div", { class: "rw " + cls }, h("div", { class: "rl" }, h("div", {}, label), sub && h("div", { class: "sub" }, sub)), control);
  const toggle = (label, sub, get, on) => row(label, sub, h("input", { class: "sw", type: "checkbox", checked: get(), onchange: (e) => { on(e.target.checked); save(); } }));
  const seg = (opts, curv, on) => {
    const wrap = h("div", { class: "seg" });
    opts.forEach(([v, t]) => wrap.append(h("button", { class: v === curv ? "on" : "", onclick: (e) => {
      wrap.querySelectorAll("button").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); on(v);
    } }, t)));
    return wrap;
  };
  const wid = (k, label, sub, extra) => toggle(label, sub, () => s.widgets[k], (v) => { s.widgets[k] = v; if (extra) extra(v); });

  // display picker (filled once monitor list is known)
  const dispRow = h("div", { class: "rw col" });
  const fillDisplay = () => {
    const opts = monList.map((m) => [String(m.index), "Screen " + (m.index + 1)]);
    dispRow.replaceChildren(monList.length > 1
      ? row("Show on", monList.map((m) => `Screen ${m.index + 1}: ${m.width}x${m.height}${m.primary ? " (main)" : ""}`).join("  |  "),
        seg([...opts, ["all", "All screens"]], s.screen, (v) => { set("screen", v); invoke("set_screens", { mode: v }); }), "col")
      : row("Show on", "Only one screen detected", null));
    if (cur && cur.contains(dispRow)) relayout();
  };
  fillDisplay();
  invoke("list_monitors").then((m) => { monList = m; fillDisplay(); });

  const dock = h("div", { class: "dpk" }, ["tl", "t", "tr", "l", null, "r", "bl", "b", "br"].map((d) => d
    ? h("button", { class: "dc" + (s.dock === d ? " on" : ""), "data-d": d, title: DOCK_NAME[d], onclick: (e) => {
      dock.querySelectorAll(".dc").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on");
      set("dock", d); applyLook(); native.dock();
    } }, h("i"))
    : h("span", { class: "dc mid" }, "screen")));

  const rowsEl = h("b", {}, s.maxRows);
  const stepRows = (d) => () => { set("maxRows", Math.min(8, Math.max(1, s.maxRows + d))); rowsEl.textContent = s.maxRows; };
  const opVal = h("span", { class: "muted val" }, s.opacity + "%");
  const sw = h("div", { class: "sws" }, SWATCHES.map((c) => h("button", { class: "swc" + (!s.sysAccent && s.accent === c ? " on" : ""), style: `background:${c}`, onclick: (e) => {
    s.sysAccent = false; set("accent", c); applyLook();
    sw.querySelectorAll(".swc").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on");
  } })), h("input", { type: "color", class: "cpick", value: s.accent, title: "Custom colour", oninput: (e) => { s.sysAccent = false; set("accent", e.target.value); applyLook(); sw.querySelectorAll(".swc").forEach((b) => b.classList.remove("on")); } }),
  h("button", { class: "btn sm" + (s.sysAccent ? " on" : ""), onclick: () => { set("sysAccent", true); applyLook(); } }, "Windows"));

  const p = prof();
  const profSeg = seg(cfg.profiles.map((x) => [x.id, x.name]), cfg.active, (v) => { cfg.active = v; save(); pollRunning(); commit(false); });
  const body = [
    grp("Display", "layout-grid",
      dispRow,
      row("Dock position", "Where Floaty sits on the screen", dock),
      row("Max rows", "Grid grows to this many rows, then scrolls", h("div", { class: "step" }, h("button", { class: "btn sm", onclick: stepRows(-1) }, "-"), rowsEl, h("button", { class: "btn sm", onclick: stepRows(1) }, "+")))),
    grp("Appearance", "palette",
      row("Theme", null, seg([["glass", "Glass"], ["dark", "Dark"], ["light", "Light"], ["solid", "Black"], ["system", "System"]], s.theme, (v) => { set("theme", v); applyLook(); }), "col"),
      row("Opacity", null, h("div", { class: "step" }, h("input", { type: "range", min: 20, max: 100, value: s.opacity, oninput: (e) => { set("opacity", +e.target.value); opVal.textContent = e.target.value + "%"; applyLook(); } }), opVal)),
      row("Accent", null, sw, "col")),
    grp("Behavior", "adjustments",
      toggle("Always on top", null, () => s.onTop, (v) => { s.onTop = v; native.onTop(); }),
      toggle("Collapse when clicking outside", "Also when you switch to another app", () => s.outside, (v) => { s.outside = v; }),
      toggle("Reuse open windows", "Clicking an item jumps to its open window or tab; off always opens a new one", () => s.reuse !== false, (v) => { s.reuse = v; }),
      toggle("Auto-hide on hover", "Collapse on mouse leave, open on hover", () => s.autohide, (v) => { s.autohide = v; }),
      toggle("Hide over fullscreen apps", "Per screen", () => s.hideFs, (v) => { s.hideFs = v; native.hideFs(); }),
      toggle("Start with Windows", null, () => s.autostart, (v) => { s.autostart = v; native.autostart(); }),
      row("Show / hide hotkey", null, h("kbd", {}, "Alt + Space"))),
    grp("Widgets", "apps",
      wid("clock", "Clock"),
      wid("timer", "Timer", "Shows in the pill while running"),
      wid("media", "Now playing", "Controls for Spotify, YouTube and more", (v) => v && pollMedia()),
      wid("battery", "Battery", null, (v) => v && initBatt()),
      wid("clip", "Clipboard history", "Kept in memory only", (v) => v && pollClip()),
      wid("todo", "Todo and plan", "Daily list and month planner, can pop out into its own window", async (v) => {
        if (v) await todoLoad(); else await todoOff();
        fillTodoData(); relayout();
      })),
    grp("Profiles", "folders",
      row("Active profile", null, profSeg, "col"),
      h("div", { class: "rw" }, h("input", { class: "fld", value: p.name, onchange: (e) => { p.name = e.target.value || p.name; save(); commit(false); } })),
      h("div", { class: "rw" },
        h("button", { class: "btn", onclick: () => { const n = { id: uid(), name: "Profile " + (cfg.profiles.length + 1), items: [] }; cfg.profiles.push(n); cfg.active = n.id; save(); commit(false); } }, "New profile"),
        cfg.profiles.length > 1 && h("button", { class: "btn danger", onclick: () => { cfg.profiles = cfg.profiles.filter((x) => x !== p); cfg.active = cfg.profiles[0].id; save(); commit(false); } }, "Delete this one"))),
    grp("Data", "copy", h("div", { class: "rw" }, h("button", { class: "btn", onclick: exportCfg }, "Export backup"), h("button", { class: "btn", onclick: importCfg }, "Import backup")), todoBox = h("div")),
  ];
  fillTodoData();
  return [hdr([backBtn(), h("span", { class: "ttl" }, "Settings")]), h("div", { class: "scroll" }, body)];
}
async function exportCfg() {
  dialogOpen = true;
  try {
    const dest = await T.dialog.save({ defaultPath: "floaty-backup.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (dest) { await invoke("save_config", { text: JSON.stringify(cfg) }); await invoke("export_config", { dest }); }
  } finally { dialogOpen = false; }
}
async function importCfg() {
  dialogOpen = true;
  try {
    const src = await T.dialog.open({ filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!src) return;
    cfg = merge(JSON.parse(await invoke("import_config", { src })));
    view = "quick"; stack = []; save(); applyLook(); Object.values(native).forEach((f) => f()); commit(true);
  } catch (e) { console.error(e); } finally { dialogOpen = false; }
}

// ------------------------------------------------------------ drag & drop (files from Explorer)
function hit(x, y) {
  const el = document.elementFromPoint(x / devicePixelRatio, y / devicePixelRatio);
  return { tile: el && el.closest(".tl[data-id]"), inIsl: !!(el && el.closest("#isl")) };
}
const clearDrop = () => document.querySelectorAll(".drop").forEach((e) => e.classList.remove("drop"));
T.webview.getCurrentWebview().onDragDropEvent(async ({ payload: p }) => {
  if (p.type === "enter" && S().collapsed) expand();
  else if (p.type === "over") {
    clearDrop();
    const { tile } = hit(p.position.x, p.position.y);
    const g = tile && findItem(tile.dataset.id);
    if (g && g.it.kind === "group") tile.classList.add("drop");
  } else if (p.type === "drop") {
    clearDrop();
    const { tile, inIsl } = hit(p.position.x, p.position.y);
    const g = tile && findItem(tile.dataset.id);
    let target = null;
    if (g && g.it.kind === "group") target = g.it;
    else if (inIsl && view.startsWith("group:")) target = (findItem(view.split(":")[1]) || {}).it || null;
    await addPaths(p.paths, target);
  } else if (p.type === "leave") clearDrop();
});

// ------------------------------------------------------------ click, keyboard, outside-collapse, autohide
isl.addEventListener("click", (e) => { if (S().collapsed && e.target.closest(".cmp")) expand(); });
isl.addEventListener("pointerover", (e) => { clearTimeout(hideTimer); if (S().collapsed && S().autohide && e.target.closest(".cg")) expand(); });
isl.addEventListener("pointerleave", () => {
  if (!S().autohide || S().collapsed || view !== "quick" || query || editing) return;
  hideTimer = setTimeout(collapse, 800);
});
// click on the transparent area around the island
document.addEventListener("pointerdown", (e) => { if (S().outside && !S().collapsed && !e.target.closest("#isl")) collapse(); });
// switching to another app (or clicking another screen's window)
window.addEventListener("blur", () => {
  if (!cfg || !S().outside || S().collapsed || dialogOpen) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (!document.hasFocus() && !dialogOpen && !S().collapsed && !(a && ["color", "month"].includes(a.type))) collapse();
  }, 200);
});
document.addEventListener("keydown", (e) => {
  if (S().collapsed) return;
  const sin = cur && cur.querySelector(".sin");
  if (e.key === "Escape") {
    if (query) { query = ""; commit(false); }
    else if (view !== "quick") back();
    else if (editing) { editing = false; commit(false); }
    else collapse();
  } else if (e.key === "Enter" && sin && document.activeElement === sin) {
    const first = cur.querySelector(".tl[data-id]");
    const f = first && findItem(first.dataset.id);
    if (f) open(f.it);
  } else if (sin && !isTyping() && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) sin.focus();
});
window.addEventListener("resize", () => { unclip(); clipLater(); });
document.addEventListener("contextmenu", (e) => { if (!e.target.closest(".tl")) e.preventDefault(); });

// ------------------------------------------------------------ boot
(async () => {
  let raw = null;
  try { raw = JSON.parse(await invoke("load_config")); } catch (_) {}
  cfg = merge(raw);
  if (S().widgets.todo) await todoLoad();
  await Promise.all(Object.values(native).map((f) => f()));
  if (LABEL === "main") await invoke("set_screens", { mode: S().screen }).catch(() => {});
  invoke("list_monitors").then((m) => { monList = m; }).catch(() => {});
  applyLook();
  await invoke("fit", { width: WIN_W, height: 4000 }); // clamped to the screen height
  commit(false);
  // mirrored windows (All screens): share config and timer; each keeps its own collapsed state
  listen("cfg", (e) => {
    if (e.payload.from === LABEL) return;
    const keep = S().collapsed;
    cfg = merge(JSON.parse(e.payload.text));
    S().collapsed = keep;
    applyLook();
    if (S().widgets.todo && !todo) todoLoad().then(() => commit(false));
    else if (!S().widgets.todo && todo) { todo = null; todoRoot = null; if (["todo", "plan"].includes(view)) { view = "quick"; stack = []; } commit(false); }
    else if (!isTyping()) commit(false);
  });
  // another window (the pop-out) saved the todos
  listen("todos", (e) => {
    if (e.payload.from === LABEL || !todo) return;
    const next = Todo.normalize(JSON.parse(e.payload.text));
    const changed = JSON.stringify(next.tasks) !== JSON.stringify(todo.tasks);
    todo = next;
    if (changed && !TodoUI.dragging) todoChanged();
  });
  listen("tm", (e) => {
    if (e.payload.from === LABEL) return;
    Object.assign(tm, e.payload.tm);
    isl.classList.remove("ring");
    afterTimer();
  });
  listen("hotkey", (e) => { if (S().collapsed) expand(); else if (e.payload === "toggle") collapse(); });
  if (LABEL === "main" && todo && todo.win.open) popOut();
  if (S().widgets.battery) initBatt();
  if (S().widgets.media) pollMedia();
  setInterval(globalTick, 1000);
  pollRunning();
})();
})();
