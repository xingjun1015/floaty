#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::{HashMap, HashSet},
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering::Relaxed},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const NO_WINDOW: u32 = 0x0800_0000;
// the UI pads the island by 10px; this keeps the island about 12px from the screen edge
const MARGIN: f64 = 2.0;
// Label of the todo pop-out. It is NOT an island: it must be skipped by every loop that docks, re-sizes,
// destroys or pins "all windows" (place_all, set_on_top, set_screens) and uses its own monitor (watch_fullscreen).
const TODO: &str = "todo";

// ---------------------------------------------------------------- state

struct St {
    dock: Mutex<String>,
    sizes: Mutex<HashMap<String, (f64, f64)>>,
    mon: Mutex<HashMap<String, usize>>,
    shown: Mutex<HashSet<String>>,
    fs_hidden: Mutex<HashSet<String>>,
    hidden: Mutex<HashSet<String>>,
    clips: Mutex<HashMap<String, [f64; 4]>>,
    hide_fs: AtomicBool,
    on_top: AtomicBool,
}

impl Default for St {
    fn default() -> Self {
        St {
            dock: Mutex::new("b".into()),
            sizes: Mutex::new(HashMap::new()),
            mon: Mutex::new(HashMap::new()),
            shown: Mutex::new(HashSet::new()),
            fs_hidden: Mutex::new(HashSet::new()),
            hidden: Mutex::new(HashSet::new()),
            clips: Mutex::new(HashMap::new()),
            hide_fs: AtomicBool::new(true),
            on_top: AtomicBool::new(true),
        }
    }
}

/// (horizontal, vertical) anchor: -1 start, 0 center, 1 end
fn parts(dock: &str) -> (i8, i8) {
    match dock {
        "tl" => (-1, -1),
        "t" => (0, -1),
        "tr" => (1, -1),
        "l" => (-1, 0),
        "r" => (1, 0),
        "bl" => (-1, 1),
        "br" => (1, 1),
        _ => (0, 1),
    }
}

/// Monitors in a stable order: primary first, then left-to-right, top-to-bottom.
fn mons(app: &AppHandle) -> Vec<tauri::Monitor> {
    let mut v = app.available_monitors().unwrap_or_default();
    let p = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.position().x, m.position().y));
    v.sort_by_key(|m| {
        (
            Some((m.position().x, m.position().y)) != p,
            m.position().x,
            m.position().y,
        )
    });
    v
}

// ---------------------------------------------------------------- docking

/// Physical (x, y, width, height) for a window of logical size lw x lh docked on its monitor.
fn target(w: &WebviewWindow, st: &St, lw: f64, lh: f64) -> Option<(i32, i32, i32, i32)> {
    let ms = mons(w.app_handle());
    let idx = st.mon.lock().unwrap().get(w.label()).copied().unwrap_or(0);
    let m = ms.get(idx).or_else(|| ms.first())?;
    let wa = m.work_area();
    let sf = m.scale_factor();
    let (pw, ph) = ((lw * sf).round() as i32, (lh * sf).round() as i32);
    let (hx, vy) = parts(&st.dock.lock().unwrap());
    let mg = (MARGIN * sf) as i32;
    let (ax, ay) = (wa.position.x, wa.position.y);
    let (aw, ah) = (wa.size.width as i32, wa.size.height as i32);
    // the window may ask for more than the screen (fixed tall canvas): keep it on its monitor
    let (pw, ph) = (pw.min(aw - 2 * mg), ph.min(ah - 2 * mg));
    let x = match hx {
        -1 => ax + mg,
        1 => ax + aw - pw - mg,
        _ => ax + (aw - pw) / 2,
    };
    let y = match vy {
        -1 => ay + mg,
        1 => ay + ah - ph - mg,
        _ => ay + (ah - ph) / 2,
    };
    Some((x, y, pw, ph))
}

/// Re-dock at the stored size (size, dock position or screen changed). Size and position go in a
/// single SetWindowPos so the window is never seen at the new size in the old spot.
fn place(w: &WebviewWindow, st: &St) {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER},
    };
    let (lw, lh) = st
        .sizes
        .lock()
        .unwrap()
        .get(w.label())
        .copied()
        .unwrap_or((300.0, 120.0));
    if let (Some((x, y, pw, ph)), Ok(h)) = (target(w, st, lw, lh), w.hwnd()) {
        unsafe {
            let _ = SetWindowPos(HWND(h.0), None, x, y, pw, ph, SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }
}

fn place_all(app: &AppHandle) {
    let st = app.state::<St>();
    for w in app.webview_windows().values() {
        if w.label() != TODO {
            place(w, &st);
        }
    }
}

// ---------------------------------------------------------------- window commands

#[tauri::command]
fn fit(w: WebviewWindow, st: State<St>, width: f64, height: f64) {
    st.sizes.lock().unwrap().insert(
        w.label().to_string(),
        (width.ceil().max(8.0), height.ceil().max(8.0)),
    );
    place(&w, &st);
    if st.shown.lock().unwrap().insert(w.label().to_string()) {
        guard_frame(&w);
        strip_frame(&w);
        let _ = w.show();
    }
}

/// Limit painting and clicks to rect (logical x, y, w, h inside the window); None = whole window.
/// The window itself never resizes while the island morphs: a resized WebView2 shows stale, shifted
/// or clipped frames for a moment, a region change does not.
#[tauri::command]
fn clip(w: WebviewWindow, st: State<St>, rect: Option<[f64; 4]>) {
    let mut m = st.clips.lock().unwrap();
    match rect {
        Some(r) => m.insert(w.label().to_string(), r),
        None => m.remove(w.label()),
    };
    drop(m);
    if !st.hidden.lock().unwrap().contains(w.label()) {
        set_region(&w, rect);
    }
}

fn set_region(w: &WebviewWindow, rect: Option<[f64; 4]>) {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{CreateRectRgn, SetWindowRgn},
    };
    let Ok(h) = w.hwnd() else { return };
    let sf = w.scale_factor().unwrap_or(1.0);
    unsafe {
        let rgn = rect.map(|[x, y, rw, rh]| {
            CreateRectRgn((x * sf).floor() as i32, (y * sf).floor() as i32, ((x + rw) * sf).ceil() as i32, ((y + rh) * sf).ceil() as i32)
        });
        // the system owns the region after this call
        let _ = SetWindowRgn(HWND(h.0), rgn, true);
    }
}

/// The region the UI asked for can go missing (hide/show, window restyling...) and the whole transparent
/// canvas then swallows clicks meant for the desktop. Re-apply it whenever the real one differs.
fn heal_region(w: &WebviewWindow, want: [f64; 4]) {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::GetWindowRgnBox,
    };
    let Ok(h) = w.hwnd() else { return };
    let sf = w.scale_factor().unwrap_or(1.0);
    let [x, y, rw, rh] = want;
    let exp = ((x * sf).floor() as i32, (y * sf).floor() as i32, ((x + rw) * sf).ceil() as i32, ((y + rh) * sf).ceil() as i32);
    let mut r = RECT::default();
    let t = unsafe { GetWindowRgnBox(HWND(h.0), &mut r) };
    if t.0 == 0 || (r.left, r.top, r.right, r.bottom) != exp {
        set_region(w, Some(want));
    }
}

/// Tao keeps WS_CAPTION | WS_SYSMENU on undecorated windows and only hides the title bar by making the client
/// area cover it. Any activation change makes Windows repaint that hidden title bar: a white strip flashing over
/// the island. Strip the bits for good (idempotent, re-applied if tao puts them back, e.g. on show()).
fn strip_frame(w: &WebviewWindow) {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZEBOX,
            WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
        },
    };
    let Ok(h) = w.hwnd() else { return };
    unsafe {
        let h = HWND(h.0);
        let cur = GetWindowLongPtrW(h, GWL_STYLE);
        let bits =
            (WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME).0 as isize;
        if cur & bits != 0 {
            SetWindowLongPtrW(h, GWL_STYLE, cur & !bits);
            let _ = SetWindowPos(
                h,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

/// tao puts the frame style bits back whenever it rewrites the window styles (show, always-on-top...).
fn watch_frame(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        for (label, w) in app.webview_windows() {
            strip_frame(&w);
            if app.state::<St>().hidden.lock().unwrap().contains(&label) {
                let (w2, a2) = (w.clone(), app.clone());
                let _ = w.run_on_main_thread(move || {
                    use windows::Win32::{Foundation::{HWND, RECT}, Graphics::Gdi::{GetWindowRgnBox, NULLREGION}};
                    let Ok(h) = w2.hwnd() else { return };
                    let mut r = RECT::default();
                    let t = unsafe { GetWindowRgnBox(HWND(h.0), &mut r) };
                    if a2.state::<St>().hidden.lock().unwrap().contains(w2.label()) && t.0 != NULLREGION.0 {
                        set_region(&w2, Some([0.0; 4]));
                    }
                });
                continue;
            }
            let want = app.state::<St>().clips.lock().unwrap().get(&label).copied();
            if let Some(want) = want {
                let (w2, a2) = (w.clone(), app.clone());
                // re-check on the main thread: the UI may have lifted the region meanwhile
                let _ = w.run_on_main_thread(move || {
                    if a2.state::<St>().clips.lock().unwrap().get(w2.label()) == Some(&want) {
                        heal_region(&w2, want);
                    }
                });
            }
        }
    });
}

/// Window-proc filter: never let Windows paint the (hidden) non-client area. Deactivating the window made
/// DefWindowProc paint a title bar into the transparent surface, which then stayed visible above the island.
unsafe extern "system" fn nc_guard(
    h: windows::Win32::Foundation::HWND,
    m: u32,
    wp: windows::Win32::Foundation::WPARAM,
    lp: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::{
        Foundation::{LPARAM, LRESULT},
        UI::{
            Shell::DefSubclassProc,
            WindowsAndMessaging::{WM_NCACTIVATE, WM_NCPAINT},
        },
    };
    match m {
        // 0xAE / 0xAF: undocumented "draw caption" / "draw frame" messages sent by the theme code
        WM_NCPAINT | 0xAE | 0xAF => LRESULT(0),
        // lParam -1: update the active state but do not repaint the frame
        WM_NCACTIVATE => DefSubclassProc(h, m, wp, LPARAM(-1)),
        _ => DefSubclassProc(h, m, wp, lp),
    }
}

fn guard_frame(w: &WebviewWindow) {
    let Ok(h) = w.hwnd() else { return };
    let raw = h.0 as isize;
    // also switch DWM's non-client rendering off for this window
    unsafe {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY};
        let policy = DWMNCRP_DISABLED;
        let _ = DwmSetWindowAttribute(
            windows::Win32::Foundation::HWND(h.0),
            DWMWA_NCRENDERING_POLICY,
            &policy as *const _ as *const _,
            std::mem::size_of_val(&policy) as u32,
        );
    }
    // SetWindowSubclass only works from the thread that owns the window
    let _ = w.run_on_main_thread(move || unsafe {
        let _ = windows::Win32::UI::Shell::SetWindowSubclass(
            windows::Win32::Foundation::HWND(raw as *mut _),
            Some(nc_guard),
            1,
            0,
        );
    });
}

#[tauri::command]
fn set_dock(app: AppHandle, st: State<St>, dock: String) {
    *st.dock.lock().unwrap() = dock;
    place_all(&app);
}

#[tauri::command]
fn set_on_top(app: AppHandle, st: State<St>, on: bool) {
    st.on_top.store(on, Relaxed);
    for w in app.webview_windows().values() {
        if w.label() != TODO {
            let _ = w.set_always_on_top(on);
        }
    }
}

#[tauri::command]
fn set_hide_fs(st: State<St>, on: bool) {
    st.hide_fs.store(on, Relaxed);
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<(), String> {
    let l = app.autolaunch();
    (if on { l.enable() } else { l.disable() }).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct MonInfo {
    index: usize,
    width: u32,
    height: u32,
    primary: bool,
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonInfo> {
    mons(&app)
        .iter()
        .enumerate()
        .map(|(i, m)| MonInfo {
            index: i,
            width: m.size().width,
            height: m.size().height,
            primary: i == 0,
        })
        .collect()
}

// mode is "all" or a monitor index. The first wanted monitor keeps the main window,
// every extra monitor gets its own window (m<index>) running the same UI.
// async: building windows from a sync command deadlocks on Windows
#[tauri::command(async)]
fn set_screens(app: AppHandle, st: State<St>, mode: String) -> Result<(), String> {
    let n = mons(&app).len().max(1);
    let want: Vec<usize> = if mode == "all" {
        (0..n).collect()
    } else {
        vec![mode.parse::<usize>().unwrap_or(0).min(n - 1)]
    };
    let label = |i: usize| {
        if i == want[0] {
            "main".to_string()
        } else {
            format!("m{i}")
        }
    };
    {
        let mut m = st.mon.lock().unwrap();
        m.clear();
        for &i in &want {
            m.insert(label(i), i);
        }
    }
    for (l, w) in app.webview_windows() {
        if l != "main" && l != TODO && !want.iter().any(|&i| label(i) == l) {
            st.shown.lock().unwrap().remove(&l);
            let _ = w.destroy();
        }
    }
    for &i in &want {
        let l = label(i);
        match app.get_webview_window(&l) {
            Some(w) => place(&w, &st),
            None => {
                tauri::WebviewWindowBuilder::new(
                    &app,
                    &l,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Floaty")
                .inner_size(300.0, 120.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(st.on_top.load(Relaxed))
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// "Hide" = empty window region (nothing painted, no clicks); "show" = restore the clip region.
/// tao's hide()/show() flashes white on a transparent WebView2 window, this keeps the WebView rendering.
fn set_hidden(app: &AppHandle, w: &WebviewWindow, hide: bool) {
    let st = app.state::<St>();
    if hide {
        st.hidden.lock().unwrap().insert(w.label().to_string());
        set_region(w, Some([0.0; 4]));
    } else {
        st.hidden.lock().unwrap().remove(w.label());
        let want = st.clips.lock().unwrap().get(w.label()).copied();
        set_region(w, want);
    }
    strip_frame(w);
}

fn show_all(app: &AppHandle) {
    app.state::<St>().fs_hidden.lock().unwrap().clear();
    for w in app.webview_windows().values() {
        set_hidden(app, w, false);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

fn toggle(app: &AppHandle) {
    let wins = app.webview_windows();
    let hidden = app.state::<St>().hidden.lock().unwrap().clone();
    if wins.keys().any(|l| !hidden.contains(l)) {
        for w in wins.values() {
            set_hidden(app, w, true);
        }
    } else {
        show_all(app);
    }
}

fn hotkey(app: &AppHandle) {
    let hidden = !app.state::<St>().hidden.lock().unwrap().is_empty();
    show_all(app);
    let _ = app.emit("hotkey", if hidden { "expand" } else { "toggle" });
}

// ---------------------------------------------------------------- todo pop-out

#[derive(serde::Deserialize)]
struct Geo {
    x: Option<i32>,
    y: Option<i32>,
    w: f64,
    h: f64,
    top: bool,
}

/// Open (or focus) / close the todo pop-out. async: building windows from a sync command deadlocks on Windows.
#[tauri::command(async)]
fn todo_window(app: AppHandle, open: bool, geo: Option<Geo>) -> Result<(), String> {
    let st = app.state::<St>();
    if !open {
        st.hidden.lock().unwrap().remove(TODO);
        st.fs_hidden.lock().unwrap().remove(TODO);
        if let Some(w) = app.get_webview_window(TODO) {
            let _ = w.destroy();
        }
        return Ok(());
    }
    if let Some(w) = app.get_webview_window(TODO) {
        set_hidden(&app, &w, false);
        let _ = w.set_focus();
        return Ok(());
    }
    let g = geo.unwrap_or(Geo { x: None, y: None, w: 340.0, h: 480.0, top: true });
    let w = tauri::WebviewWindowBuilder::new(&app, TODO, tauri::WebviewUrl::App("todo.html".into()))
        .title("Floaty Todo")
        .inner_size(g.w.max(280.0), g.h.max(240.0))
        .min_inner_size(280.0, 240.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(true)
        .always_on_top(g.top)
        .visible(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    // restore the last position, unless that spot is no longer on any screen
    if let (Some(x), Some(y)) = (g.x, g.y) {
        let on = app.available_monitors().unwrap_or_default().iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x && y >= p.y && x < p.x + s.width as i32 - 40 && y < p.y + s.height as i32 - 40
        });
        if on {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    Ok(())
}

/// The pop-out's own "keep on top" pin. tao rewrites the window styles here, so strip the frame bits again.
#[tauri::command]
fn todo_top(w: WebviewWindow, on: bool) {
    let _ = w.set_always_on_top(on);
    strip_frame(&w);
}

/// Called by the pop-out after its first render, so it never shows a blank white frame.
#[tauri::command]
fn todo_ready(w: WebviewWindow) {
    guard_frame(&w);
    strip_frame(&w);
    let _ = w.show();
}

// ---------------------------------------------------------------- fullscreen watcher

/// Top-left of the monitor hosting a fullscreen foreground window that is not ours.
fn fullscreen_monitor(own: &HashSet<isize>) -> Option<(i32, i32)> {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect,
    };
    unsafe {
        let h = GetForegroundWindow();
        if h.0.is_null() || own.contains(&(h.0 as isize)) {
            return None;
        }
        let mut cls = [0u16; 64];
        let n = GetClassNameW(h, &mut cls).max(0) as usize;
        let c = String::from_utf16_lossy(&cls[..n]);
        if matches!(c.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
            return None;
        }
        let mut r = windows::Win32::Foundation::RECT::default();
        GetWindowRect(h, &mut r).ok()?;
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
            return None;
        }
        let m = mi.rcMonitor;
        (r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom)
            .then_some((m.left, m.top))
    }
}

fn watch_fullscreen(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let st = app.state::<St>();
        let wins = app.webview_windows();
        let own: HashSet<isize> = wins
            .values()
            .filter_map(|w| w.hwnd().ok().map(|h| h.0 as isize))
            .collect();
        let fs = if st.hide_fs.load(Relaxed) {
            fullscreen_monitor(&own)
        } else {
            None
        };
        let ms = mons(&app);
        for (label, w) in &wins {
            let idx = st.mon.lock().unwrap().get(label).copied().unwrap_or(0);
            let pos = if label == TODO {
                w.current_monitor().ok().flatten().map(|m| (m.position().x, m.position().y))
            } else {
                ms.get(idx).map(|m| (m.position().x, m.position().y))
            };
            let full = fs.is_some() && fs == pos;
            let user_hidden = st.hidden.lock().unwrap().contains(label);
            if full && !user_hidden {
                st.fs_hidden.lock().unwrap().insert(label.clone());
                set_hidden(&app, w, true);
            } else if !full && st.fs_hidden.lock().unwrap().remove(label) {
                set_hidden(&app, w, false);
            }
        }
    });
}

// ---------------------------------------------------------------- items

#[derive(Serialize)]
struct Item {
    name: String,
    path: String,
    kind: &'static str,
    exe: Option<String>,
}

fn resolve_lnk(p: &str) -> Option<String> {
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED, STGM_READ,
            },
            UI::Shell::{IShellLinkW, ShellLink},
        },
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let pf: IPersistFile = link.cast().ok()?;
        let wide: Vec<u16> = p.encode_utf16().chain(Some(0)).collect();
        pf.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
        let mut buf = [0u16; 260];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..n])).filter(|s| !s.is_empty())
    }
}

fn exe_name(p: &str) -> Option<String> {
    let f = Path::new(p).file_name()?.to_string_lossy().to_lowercase();
    f.ends_with(".exe").then_some(f)
}

#[tauri::command(async)]
fn classify(paths: Vec<String>) -> Vec<Item> {
    paths
        .into_iter()
        .map(|p| {
            let path = Path::new(&p);
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let (kind, exe, name) = if path.is_dir() {
                (
                    "folder",
                    None,
                    path.file_name().map(|n| n.to_string_lossy().into_owned()),
                )
            } else if matches!(
                ext.as_str(),
                "exe" | "lnk" | "bat" | "cmd" | "msi" | "appref-ms"
            ) {
                let exe = match ext.as_str() {
                    "exe" => exe_name(&p),
                    "lnk" => resolve_lnk(&p).and_then(|t| exe_name(&t)),
                    _ => None,
                };
                (
                    "app",
                    exe,
                    path.file_stem().map(|n| n.to_string_lossy().into_owned()),
                )
            } else {
                (
                    "file",
                    None,
                    path.file_name().map(|n| n.to_string_lossy().into_owned()),
                )
            };
            Item {
                name: name.unwrap_or_else(|| p.clone()),
                path: p,
                kind,
                exe,
            }
        })
        .collect()
}

#[tauri::command(async)]
fn launch(app: AppHandle, kind: String, path: String) -> Result<(), String> {
    match kind.as_str() {
        "url" => app
            .opener()
            .open_url(path, None::<&str>)
            .map_err(|e| e.to_string()),
        // own visible console that stays open (/K), so the output of the command can be read
        "cmd" => Command::new("cmd")
            .raw_arg(format!("/K {path}"))
            .creation_flags(0x0000_0010) // CREATE_NEW_CONSOLE
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        _ => app
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string()),
    }
}

/// (hwnd, class, title) of every visible top-level window.
fn top_windows() -> Vec<(isize, String, String)> {
    use windows::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowTextW, IsWindowVisible},
    };
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> windows::core::BOOL {
        let out = &mut *(l.0 as *mut Vec<(isize, String, String)>);
        if IsWindowVisible(h).as_bool() {
            let (mut c, mut t) = ([0u16; 64], [0u16; 512]);
            let (cn, tn) = (GetClassNameW(h, &mut c), GetWindowTextW(h, &mut t));
            if tn > 0 {
                out.push((h.0 as isize, String::from_utf16_lossy(&c[..cn as usize]), String::from_utf16_lossy(&t[..tn as usize])));
            }
        }
        windows::core::BOOL(1)
    }
    let mut v: Vec<(isize, String, String)> = vec![];
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut v as *mut _ as isize));
    }
    v
}

const BROWSER_CLASSES: [&str; 2] = ["Chrome_WidgetWin_1", "MozillaWindowClass"];
const BROWSER_NAMES: [&str; 6] = ["chrome", "edge", "firefox", "brave", "opera", "vivaldi"];

/// Page title of the browser window in front, without the " - Google Chrome" suffix.
#[tauri::command(async)]
fn browser_title() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let fg = unsafe { GetForegroundWindow() }.0 as isize;
    let (_, class, title) = top_windows().into_iter().find(|w| w.0 == fg)?;
    let cut = title.rfind(" - ").or_else(|| title.rfind(" \u{2014} "))?;
    let (page, browser) = (&title[..cut], title[cut..].to_lowercase());
    // drop a leading unread counter such as "(465) ": it changes all the time
    let page = match page.strip_prefix('(').and_then(|r| r.split_once(") ")) {
        Some((n, rest)) if n.chars().all(|c| c.is_ascii_digit()) => rest,
        _ => page,
    };
    (BROWSER_CLASSES.contains(&class.as_str()) && BROWSER_NAMES.iter().any(|b| browser.contains(b)) && !page.is_empty())
        .then(|| page.to_string())
}

// ---- browser tabs (UI Automation: browsers expose their tab strip as TabItem elements)
use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomationElement};

/// A UIA element stays valid for as long as its tab exists, also while the tab navigates to other pages.
struct TabEl(IUIAutomationElement);
// SAFETY: UIA proxies are free-threaded and COM is initialised as MTA on every thread that uses them
unsafe impl Send for TabEl {}
/// Floaty item id -> (top-level browser window, its tab)
static TABS: std::sync::LazyLock<Mutex<HashMap<String, (isize, TabEl)>>> = std::sync::LazyLock::new(Default::default);

fn uia() -> Option<IUIAutomation> {
    use windows::Win32::{
        System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
        UI::Accessibility::CUIAutomation,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
    }
}

/// All tab elements of one browser window.
fn tabs_of(ua: &IUIAutomation, hwnd: isize) -> Vec<IUIAutomationElement> {
    use windows::Win32::{
        Foundation::HWND,
        System::Variant::VARIANT,
        UI::Accessibility::{TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_TabItemControlTypeId},
    };
    unsafe {
        let Ok(cond) = ua.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0)) else {
            return vec![];
        };
        let Ok(root) = ua.ElementFromHandle(HWND(hwnd as *mut _)) else { return vec![] };
        let Ok(arr) = root.FindAll(TreeScope_Descendants, &cond) else { return vec![] };
        (0..arr.Length().unwrap_or(0)).filter_map(|i| arr.GetElement(i).ok()).collect()
    }
}

fn tab_name(t: &IUIAutomationElement) -> Option<String> {
    // Chrome and Edge append " - Memory usage - 94.9 MB" to the name of a tab
    unsafe { t.CurrentName().ok().map(|n| n.to_string().split(" - Memory usage").next().unwrap_or_default().to_string()) }
}

/// Select the tab and raise its window. False if the tab is gone.
fn show_tab(hwnd: isize, tab: &IUIAutomationElement) -> bool {
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Accessibility::{IUIAutomationSelectionItemPattern, UIA_SelectionItemPatternId},
            WindowsAndMessaging::{IsIconic, IsWindow, SetForegroundWindow, ShowWindow, SW_RESTORE},
        },
    };
    unsafe {
        let h = HWND(hwnd as *mut _);
        if !IsWindow(Some(h)).as_bool() || tab_name(tab).is_none() {
            return false;
        }
        let Ok(sel) = tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) else {
            return false;
        };
        if sel.Select().is_err() {
            return false;
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let _ = SetForegroundWindow(h);
        true
    }
}

/// Jump to the tab that belongs to this item: first the exact tab we remembered (it survives navigating to other
/// pages), else any tab whose title contains `title` (after a Floaty restart). Returns the tab's current title.
#[tauri::command(async)]
fn focus_tab(id: String, title: String) -> Option<String> {
    let ua = uia()?;
    let known = TABS.lock().unwrap().remove(&id);
    if let Some((h, TabEl(t))) = known {
        if show_tab(h, &t) {
            let name = tab_name(&t);
            TABS.lock().unwrap().insert(id, (h, TabEl(t)));
            return name;
        }
    }
    let want = title.to_lowercase();
    if want.is_empty() {
        return None;
    }
    for (h, class, _) in top_windows() {
        if !BROWSER_CLASSES.contains(&class.as_str()) {
            continue;
        }
        for t in tabs_of(&ua, h) {
            let name = tab_name(&t).unwrap_or_default();
            if name.to_lowercase().contains(&want) && show_tab(h, &t) {
                TABS.lock().unwrap().insert(id, (h, TabEl(t)));
                return Some(name);
            }
        }
    }
    None
}

/// Remember the selected tab of the browser window in front as this item's tab. Returns its title.
#[tauri::command(async)]
fn learn_tab(id: String) -> Option<String> {
    use windows::Win32::UI::{
        Accessibility::{IUIAutomationSelectionItemPattern, UIA_SelectionItemPatternId},
        WindowsAndMessaging::GetForegroundWindow,
    };
    let ua = uia()?;
    let fg = unsafe { GetForegroundWindow() }.0 as isize;
    let (_, class, _) = top_windows().into_iter().find(|w| w.0 == fg)?;
    // browsers and File Explorer (Windows 11) both expose their tabs
    if !BROWSER_CLASSES.contains(&class.as_str()) && class != "CabinetWClass" {
        return None;
    }
    for t in tabs_of(&ua, fg) {
        let selected = unsafe {
            t.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                .and_then(|p| p.CurrentIsSelected())
                .map(|b| b.as_bool())
                .unwrap_or(false)
        };
        if selected {
            let name = tab_name(&t)?;
            TABS.lock().unwrap().insert(id, (fg, TabEl(t)));
            return Some(name);
        }
    }
    None
}

/// Floaty item id -> top-level window that item opened (files, folders and apps without tabs)
static WINS: std::sync::LazyLock<Mutex<HashMap<String, isize>>> = std::sync::LazyLock::new(Default::default);

/// Handles of the visible top-level windows right now, to tell afterwards which window a launch created.
#[tauri::command(async)]
fn window_ids() -> Vec<isize> {
    top_windows().into_iter().map(|w| w.0).collect()
}

/// Bring the window this item opened earlier to the front. False if it is gone.
#[tauri::command(async)]
fn focus_window(id: String) -> bool {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE},
    };
    let Some(h) = WINS.lock().unwrap().get(&id).copied() else { return false };
    unsafe {
        let hw = HWND(h as *mut _);
        if !IsWindow(Some(hw)).as_bool() || !IsWindowVisible(hw).as_bool() {
            WINS.lock().unwrap().remove(&id);
            return false;
        }
        if IsIconic(hw).as_bool() {
            let _ = ShowWindow(hw, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hw);
    }
    true
}

/// Remember the window in front as this item's window, unless it is Floaty, the desktop/taskbar, or was already
/// open before the launch (`before`). The handle survives navigating inside the window (e.g. to another folder).
#[tauri::command(async)]
fn learn_window(id: String, before: Vec<isize>) -> bool {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };
    let fg = unsafe { GetForegroundWindow() }.0 as isize;
    if fg == 0 || before.contains(&fg) {
        return false;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(HWND(fg as *mut _), Some(&mut pid)) };
    if pid == std::process::id() {
        return false;
    }
    let Some((_, class, _)) = top_windows().into_iter().find(|w| w.0 == fg) else { return false };
    if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
        return false;
    }
    WINS.lock().unwrap().insert(id, fg);
    true
}

#[tauri::command(async)]
fn run_admin(path: String) -> Result<(), String> {
    let q = path.replace('\'', "''");
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &format!("Start-Process -FilePath '{q}' -Verb RunAs"),
        ])
        .creation_flags(NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn reveal(path: String) -> Result<(), String> {
    Command::new("explorer")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn running_exes() -> Vec<String> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };
    let mut set = HashSet::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return vec![];
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(260);
                set.insert(String::from_utf16_lossy(&e.szExeFile[..n]).to_lowercase());
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    set.into_iter().collect()
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    store: bool,
}

fn walk(dir: &Path, depth: u8, out: &mut Vec<Entry>) {
    if depth > 3 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, depth + 1, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")) {
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !name.to_lowercase().contains("uninstall") {
                out.push(Entry {
                    name,
                    path: p.to_string_lossy().into_owned(),
                    store: false,
                });
            }
        }
    }
}

#[tauri::command(async)]
fn start_menu() -> Vec<Entry> {
    let mut v = vec![];
    for var in ["ProgramData", "APPDATA"] {
        if let Some(b) = std::env::var_os(var) {
            walk(
                &PathBuf::from(b).join(r"Microsoft\Windows\Start Menu\Programs"),
                0,
                &mut v,
            );
        }
    }
    // Store (UWP) apps have no .lnk: ask Windows for the Start apps and keep the packaged ones (AppID contains "!")
    if let Ok(o) = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-StartApps | ForEach-Object { $_.Name + [char]9 + $_.AppID }"])
        .creation_flags(NO_WINDOW)
        .output()
    {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some((name, id)) = line.split_once('\t') {
                if id.contains('!') && !name.trim().is_empty() {
                    v.push(Entry { name: name.trim().to_string(), path: format!("shell:AppsFolder\\{}", id.trim()), store: true });
                }
            }
        }
    }
    v.sort_by_key(|e| e.name.to_lowercase());
    v.dedup_by_key(|e| e.name.to_lowercase());
    v
}

// ---------------------------------------------------------------- widgets

#[tauri::command(async)]
fn read_clipboard() -> Option<String> {
    arboard::Clipboard::new()
        .ok()?
        .get_text()
        .ok()
        .filter(|t| !t.trim().is_empty())
}

#[derive(Serialize, Default, Clone)]
struct Media {
    active: bool,
    playing: bool,
    title: String,
    artist: String,
}

fn media_now() -> windows::core::Result<Media> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Mgr,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Ps,
    };
    let s = Mgr::RequestAsync()?.get()?.GetCurrentSession()?;
    let p = s.TryGetMediaPropertiesAsync()?.get()?;
    let playing = s.GetPlaybackInfo()?.PlaybackStatus()? == Ps::Playing;
    Ok(Media {
        active: true,
        playing,
        title: p.Title()?.to_string(),
        artist: p.Artist()?.to_string(),
    })
}

/// The system media query can block for 10+ seconds (or forever), so it never runs on a command thread:
/// one worker refreshes MEDIA while somebody is asking, and the command just returns the cached value.
static MEDIA: Mutex<Option<(Media, Instant)>> = Mutex::new(None);
static MEDIA_ASKED: Mutex<Option<Instant>> = Mutex::new(None);

#[tauri::command]
fn media_info() -> Media {
    static START: std::sync::Once = std::sync::Once::new();
    *MEDIA_ASKED.lock().unwrap() = Some(Instant::now());
    START.call_once(|| {
        std::thread::spawn(|| loop {
            let asked = MEDIA_ASKED.lock().unwrap().map_or(false, |t| t.elapsed() < Duration::from_secs(20));
            if asked {
                let m = media_now().unwrap_or_default();
                *MEDIA.lock().unwrap() = Some((m, Instant::now()));
            }
            std::thread::sleep(Duration::from_secs(2));
        });
    });
    MEDIA.lock().unwrap().as_ref().map(|(m, _)| m.clone()).unwrap_or_default()
}

#[tauri::command(async)]
fn media_ctl(op: String) {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Mgr;
    let _ = (|| -> windows::core::Result<bool> {
        let s = Mgr::RequestAsync()?.get()?.GetCurrentSession()?;
        match op.as_str() {
            "toggle" => s.TryTogglePlayPauseAsync()?.get(),
            "next" => s.TrySkipNextAsync()?.get(),
            _ => s.TrySkipPreviousAsync()?.get(),
        }
    })();
}

// ---------------------------------------------------------------- config

/// Debug builds can redirect all data files with FLOATY_DATA_DIR so tests never touch the real config.
fn data_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("FLOATY_DATA_DIR") {
        let d = PathBuf::from(d);
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        return Ok(d.join(file));
    }
    let d = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join(file))
}

fn cfg_path(app: &AppHandle) -> Result<PathBuf, String> {
    data_path(app, "config.json")
}

/// Atomic write (tmp + rename), then tell the other windows (event payload { from, text }).
fn write_shared(app: &AppHandle, w: &WebviewWindow, file: &str, event: &str, text: String) -> Result<(), String> {
    let p = data_path(app, file)?;
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, &text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    if app.webview_windows().len() > 1 {
        let _ = app.emit(event, serde_json::json!({ "from": w.label(), "text": text }));
    }
    Ok(())
}

#[tauri::command]
fn load_config(app: AppHandle) -> Option<String> {
    fs::read_to_string(cfg_path(&app).ok()?).ok()
}

#[tauri::command]
fn save_config(app: AppHandle, w: WebviewWindow, text: String) -> Result<(), String> {
    write_shared(&app, &w, "config.json", "cfg", text)
}

// todos live in their own file: tasks pile up, and every window saves them on each edit
#[tauri::command]
fn load_todos(app: AppHandle) -> Option<String> {
    fs::read_to_string(data_path(&app, "todos.json").ok()?).ok()
}

#[tauri::command]
fn save_todos(app: AppHandle, w: WebviewWindow, text: String) -> Result<(), String> {
    write_shared(&app, &w, "todos.json", "todos", text)
}

/// Writes the given export text (JS builds it) to a path picked in the save dialog.
#[tauri::command]
fn export_todos(dest: String, text: String) -> Result<(), String> {
    fs::write(dest, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_todos(src: String) -> Result<String, String> {
    fs::read_to_string(src).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_config(app: AppHandle, dest: String) -> Result<(), String> {
    fs::copy(cfg_path(&app)?, dest)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn import_config(src: String) -> Result<String, String> {
    let text = fs::read_to_string(src).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if v.get("profiles").is_none() {
        return Err("not a Floaty config".into());
    }
    Ok(text)
}

// ---------------------------------------------------------------- main

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_all(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        hotkey(app);
                    }
                })
                .build(),
        )
        .manage(St::default())
        .invoke_handler(tauri::generate_handler![
            fit,
            clip,
            set_dock,
            set_on_top,
            set_hide_fs,
            set_autostart,
            set_screens,
            list_monitors,
            classify,
            launch,
            run_admin,
            reveal,
            running_exes,
            browser_title,
            focus_tab,
            learn_tab,
            window_ids,
            focus_window,
            learn_window,
            start_menu,
            read_clipboard,
            media_info,
            media_ctl,
            load_config,
            save_config,
            export_config,
            import_config,
            load_todos,
            save_todos,
            export_todos,
            import_todos,
            todo_window,
            todo_top,
            todo_ready
        ])
        .setup(|app| {
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Floaty")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "toggle" => toggle(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|t, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        // a tray double-click sends two Click{Up}: ignore the 2nd or the island blinks off/on
                        static LAST: Mutex<Option<Instant>> = Mutex::new(None);
                        let dbl = Duration::from_millis(unsafe {
                            windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime()
                        } as u64);
                        let mut last = LAST.lock().unwrap();
                        if last.is_some_and(|l| l.elapsed() < dbl) {
                            return;
                        }
                        *last = Some(Instant::now());
                        drop(last);
                        toggle(t.app_handle());
                    }
                })
                .build(app)?;
            // ponytail: fixed hotkey; make configurable if Alt+Space collides with another tool
            let _ = app.global_shortcut().register("Alt+Space");
            watch_fullscreen(app.handle().clone());
            watch_frame(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Floaty");
}
