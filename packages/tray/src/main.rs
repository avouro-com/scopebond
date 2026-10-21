// The Scopebond tray for Windows: the icon, its menu and the status panel, drawn from the agent's tray model. No console
// window, ever.
#![windows_subsystem = "windows"]

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use scopebond_tray::agent::{scopebond_home, AgentClient};
use scopebond_tray::icon::{self, IconState};
use scopebond_tray::menu::{self, AgentLink, Autostart, Command, Entry, MenuContext};
use scopebond_tray::live::{self, LiveWatch};
use scopebond_tray::model::{LiveQuestion, Notifications, TrayAction, TrayAnswer};
use scopebond_tray::notify::{update_toast, Kind, Notifier, RequestWatch, Situation, Toast};
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
/// The panel shows when its page says it has drawn, or after this long whatever happens.
const PANEL_SHOW_WAIT_MS: u64 = 1_500;
/// The client's one version (the agent package's, from build.rs): what About, the panel and the support report say.
const SCOPEBOND_VERSION: &str = env!("SCOPEBOND_VERSION");

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
    /// Supervision could not bring the agent back (two failed restarts within ten minutes): protection is off.
    protection_off: AtomicBool,
    notifier: Mutex<Notifier>,
    /// Since when the agent has not answered (for a notification when that lasts).
    silent_since: Mutex<Option<Instant>>,
    /// The block whose Unblock form the panel opens next (a notification's *Unblock…*).
    open_block: Mutex<Option<String>>,
    /// The last answer given in the panel's form: the block, what the agent said, and when.
    answered: Mutex<Option<(String, String, String, Instant)>>,
    /// The panel's form has input: the panel stays open when it loses focus.
    hold: AtomicBool,
    /// The hook's question waiting for the person now (the live prompt), as the agent last said.
    pending: Mutex<Option<LiveQuestion>>,
    live_watch: Mutex<LiveWatch>,
    request_watch: Mutex<RequestWatch>,
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
            protection_off: AtomicBool::new(false),
            notifier: Mutex::new(Notifier::new()),
            silent_since: Mutex::new(None),
            open_block: Mutex::new(None),
            answered: Mutex::new(None),
            hold: AtomicBool::new(false),
            pending: Mutex::new(None),
            live_watch: Mutex::new(LiveWatch::new()),
            request_watch: Mutex::new(RequestWatch::new()),
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
/// In the tray's settings file: the version whose "Updated to …" was told (once per version).
const TOLD_UPDATE: &str = "told_update";

/// The tray's settings file as a JSON object (empty when there is none, or it cannot be read).
fn tray_settings(home: &Path) -> serde_json::Map<String, Value> {
    match std::fs::read(home.join(TRAY_SETTINGS)).ok().and_then(|text| serde_json::from_slice::<Value>(&text).ok()) {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

/// Set one value in the tray's settings file, keeping the others.
fn save_tray_setting(home: &Path, key: &str, value: Value) {
    let mut settings = tray_settings(home);
    settings.insert(key.to_string(), value);
    let _ = std::fs::write(home.join(TRAY_SETTINGS), format!("{}\n", Value::Object(settings)));
}

fn start_with_windows_choice(home: &Path) -> Option<bool> {
    tray_settings(home).get("start_with_windows")?.as_bool()
}

fn set_start_with_windows(home: &Path, on: bool) -> bool {
    let done = if on {
        std::env::current_exe()
            .map(|exe| win::set_user_string(win::RUN_KEY, "Scopebond", &format!("\"{}\"", exe.display())))
            .unwrap_or(false)
    } else {
        win::delete_user_value(win::RUN_KEY, "Scopebond")
    };
    save_tray_setting(home, "start_with_windows", json!(on));
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
    let starting = menu::menu_spec(None, &MenuContext { link: AgentLink::Starting, autostart: autostart_state(), notifications: Notifications::Blocks });
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

/// Start `scopebond-agent.exe run` with no console window (supervise::agent_command: never with NODE_OPTIONS). It writes its
/// own log and leaves the tray to this program.
fn start_agent(program: &Path, home: &Path) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::fs::create_dir_all(home);
    supervise::agent_command(program, home).creation_flags(CREATE_NO_WINDOW).spawn()
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
            // Restarts are silent: only the log says so. The person is told once two restarts failed (below).
            if let Some(notice) = sup.take_notice() {
                log::line(match notice {
                    supervise::Notice::StartingAgain => "the agent stopped and nothing replaced it: starting it again",
                    supervise::Notice::Restarting => "the agent has not answered: restarting it",
                });
            }
            // Two restarts failed within ten minutes: protection is off. The refresh tells the person once, with Restart it.
            let off = sup.protection_off();
            if shared.protection_off.swap(off, Ordering::SeqCst) != off {
                log::line(if off { "two restarts of the agent failed within ten minutes: protection is off" } else { "protection is no longer off" });
                shared.wake();
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
    notify(app, shared, answer.as_ref(), link, setting);
}

/// How long the agent program may be missing beside the tray before that is worth a notification.
const SILENT_FOR: Duration = Duration::from_secs(2 * 60);

fn notify(app: &AppHandle, shared: &Arc<Shared>, answer: Option<&TrayAnswer>, link: AgentLink, setting: Notifications) {
    let now = Instant::now();
    let off = answer.is_none() && shared.protection_off.load(Ordering::SeqCst);
    let (state, headline, blocks) = match (answer, link) {
        (Some(a), _) => {
            *lock(&shared.silent_since) = None;
            (a.tray.icon_state(), a.tray.headline.clone(), a.tray.recent_blocks.clone())
        }
        // Supervision could not bring the agent back (two restarts failed within ten minutes): protection is off, told once
        // with Restart it.
        (None, _) if off => {
            *lock(&shared.silent_since) = None;
            (IconState::Problem, menu::header(None, link).trim_start_matches("Scopebond — ").to_string(), Vec::new())
        }
        // No agent program beside the tray: a problem once it has lasted.
        (None, AgentLink::Missing) => {
            let since = *lock(&shared.silent_since).get_or_insert(now);
            let state = if now.duration_since(since) >= SILENT_FOR { IconState::Problem } else { IconState::Working };
            (state, menu::header(None, link).trim_start_matches("Scopebond — ").to_string(), Vec::new())
        }
        // Starting, restarted after a crash or a hang (silently), stopped on purpose, waiting for an update's replacement:
        // nothing to tell.
        (None, _) => {
            *lock(&shared.silent_since) = None;
            (IconState::Working, String::new(), Vec::new())
        }
    };
    // The first sign-in: nothing about the state while it waits, "Connected to …" once it is done.
    let situation = Situation {
        protection_off: off,
        first_sign_in: answer.is_some_and(|a| a.tray.first_sign_in),
        workspace: answer.and_then(|a| a.tray.workspace.as_deref()),
    };
    for toast in lock(&shared.notifier).observe(state, &headline, &blocks, setting, situation, now) {
        show_toast(toast, Some((app.clone(), shared.clone())));
    }
    // An admin's answer to one of the person's requests.
    if let Some(a) = answer {
        for toast in lock(&shared.request_watch).observe(&a.tray.asked, setting) {
            show_toast(toast, Some((app.clone(), shared.clone())));
        }
    }
    // "Updated to Scopebond 0.11.5", once per version (remembered in the tray's settings file, so a restart of the tray does
    // not tell it again).
    if let Some(updated) = answer.and_then(|a| a.tray.updated.as_ref()) {
        let home = shared.client.home();
        let told = tray_settings(home).get(TOLD_UPDATE).and_then(Value::as_str).map(str::to_string);
        if let Some((version, toast)) = update_toast(Some(updated), told.as_deref(), setting) {
            save_tray_setting(home, TOLD_UPDATE, json!(version));
            if let Some(toast) = toast {
                show_toast(toast, None);
            }
        }
    }
}

/// The live prompt: wait for the hook's question (the agent answers when one starts waiting, or after 20 s), keep it for the
/// panel, and tell the person once. An agent without the route (an older one) is asked again only after a minute.
fn watch_questions(app: &AppHandle, shared: &Arc<Shared>) {
    loop {
        let seen = lock(&shared.pending).as_ref().map(|q| q.action_id.clone());
        let result = shared.client.call("POST", "/override/wait", Some(&live::wait_body(seen.as_deref())), Duration::from_secs(live::WAIT_TIMEOUT_SECS));
        let pause = match result {
            Ok(answer) => {
                let question = live::parse_wait(&answer);
                let setting = lock(&shared.answer).as_ref().map(|a| a.settings.notifications).unwrap_or_default();
                let toast = lock(&shared.live_watch).observe(question.as_ref(), setting);
                let changed = *lock(&shared.pending) != question;
                *lock(&shared.pending) = question;
                if let Some(toast) = toast {
                    log::line("a question is waiting for the person in the tray");
                    show_toast(toast, Some((app.clone(), shared.clone())));
                }
                if changed {
                    shared.wake();
                }
                Duration::ZERO
            }
            Err(scopebond_tray::agent::CallError::Refused(404)) => Duration::from_secs(60),
            Err(_) => {
                *lock(&shared.pending) = None;
                Duration::from_secs(3)
            }
        };
        if !pause.is_zero() {
            thread::sleep(pause);
        }
    }
}

/// The person opened the waiting question in the tray: the agent opens no window for it.
fn open_question(shared: &Arc<Shared>, action_id: &str) {
    let waiting = lock(&shared.pending).as_ref().is_some_and(|q| q.action_id == action_id);
    if waiting {
        let _ = shared.client.call("POST", "/override/open", Some(&json!({ "action_id": action_id })), Duration::from_secs(5));
    }
}

/// A Windows notification under the installer's AppUserModelID (the Start-menu entry carries it). Shown on its own
/// thread; a failure (no Start-menu entry, notifications turned off in Windows) is only logged. A block notification opens
/// the panel when it is clicked, and its *Unblock…* button opens the panel on that block's form.
fn show_toast(toast: Toast, panel: Option<(AppHandle, Arc<Shared>)>) {
    thread::spawn(move || {
        let mut t = tauri_winrt_notification::Toast::new("Avouro.Scopebond").title(&toast.title).text1(&toast.text);
        if matches!(toast.kind, Kind::Recovered | Kind::Block | Kind::Request | Kind::Connected | Kind::Updated) {
            t = t.sound(None);
        }
        match (toast.kind, panel) {
            (Kind::Block, Some((app, shared))) => {
                if let (Some(_), Some(words)) = (&toast.unblock, toast.button) {
                    t = t.add_button(words, "unblock");
                }
                let block = toast.unblock.clone();
                t = t.on_activated(move |action| {
                    if action.as_deref() == Some("unblock") {
                        *lock(&shared.open_block) = block.clone();
                        // A question waiting now: no window for it while the person answers in the panel.
                        if let Some(id) = block.clone() {
                            let s = shared.clone();
                            thread::spawn(move || open_question(&s, &id));
                        }
                    }
                    open_panel(&app, &shared, None);
                    Ok(())
                });
            }
            (Kind::Request, Some((app, shared))) => {
                t = t.on_activated(move |_| {
                    open_panel(&app, &shared, None);
                    Ok(())
                });
            }
            // Protection is off: *Restart it* starts the agent at once (with a fresh count of failed restarts); a click on the
            // notification itself opens the panel.
            (Kind::Problem, Some((app, shared))) => {
                if let Some(words) = toast.button {
                    t = t.add_button(words, "restart");
                }
                t = t.on_activated(move |action| {
                    if action.as_deref() == Some("restart") {
                        log::line("asked to restart the agent (from the notification)");
                        shared.start_requested.store(true, Ordering::SeqCst);
                        shared.wake();
                    } else {
                        open_panel(&app, &shared, None);
                    }
                    Ok(())
                });
            }
            _ => {}
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
    // A sign-in waiting shows its code whole; at most 63 characters.
    let tooltip = menu::tooltip(answer.as_ref(), link);
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
            show_toast(Toast { kind: Kind::Recovered, title: "Scopebond".into(), text: text.clone(), unblock: None, button: None }, None);
        }
    }
    if from_menu && (failed || action.id == "reconnect") {
        open_panel(app, shared, None);
    }
}

/// Send the panel's Unblock form (already checked by `panel::check_answer`) to the agent, which checks it again and applies
/// it as the Scopebond window's answer is applied. Nothing waits for a window here, so it is quick.
fn answer_block(shared: &Arc<Shared>, action_id: String, body: Value) {
    {
        let mut busy = lock(&shared.busy);
        if busy.is_some() {
            return;
        }
        *busy = Some(format!("answer:{action_id}"));
    }
    let (outcome, text) = match shared.client.call("POST", "/blocked/answer", Some(&body), Duration::from_secs(20)) {
        Ok(answer) => (answer.get("outcome").and_then(Value::as_str).unwrap_or("").to_string(), panel::block_text(&answer)),
        Err(e) => ("failed".to_string(), format!("The answer could not be sent: {e}")),
    };
    *lock(&shared.busy) = None;
    *lock(&shared.answered) = Some((action_id, outcome, text.clone(), Instant::now()));
    shared.set_note(text);
    shared.wake();
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

/// "Get help…": copy a support report (the agent's, with no keys, records, commands or reasons; the tray's version and how
/// it stands with the agent) and open the Help page. Nothing in the Scopebond folder is opened or attached.
fn get_help(shared: &Arc<Shared>) {
    {
        let mut busy = lock(&shared.busy);
        if busy.is_some() {
            return;
        }
        *busy = Some("help".into());
    }
    let link = link_name(*lock(&shared.link));
    let agent = shared.client.call("GET", "/support", None, Duration::from_secs(15)).map_err(|e| e.to_string());
    let report = panel::help_report(SCOPEBOND_VERSION, link, agent);
    let copied = win::copy_text(&serde_json::to_string_pretty(&report).unwrap_or_default());
    let opened = std::process::Command::new("explorer.exe").arg(panel::HELP_URL).spawn().is_ok();
    *lock(&shared.busy) = None;
    shared.set_note(match (copied, opened) {
        (true, true) => "Support report copied (no keys, records or commands): paste it in your message. The Help page is opening.".into(),
        (true, false) => format!("Support report copied (no keys, records or commands). Help: {}", panel::HELP_URL),
        (false, _) => format!("The support report could not be copied; try again. Help: {}", panel::HELP_URL),
    });
    shared.wake();
}

fn about(shared: &Arc<Shared>) {
    let status = shared.client.call("GET", "/status", None, Duration::from_secs(10)).unwrap_or(Value::Null);
    let field = |v: &Value| v.as_str().map(str::to_string).unwrap_or_else(|| "not running".into());
    let agent = field(&status["agent"]["version"]).trim_start_matches("agent/").to_string();
    // One version for the whole client; the agent's only when it is not the same (an update not finished yet).
    let agent_line = if agent == SCOPEBOND_VERSION { String::new() } else { format!("Agent: {agent}\n") };
    let text = format!(
        "Scopebond {SCOPEBOND_VERSION}\nPublisher: Avouro LLC\n\n{agent_line}Rule engine: {}\nComputer: {}\n\nScopebond folder: {}",
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
        Command::GetHelp => {
            thread::spawn(move || get_help(&s));
        }
        Command::About => {
            thread::spawn(move || about(&s));
        }
        Command::HideIcon => {
            log::line("icon hidden until the tray starts again");
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_visible(false);
            }
            // Asked for just now, so said whatever the notification setting: how to bring the icon back.
            show_toast(Toast { kind: Kind::Recovered, title: "Scopebond icon hidden".into(), text: menu::HIDDEN_ICON_TEXT.into(), unblock: None, button: None }, None);
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
    // Opaque from the first frame: the webview's own background is the panel's (light or dark), never see-through while the
    // page loads. The window is shown once the page has drawn (panel_ready), or after a short wait whatever happens.
    let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
    let _ = window.set_background_color(Some(if dark { tauri::window::Color(0x1d, 0x25, 0x33, 0xff) } else { tauri::window::Color(0xf9, 0xf9, 0xfb, 0xff) }));
    let late = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(PANEL_SHOW_WAIT_MS));
        if !late.is_visible().unwrap_or(true) {
            let _ = late.show();
            let _ = late.set_focus();
        }
    });
    shared.hold.store(false, Ordering::SeqCst);
    let (w, s) = (window.clone(), shared.clone());
    window.on_window_event(move |event| {
        // It closes when it loses focus (a click elsewhere, Alt+Tab), and is made again next time; not while the person is
        // writing a reason in its Unblock form (Esc, the close button or the tray icon close it then).
        if let WindowEvent::Focused(false) = event {
            if s.hold.load(Ordering::SeqCst) {
                return;
            }
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
            shared.hold.store(false, Ordering::SeqCst);
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
        "version": SCOPEBOND_VERSION,
        // For the panel's Settings: Start with Windows as the menu shows it.
        "autostart": autostart_state().as_str(),
        // A notification's Unblock…: the block whose form to open (once).
        "openBlock": lock(&shared.open_block).take(),
        // What came of the last answer in the panel's form, for a while.
        // The hook's question waiting for the person now.
        "pending": lock(&shared.pending).clone(),
        "answered": lock(&shared.answered).as_ref().filter(|a| a.3.elapsed() < NOTE_FOR).map(|(id, outcome, text, _)| json!({ "actionId": id, "outcome": outcome, "text": text })),
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
fn panel_block(action_id: String, choice: Option<String>, reason: Option<String>, scope: Option<String>, shared: State<'_, Arc<Shared>>) -> bool {
    let block = lock(&shared.answer).as_ref().and_then(|a| a.tray.actionable_block(&action_id).cloned());
    let Some(block) = block else { return false };
    let s = shared.inner().clone();
    match choice {
        // The panel's own form (what it covers: this command, or similar commands in this project): checked here, then by the agent.
        Some(choice) => match panel::check_scoped_answer(&block, &choice, reason.as_deref().unwrap_or_default(), scope.as_deref()) {
            Ok(body) => {
                thread::spawn(move || answer_block(&s, action_id, body));
                true
            }
            Err(why) => {
                shared.set_note(why);
                false
            }
        },
        // An agent that does not say what may be done: its Scopebond window asks.
        None => {
            thread::spawn(move || act_on_block(&s, action_id));
            true
        }
    }
}

/// The question waiting now, from the panel: its form opened (no choice), or the person's answer (checked here, then by
/// the agent, which hands it to the hook's waiting call).
#[tauri::command]
fn panel_live(action_id: String, choice: Option<String>, reason: Option<String>, shared: State<'_, Arc<Shared>>) -> bool {
    let question = lock(&shared.pending).clone().filter(|q| q.action_id == action_id);
    let Some(question) = question else { return false };
    let s = shared.inner().clone();
    match choice {
        // The form opened: no window for this question.
        None => {
            thread::spawn(move || open_question(&s, &action_id));
            true
        }
        Some(choice) => match live::check_live_answer(&question, &choice, reason.as_deref().unwrap_or_default()) {
            Ok(body) => {
                thread::spawn(move || {
                    {
                        let mut busy = lock(&s.busy);
                        if busy.is_some() {
                            return;
                        }
                        *busy = Some(format!("answer:{action_id}"));
                    }
                    let (outcome, text) = match s.client.call("POST", "/override/answer", Some(&body), Duration::from_secs(10)) {
                        Ok(answer) => (answer.get("outcome").and_then(Value::as_str).unwrap_or("").to_string(), panel::block_text(&answer)),
                        Err(e) => ("failed".to_string(), format!("The answer could not be sent: {e}")),
                    };
                    *lock(&s.busy) = None;
                    *lock(&s.answered) = Some((action_id, outcome, text.clone(), Instant::now()));
                    s.set_note(text);
                    s.wake();
                });
                true
            }
            Err(why) => {
                shared.set_note(why);
                false
            }
        },
    }
}

/// "Stop allowing" an allowance the person made (the panel asked them to confirm first).
#[tauri::command]
fn panel_stop(id: String, shared: State<'_, Arc<Shared>>) -> bool {
    let known = lock(&shared.answer).as_ref().is_some_and(|a| a.tray.allowed.iter().any(|x| x.id == id && live::stoppable(x)));
    if !known {
        return false;
    }
    let s = shared.inner().clone();
    thread::spawn(move || {
        let text = match s.client.call("POST", "/allowances/stop", Some(&json!({ "id": id })), Duration::from_secs(10)) {
            Ok(answer) => panel::block_text(&answer),
            Err(e) => format!("It could not be stopped: {e}"),
        };
        s.set_note(text);
        s.wake();
    });
    true
}

/// "This shouldn't be blocked" on a block in the panel: the agent keeps the mark and sends it to the workspace.
#[tauri::command]
fn panel_feedback(action_id: String, shared: State<'_, Arc<Shared>>) -> bool {
    let known = lock(&shared.answer).as_ref().is_some_and(|a| a.tray.feedback_offered && a.tray.recent_blocks.iter().any(|b| b.action_id.as_deref() == Some(action_id.as_str())));
    if !known {
        return false;
    }
    let s = shared.inner().clone();
    thread::spawn(move || {
        let text = match s.client.call("POST", "/blocked/feedback", Some(&json!({ "action_id": action_id })), Duration::from_secs(10)) {
            Ok(answer) => panel::block_text(&answer),
            Err(e) => format!("It could not be noted: {e}"),
        };
        s.set_note(text);
        s.wake();
    });
    true
}

/// The panel's Unblock form has input (keep the panel open when it loses focus), or no longer has.
#[tauri::command]
fn panel_hold(hold: bool, shared: State<'_, Arc<Shared>>) {
    shared.hold.store(hold, Ordering::SeqCst);
}

#[tauri::command]
fn panel_command(id: String, app: AppHandle, shared: State<'_, Arc<Shared>>) -> bool {
    // The same commands the menu has (Settings in the panel offers them too); anything else does nothing.
    let command = match id.as_str() {
        "get_help" => Command::GetHelp,
        "start_agent" => Command::StartAgent,
        "autostart" => Command::ToggleAutostart,
        "about" => Command::About,
        "hide_icon" => Command::HideIcon,
        other => match other.strip_prefix("notifications:").and_then(Notifications::from_choice) {
            Some(n) => Command::Notifications(n),
            None => return false,
        },
    };
    dispatch(&app, shared.inner(), command);
    true
}

/// The panel's page has drawn: show the window now (it was made hidden, so it never shows a half-drawn, see-through frame).
#[tauri::command]
fn panel_ready(window: WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn panel_close(window: WebviewWindow, shared: State<'_, Arc<Shared>>) {
    shared.hold.store(false, Ordering::SeqCst);
    let _ = window.destroy();
}

fn main() {
    let home = scopebond_home().unwrap_or_else(std::env::temp_dir);
    log::init(&home);
    log::line(&format!("Scopebond {} tray starting for {} (tray crate {})", SCOPEBOND_VERSION, home.display(), env!("CARGO_PKG_VERSION")));
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
        .invoke_handler(tauri::generate_handler![panel_state, panel_action, panel_block, panel_live, panel_stop, panel_feedback, panel_hold, panel_command, panel_ready, panel_close])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Err(e) = create_tray(&handle, &shared) {
                log::line(&format!("the tray icon could not be added yet: {e}"));
            }
            let (app_live, s_live) = (handle.clone(), shared.clone());
            thread::spawn(move || loop {
                if std::panic::catch_unwind(AssertUnwindSafe(|| watch_questions(&app_live, &s_live))).is_err() {
                    log::line("watching for questions failed; going on");
                    thread::sleep(Duration::from_secs(5));
                }
            });
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
