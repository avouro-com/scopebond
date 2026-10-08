// The Scopebond tray for Windows: the icon, its menu and the status panel, drawn from the agent's tray model. No console
// window, ever.
#![windows_subsystem = "windows"]

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use scopebond_tray::agent::{scopebond_home, AgentClient};
use scopebond_tray::icon::{self, IconState};
use scopebond_tray::menu::{self, AgentLink, Autostart, Command, Entry, MenuContext};
use scopebond_tray::model::{Notifications, TrayAction, TrayAnswer};
use scopebond_tray::notify::{Kind, Notifier, Toast};
use scopebond_tray::panel::{self, Area, PANEL_HEIGHT, PANEL_WIDTH};
use scopebond_tray::supervise::{self, Decision, Observation, Supervisor};
use scopebond_tray::{log, win};
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const TRAY_ID: &str = "scopebond";
const PANEL: &str = "panel";
/// How often the tray asks the agent for its model when nothing else asks sooner.
const REFRESH_EVERY: Duration = Duration::from_secs(30);
/// How long a result stays on the panel.
const NOTE_FOR: Duration = Duration::from_secs(120);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Note {
    text: String,
    at: Instant,
}

/// What was last drawn, so the icon, tooltip and menu change only when they should.
#[derive(Default)]
struct Drawn {
    spec: Vec<Entry>,
    icon: Option<IconState>,
    tooltip: String,
}

struct Shared {
    client: AgentClient,
    answer: Mutex<Option<TrayAnswer>>,
    link: Mutex<AgentLink>,
    /// Since when the agent's pipe has accepted connections without giving a model (none in time, or an error).
    model_failing_since: Mutex<Option<Instant>>,
    note: Mutex<Option<Note>>,
    /// The action running now (one at a time), so the panel can say so and not start a second.
    busy: Mutex<Option<String>>,
    wake: (Mutex<bool>, Condvar),
    drawn: Mutex<Drawn>,
    panel_closed_at: Mutex<Option<Instant>>,
    /// Where the tray icon is on screen (physical pixels), for placing the panel.
    anchor: Mutex<Option<(f64, f64)>>,
    /// What supervision knows when the agent's model is not there (starting, stopped, waiting for a replacement…).
    supervised: Mutex<AgentLink>,
    /// The person asked for the agent to be started.
    start_requested: AtomicBool,
    notifier: Mutex<Notifier>,
    /// Since when the agent has not answered (for a notification when that lasts).
    silent_since: Mutex<Option<Instant>>,
}

impl Shared {
    fn new(client: AgentClient) -> Shared {
        Shared {
            client,
            answer: Mutex::new(None),
            link: Mutex::new(AgentLink::Starting),
            model_failing_since: Mutex::new(None),
            note: Mutex::new(None),
            busy: Mutex::new(None),
            wake: (Mutex::new(false), Condvar::new()),
            drawn: Mutex::new(Drawn::default()),
            panel_closed_at: Mutex::new(None),
            anchor: Mutex::new(None),
            supervised: Mutex::new(AgentLink::Starting),
            start_requested: AtomicBool::new(false),
            notifier: Mutex::new(Notifier::new()),
            silent_since: Mutex::new(None),
        }
    }

    /// Ask the agent again now instead of at the next half minute.
    fn wake(&self) {
        *lock(&self.wake.0) = true;
        self.wake.1.notify_all();
    }

    fn sleep(&self, at_most: Duration) {
        let mut woken = lock(&self.wake.0);
        if !*woken {
            woken = self.wake.1.wait_timeout(woken, at_most).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
        *woken = false;
    }

    fn set_note(&self, text: String) {
        log::line(&format!("note: {text}"));
        *lock(&self.note) = Some(Note { text, at: Instant::now() });
    }

    fn snapshot(&self) -> (Option<TrayAnswer>, AgentLink) {
        (lock(&self.answer).clone(), *lock(&self.link))
    }
}

fn icon_image(state: IconState) -> Image<'static> {
    Image::new_owned(icon::render(state, 32), 32, 32)
}

fn autostart_state() -> Autostart {
    if win::read_string(true, win::RUN_KEY, "Scopebond").is_some() {
        Autostart::Managed
    } else if win::read_string(false, win::RUN_KEY, "Scopebond").is_some() {
        Autostart::On
    } else {
        Autostart::Off
    }
}

/// The person's own choice about starting with Windows, kept in the Scopebond folder: an upgrade of the installer puts
/// the Run value back, and the tray takes it out again when the person had turned it off.
const TRAY_SETTINGS: &str = "tray-settings.json";

fn start_with_windows_choice(home: &Path) -> Option<bool> {
    let text = std::fs::read(home.join(TRAY_SETTINGS)).ok()?;
    serde_json::from_slice::<Value>(&text).ok()?.get("start_with_windows")?.as_bool()
}

fn set_start_with_windows(home: &Path, on: bool) -> bool {
    let done = if on {
        std::env::current_exe()
            .map(|exe| win::set_user_string(win::RUN_KEY, "Scopebond", &format!("\"{}\"", exe.display())))
            .unwrap_or(false)
    } else {
        win::delete_user_value(win::RUN_KEY, "Scopebond")
    };
    let _ = std::fs::write(home.join(TRAY_SETTINGS), format!("{}\n", json!({ "start_with_windows": on })));
    done
}

fn menu_item(app: &AppHandle, entry: &Entry) -> tauri::Result<Box<dyn IsMenuItem<tauri::Wry>>> {
    Ok(match entry {
        Entry::Item { id, label, enabled } => Box::new(MenuItem::with_id(app, id.clone(), label, *enabled, None::<&str>)?),
        Entry::Check { id, label, checked, enabled } => {
            Box::new(CheckMenuItem::with_id(app, id.clone(), label, *enabled, *checked, None::<&str>)?)
        }
        Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        Entry::Submenu { label, entries } => {
            let sub = Submenu::new(app, label, true)?;
            for e in entries {
                sub.append(&*menu_item(app, e)?)?;
            }
            Box::new(sub)
        }
    })
}

fn build_menu(app: &AppHandle, spec: &[Entry]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for entry in spec {
        menu.append(&*menu_item(app, entry)?)?;
    }
    Ok(menu)
}

fn create_tray(app: &AppHandle, shared: &Arc<Shared>) -> tauri::Result<tauri::tray::TrayIcon> {
    let (s_menu, s_tray) = (shared.clone(), shared.clone());
    let starting = menu::menu_spec(None, &MenuContext { link: AgentLink::Starting, autostart: autostart_state(), notifications: Notifications::Problems });
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_image(IconState::Working))
        .tooltip("Scopebond — starting")
        .menu(&build_menu(app, &starting)?)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let answer = lock(&s_menu.answer).clone();
            if let Some(command) = menu::command_for(event.id().as_ref(), answer.as_ref()) {
                dispatch(app, &s_menu, command);
            }
        })
        .on_tray_icon_event(move |tray, event| on_tray_event(tray.app_handle(), &s_tray, event))
        .build(app)?;
    *lock(&shared.drawn) = Drawn { spec: starting, icon: Some(IconState::Working), tooltip: "Scopebond — starting".into() };
    Ok(tray)
}

/// The agent program: `scopebond-agent.exe` beside the tray in the install folder.
fn agent_program() -> Option<PathBuf> {
    std::env::current_exe().ok().map(|p| p.with_file_name("scopebond-agent.exe"))
}

/// Start `scopebond-agent.exe run` with no console window. It writes its own log and leaves the tray to this program.
fn start_agent(program: &Path, home: &Path) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::fs::create_dir_all(home);
    std::process::Command::new(program)
        .arg("run")
        .env("SCOPEBOND_AGENT_TRAY", "off")
        .env("SCOPEBOND_AGENT_LOG", home.join("agent.log"))
        .env_remove("SCOPEBOND_AGENT_AFTER_PID")
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

/// Another agent is starting: its lock is fresh and its process alive, and it is not the tray's own child.
fn other_agent_starting(home: &Path, own: Option<u32>) -> bool {
    let Ok(text) = std::fs::read_to_string(home.join("agent.lock")) else { return false };
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    match supervise::read_lock(&text, now_ms) {
        Some((pid, true)) => Some(pid) != own && win::process_alive(pid),
        _ => false,
    }
}

/// Whether the agent's pipe has accepted connections without a model (or with only errors) for UNRESPONSIVE_AFTER.
fn unresponsive(shared: &Shared, now: Instant) -> bool {
    lock(&shared.model_failing_since).is_some_and(|since| now.duration_since(since) >= supervise::UNRESPONSIVE_AFTER)
}

/// End the agent that does not answer: the tray's own child when it is the one in `agent.json`, or else the process
/// `agent.json` names, but only when that process runs the agent program beside this tray. Never anything else.
fn end_hung_agent(child: &mut Option<Child>, pid: u32, program: Option<&Path>) -> Result<(), String> {
    if let Some(own) = child.as_mut() {
        if pid == 0 || own.id() == pid {
            own.kill().map_err(|e| e.to_string())?;
            let _ = own.wait();
            *child = None;
            return Ok(());
        }
    }
    let program = program.ok_or("there is no agent program beside the tray")?;
    win::end_if_running(pid, program, Duration::from_secs(10))
}

/// Keep the agent running (every rule is in supervise.rs). It looks every second while the agent is not answering, and
/// every three seconds while it is.
fn supervise_agent(shared: &Arc<Shared>) {
    let program = agent_program();
    let home = shared.client.home().to_path_buf();
    let mut child: Option<Child> = None;
    let mut sup = Supervisor::new();
    loop {
        let step = std::panic::catch_unwind(AssertUnwindSafe(|| {
            if shared.start_requested.swap(false, Ordering::SeqCst) {
                sup.start_requested();
            }
            let child_state = match child.as_mut().map(|c| c.try_wait()) {
                None => supervise::Child::None,
                Some(Ok(None)) => supervise::Child::Running,
                Some(Ok(Some(status))) => {
                    log::line(&format!("the agent exited ({status})"));
                    supervise::Child::Exited(status.code())
                }
                Some(Err(_)) => supervise::Child::Exited(None),
            };
            if matches!(child_state, supervise::Child::Exited(_)) {
                child = None;
            }
            let own = child.as_ref().map(|c| c.id());
            let answering = shared.client.answers();
            let observation = Observation {
                answering,
                child: child_state,
                other_starting: other_agent_starting(&home, own),
                endpoint_file: shared.client.endpoint().is_some(),
                agent_present: program.as_ref().is_some_and(|p| p.exists()),
                unresponsive: answering && unresponsive(shared, Instant::now()),
                stopped_on_purpose: home.join(supervise::STOPPED_FILE).exists(),
            };
            let before = sup.link();
            let now = Instant::now();
            let decision = sup.tick(&observation, now);
            let start = match decision {
                Decision::Wait => false,
                Decision::Start => true,
                Decision::Restart => {
                    let pid = shared.client.endpoint().map(|e| e.pid).unwrap_or(0);
                    match end_hung_agent(&mut child, pid, program.as_deref()) {
                        Ok(()) => {
                            log::line(&format!("ended the agent that did not answer (process {pid}); starting it again"));
                            *lock(&shared.model_failing_since) = None;
                            true
                        }
                        Err(why) => {
                            log::line(&format!("the agent does not answer and was not ended: {why}"));
                            false
                        }
                    }
                }
            };
            if start {
                if let Some(program) = &program {
                    match start_agent(program, &home) {
                        Ok(c) => {
                            log::line(&format!("started the agent (process {})", c.id()));
                            child = Some(c);
                        }
                        Err(e) => {
                            log::line(&format!("could not start the agent: {e}"));
                            sup.start_failed(now);
                        }
                    }
                }
            }
            if let Some(notice) = sup.take_notice() {
                log::line(match notice {
                    supervise::Notice::StartingAgain => "the agent stopped and nothing replaced it: starting it again",
                    supervise::Notice::Restarting => "the agent has not answered: restarting it",
                });
                // An agent that stopped without anyone asking is told about (as the person's setting allows). A hung agent
                // was already told about once, as a problem, when it was shown as not answering.
                let setting = lock(&shared.answer).as_ref().map(|a| a.settings.notifications).unwrap_or_default();
                if notice == supervise::Notice::StartingAgain && setting != Notifications::Off {
                    show_toast(Toast {
                        kind: Kind::Problem,
                        title: "Scopebond".into(),
                        text: "The Scopebond Agent stopped and nothing started in its place; starting it again".into(),
                    });
                }
            }
            if sup.link() != before || *lock(&shared.supervised) != sup.link() {
                log::line(&format!("agent: {}", link_name(sup.link())));
                *lock(&shared.supervised) = sup.link();
                shared.wake();
            }
        }));
        if step.is_err() {
            log::line("a supervision step failed; going on");
        }
        thread::sleep(if sup.link() == AgentLink::Answering { Duration::from_secs(3) } else { Duration::from_secs(1) });
    }
}

/// Ask the agent for its model and redraw. Only the refresh thread calls this (menus are built on the main thread, which
/// this waits for, so nothing on the main thread may wait for this).
fn refresh(app: &AppHandle, shared: &Arc<Shared>) {
    let answer = shared.client.tray();
    let now = Instant::now();
    {
        // Since when the pipe has accepted connections without giving a model (no answer in time, or an error).
        let mut failing = lock(&shared.model_failing_since);
        if answer.is_some() || !shared.client.answers() {
            *failing = None;
        } else if failing.is_none() {
            *failing = Some(now);
        }
    }
    let link = match (&answer, *lock(&shared.supervised)) {
        (Some(_), _) => AgentLink::Answering,
        // Its pipe accepts connections, but no model for half a minute: not answering (supervision restarts it).
        (None, _) if unresponsive(shared, now) => AgentLink::NotAnswering,
        // Its pipe accepts connections but it gave no model yet: still starting.
        (None, AgentLink::Answering) => AgentLink::Starting,
        (None, link) => link,
    };
    // The notification setting lives in the agent; while it does not answer, the last one it gave holds.
    let setting = answer.as_ref().or(lock(&shared.answer).as_ref()).map(|a| a.settings.notifications).unwrap_or_default();
    *lock(&shared.answer) = answer.clone();
    *lock(&shared.link) = link;
    draw(app, shared);
    notify(shared, answer.as_ref(), link, setting);
}

/// How long the agent may not answer (while the tray tries to start it) before that is worth a notification.
const SILENT_FOR: Duration = Duration::from_secs(2 * 60);

fn notify(shared: &Arc<Shared>, answer: Option<&TrayAnswer>, link: AgentLink, setting: Notifications) {
    let now = Instant::now();
    let (state, headline, blocks) = match (answer, link) {
        (Some(a), _) => {
            *lock(&shared.silent_since) = None;
            (a.tray.icon_state(), a.tray.headline.clone(), a.tray.recent_blocks.clone())
        }
        // Not answering although the tray keeps trying: a problem once it has lasted. Stopped on purpose, waiting for an
        // update's replacement or starting: nothing to tell.
        (None, AgentLink::NotAnswering | AgentLink::Missing) => {
            let since = *lock(&shared.silent_since).get_or_insert(now);
            // An agent whose pipe accepts but that has given no model for half a minute already waited its time: a
            // problem at once (one notification; the notifier says it once).
            let hung = link == AgentLink::NotAnswering && unresponsive(shared, now);
            let state = if hung || now.duration_since(since) >= SILENT_FOR { IconState::Problem } else { IconState::Working };
            (state, menu::header(None, link).trim_start_matches("Scopebond — ").to_string(), Vec::new())
        }
        (None, _) => {
            *lock(&shared.silent_since) = None;
            (IconState::Working, String::new(), Vec::new())
        }
    };
    for toast in lock(&shared.notifier).observe(state, &headline, &blocks, setting, now) {
        show_toast(toast);
    }
}

/// A Windows notification under the installer's AppUserModelID (the Start-menu entry carries it). Shown on its own
/// thread; a failure (no Start-menu entry, notifications turned off in Windows) is only logged.
fn show_toast(toast: Toast) {
    thread::spawn(move || {
        let mut t = tauri_winrt_notification::Toast::new("Avouro.Scopebond").title(&toast.title).text1(&toast.text);
        if matches!(toast.kind, Kind::Recovered | Kind::Block) {
            t = t.sound(None);
        }
        match t.show() {
            Ok(()) => log::line(&format!("notified: {}", toast.text)),
            Err(e) => log::line(&format!("could not notify ({e}): {}", toast.text)),
        }
    });
}

fn draw(app: &AppHandle, shared: &Arc<Shared>) {
    let (answer, link) = shared.snapshot();
    let tray = match app.tray_by_id(TRAY_ID) {
        Some(tray) => tray,
        // At sign-in the taskbar may not be there yet: the icon is added once it is.
        None => match create_tray(app, shared) {
            Ok(tray) => tray,
            Err(e) => {
                log::line(&format!("the tray icon could not be added yet: {e}"));
                return;
            }
        },
    };
    let ctx = MenuContext {
        link,
        autostart: autostart_state(),
        notifications: answer.as_ref().map(|a| a.settings.notifications).unwrap_or_default(),
    };
    let spec = menu::menu_spec(answer.as_ref(), &ctx);
    let state = match (link, &answer) {
        (AgentLink::Answering, Some(a)) => a.tray.icon_state(),
        (AgentLink::Starting | AgentLink::Waiting, _) | (AgentLink::Answering, None) => IconState::Working,
        _ => IconState::Problem,
    };
    let tooltip = match (link, &answer) {
        (AgentLink::Answering, Some(a)) if !a.tray.tooltip.is_empty() => a.tray.tooltip.clone(),
        _ => menu::header(answer.as_ref(), link),
    };
    let tooltip: String = tooltip.chars().take(120).collect();
    let mut drawn = lock(&shared.drawn);
    if drawn.icon != Some(state) {
        let _ = tray.set_icon(Some(icon_image(state)));
        drawn.icon = Some(state);
    }
    if drawn.tooltip != tooltip {
        let _ = tray.set_tooltip(Some(&tooltip));
        drawn.tooltip = tooltip;
    }
    if drawn.spec != spec {
        match build_menu(app, &spec) {
            Ok(m) => {
                let _ = tray.set_menu(Some(m));
                drawn.spec = spec;
            }
            Err(e) => log::line(&format!("could not build the menu: {e}")),
        }
    }
}

fn timeout_for(action_id: &str) -> Duration {
    Duration::from_secs(match action_id {
        "update_now" => 15 * 60,
        "check_now" => 6 * 60,
        "send_now" => 3 * 60,
        "reconnect" => 90,
        _ => 30,
    })
}

/// Call the route of an action the model offers, then say what came of it.
fn run_action(app: &AppHandle, shared: &Arc<Shared>, action: TrayAction, from_menu: bool) {
    {
        let mut busy = lock(&shared.busy);
        if busy.is_some() {
            return;
        }
        *busy = Some(action.id.clone());
    }
    log::line(&format!("running {} ({})", action.id, action.route));
    let result = shared.client.call("POST", &action.route, Some(&json!({})), timeout_for(&action.id));
    let failed = result.is_err();
    let text = match result {
        Ok(answer) => panel::outcome_text(&action.id, &answer),
        Err(e) => format!("{} did not finish: {e}", action.label.trim_end_matches('…')),
    };
    *lock(&shared.busy) = None;
    shared.set_note(text);
    shared.wake();
    // The sign-in code has to be seen, and so does a failure; otherwise the icon and tooltip say enough.
    // "Check now" from the menu says what it found, as the person's setting allows.
    let setting = lock(&shared.answer).as_ref().map(|a| a.settings.notifications).unwrap_or_default();
    if from_menu && !failed && action.id == "check_now" && setting != Notifications::Off {
        if let Some(Note { text, .. }) = lock(&shared.note).as_ref() {
            show_toast(Toast { kind: Kind::Recovered, title: "Scopebond".into(), text: text.clone() });
        }
    }
    if from_menu && (failed || action.id == "reconnect") {
        open_panel(app, shared, None);
    }
}

fn act_on_block(shared: &Arc<Shared>, action_id: String) {
    {
        let mut busy = lock(&shared.busy);
        if busy.is_some() {
            return;
        }
        *busy = Some(format!("block:{action_id}"));
    }
    // The agent shows its Scopebond window; only the person answers it there.
    let text = match shared.client.call("POST", "/blocked", Some(&json!({ "action_id": action_id })), Duration::from_secs(75)) {
        Ok(answer) => panel::block_text(&answer),
        Err(e) => format!("The block could not be acted on: {e}"),
    };
    *lock(&shared.busy) = None;
    shared.set_note(text);
    shared.wake();
}

fn copy_diagnostics(shared: &Arc<Shared>) {
    let text = match shared.client.call("GET", "/status", None, Duration::from_secs(10)) {
        Ok(status) => {
            let report = json!({ "tray": env!("CARGO_PKG_VERSION"), "status": status });
            if win::copy_text(&serde_json::to_string_pretty(&report).unwrap_or_default()) {
                "Diagnostics copied (no keys or credentials)".to_string()
            } else {
                "The clipboard could not be used; try again".to_string()
            }
        }
        Err(e) => format!("Diagnostics could not be read: {e}"),
    };
    shared.set_note(text);
}

fn about(shared: &Arc<Shared>) {
    let status = shared.client.call("GET", "/status", None, Duration::from_secs(10)).unwrap_or(Value::Null);
    let field = |v: &Value| v.as_str().map(str::to_string).unwrap_or_else(|| "not running".into());
    let text = format!(
        "Scopebond\nPublisher: Avouro LLC\n\nTray: {}\nAgent: {}\nHook: {}\nComputer: {}\n\nScopebond folder: {}",
        env!("CARGO_PKG_VERSION"),
        field(&status["agent"]["version"]).trim_start_matches("agent/"),
        field(&status["version"]),
        field(&status["identity"]["installation_id"]),
        shared.client.home().display(),
    );
    win::message("About Scopebond", &text);
}

fn dispatch(app: &AppHandle, shared: &Arc<Shared>, command: Command) {
    let (app2, s) = (app.clone(), shared.clone());
    match command {
        Command::OpenStatus => open_panel(app, shared, None),
        Command::Run(action) => {
            thread::spawn(move || run_action(&app2, &s, action, true));
        }
        Command::StartAgent => {
            log::line("asked to start the agent");
            shared.start_requested.store(true, Ordering::SeqCst);
        }
        Command::ToggleAutostart => {
            let on = match autostart_state() {
                Autostart::Managed => return,
                Autostart::On => false,
                Autostart::Off => true,
            };
            let done = set_start_with_windows(shared.client.home(), on);
            log::line(&format!("start with Windows: {} ({})", if on { "on" } else { "off" }, if done { "saved" } else { "not saved" }));
            if !done {
                shared.set_note("Start with Windows could not be changed".into());
            }
            shared.wake();
        }
        Command::Notifications(n) => {
            thread::spawn(move || {
                if let Err(e) = s.client.call("POST", "/settings", Some(&json!({ "notifications": n.as_str() })), Duration::from_secs(10)) {
                    s.set_note(format!("The setting could not be saved: {e}"));
                }
                s.wake();
            });
        }
        Command::CopyDiagnostics => {
            thread::spawn(move || copy_diagnostics(&s));
        }
        Command::OpenLogs => {
            let _ = std::process::Command::new("explorer.exe").arg(shared.client.home()).spawn();
        }
        Command::About => {
            thread::spawn(move || about(&s));
        }
        Command::HideIcon => {
            log::line("icon hidden until the tray starts again");
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_visible(false);
            }
        }
    }
}

/// Open the status panel beside the tray, or bring it forward when it is open.
fn open_panel(app: &AppHandle, shared: &Arc<Shared>, anchor: Option<(f64, f64)>) {
    if let Some(window) = app.get_webview_window(PANEL) {
        let _ = window.set_focus();
        return;
    }
    shared.wake();
    let (app, shared) = (app.clone(), shared.clone());
    // Windows are made off the main thread: making a WebView2 window waits for the main thread's message loop.
    thread::spawn(move || {
        if let Err(e) = build_panel(&app, &shared, anchor) {
            log::line(&format!("could not open the status panel: {e}"));
        }
    });
}

fn build_panel(app: &AppHandle, shared: &Arc<Shared>, anchor: Option<(f64, f64)>) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html".into()))
        .title("Scopebond status")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .data_directory(shared.client.home().join("tray").join("webview"))
        .build()?;
    let anchor = anchor
        .or_else(|| *lock(&shared.anchor))
        .or_else(|| window.cursor_position().ok().map(|p| (p.x, p.y)))
        .unwrap_or((0.0, 0.0));
    let monitor = window.monitor_from_point(anchor.0, anchor.1).ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let work = m.work_area();
        let area = Area { x: work.position.x as f64, y: work.position.y as f64, width: work.size.width as f64, height: work.size.height as f64 };
        let scale = m.scale_factor();
        let (x, y) = panel::place(anchor, area, (PANEL_WIDTH * scale, PANEL_HEIGHT * scale));
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    window.show()?;
    window.set_focus()?;
    let (w, s) = (window.clone(), shared.clone());
    window.on_window_event(move |event| {
        // It closes when it loses focus (a click elsewhere, Alt+Tab), and is made again next time.
        if let WindowEvent::Focused(false) = event {
            *lock(&s.panel_closed_at) = Some(Instant::now());
            let _ = w.destroy();
        }
    });
    Ok(())
}

fn on_tray_event(app: &AppHandle, shared: &Arc<Shared>, event: TrayIconEvent) {
    if let TrayIconEvent::Click { rect, button, button_state, position, .. } = event {
        let (x, y, w, h) = match (rect.position, rect.size) {
            (tauri::Position::Physical(p), tauri::Size::Physical(s)) => (p.x as f64, p.y as f64, s.width as f64, s.height as f64),
            _ => (position.x, position.y, 0.0, 0.0),
        };
        *lock(&shared.anchor) = Some((x + w / 2.0, y + h / 2.0));
        if button != MouseButton::Left || button_state != MouseButtonState::Up {
            return;
        }
        if let Some(window) = app.get_webview_window(PANEL) {
            let _ = window.destroy();
            return;
        }
        // The click that took focus from the panel (and so closed it) does not open it again.
        if lock(&shared.panel_closed_at).map(|t| t.elapsed() < Duration::from_millis(400)).unwrap_or(false) {
            return;
        }
        open_panel(app, shared, Some((position.x, position.y)));
    }
}

fn link_name(link: AgentLink) -> &'static str {
    match link {
        AgentLink::Answering => "answering",
        AgentLink::Starting => "starting",
        AgentLink::NotAnswering => "not_answering",
        AgentLink::Waiting => "waiting",
        AgentLink::Stopped => "stopped",
        AgentLink::Missing => "missing",
    }
}

// What the panel asks for. It shows the same model the menu does.

#[tauri::command]
fn panel_state(shared: State<'_, Arc<Shared>>) -> Value {
    let (answer, link) = shared.snapshot();
    let note = lock(&shared.note).as_ref().filter(|n| n.at.elapsed() < NOTE_FOR).map(|n| n.text.clone());
    let headline = match (link, &answer) {
        (AgentLink::Answering, Some(a)) => a.tray.headline.clone(),
        _ => menu::header(answer.as_ref(), link).trim_start_matches("Scopebond — ").to_string(),
    };
    let state = match (link, &answer) {
        (AgentLink::Answering, Some(a)) => a.tray.icon_state().as_str(),
        (AgentLink::Starting | AgentLink::Waiting, _) => "working",
        _ => "problem",
    };
    json!({
        "link": link_name(link),
        "state": state,
        "stateLabel": panel::state_label(state),
        "headline": headline,
        "answer": answer,
        "note": note,
        "busy": *lock(&shared.busy),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
fn panel_action(id: String, app: AppHandle, shared: State<'_, Arc<Shared>>) -> bool {
    let action = lock(&shared.answer).as_ref().and_then(|a| a.tray.offered_action(&id).cloned());
    let Some(action) = action else { return false };
    let s = shared.inner().clone();
    thread::spawn(move || run_action(&app, &s, action, false));
    true
}

#[tauri::command]
fn panel_block(action_id: String, shared: State<'_, Arc<Shared>>) -> bool {
    let known = lock(&shared.answer)
        .as_ref()
        .map(|a| a.tray.recent_blocks.iter().any(|b| b.can_act && b.action_id.as_deref() == Some(action_id.as_str())))
        .unwrap_or(false);
    if !known {
        return false;
    }
    let s = shared.inner().clone();
    thread::spawn(move || act_on_block(&s, action_id));
    true
}

#[tauri::command]
fn panel_command(id: String, app: AppHandle, shared: State<'_, Arc<Shared>>) -> bool {
    let command = match id.as_str() {
        "copy_diagnostics" => Command::CopyDiagnostics,
        "open_logs" => Command::OpenLogs,
        "start_agent" => Command::StartAgent,
        _ => return false,
    };
    dispatch(&app, shared.inner(), command);
    true
}

#[tauri::command]
fn panel_close(window: WebviewWindow) {
    let _ = window.destroy();
}

fn main() {
    let home = scopebond_home().unwrap_or_else(std::env::temp_dir);
    log::init(&home);
    log::line(&format!("Scopebond tray {} starting for {}", env!("CARGO_PKG_VERSION"), home.display()));
    if start_with_windows_choice(&home) == Some(false) && win::read_string(false, win::RUN_KEY, "Scopebond").is_some() {
        win::delete_user_value(win::RUN_KEY, "Scopebond");
        log::line("start with Windows stays off, as chosen");
    }
    let shared = Arc::new(Shared::new(AgentClient::new(home)));
    let open_at_start = std::env::args().any(|a| a == "--status");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Started again (the Start-menu entry, or a second sign-in start): show the icon and the panel in this one.
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_visible(true);
            }
            if let Some(shared) = app.try_state::<Arc<Shared>>() {
                open_panel(app, &shared.inner().clone(), None);
            }
        }))
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![panel_state, panel_action, panel_block, panel_command, panel_close])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Err(e) = create_tray(&handle, &shared) {
                log::line(&format!("the tray icon could not be added yet: {e}"));
            }
            let s_supervise = shared.clone();
            thread::spawn(move || supervise_agent(&s_supervise));
            let (app_refresh, s_refresh) = (handle.clone(), shared.clone());
            thread::spawn(move || loop {
                if std::panic::catch_unwind(AssertUnwindSafe(|| refresh(&app_refresh, &s_refresh))).is_err() {
                    log::line("the refresh failed; trying again");
                }
                // While the pipe accepts but gives no model, ask again soon, so "not answering" shows when it is due.
                let failing = lock(&s_refresh.model_failing_since).is_some();
                s_refresh.sleep(if failing { Duration::from_secs(5) } else { REFRESH_EVERY });
            });
            if open_at_start {
                open_panel(&handle, &shared, None);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Scopebond tray could not start");
    app.run(|_app, event| {
        // The tray lives on with no window open: only an exit asked for in code ends it.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
