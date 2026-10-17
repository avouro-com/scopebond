//! The pure parts of the status panel and of running an action: where the panel goes on screen, and what the tray says
//! after an action (never silence: "Check now" always says what it found).

use serde_json::{json, Value};

use crate::model::RecentBlock;

/// The panel's size in logical pixels (the blocked list, its forms and the settings fit; the list scrolls).
pub const PANEL_WIDTH: f64 = 360.0;
pub const PANEL_HEIGHT: f64 = 560.0;
const MARGIN: f64 = 8.0;

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the panel's top-left corner goes, in physical pixels: beside the point where the tray was clicked, on the side
/// of the screen's work area that has room (above a taskbar at the bottom, below one at the top, and so on), and always
/// inside the work area.
pub fn place(anchor: (f64, f64), work: Area, panel: (f64, f64)) -> (i32, i32) {
    let (ax, ay) = anchor;
    let (pw, ph) = panel;
    let margin = MARGIN * (pw / PANEL_WIDTH).max(1.0);
    let right = work.x + work.width;
    let bottom = work.y + work.height;
    // Its right edge at the click, or its left edge when the click is in the left half (a taskbar on the left).
    let x = if ax - work.x < work.width / 2.0 { ax + margin } else { ax - pw + margin };
    // Above the click when it is in the lower half, below it otherwise.
    let y = if ay - work.y > work.height / 2.0 { ay - ph - margin } else { ay + margin };
    let x = x.min(right - pw - margin).max(work.x + margin);
    let y = y.min(bottom - ph - margin).max(work.y + margin);
    (x.round() as i32, y.round() as i32)
}

/// Words for a state, for the panel and for screen readers.
pub fn state_label(state: &str) -> &'static str {
    match state {
        "protected" => "Protected",
        "working" => "Working",
        "offline" => "Offline",
        "problem" => "Problem",
        "disconnected" => "Not connected",
        _ => "Needs attention",
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.trim().is_empty())
}

/// What the tray says after the agent answered an action.
pub fn outcome_text(action_id: &str, answer: &Value) -> String {
    if let Some(error) = text(answer, "error") {
        return cut(&format!("It did not work: {error}"));
    }
    let said = match action_id {
        "check_now" => text(answer, "text").unwrap_or_else(|| "Checked just now".into()),
        "send_now" => {
            let cycle = answer.get("cycle").cloned().unwrap_or(Value::Null);
            let n = |k: &str| cycle.get(k).and_then(Value::as_u64).unwrap_or(0);
            match text(&cycle, "deliveryError") {
                Some(e) => format!("Could not send now: {e}. The records wait on this computer and are tried again."),
                None if n("pending") == 0 => format!("Sent {} record{}; nothing is waiting", n("delivered"), plural(n("delivered"))),
                None => format!("Sent {} record{}; {} still waiting", n("delivered"), plural(n("delivered")), n("pending")),
            }
        }
        "update_now" => match text(answer, "updated_to") {
            Some(v) => format!("Updating to {v}; Scopebond restarts by itself"),
            None => "Already on the version your workspace recommends".into(),
        },
        "repair" => match answer.get("repaired").and_then(Value::as_array).map(Vec::len) {
            Some(0) | None => "Nothing needed repairing".into(),
            Some(n) => format!("Put the Scopebond hook back in {n} place{}", plural(n as u64)),
        },
        "reconnect" if answer.get("connected").and_then(Value::as_bool) == Some(true) =>
            "Connected to your workspace. Open it from here to make this computer yours.".into(),
        "reconnect" => match (text(answer, "user_code"), text(answer, "verification_url")) {
            (Some(code), _) => format!("Approve this computer in your workspace (the page is opening in your browser). Check that it shows the code {code}."),
            (None, Some(url)) => format!("Approve this computer in your workspace: {url}"),
            _ => "The sign-in started; approve it in your workspace".into(),
        },
        "open_workspace" => match answer.get("opened").and_then(Value::as_bool) {
            Some(false) => "The workspace page could not be opened from here".into(),
            _ => "Opened this computer's page in your workspace".into(),
        },
        _ => text(answer, "text").unwrap_or_else(|| "Done".into()),
    };
    cut(&said)
}

/// What the tray says after the person acted on an earlier block (the agent words it).
pub fn block_text(answer: &Value) -> String {
    cut(&text(answer, "text").unwrap_or_else(|| "Nothing was allowed.".into()))
}

/// What the person can do about a block, as its button says it (the panel and a block notification use the same words):
/// *Unblock…* where the workspace lets them allow it, *Ask to unblock…* where an admin decides, and nothing where the
/// block is final. An older agent that says nothing about it but lets the person act gets *Unblock…* (its Scopebond window
/// offers what there is).
pub fn block_button(block: &RecentBlock) -> Option<&'static str> {
    if !block.can_act || block.action_id.is_none() || block.acted.is_some() {
        return None;
    }
    match &block.offers {
        Some(offers) if offers.allows() => Some("Unblock…"),
        Some(offers) if offers.ask => Some("Ask to unblock…"),
        Some(_) => None,
        None => Some("Unblock…"),
    }
}

/// The longest reason the agent accepts.
pub const REASON_MAX: usize = 500;

/// Whether a character may be in a reason: text, and line breaks; no other control characters.
fn reason_char(c: char) -> bool {
    !c.is_control() || c == '\n' || c == '\r'
}

/// Check an answer from the panel's Unblock form before it goes to the agent (which checks it again): the block is one the
/// person may still act on and says what may be done, the choice is one it offers, and the reason is long enough, at most
/// 500 characters and free of control characters (line breaks aside). The body for `POST /blocked/answer`, or what to say.
pub fn check_answer(block: &RecentBlock, choice: &str, reason: &str) -> Result<Value, String> {
    let id = block.action_id.as_deref().unwrap_or_default();
    let id_ok = !id.is_empty() && id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    let offers = match (&block.offers, block.can_act && id_ok) {
        (Some(offers), true) => offers,
        _ => return Err("This block can no longer be answered here.".into()),
    };
    let offered = match choice {
        "once" => offers.once,
        "fifteen" => offers.fifteen,
        "always" => offers.always,
        "ask" => offers.ask,
        _ => false,
    };
    if !offered {
        return Err("Your workspace does not offer that choice for this block.".into());
    }
    let reason = reason.trim();
    let min = block.reason_min.unwrap_or(10) as usize;
    let length = reason.chars().count();
    if length < min {
        return Err(format!("Say why in at least {min} characters."));
    }
    if length > REASON_MAX {
        return Err(format!("Say why in at most {REASON_MAX} characters."));
    }
    if !reason.chars().all(reason_char) {
        return Err("The reason has characters that cannot be sent.".into());
    }
    Ok(json!({ "action_id": id, "choice": choice, "reason": reason }))
}

fn plural(n: u64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn cut(s: &str) -> String {
    if s.chars().count() <= 300 { s.to_string() } else { s.chars().take(299).chain(std::iter::once('…')).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SCREEN: Area = Area { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };

    #[test]
    fn above_a_bottom_taskbar_at_the_click() {
        let (x, y) = place((1800.0, 1060.0), SCREEN, (360.0, 420.0));
        assert_eq!((x, y), (1448, 612));
    }

    #[test]
    fn below_a_top_taskbar_and_right_of_a_left_one() {
        let top = Area { x: 0.0, y: 40.0, width: 1920.0, height: 1040.0 };
        assert_eq!(place((1800.0, 20.0), top, (360.0, 420.0)).1, 48);
        let left = Area { x: 60.0, y: 0.0, width: 1860.0, height: 1080.0 };
        assert_eq!(place((30.0, 1000.0), left, (360.0, 420.0)).0, 68);
    }

    #[test]
    fn always_inside_the_work_area_on_any_monitor() {
        let second = Area { x: 1920.0, y: -200.0, width: 1280.0, height: 984.0 };
        for anchor in [(1925.0, -190.0), (3195.0, 780.0), (2500.0, 300.0)] {
            let (x, y) = place(anchor, second, (720.0, 840.0));
            assert!(x as f64 >= second.x && x as f64 + 720.0 <= second.x + second.width, "{anchor:?}: x {x}");
            assert!(y as f64 >= second.y && y as f64 + 840.0 <= second.y + second.height, "{anchor:?}: y {y}");
        }
    }

    #[test]
    fn check_now_says_what_it_found() {
        assert_eq!(outcome_text("check_now", &json!({ "text": "Checked just now: all good", "tray": {} })), "Checked just now: all good");
        assert_eq!(outcome_text("check_now", &json!({})), "Checked just now");
    }

    #[test]
    fn send_now_says_what_was_sent_or_why_not() {
        assert_eq!(outcome_text("send_now", &json!({ "cycle": { "delivered": 12, "pending": 0, "deliveryError": null } })), "Sent 12 records; nothing is waiting");
        assert_eq!(outcome_text("send_now", &json!({ "cycle": { "delivered": 1, "pending": 3, "deliveryError": null } })), "Sent 1 record; 3 still waiting");
        assert!(outcome_text("send_now", &json!({ "cycle": { "delivered": 0, "pending": 3, "deliveryError": "fetch failed" } })).starts_with("Could not send now: fetch failed."));
    }

    #[test]
    fn reconnect_shows_the_code_to_check() {
        assert!(outcome_text("reconnect", &json!({ "connected": true })).starts_with("Connected to your workspace."));
        let t = outcome_text("reconnect", &json!({ "user_code": "ABCD-EFGH", "verification_url": "https://cloud.example.test/device" }));
        assert!(t.ends_with("Check that it shows the code ABCD-EFGH."));
        assert_eq!(outcome_text("reconnect", &json!({ "error": "this computer was never connected" })), "It did not work: this computer was never connected");
    }

    #[test]
    fn the_other_actions() {
        assert_eq!(outcome_text("update_now", &json!({ "updated_to": "0.6.0", "error": null })), "Updating to 0.6.0; Scopebond restarts by itself");
        assert_eq!(outcome_text("update_now", &json!({ "updated_to": null, "error": null })), "Already on the version your workspace recommends");
        assert_eq!(outcome_text("repair", &json!({ "repaired": [{ "harness": "claude" }] })), "Put the Scopebond hook back in 1 place");
        assert_eq!(outcome_text("open_workspace", &json!({ "opened": false })), "The workspace page could not be opened from here");
        assert_eq!(outcome_text("something_new", &json!({})), "Done");
        assert_eq!(block_text(&json!({ "outcome": "asked", "text": "Request sent." })), "Request sent.");
        assert_eq!(outcome_text("check_now", &json!({ "text": "x".repeat(500) })).chars().count(), 300);
    }

    fn answerable() -> RecentBlock {
        RecentBlock {
            action_id: Some("act-read-env-0000000001".into()),
            can_act: true,
            reason_min: Some(12),
            offers: Some(crate::model::BlockOffers { once: true, fifteen: true, ask: true, ..Default::default() }),
            ..Default::default()
        }
    }

    #[test]
    fn a_blocks_button_follows_what_the_workspace_lets_a_person_do() {
        use crate::model::BlockOffers;
        let mut b = answerable();
        assert_eq!(block_button(&b), Some("Unblock…"), "self-service");
        b.offers = Some(BlockOffers { ask: true, ..Default::default() });
        assert_eq!(block_button(&b), Some("Ask to unblock…"), "an admin decides");
        b.offers = Some(BlockOffers::default());
        assert_eq!(block_button(&b), None, "final: no button");
        b.can_act = false;
        b.offers = None;
        assert_eq!(block_button(&b), None, "nothing to do");
        b.can_act = true;
        assert_eq!(block_button(&b), Some("Unblock…"), "an older agent: its window offers what there is");
        b.acted = Some("asked".into());
        assert_eq!(block_button(&b), None, "already acted on");
        // Unblocking automatically, reviewed later: one length the workspace set, and the same button.
        let mut automatic = answerable();
        automatic.offers = serde_json::from_value(json!({ "once": false, "fifteen": true, "always": false, "ask": false, "reviewed": true })).ok();
        assert!(automatic.offers.as_ref().is_some_and(|o| o.reviewed));
        assert_eq!(block_button(&automatic), Some("Unblock…"));
        assert!(check_answer(&automatic, "fifteen", "The tests need the API URL").is_ok());
        assert!(check_answer(&automatic, "once", "The tests need the API URL").is_err(), "only the length the workspace set");
    }

    #[test]
    fn an_answer_is_checked_before_it_is_sent() {
        let b = answerable();
        let body = check_answer(&b, "fifteen", "  The tests need the API URL  ").unwrap();
        assert_eq!(body, json!({ "action_id": "act-read-env-0000000001", "choice": "fifteen", "reason": "The tests need the API URL" }));
        assert_eq!(check_answer(&b, "always", "The tests need the API URL").unwrap_err(), "Your workspace does not offer that choice for this block.");
        assert_eq!(check_answer(&b, "forever", "The tests need the API URL").unwrap_err(), "Your workspace does not offer that choice for this block.");
        assert_eq!(check_answer(&b, "once", "too short").unwrap_err(), "Say why in at least 12 characters.");
        assert!(check_answer(&b, "once", &"x".repeat(501)).is_err());
        let two_lines = format!("two lines{}are fine here", '\n');
        assert!(check_answer(&b, "once", &two_lines).is_ok());
        let bell = format!("a bell {} is not fine", char::from(7u8));
        assert!(check_answer(&b, "once", &bell).is_err());
        let mut done = answerable();
        done.can_act = false;
        assert_eq!(check_answer(&done, "once", "The tests need the API URL").unwrap_err(), "This block can no longer be answered here.");
        let mut older = answerable();
        older.offers = None;
        assert!(check_answer(&older, "once", "The tests need the API URL").is_err(), "an older agent: the Scopebond window answers");
        let mut odd = answerable();
        odd.action_id = Some("../flush".into());
        assert!(check_answer(&odd, "once", "The tests need the API URL").is_err());
    }

    #[test]
    fn states_in_words() {
        assert_eq!(state_label("disconnected"), "Not connected");
        assert_eq!(state_label("brand-new"), "Needs attention");
    }
}
