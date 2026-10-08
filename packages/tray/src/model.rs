//! What the agent's `GET /tray` answers: the tray model (one state, one headline, the rows that have data, the one fix,
//! the actions that apply now, recent blocks) and the person's tray settings. The tray never works out health itself; it
//! draws this. Every field has a default, so an answer from an older or newer agent still reads.

use serde::{Deserialize, Serialize};

use crate::icon::IconState;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrayAction {
    pub id: String,
    pub label: String,
    /// The agent's local route that does it (POST).
    pub route: String,
}

impl TrayAction {
    /// A route the tray will call: a short path of lower-case words, never a full address.
    pub fn route_is_valid(&self) -> bool {
        let r = self.route.as_str();
        r.len() > 1
            && r.len() <= 64
            && r.starts_with('/')
            && r[1..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '/')
            && !r.contains("//")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Row {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RecentBlock {
    pub action_id: Option<String>,
    pub summary: String,
    pub at: String,
    pub rule: Option<String>,
    /// The person may still allow it or ask an admin.
    pub can_act: bool,
    /// What they did: "allowed", "asked", or nothing yet.
    pub acted: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrayModel {
    pub state: String,
    pub headline: String,
    pub tooltip: String,
    pub rows: Vec<Row>,
    pub fix: Option<TrayAction>,
    pub actions: Vec<TrayAction>,
    pub hint: Option<String>,
    pub recent_blocks: Vec<RecentBlock>,
}

impl TrayModel {
    pub fn icon_state(&self) -> IconState {
        IconState::parse(&self.state)
    }

    /// The fix first, then the other actions in the agent's order, each once, only those with a route the tray calls.
    pub fn offered(&self) -> Vec<&TrayAction> {
        let mut out: Vec<&TrayAction> = Vec::new();
        for action in self.fix.iter().chain(self.actions.iter()) {
            if action.route_is_valid() && !action.label.trim().is_empty() && !out.iter().any(|a| a.id == action.id) {
                out.push(action);
            }
        }
        out
    }

    /// The offered action with this id, if the model still offers it.
    pub fn offered_action(&self, id: &str) -> Option<&TrayAction> {
        self.offered().into_iter().find(|a| a.id == id)
    }
}

/// Which notifications the person wants: everything (blocks too), problems only (the default), or none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", from = "String")]
pub enum Notifications {
    All,
    #[default]
    Problems,
    Off,
}

impl From<String> for Notifications {
    fn from(value: String) -> Self {
        Notifications::parse(&value)
    }
}

impl Notifications {
    pub const ALL: [Notifications; 3] = [Notifications::All, Notifications::Problems, Notifications::Off];

    pub fn parse(value: &str) -> Notifications {
        match value {
            "all" => Notifications::All,
            "off" => Notifications::Off,
            _ => Notifications::Problems,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Notifications::All => "all",
            Notifications::Problems => "problems",
            Notifications::Off => "off",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Notifications::All => "All",
            Notifications::Problems => "Problems only",
            Notifications::Off => "Off",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub notifications: Notifications,
}

/// The whole answer of `GET /tray`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrayAnswer {
    pub tray: TrayModel,
    pub settings: Settings,
}

impl TrayAnswer {
    pub fn parse(json: &[u8]) -> Option<TrayAnswer> {
        serde_json::from_slice::<TrayAnswer>(json).ok().filter(|a| !a.tray.state.is_empty())
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    /// A real answer's shape, as the agent writes it.
    pub const PROTECTED: &str = r#"{
      "tray": {
        "state": "protected", "headline": "Protected", "tooltip": "Scopebond — Protected · Acme · Laptops",
        "rows": [
          { "label": "Rules", "value": "Up to date · checked just now · 4 block · 2 monitor" },
          { "label": "Delivery", "value": "All sent · just now" },
          { "label": "Version", "value": "Up to date (agent 0.5.1)" }
        ],
        "fix": null,
        "actions": [
          { "id": "check_now", "label": "Check now", "route": "/check" },
          { "id": "open_workspace", "label": "Open workspace", "route": "/open-workspace" }
        ],
        "hint": null,
        "recent_blocks": [
          { "action_id": "a1", "summary": "rm -rf build", "at": "2026-10-08T09:12:00.000Z", "rule": "no-destroy", "can_act": true, "acted": null }
        ]
      },
      "settings": { "notifications": "problems" }
    }"#;

    pub const WAITING: &str = r#"{
      "tray": {
        "state": "attention", "headline": "12 records waiting to send", "tooltip": "Scopebond — 12 records waiting to send",
        "rows": [], "hint": null, "recent_blocks": [],
        "fix": { "id": "send_now", "label": "Send records now", "route": "/flush" },
        "actions": [
          { "id": "update_now", "label": "Update now", "route": "/update" },
          { "id": "check_now", "label": "Check now", "route": "/check" }
        ]
      },
      "settings": { "notifications": "all" }
    }"#;

    pub const DISCONNECTED: &str = r#"{
      "tray": {
        "state": "disconnected", "headline": "Not connected to your workspace: using this computer's own rules",
        "tooltip": "Scopebond — Not connected", "rows": [], "hint": null, "recent_blocks": [],
        "fix": { "id": "reconnect", "label": "Reconnect…", "route": "/reconnect" },
        "actions": [ { "id": "check_now", "label": "Check now", "route": "/check" } ]
      },
      "settings": { "notifications": "off" }
    }"#;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_agents_answer() {
        let a = TrayAnswer::parse(fixtures::PROTECTED.as_bytes()).expect("parses");
        assert_eq!(a.tray.icon_state(), IconState::Protected);
        assert_eq!(a.tray.rows.len(), 3);
        assert_eq!(a.tray.recent_blocks[0].action_id.as_deref(), Some("a1"));
        assert!(a.tray.recent_blocks[0].can_act);
        assert_eq!(a.settings.notifications, Notifications::Problems);
    }

    #[test]
    fn fields_it_does_not_know_and_fields_that_are_missing_are_fine() {
        let a = TrayAnswer::parse(br#"{"tray":{"state":"working","headline":"Updating","new_field":1},"settings":{"notifications":"loud"}}"#).unwrap();
        assert_eq!(a.tray.icon_state(), IconState::Working);
        assert!(a.tray.actions.is_empty());
        assert_eq!(a.settings.notifications, Notifications::Problems, "an unknown setting reads as the default");
    }

    #[test]
    fn something_that_is_not_a_tray_answer_is_none() {
        assert!(TrayAnswer::parse(b"{\"error\":\"unauthorized\"}").is_none());
        assert!(TrayAnswer::parse(b"not json").is_none());
    }

    #[test]
    fn the_fix_comes_first_and_each_action_once() {
        let mut a = TrayAnswer::parse(fixtures::WAITING.as_bytes()).unwrap();
        a.tray.actions.push(a.tray.fix.clone().unwrap());
        let ids: Vec<&str> = a.tray.offered().iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["send_now", "update_now", "check_now"]);
    }

    #[test]
    fn only_local_routes_are_called() {
        let ok = |route: &str| TrayAction { id: "x".into(), label: "X".into(), route: route.into() }.route_is_valid();
        assert!(ok("/flush"));
        assert!(ok("/open-workspace"));
        assert!(!ok("flush"));
        assert!(!ok("/"));
        assert!(!ok("http://example.com/flush"));
        assert!(!ok("//example.com"));
        assert!(!ok("/flush?x=1"));
        assert!(!ok("/Flush"));
    }
}
