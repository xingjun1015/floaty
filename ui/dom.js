// shared by the island (app.js) and the todo pop-out (popout.js)
(() => {
function h(tag, a = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k === "value" || k === "checked") e[k] = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
function ic(name, size = 18) {
  const s = document.createElement("span");
  s.className = "ic";
  // ICONS holds static, bundled SVG markup (icons.js), never user input
  s.innerHTML = `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${(window.ICONS || {})[name] || ""}</svg>`;
  return s;
}
// opacity, accent and theme from the settings object (same variables the island uses)
function paint(s) {
  const r = document.documentElement.style;
  r.setProperty("--a", (s.opacity == null ? 85 : s.opacity) / 100);
  r.setProperty("--accent", s.sysAccent ? "AccentColor" : s.accent || "#0a84ff");
  document.body.className = `t-${s.theme || "glass"}`;
}
Object.assign(window, { h, ic, paint });
})();
