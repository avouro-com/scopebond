//! The live prompt, as plain decisions (no window system here, so it is tested on its own). When the hook asks during a
//! coding session, the agent hands the question to the tray (`POST /override/wait`): the tray tells the person once, with
//! the button the panel would show (*Unblock…* or *Ask to unblock…*), and the panel shows the question's form. The answer
//! goes to `POST /override/answer`, checked here first exactly as an earlier block's is. Also here: which allowances the
//! person may stop.

use serde_json::{json, Value};

use crate::model::{AllowedItem, LiveQuestion, Notifications, RecentBlock};
use crate::notify::{Kind, Toast};
use crate::panel::{block_button, check_answer};

/// How long one wait for a question may take (the agent answers within 20 s).
pub const WAIT_TIMEOUT_SECS: u64 = 25;

/// The body of the tray's wait: the question it last saw, so a new one comes back at once.
pub fn wait_body(seen: Option<&str>) -> Value {
    json!({ "seen": seen })
}

/// The question in the agent's answer to a wait, if there is one (an older agent has no such route: none).
pub fn parse_wait(answer: &Value) -> Option<LiveQuestion> {
    let q = answer.get("question")?;
    if q.is_null() {
        return None;
    }
    serde_json::from_value::<LiveQuestion>(q.clone()).ok().filter(|q| !q.action_id.is_empty())
}

/// The question as a block the person may act on, so the panel's form, its checks and its button are the same ones.
pub fn as_block(q: &LiveQuestion) -> RecentBlock {
    RecentBlock {
        action_id: Some(q.action_id.clone()),
        summary: q.what.clone(),
        what: q.what.clone(),
        action_text: q.action_text.clone(),
        rule: Some(q.rule.clone()),
        rule_title: Some(q.rule_title.clone()).filter(|t| !t.is_empty()),
        tool: q.tool.clone(),
        project: q.project.clone(),
        can_act: true,
        offers: Some(q.offers.clone()),
        reason_min: Some(q.reason_min),
        ..Default::default()
    }
}

/// Check the person's answer to the question waiting now; the body for `POST /override/answer`, or what to say.
pub fn check_live_answer(q: &LiveQuestion, choice: &str, reason: &str) -> Result<Value, String> {
    check_answer(&as_block(q), choice, reason)
}

/// Tells the person once about each question that starts waiting.
#[derive(Debug, Default)]
pub struct LiveWatch {
    told: Option<String>,
}

impl LiveWatch {
    pub fn new() -> LiveWatch {
        LiveWatch::default()
    }

    /// The notification for a question that just started waiting, if any. The person is told unless they turned
    /// notifications off (the Scopebond window opens anyway when they do not open the question in time).
    pub fn observe(&mut self, question: Option<&LiveQuestion>, setting: Notifications) -> Option<Toast> {
        let q = question?;
        if self.told.as_deref() == Some(q.action_id.as_str()) {
            return None;
        }
        self.told = Some(q.action_id.clone());
        if setting == Notifications::Off {
            return None;
        }
        let block = as_block(q);
        let button = block_button(&block);
        let who = q.tool.clone().unwrap_or_else(|| "Your coding agent".into());
        let rule = block.rule_name().to_string();
        Some(Toast {
            kind: Kind::Block,
            title: cut(&format!("Blocked: {}", block.words()), 120),
            text: cut(&format!("{who} is waiting for your answer · {rule}"), 200),
            unblock: button.and(Some(q.action_id.clone())),
            button,
        })
    }
}

/// Whether the person may stop this allowance from the tray: one they made (or that applied at once by the workspace's
/// terms), in force or waiting for an admin. One an admin made is not theirs to stop.
pub fn stoppable(item: &AllowedItem) -> bool {
    item.by == "person" && (item.state == "active" || item.state == "proposed") && !item.id.is_empty()
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max - 1).chain(std::iter::once('…')).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::BlockOffers;

    fn question(offers: BlockOffers) -> LiveQuestion {
        LiveQuestion {
            action_id: "act-live-000000000001".into(),
            what: "Read .env.production".into(),
            action_text: ".env.production".into(),
            rule: "secret-read".into(),
            rule_title: "Read passwords, keys or secrets".into(),
            tool: Some("Claude Code".into()),
            reason_min: 12,
            offers,
            deadline: "2026-10-14T16:00:00.000Z".into(),
            ..Default::default()
        }
    }

    #[test]
    fn reads_the_question_from_a_wait_and_nothing_from_an_older_agent() {
        let q = parse_wait(&json!({ "question": { "action_id": "act-1", "what": "Read .env", "rule": "secret-read", "rule_title": "Read passwords, keys or secrets",
            "reason_min": 12, "deadline": "2026-10-14T16:00:00.000Z", "opened": false,
            "offers": { "once": true, "fifteen": true, "always": false, "always_days": null, "always_needs_admin": false, "ask": true, "reviewed": false } } }));
        let q = q.expect("a question");
        assert_eq!(q.reason_min, 12);
        assert!(q.offers.once && q.offers.ask);
        assert_eq!(parse_wait(&json!({ "question": null })), None);
        assert_eq!(parse_wait(&json!({ "error": "not found" })), None);
        assert_eq!(parse_wait(&json!({ "question": { "what": "no id" } })), None);
        assert_eq!(wait_body(Some("act-1")), json!({ "seen": "act-1" }));
        assert_eq!(wait_body(None), json!({ "seen": null }));
    }

    #[test]
    fn the_person_is_told_once_per_question_with_the_panels_button() {
        let mut w = LiveWatch::new();
        let unblock = question(BlockOffers { once: true, fifteen: true, ask: true, ..Default::default() });
        let t = w.observe(Some(&unblock), Notifications::Blocks).expect("told");
        assert_eq!(t.title, "Blocked: Read .env.production");
        assert_eq!(t.text, "Claude Code is waiting for your answer · Read passwords, keys or secrets");
        assert_eq!((t.button, t.unblock.as_deref()), (Some("Unblock…"), Some("act-live-000000000001")));
        assert_eq!(w.observe(Some(&unblock), Notifications::Blocks), None, "once");
        assert_eq!(w.observe(None, Notifications::Blocks), None);
        let mut ask = question(BlockOffers { ask: true, ..Default::default() });
        ask.action_id = "act-live-000000000002".into();
        assert_eq!(w.observe(Some(&ask), Notifications::Blocks).unwrap().button, Some("Ask to unblock…"));
        let mut off = ask.clone();
        off.action_id = "act-live-000000000003".into();
        assert_eq!(w.observe(Some(&off), Notifications::Off), None, "off: the window still opens in time");
    }

    #[test]
    fn an_answer_is_checked_as_an_earlier_blocks_is() {
        let q = question(BlockOffers { fifteen: true, reviewed: true, ..Default::default() });
        assert_eq!(check_live_answer(&q, "fifteen", "  The tests need the API URL ").unwrap(),
            json!({ "action_id": "act-live-000000000001", "choice": "fifteen", "reason": "The tests need the API URL" }));
        assert!(check_live_answer(&q, "once", "The tests need the API URL").is_err(), "only the length the workspace set");
        assert_eq!(check_live_answer(&q, "fifteen", "short").unwrap_err(), "Say why in at least 12 characters.");
        assert_eq!(as_block(&q).words(), "Read .env.production");
    }

    #[test]
    fn only_the_persons_own_allowances_can_be_stopped() {
        let mine = AllowedItem { id: "alw_1".into(), by: "person".into(), state: "active".into(), ..Default::default() };
        assert!(stoppable(&mine));
        assert!(stoppable(&AllowedItem { state: "proposed".into(), ..mine.clone() }));
        assert!(!stoppable(&AllowedItem { by: "admin".into(), ..mine.clone() }), "an admin's");
        assert!(!stoppable(&AllowedItem { state: "revoked".into(), ..mine.clone() }));
        assert!(!stoppable(&AllowedItem { id: String::new(), ..mine }));
    }
}
