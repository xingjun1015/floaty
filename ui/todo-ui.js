// Todo views shared by the island and the pop-out window: days(ctx) and plan(ctx) return a root element with a
// .refresh() method that re-renders only the lists (the add box keeps focus, scroll positions are kept).
// ctx = { get(): tasks, set(next): store + save (called only with a real change), ui: per-window view state, after(): optional }
(() => {
const { h, ic, Todo } = window;
const TodoUI = { dragging: false };
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const today = () => Todo.localISO(new Date());
const dayName = (iso) => {
  const t = today();
  if (iso === t) return "Today";
  if (iso === Todo.shiftDay(t, -1)) return "Yesterday";
  if (iso === Todo.shiftDay(t, 1)) return "Tomorrow";
  return Todo.parse(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

// one add box per view; its target day is ui.addDate (days view) or ui.sel (plan view)
function addBox(ctx, date, apply) {
  const inp = h("input", { class: "tin", placeholder: "", autocomplete: "off", spellcheck: "false" });
  const label = () => { inp.placeholder = "Add to " + dayName(date()); };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.stopPropagation();
      const r = Todo.add(ctx.get(), inp.value, date());
      if (!r) return;
      inp.value = "";
      apply(r.tasks);
    } else if (e.key === "Escape" && inp.value) { e.stopPropagation(); inp.value = ""; }
  });
  label();
  const el = h("label", { class: "abox" }, ic("plus", 15), inp);
  el.label = label;
  el.inp = inp;
  return el;
}

function rowEl(t, ctx, apply, refresh) {
  const el = h("div", { class: "td" + (t.done ? " done" : ""), "data-id": t.id },
    h("button", { class: "ck", title: t.done ? "Mark as open" : "Mark as done", onclick: () => apply(Todo.toggle(ctx.get(), t.id)) }, t.done && ic("check", 12)),
    h("span", { class: "tt", title: t.text }, t.text),
    h("button", { class: "del", title: "Delete", onclick: () => apply(Todo.remove(ctx.get(), t.id)) }, ic("x", 12)));
  // on the row, not the text: the drag captures the pointer on press, which retargets click and dblclick to the row
  el.addEventListener("dblclick", (e) => { if (!e.target.closest("button, input")) rename(el.querySelector(".tt"), t, ctx, apply); });
  drag(el, t, ctx, apply, refresh);
  return el;
}

// double-click: Enter or clicking away saves (trimmed, empty keeps the old text), Esc cancels
function rename(span, t, ctx, apply) {
  const inp = h("input", { class: "fld editing", value: t.text, spellcheck: "false" });
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const next = save ? Todo.rename(ctx.get(), t.id, inp.value) : null;
    inp.classList.remove("editing"); // refresh() skips lists that still hold an editing input
    if (next) apply(next);
    else inp.replaceWith(span);
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  inp.addEventListener("blur", () => finish(true));
  span.replaceWith(inp);
  inp.focus();
  inp.select();
}

// pointer-event drag (HTML5 drag and drop does not work here: Tauri swallows it). Drop on a row (insert before/after it),
// on a day section or on a calendar day (end of that day).
function drag(el, t, ctx, apply, refresh) {
  let sx = 0, sy = 0, down = false, on = false;
  const clear = () => document.querySelectorAll(".ins, .insb, .drop").forEach((e) => e.classList.remove("ins", "insb", "drop"));
  const at = (x, y) => {
    el.style.pointerEvents = "none";
    const hit = document.elementFromPoint(x, y);
    el.style.pointerEvents = "";
    const zone = hit && hit.closest("[data-date]");
    if (!zone) return null;
    const row = hit.closest(".td[data-id]");
    if (!row || row === el) return { zone, row: null, before: null };
    const r = row.getBoundingClientRect(), after = y > r.top + r.height / 2;
    let sib = after ? row.nextElementSibling : row;
    if (sib === el) sib = sib.nextElementSibling;
    while (sib && !sib.matches(".td[data-id]")) sib = sib.nextElementSibling;
    return { zone, row, after, before: sib ? sib.dataset.id : null };
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input")) return;
    sx = e.clientX; sy = e.clientY; down = true; on = false;
    el.setPointerCapture(e.pointerId); // a fast drag leaves the row before the first move event arrives
  });
  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (!on) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      on = true; TodoUI.dragging = true; el.classList.add("drag");
    }
    clear();
    const d = at(e.clientX, e.clientY);
    if (!d) return;
    if (d.row) d.row.classList.add(d.after ? "insb" : "ins");
    else d.zone.classList.add("drop");
  });
  const end = (e) => {
    down = false;
    if (!on) return;
    on = false; TodoUI.dragging = false;
    const d = e.type === "pointerup" ? at(e.clientX, e.clientY) : null;
    clear(); el.classList.remove("drag");
    // the click that follows a drag must not toggle or select anything
    const stop = (ev) => ev.stopImmediatePropagation();
    el.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => el.removeEventListener("click", stop, { capture: true }), 60);
    const next = d && Todo.move(ctx.get(), t.id, d.zone.dataset.date, d.before);
    if (next) apply(next); else refresh();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

function list(tasks, ctx, apply, refresh) {
  return tasks.length ? tasks.map((t) => rowEl(t, ctx, apply, refresh)) : [h("div", { class: "muted tnone" }, "Nothing here")];
}

// root with a fixed top part (add box) and a re-rendered scroll body
function shell(ctx, top, cls, fill) {
  const body = h("div", { class: "scroll tdl " + cls });
  const root = h("div", { class: "tdroot" }, top, body);
  const refresh = () => {
    if (body.querySelector(".editing")) return; // renaming: do not pull the input away
    const st = body.scrollTop;
    fill(body);
    body.scrollTop = st;
  };
  const apply = (next) => {
    if (!next) return;
    ctx.set(next);
    refresh();
    if (ctx.after) ctx.after();
  };
  root.refresh = refresh;
  return { root, apply, refresh, fill: () => refresh() };
}

TodoUI.days = (ctx) => {
  const ui = ctx.ui;
  const box = addBox(ctx, () => ui.addDate || today(), (n) => s.apply(n));
  const s = shell(ctx, box, "days", (body) => {
    const t = today(), tasks = ctx.get();
    const dates = [Todo.shiftDay(t, -1), t, Todo.shiftDay(t, 1)];
    if (ui.addDate && !dates.includes(ui.addDate)) ui.addDate = null; // the day rolled over
    box.label();
    body.replaceChildren(...dates.map((iso) => {
      const rows = Todo.byDate(tasks, iso), open = rows.filter((x) => !x.done).length;
      return h("div", { class: "tsx", "data-date": iso },
        h("div", { class: "tsec" },
          h("span", { class: "tn" + ((ui.addDate || t) === iso ? " on" : "") }, dayName(iso)),
          h("span", { class: "tc" }, open ? open + " open" : ""),
          h("span", { class: "sp" }),
          iso < t && open > 0 && h("button", { class: "tx", title: "Move the open tasks to today", onclick: () => s.apply(Todo.carry(ctx.get(), iso, t)) }, "Move to today"),
          h("button", { class: "ibtn", title: "Add to " + dayName(iso), onclick: () => { ui.addDate = iso; box.label(); s.refresh(); box.inp.focus(); } }, ic("plus", 15))),
        ...list(rows, ctx, s.apply, s.refresh));
    }));
  });
  s.fill();
  return s.root;
};

TodoUI.plan = (ctx) => {
  const ui = ctx.ui;
  const now = () => new Date();
  if (!ui.sel) ui.sel = today();
  if (!ui.month) { const d = Todo.parse(ui.sel); ui.month = { y: d.getFullYear(), m: d.getMonth() }; }
  const box = addBox(ctx, () => ui.sel, (n) => s.apply(n));
  const monthVal = () => `${ui.month.y}-${String(ui.month.m + 1).padStart(2, "0")}`;
  const jump = (y, m) => { const d = new Date(y, m, 1); ui.month = { y: d.getFullYear(), m: d.getMonth() }; s.refresh(); };
  const mon = h("input", { class: "fld mon", type: "month", onchange: (e) => {
    const [y, m] = e.target.value.split("-").map(Number);
    if (y >= 1900 && y <= 2200) jump(y, m - 1); else mon.value = monthVal();
  } });
  const nav = h("div", { class: "pnav" },
    h("button", { class: "ibtn", title: "Previous month", onclick: () => jump(ui.month.y, ui.month.m - 1) }, ic("chevron-left", 18)),
    mon,
    h("button", { class: "ibtn", title: "Next month", onclick: () => jump(ui.month.y, ui.month.m + 1) }, ic("chevron-right", 18)),
    h("button", { class: "tx", onclick: () => { ui.sel = today(); const d = now(); ui.month = { y: d.getFullYear(), m: d.getMonth() }; s.refresh(); } }, "Today"));
  const cal = h("div", { class: "cal" });
  const top = h("div", { class: "ptop" }, nav, cal, box);
  const s = shell(ctx, top, "plan", (body) => {
    const t = today(), open = Todo.openCounts(ctx.get());
    mon.value = monthVal();
    cal.replaceChildren(...DOW.map((d) => h("div", { class: "dow" }, d)), ...Todo.monthGrid(ui.month.y, ui.month.m).map((iso) => {
      const d = Todo.parse(iso);
      return h("button", {
        class: "day" + (d.getMonth() !== ui.month.m ? " other" : "") + (iso === t ? " today" : "") + (iso === ui.sel ? " sel" : ""),
        "data-date": iso,
        onclick: () => { ui.sel = iso; ui.month = { y: d.getFullYear(), m: d.getMonth() }; s.refresh(); },
      }, d.getDate(), open[iso] && h("span", { class: "bdg" }, open[iso]));
    }));
    box.label();
    body.replaceChildren(h("div", { class: "tsx", "data-date": ui.sel },
      h("div", { class: "tsec" }, h("span", { class: "tn on" }, Todo.parse(ui.sel).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }))),
      ...list(Todo.byDate(ctx.get(), ui.sel), ctx, s.apply, s.refresh)));
  });
  s.fill();
  return s.root;
};

window.TodoUI = TodoUI;
})();
