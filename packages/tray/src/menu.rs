//! The right-click menu, worked out from the agent's tray model as plain data (no window system here, so it is tested on
//! its own). The menu offers what the model offers, one item per action, and nothing else: there is no "Quit" and no
//! "Pause protection"; the hook decides every action whether or not the tray runs.

use crate::model::{Notifications, TrayAction, TrayAnswer};

/// How the tray stands with the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLink {
    /// It answers on its local channel.
    Answering,
    /// The tray started it (or another start is under way) and is waiting for it to answer.
    Starting,
    /// Nothing answers and nothing is starting it right now (it will be tried again).
    NotAnswering,
    /// It stopped because someone asked it to (`scopebond-agent stop`, `autostart off`); the tray leaves it stopped.
    Stopped,
    /// There is no agent program beside the tray.
    Missing,
}

/// Whether Scopebond starts with Windows for this person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Autostart {
    On,
    Off,
    /// Installed for every user: set by whoever installed it, not changed from here.
    Managed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuContext {
    pub link: AgentLink,
    pub autostart: Autostart,
    pub notifications: Notifications,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Item { id: String, label: String, enabled: bool },
    Check { id: String, label: String, checked: bool, enabled: bool },
    Separator,
    Submenu { label: String, entries: Vec<Entry> },
}

/// What choosing a menu item does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    OpenStatus,
    /// Call this action's route on the agent.
    Run(TrayAction),
    StartAgent,
    ToggleAutostart,
    Notifications(Notifications),
    CopyDiagnostics,
    OpenLogs,
    About,
    HideIcon,
}

const ACTION_PREFIX: &str = "action:";
const NOTIFICATIONS_PREFIX: &str = "notifications:";

/// A menu label as Windows shows it: "&" would mark a keyboard shortcut, so it is doubled; long text is cut.
pub fn menu_text(text: &str, max: usize) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = if one_line.chars().count() > max {
        let mut s: String = one_line.chars().take(max.saturating_sub(1)).collect();
        s.push('…');
        s
    } else {
        one_line
    };
    cut.replace('&', "&&")
}

/// The first line of the menu.
pub fn header(answer: Option<&TrayAnswer>, link: AgentLink) -> String {
    let line = match (link, answer) {
        (AgentLink::Answering, Some(a)) => a.tray.headline.clone(),
        (AgentLink::Answering, None) | (AgentLink::Starting, _) => "Starting the Scopebond Agent…".to_string(),
        (AgentLink::NotAnswering, _) => "The Scopebond Agent is not answering".to_string(),
        (AgentLink::Stopped, _) => "The Scopebond Agent is stopped".to_string(),
        (AgentLink::Missing, _) => "The Scopebond Agent is not installed beside this tray".to_string(),
    };
    format!("Scopebond — {line}")
}

/// The whole menu for this model and context, top to bottom.
pub fn menu_spec(answer: Option<&TrayAnswer>, ctx: &MenuContext) -> Vec<Entry> {
    let item = |id: &str, label: &str| Entry::Item { id: id.to_string(), label: menu_text(label, 80), enabled: true };
    let mut out = vec![
        Entry::Item { id: "header".into(), label: menu_text(&header(answer, ctx.link), 80), enabled: false },
        item("open_status", "Open status…"),
        Entry::Separator,
    ];
    match (ctx.link, answer) {
        (AgentLink::Answering, Some(a)) => {
            for action in a.tray.offered() {
                out.push(item(&format!("{ACTION_PREFIX}{}", action.id), &action.label));
            }
        }
        (AgentLink::NotAnswering | AgentLink::Stopped, _) => out.push(item("start_agent", "Start the Scopebond Agent")),
        _ => {}
    }
    if !matches!(out.last(), Some(Entry::Separator)) {
        out.push(Entry::Separator);
    }
    out.push(Entry::Check {
        id: "autostart".into(),
        label: if ctx.autostart == Autostart::Managed { "Start with Windows (set for every user)".into() } else { "Start with Windows".into() },
        checked: ctx.autostart != Autostart::Off,
        enabled: ctx.autostart != Autostart::Managed,
    });
    out.push(Entry::Submenu {
        label: "Notifications".into(),
        entries: Notifications::ALL
            .iter()
            .map(|n| Entry::Check {
                id: format!("{NOTIFICATIONS_PREFIX}{}", n.as_str()),
                label: n.label().into(),
                checked: *n == ctx.notifications,
                enabled: ctx.link == AgentLink::Answering,
            })
            .collect(),
    });
    out.push(Entry::Submenu {
        label: "Help".into(),
        entries: vec![item("copy_diagnostics", "Copy diagnostics"), item("open_logs", "Open logs folder"), item("about", "About Scopebond")],
    });
    out.push(Entry::Separator);
    out.push(item("hide_icon", "Hide icon"));
    out
}

/// What the item with this id does now. An action the model no longer offers (it changed since the menu was drawn) does
/// nothing, so a menu item can only ever call what the agent offers at that moment.
pub fn command_for(id: &str, answer: Option<&TrayAnswer>) -> Option<Command> {
    if let Some(action_id) = id.strip_prefix(ACTION_PREFIX) {
        return answer?.tray.offered_action(action_id).cloned().map(Command::Run);
    }
    if let Some(value) = id.strip_prefix(NOTIFICATIONS_PREFIX) {
        return Notifications::ALL.iter().find(|n| n.as_str() == value).map(|n| Command::Notifications(*n));
    }
    Some(match id {
        "open_status" => Command::OpenStatus,
        "start_agent" => Command::StartAgent,
        "autostart" => Command::ToggleAutostart,
        "copy_diagnostics" => Command::CopyDiagnostics,
        "open_logs" => Command::OpenLogs,
        "about" => Command::About,
        "hide_icon" => Command::HideIcon,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fixtures;

    fn answer(json: &str) -> TrayAnswer {
        TrayAnswer::parse(json.as_bytes()).unwrap()
    }

    fn ctx(link: AgentLink) -> MenuContext {
        MenuContext { link, autostart: Autostart::On, notifications: Notifications::Problems }
    }

    /// Every label, submenus indented, separators as "-".
    fn labels(entries: &[Entry]) -> Vec<String> {
        let mut out = Vec::new();
        for e in entries {
            match e {
                Entry::Item { label, .. } => out.push(label.clone()),
                Entry::Check { label, checked, .. } => out.push(format!("{}{label}", if *checked { "[x] " } else { "[ ] " })),
                Entry::Separator => out.push("-".into()),
                Entry::Submenu { label, entries } => {
                    out.push(format!("{label} >"));
                    out.extend(labels(entries).into_iter().map(|l| format!("  {l}")));
                }
            }
        }
        out
    }

    fn ids(entries: &[Entry]) -> Vec<String> {
        let mut out = Vec::new();
        for e in entries {
            match e {
                Entry::Item { id, .. } | Entry::Check { id, .. } => out.push(id.clone()),
                Entry::Submenu { entries, .. } => out.extend(ids(entries)),
                Entry::Separator => {}
            }
        }
        out
    }

    #[test]
    fn protected_offers_the_models_actions_and_the_fixed_items() {
        let a = answer(fixtures::PROTECTED);
        assert_eq!(
            labels(&menu_spec(Some(&a), &ctx(AgentLink::Answering))),
            [
                "Scopebond — Protected",
                "Open status…",
                "-",
                "Check now",
                "Open workspace",
                "-",
                "[x] Start with Windows",
                "Notifications >",
                "  [ ] All",
                "  [x] Problems only",
                "  [ ] Off",
                "Help >",
                "  Copy diagnostics",
                "  Open logs folder",
                "  About Scopebond",
                "-",
                "Hide icon",
            ]
        );
    }

    #[test]
    fn the_header_is_not_clickable() {
        let a = answer(fixtures::PROTECTED);
        assert!(matches!(&menu_spec(Some(&a), &ctx(AgentLink::Answering))[0], Entry::Item { enabled: false, .. }));
    }

    #[test]
    fn send_update_and_reconnect_appear_only_when_the_model_offers_them() {
        let protected = labels(&menu_spec(Some(&answer(fixtures::PROTECTED)), &ctx(AgentLink::Answering)));
        for absent in ["Send records now", "Update now", "Reconnect…"] {
            assert!(!protected.iter().any(|l| l == absent), "{absent} without the model offering it");
        }
        let waiting = labels(&menu_spec(Some(&answer(fixtures::WAITING)), &ctx(AgentLink::Answering)));
        assert_eq!(&waiting[3..6], ["Send records now", "Update now", "Check now"], "the fix first, then the model's order");
        let disconnected = labels(&menu_spec(Some(&answer(fixtures::DISCONNECTED)), &ctx(AgentLink::Answering)));
        assert_eq!(&disconnected[3..5], ["Reconnect…", "Check now"]);
    }

    #[test]
    fn there_is_no_quit_and_no_pause() {
        for fixture in [fixtures::PROTECTED, fixtures::WAITING, fixtures::DISCONNECTED] {
            for link in [AgentLink::Answering, AgentLink::Starting, AgentLink::NotAnswering, AgentLink::Stopped, AgentLink::Missing] {
                for label in labels(&menu_spec(Some(&answer(fixture)), &ctx(link))) {
                    let l = label.to_lowercase();
                    assert!(!l.contains("quit") && !l.contains("exit") && !l.contains("pause"), "{label}");
                }
            }
        }
    }

    #[test]
    fn every_item_maps_to_a_command_and_actions_map_to_the_models_routes() {
        let a = answer(fixtures::WAITING);
        let spec = menu_spec(Some(&a), &ctx(AgentLink::Answering));
        for id in ids(&spec) {
            if id == "header" {
                assert_eq!(command_for(&id, Some(&a)), None);
                continue;
            }
            assert!(command_for(&id, Some(&a)).is_some(), "{id} does nothing");
        }
        let routes: Vec<String> = ids(&spec)
            .iter()
            .filter_map(|id| match command_for(id, Some(&a)) {
                Some(Command::Run(action)) => Some(action.route),
                _ => None,
            })
            .collect();
        assert_eq!(routes, ["/flush", "/update", "/check"]);
    }

    #[test]
    fn an_action_the_model_no_longer_offers_does_nothing() {
        let waiting = answer(fixtures::WAITING);
        let protected = answer(fixtures::PROTECTED);
        assert!(matches!(command_for("action:send_now", Some(&waiting)), Some(Command::Run(_))));
        assert_eq!(command_for("action:send_now", Some(&protected)), None);
        assert_eq!(command_for("action:send_now", None), None);
    }

    #[test]
    fn a_route_that_is_not_local_is_never_offered() {
        let mut a = answer(fixtures::PROTECTED);
        a.tray.actions.push(TrayAction { id: "odd".into(), label: "Odd".into(), route: "https://example.com/x".into() });
        assert!(!labels(&menu_spec(Some(&a), &ctx(AgentLink::Answering))).contains(&"Odd".to_string()));
        assert_eq!(command_for("action:odd", Some(&a)), None);
    }

    #[test]
    fn an_action_from_a_newer_agent_is_offered_as_the_model_names_it() {
        let mut a = answer(fixtures::PROTECTED);
        a.tray.actions.push(TrayAction { id: "tidy".into(), label: "Tidy up".into(), route: "/tidy".into() });
        assert!(labels(&menu_spec(Some(&a), &ctx(AgentLink::Answering))).contains(&"Tidy up".to_string()));
        assert_eq!(command_for("action:tidy", Some(&a)).map(|c| matches!(c, Command::Run(x) if x.route == "/tidy")), Some(true));
    }

    #[test]
    fn without_the_agent_it_says_why_and_offers_to_start_it() {
        let spec = menu_spec(None, &ctx(AgentLink::NotAnswering));
        let l = labels(&spec);
        assert_eq!(l[0], "Scopebond — The Scopebond Agent is not answering");
        assert_eq!(l[3], "Start the Scopebond Agent");
        assert_eq!(command_for("start_agent", None), Some(Command::StartAgent));
        let stopped = labels(&menu_spec(None, &ctx(AgentLink::Stopped)));
        assert_eq!(stopped[0], "Scopebond — The Scopebond Agent is stopped");
        let starting = labels(&menu_spec(None, &ctx(AgentLink::Starting)));
        assert!(!starting.contains(&"Start the Scopebond Agent".to_string()), "no second start while one is under way");
        assert!(matches!(
            &spec.iter().find_map(|e| match e { Entry::Submenu { label, entries } if label == "Notifications" => Some(entries[0].clone()), _ => None }),
            Some(Entry::Check { enabled: false, .. })
        ), "the setting lives in the agent, so it waits for it");
    }

    #[test]
    fn notifications_and_autostart() {
        let a = answer(fixtures::PROTECTED);
        let mut c = ctx(AgentLink::Answering);
        c.notifications = Notifications::Off;
        c.autostart = Autostart::Managed;
        let l = labels(&menu_spec(Some(&a), &c));
        assert!(l.contains(&"[x] Start with Windows (set for every user)".to_string()));
        assert!(l.contains(&"  [x] Off".to_string()));
        assert_eq!(command_for("notifications:all", Some(&a)), Some(Command::Notifications(Notifications::All)));
        assert_eq!(command_for("notifications:loud", Some(&a)), None);
        c.autostart = Autostart::Off;
        assert!(labels(&menu_spec(Some(&a), &c)).contains(&"[ ] Start with Windows".to_string()));
    }

    #[test]
    fn labels_are_safe_for_a_windows_menu() {
        assert_eq!(menu_text("Acme & Co", 80), "Acme && Co");
        assert_eq!(menu_text("two\nlines", 80), "two lines");
        assert_eq!(menu_text("abcdefghij", 5), "abcd…");
        let mut a = answer(fixtures::PROTECTED);
        a.tray.headline = "x".repeat(200);
        let Entry::Item { label, .. } = &menu_spec(Some(&a), &ctx(AgentLink::Answering))[0] else { panic!() };
        assert_eq!(label.chars().count(), 80);
    }
}
