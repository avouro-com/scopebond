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

/// What the person may do about a block, as the workspace allows it now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BlockOffers {
    /// Allow it once (the next try).
    pub once: bool,
    /// Allow it for 15 minutes.
    pub fifteen: bool,
    /// Always allow it on this computer, for `always_days` (after an admin approves, when `always_needs_admin`).
    pub always: bool,
    pub always_days: Option<u32>,
    pub always_needs_admin: bool,
    /// Ask an admin.
    pub ask: bool,
    /// The workspace reviews every unblock later and may undo it (false from an older agent).
    pub reviewed: bool,
}

impl BlockOffers {
    /// Whether the person may let it through here (once, for 15 minutes or always), not only ask an admin.
    pub fn allows(&self) -> bool {
        self.once || self.fifteen || self.always
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RecentBlock {
    pub action_id: Option<String>,
    /// The one-line description `log` prints (`shell.exec rm`); newer agents also send `what`.
    pub summary: String,
    pub at: String,
    pub rule: Option<String>,
    /// The person may still allow it or ask an admin.
    pub can_act: bool,
    /// What they did: "allowed", "asked", or nothing yet.
    pub acted: Option<String>,
    /// The action in plain words ("Read .env.production"), secrets masked; empty from an older agent.
    pub what: String,
    /// The text the Scopebond window shows for it.
    pub action_text: String,
    pub rule_title: Option<String>,
    pub project: Option<String>,
    pub tool: Option<String>,
    /// What may be done now (none when nothing can be, or from an older agent).
    pub offers: Option<BlockOffers>,
    pub reason_min: Option<u32>,
    /// How many times the coding agent tried it (retries folded; 0 from an older agent, read as 1).
    pub tries: u32,
    /// The first try's action id, the same for every retry, so a retry is not announced again (none from an older agent).
    pub group_id: Option<String>,
    /// The one outcome the row shows, and the sentence that stands in for a button (none from an older agent).
    pub outcome: Option<String>,
    pub outcome_text: Option<String>,
    /// When the coding agent first tried it, the text "Copy details" copies, and the person's request for it (none from an
    /// older agent). Kept so the panel gets them: it draws what the tray passes on, and a field not named here is dropped.
    pub first_at: Option<String>,
    pub copy_details: Option<String>,
    pub request: Option<serde_json::Value>,
    /// Why the rule exists, in one line, for the block's details (none when the rule says nothing about itself).
    pub rule_why: Option<String>,
}

/// Blocks the panel shows as one row: today's repeats of one action under one rule. `members` index `recent_blocks`,
/// newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BlockGroup {
    pub key: String,
    pub members: Vec<usize>,
    pub times: u64,
    pub first_at: String,
    pub last_at: String,
    pub today: bool,
}

/// The rule's name when the agent sends none (an older agent): never an empty line, never a rule id.
pub const ANY_RULE: &str = "A Scopebond rule";

impl RecentBlock {
    /// The words to show: the plain words, or the older summary.
    pub fn words(&self) -> &str {
        if self.what.trim().is_empty() { &self.summary } else { &self.what }
    }

    /// The rule's name as the workspace shows it, or "A Scopebond rule".
    pub fn rule_name(&self) -> &str {
        self.rule_title.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(ANY_RULE)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Today {
    pub actions: u64,
    pub blocked: u64,
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
    /// The rows the panel's Blocked list shows (none from an older agent: each block is its own row).
    pub blocked_groups: Vec<BlockGroup>,
    /// The line under "Protected" (when the rules were checked, what was blocked today); none otherwise.
    pub detail: Option<String>,
    /// The workspace's name, when the agent knows it.
    pub workspace: Option<String>,
    pub today: Option<Today>,
    /// Whether the workspace lets a person ask an admin under any rule (none from an older agent).
    pub can_ask: Option<bool>,
    /// What the person let through (in force, or waiting for an admin), newest first.
    pub allowed: Vec<AllowedItem>,
    /// What the person asked an admin, newest first, with the answer when there is one.
    pub asked: Vec<AskedItem>,
    /// The hook's question waiting for the person now (the live prompt), when the tray is listening.
    pub pending: Option<LiveQuestion>,
}

/// A question the hook is waiting on during a coding session: what the coding tool tried, under which rule, what the person
/// may do, and until when the hook waits.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LiveQuestion {
    pub action_id: String,
    pub what: String,
    pub action_text: String,
    pub rule: String,
    pub rule_title: String,
    pub tool: Option<String>,
    pub project: Option<String>,
    pub reason_min: u32,
    pub offers: BlockOffers,
    /// When the hook stops waiting (RFC 3339).
    pub deadline: String,
    /// The person opened it in the tray.
    pub opened: bool,
}

/// An allowance in force or waiting for an admin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AllowedItem {
    pub id: String,
    pub rule: String,
    pub rule_title: Option<String>,
    pub what: Option<String>,
    /// "once", "fifteen" or "always".
    pub choice: String,
    /// "active" or "proposed".
    pub state: String,
    pub needs_admin: bool,
    /// "person" (made on this computer) or "admin".
    pub by: String,
    pub created_at: String,
    pub ends_at: String,
    pub answered_by: Option<String>,
    /// "automatic" (applied at once by the workspace's terms, reviewed later), "person", or none (an older agent).
    pub unblocked: Option<String>,
}

/// A request to an admin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AskedItem {
    pub id: String,
    pub rule: String,
    pub rule_title: Option<String>,
    pub what: String,
    pub reason: String,
    pub asked_at: String,
    pub sent: bool,
    /// "waiting", "approved" or "declined".
    pub state: String,
    pub answered_by: Option<String>,
    pub note: Option<String>,
    pub answered_at: Option<String>,
    /// The coding tool that asked ("Claude Code"); none from an older agent.
    pub tool: Option<String>,
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

    /// How many actions were blocked today: the agent's count, or (from an older agent) the blocks it listed.
    pub fn blocked_today(&self) -> u64 {
        self.today.as_ref().map(|t| t.blocked).unwrap_or(self.recent_blocks.len() as u64)
    }

    /// Whether the panel shows the Requests list: the workspace lets a person ask an admin (under any rule, or for a listed
    /// block), or the person has asked before.
    pub fn asks(&self) -> bool {
        self.can_ask == Some(true) || !self.asked.is_empty() || self.recent_blocks.iter().any(|b| b.offers.as_ref().is_some_and(|o| o.ask))
    }

    /// The block with this id that the person may still act on.
    pub fn actionable_block(&self, action_id: &str) -> Option<&RecentBlock> {
        self.recent_blocks.iter().find(|b| b.can_act && b.action_id.as_deref() == Some(action_id))
    }
}

/// Which notifications the person wants: blocks and problems (the agent's default for a new install), problems only (the
/// default when the agent says nothing), or none. An older agent's "all" meant blocks and problems too.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", from = "String")]
pub enum Notifications {
    Blocks,
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
    pub const ALL: [Notifications; 3] = [Notifications::Blocks, Notifications::Problems, Notifications::Off];

    pub fn parse(value: &str) -> Notifications {
        match value {
            "blocks" | "all" => Notifications::Blocks,
            "off" => Notifications::Off,
            _ => Notifications::Problems,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Notifications::Blocks => "blocks",
            Notifications::Problems => "problems",
            Notifications::Off => "off",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Notifications::Blocks => "Blocks and problems",
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

    /// A newer agent's answer: blocks in plain words with what may be done, the line under the state, today's counts.
    pub const BLOCKED: &str = r#"{
      "tray": {
        "state": "protected", "headline": "Protected", "tooltip": "Scopebond — Protected · Acme",
        "rows": [], "fix": null, "hint": null,
        "actions": [
          { "id": "check_now", "label": "Check now", "route": "/check" },
          { "id": "open_workspace", "label": "Open workspace", "route": "/open-workspace" }
        ],
        "detail": "Rules checked 3 min ago · 2 blocked today", "workspace": "Acme", "today": { "actions": 1160, "blocked": 2 }, "can_ask": true,
        "allowed": [
          { "id": "alw_aaaaaaaaaaaaaaaaaaaa", "rule": "secret-read", "rule_title": "Read passwords, keys or secrets", "what": ".env.staging", "choice": "fifteen",
            "state": "active", "needs_admin": false, "by": "person", "created_at": "2026-10-14T15:52:00.000Z", "ends_at": "2026-10-14T16:07:00.000Z", "answered_by": null }
        ],
        "asked": [
          { "id": "req_aaaaaaaaaaaaaaaaaaaa", "rule": "destructive-shell", "rule_title": "Run a command that deletes data or shuts down the computer", "what": "rm -rf ./dist", "reason": "Clearing the release build",
            "asked_at": "2026-10-14T13:52:00.000Z", "sent": true, "state": "declined", "answered_by": "morgan@acme.test", "note": "Use the clean script", "answered_at": null }
        ],
        "recent_blocks": [
          { "action_id": "act-read-env-0000000001", "summary": "file.read .env.production", "at": "2026-10-14T15:46:00.000Z", "rule": "secret-read",
            "can_act": true, "acted": null, "what": "Read .env.production", "action_text": ".env.production", "rule_title": "Read passwords, keys or secrets",
            "project": "checkout", "tool": "Claude Code", "reason_min": 10,
            "offers": { "once": true, "fifteen": true, "always": true, "always_days": 30, "always_needs_admin": false, "ask": true } },
          { "action_id": "act-push-main-00000001", "summary": "git.push origin main", "at": "2026-10-14T15:24:00.000Z", "rule": "force-push-protected",
            "can_act": true, "acted": null, "what": "git push --force origin main", "action_text": "git push origin main",
            "rule_title": "Rewrite history on a protected branch", "project": "checkout", "tool": "Claude Code", "reason_min": 20,
            "offers": { "once": false, "fifteen": false, "always": false, "always_days": null, "always_needs_admin": false, "ask": true } }
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
    fn reads_blocks_in_plain_words_with_what_may_be_done() {
        let a = TrayAnswer::parse(fixtures::BLOCKED.as_bytes()).expect("parses");
        let read = &a.tray.recent_blocks[0];
        assert_eq!(read.words(), "Read .env.production");
        assert_eq!(read.rule_title.as_deref(), Some("Read passwords, keys or secrets"));
        assert_eq!(read.tool.as_deref(), Some("Claude Code"));
        assert_eq!(read.reason_min, Some(10));
        let offers = read.offers.clone().unwrap();
        assert!(offers.allows() && offers.fifteen && offers.ask);
        assert_eq!(offers.always_days, Some(30));
        let push = &a.tray.recent_blocks[1];
        assert!(!push.offers.clone().unwrap().allows(), "only Ask an admin");
        assert_eq!(a.tray.blocked_today(), 2);
        assert_eq!(a.tray.workspace.as_deref(), Some("Acme"));
        assert!(a.tray.asks());
        let mut final_rules = a.tray.clone();
        final_rules.can_ask = Some(false);
        final_rules.asked.clear();
        final_rules.recent_blocks.iter_mut().for_each(|b| b.offers = None);
        assert!(!final_rules.asks(), "nothing to ask: no Requests list");
        assert_eq!(a.tray.allowed[0].choice, "fifteen");
        assert_eq!(a.tray.asked[0].state, "declined");
        assert_eq!(a.tray.asked[0].note.as_deref(), Some("Use the clean script"));
        assert!(TrayAnswer::parse(fixtures::PROTECTED.as_bytes()).unwrap().tray.allowed.is_empty(), "an older agent sends no lists");
        assert!(a.tray.actionable_block("act-push-main-00000001").is_some());
        assert!(a.tray.actionable_block("act-unknown").is_none());
        // An older agent's block: the summary stands in for the plain words, and nothing says what may be done.
        let old = TrayAnswer::parse(fixtures::PROTECTED.as_bytes()).unwrap();
        assert_eq!(old.tray.recent_blocks[0].words(), "rm -rf build");
        assert_eq!(old.tray.recent_blocks[0].offers, None);
        assert_eq!(old.tray.blocked_today(), 1, "an older agent: the blocks it listed");
    }

    #[test]
    fn the_fields_the_panel_draws_pass_through_the_tray() {
        // The panel gets the model as the tray serializes it again: a field the tray does not name never reaches it.
        let json = r#"{"tray":{"state":"protected","headline":"Protected",
          "recent_blocks":[{"action_id":"a1","summary":"rm","at":"2026-10-21T15:00:00.000Z","what":"rm -rf ../build",
            "first_at":"2026-10-21T14:58:00.000Z","copy_details":"rm -rf ../build\nRule: Delete","rule_why":"Deny destructive programs.",
            "request":{"state":"waiting","answered_by":null,"answered_at":null},"outcome":"requested"}],
          "blocked_groups":[{"key":"Delete\nrm -rf ../build","members":[0],"times":3,"first_at":"2026-10-21T14:58:00.000Z","last_at":"2026-10-21T15:00:00.000Z","today":true}]}}"#;
        let a = TrayAnswer::parse(json.as_bytes()).unwrap();
        let again = serde_json::to_value(&a).unwrap();
        let b = &again["tray"]["recent_blocks"][0];
        assert_eq!(b["rule_why"], "Deny destructive programs.");
        assert_eq!(b["copy_details"], "rm -rf ../build\nRule: Delete");
        assert_eq!(b["first_at"], "2026-10-21T14:58:00.000Z");
        assert_eq!(b["request"]["state"], "waiting");
        assert_eq!(again["tray"]["blocked_groups"][0]["times"], 3);
        assert_eq!(a.tray.blocked_groups[0].members, vec![0]);
        assert!(TrayAnswer::parse(fixtures::PROTECTED.as_bytes()).unwrap().tray.blocked_groups.is_empty(), "an older agent sends none");
    }

    #[test]
    fn fields_it_does_not_know_and_fields_that_are_missing_are_fine() {
        let a = TrayAnswer::parse(br#"{"tray":{"state":"working","headline":"Updating","new_field":1},"settings":{"notifications":"loud"}}"#).unwrap();
        assert_eq!(a.tray.icon_state(), IconState::Working);
        assert!(a.tray.actions.is_empty());
        assert_eq!(a.settings.notifications, Notifications::Problems, "an unknown setting reads as the default");
    }

    #[test]
    fn notification_settings_old_and_new() {
        assert_eq!(Notifications::parse("blocks"), Notifications::Blocks);
        assert_eq!(Notifications::parse("all"), Notifications::Blocks, "an older agent's all meant blocks and problems");
        assert_eq!(Notifications::Blocks.as_str(), "blocks");
        assert_eq!(Notifications::Blocks.label(), "Blocks and problems");
        assert_eq!(serde_json::to_string(&Notifications::Blocks).unwrap(), "\"blocks\"");
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
