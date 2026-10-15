//! When the tray shows a Windows notification, as plain decisions (tested here; the tray only shows what this returns):
//!
//! - one when the state gets worse: at once for a problem or a lost connection to the workspace, and for "needs
//!   attention" only once it has lasted five minutes, so sleep and wake or a short hiccup do not flap;
//! - one when it is protected again after one of those;
//! - with *Blocks and problems*, one for a new block (with *Unblock…* when the person may act on it); further blocks within
//!   a minute of that one wait and are told together ("3 actions blocked in the last minute");
//! - with *Blocks and problems*, one when an admin answers one of the person's requests ("Your request was approved");
//! - nothing about blocks with *Problems only*, and nothing at all with *Off*.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::icon::IconState;
use std::collections::HashMap;

use crate::model::{AskedItem, Notifications, RecentBlock};
use crate::panel::block_button;

/// "Needs attention" must last this long before it is worth a notification.
pub const ATTENTION_AFTER: Duration = Duration::from_secs(5 * 60);
/// Blocks within this long of the last block notification are told together, once it has passed.
pub const BLOCK_GROUP: Duration = Duration::from_secs(60);
/// How many block ids are remembered, so a block is announced once.
const REMEMBERED_BLOCKS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Problem,
    Attention,
    Recovered,
    Block,
    /// An admin answered one of the person's requests.
    Request,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub kind: Kind,
    pub title: String,
    pub text: String,
    /// The block whose form the notification's button opens (one block the person may act on).
    pub unblock: Option<String>,
    /// That button's words: *Unblock…*, or *Ask to unblock…* where an admin decides.
    pub button: Option<&'static str>,
}

/// How bad a state is: protected and working are fine, offline is not yet worth a word.
pub fn rank(state: IconState) -> u8 {
    match state {
        IconState::Protected | IconState::Working => 0,
        IconState::Offline => 1,
        IconState::Attention => 2,
        IconState::Problem | IconState::Disconnected => 3,
    }
}

/// The notification for blocks seen together: one in plain words (with *Unblock…* when the person may act on it), or a
/// count.
pub fn block_toast(blocks: &[RecentBlock]) -> Option<Toast> {
    match blocks {
        [] => None,
        [one] => {
            let place = match (one.tool.as_deref(), one.project.as_deref()) {
                (Some(tool), Some(project)) => Some(format!("{tool} in {project}")),
                (Some(tool), None) => Some(tool.to_string()),
                (None, Some(project)) => Some(project.to_string()),
                (None, None) => None,
            };
            let rule = one.rule_title.clone().or_else(|| one.rule.clone());
            let text = [place, rule].into_iter().flatten().collect::<Vec<_>>().join(" · ");
            let button = block_button(one);
            Some(Toast {
                kind: Kind::Block,
                title: cut(&format!("Blocked: {}", one.words()), 120),
                text: if text.is_empty() { "Scopebond blocked an action your coding agent tried".into() } else { cut(&text, 200) },
                unblock: button.and(one.action_id.clone()),
                button,
            })
        }
        many => Some(Toast {
            kind: Kind::Block,
            title: format!("{} actions blocked in the last minute", many.len()),
            text: "Open Scopebond to see what was blocked".into(),
            unblock: None,
            button: None,
        }),
    }
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max - 1).chain(std::iter::once('…')).collect() }
}

#[derive(Debug, Default)]
pub struct Notifier {
    /// The worse state last told about, until protected again.
    told: Option<IconState>,
    /// Since when the state has been worth telling about.
    worse_since: Option<Instant>,
    /// Blocks already seen (None until the first look, so blocks from before the tray started are not announced).
    seen: Option<VecDeque<String>>,
    /// When the last block notification was shown.
    last_block_toast: Option<Instant>,
    /// New blocks waiting to be told together.
    held: Vec<RecentBlock>,
}

impl Notifier {
    pub fn new() -> Notifier {
        Notifier::default()
    }

    /// Look at the state now; the notifications to show, if any.
    pub fn observe(&mut self, state: IconState, headline: &str, blocks: &[RecentBlock], setting: Notifications, now: Instant) -> Vec<Toast> {
        let mut out = Vec::new();
        if rank(state) >= 2 {
            self.worse_since.get_or_insert(now);
        } else {
            self.worse_since = None;
        }
        let due = self.worse_since.is_some_and(|since| state != IconState::Attention || now.duration_since(since) >= ATTENTION_AFTER);
        if due && self.told != Some(state) {
            // Better than what was told (a problem eased to attention) is remembered without a word.
            if self.told.is_none_or(|told| rank(state) > rank(told)) {
                let kind = if rank(state) >= 3 { Kind::Problem } else { Kind::Attention };
                out.push(Toast { kind, title: "Scopebond".into(), text: headline.to_string(), unblock: None, button: None });
            }
            self.told = Some(state);
        } else if state == IconState::Protected && self.told.is_some() {
            out.push(Toast { kind: Kind::Recovered, title: "Scopebond".into(), text: "Scopebond is protecting again".into(), unblock: None, button: None });
            self.told = None;
        }

        let ids = blocks.iter().filter_map(|b| b.action_id.clone().map(|id| (id, b)));
        match &mut self.seen {
            None => self.seen = Some(ids.map(|(id, _)| id).collect()),
            Some(seen) => {
                // Oldest first, so a group is told in the order it happened.
                let fresh: Vec<(String, &RecentBlock)> = ids.filter(|(id, _)| !seen.contains(id)).collect();
                for (id, block) in fresh.into_iter().rev() {
                    if setting == Notifications::Blocks {
                        self.held.push(block.clone());
                    }
                    seen.push_back(id);
                    if seen.len() > REMEMBERED_BLOCKS {
                        seen.pop_front();
                    }
                }
            }
        }
        if setting != Notifications::Blocks {
            self.held.clear();
        }
        let quiet = self.last_block_toast.is_some_and(|at| now.duration_since(at) < BLOCK_GROUP);
        if !self.held.is_empty() && !quiet {
            out.extend(block_toast(&self.held));
            self.held.clear();
            self.last_block_toast = Some(now);
        }
        if setting == Notifications::Off {
            out.clear();
        }
        out
    }
}

/// Tells the person when an admin answers one of their requests: once per request, when it changes from waiting to
/// approved or declined (requests already answered when the tray starts are not told again).
#[derive(Debug, Default)]
pub struct RequestWatch {
    states: Option<HashMap<String, String>>,
}

impl RequestWatch {
    pub fn new() -> RequestWatch {
        RequestWatch::default()
    }

    pub fn observe(&mut self, asked: &[AskedItem], setting: Notifications) -> Vec<Toast> {
        let mut out = Vec::new();
        let now: HashMap<String, String> = asked.iter().map(|r| (r.id.clone(), r.state.clone())).collect();
        if let Some(before) = &self.states {
            for r in asked {
                let was = before.get(&r.id).map(String::as_str);
                let answered = r.state == "approved" || r.state == "declined";
                if answered && was != Some(r.state.as_str()) && setting == Notifications::Blocks {
                    let by = r.answered_by.as_deref().map(|b| format!(" · by {b}")).unwrap_or_default();
                    let note = r.note.as_deref().map(|n| format!(" · \u{201c}{n}\u{201d}")).unwrap_or_default();
                    out.push(Toast {
                        kind: Kind::Request,
                        title: format!("Your request was {}", r.state),
                        text: cut(&format!("{}{by}{note}", r.what), 200),
                        unblock: None,
                        button: None,
                    });
                }
            }
        }
        self.states = Some(now);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::BlockOffers;

    fn block(id: &str) -> RecentBlock {
        RecentBlock { action_id: Some(id.into()), summary: format!("rm -rf {id}"), rule: Some("no-destroy".into()), ..Default::default() }
    }

    struct Run {
        n: Notifier,
        start: Instant,
    }
    impl Run {
        fn new() -> Run {
            Run { n: Notifier::new(), start: Instant::now() }
        }
        fn at(&mut self, secs: u64, state: IconState, setting: Notifications) -> Vec<Kind> {
            self.n.observe(state, "headline", &[], setting, self.start + Duration::from_secs(secs)).into_iter().map(|t| t.kind).collect()
        }
        fn blocks(&mut self, secs: u64, blocks: &[RecentBlock], setting: Notifications) -> Vec<Toast> {
            self.n.observe(IconState::Protected, "", blocks, setting, self.start + Duration::from_secs(secs))
        }
    }

    const NONE: [Kind; 0] = [];
    use IconState::*;
    use Notifications::{Blocks, Off, Problems};

    #[test]
    fn a_problem_is_told_once_and_the_recovery_once() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Protected, Problems), NONE);
        assert_eq!(r.at(30, Problem, Problems), [Kind::Problem]);
        for t in 31..100 {
            assert_eq!(r.at(t, Problem, Problems), NONE, "once");
        }
        assert_eq!(r.at(100, Protected, Problems), [Kind::Recovered]);
        assert_eq!(r.at(130, Protected, Problems), NONE);
    }

    #[test]
    fn attention_waits_five_minutes() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Attention, Problems), NONE);
        assert_eq!(r.at(299, Attention, Problems), NONE);
        assert_eq!(r.at(300, Attention, Problems), [Kind::Attention]);
        // A short spell that clears before five minutes says nothing, and no recovery either.
        let mut r = Run::new();
        r.at(0, Attention, Problems);
        assert_eq!(r.at(120, Protected, Problems), NONE);
        assert_eq!(r.at(200, Attention, Problems), NONE);
        assert_eq!(r.at(499, Attention, Problems), NONE, "the five minutes start again");
        assert_eq!(r.at(500, Attention, Problems), [Kind::Attention]);
    }

    #[test]
    fn offline_and_working_are_not_worth_a_notification() {
        let mut r = Run::new();
        for t in 0..1000 {
            assert_eq!(r.at(t, if t % 2 == 0 { Offline } else { Working }, Problems), NONE);
        }
    }

    #[test]
    fn worse_again_is_told_and_better_is_not() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Problem, Problems), [Kind::Problem]);
        assert_eq!(r.at(400, Attention, Problems), NONE, "eased, still not protected");
        assert_eq!(r.at(410, Disconnected, Problems), [Kind::Problem]);
        assert_eq!(r.at(420, Protected, Problems), [Kind::Recovered]);
    }

    #[test]
    fn off_means_nothing() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Problem, Off), NONE);
        assert_eq!(r.at(10, Protected, Off), NONE);
        r.blocks(20, &[block("a")], Off);
        assert!(r.blocks(30, &[block("b"), block("a")], Off).is_empty());
    }

    #[test]
    fn a_new_block_is_told_once_with_problems_only_none() {
        let mut r = Run::new();
        // Blocks from before the tray started are not announced.
        assert!(r.blocks(0, &[block("a")], Blocks).is_empty());
        let toasts = r.blocks(5, &[block("b"), block("a")], Blocks);
        assert_eq!(toasts.len(), 1);
        assert_eq!(toasts[0].title, "Blocked: rm -rf b");
        assert_eq!(toasts[0].text, "no-destroy");
        assert!(r.blocks(100, &[block("b"), block("a")], Blocks).is_empty(), "once");
        assert!(r.blocks(200, &[block("c"), block("b")], Problems).is_empty(), "problems only: no blocks");
        assert_eq!(r.blocks(300, &[block("d"), block("c")], Blocks).len(), 1, "c was seen meanwhile");
    }

    #[test]
    fn blocks_within_a_minute_are_told_together() {
        let mut r = Run::new();
        r.blocks(0, &[], Blocks);
        assert_eq!(r.blocks(10, &[block("a")], Blocks).len(), 1, "the first at once");
        assert!(r.blocks(20, &[block("b"), block("a")], Blocks).is_empty(), "held");
        assert!(r.blocks(40, &[block("d"), block("c"), block("b"), block("a")], Blocks).is_empty(), "held");
        let group = r.blocks(70, &[block("d"), block("c"), block("b"), block("a")], Blocks);
        assert_eq!(group.len(), 1);
        assert_eq!(group[0].title, "3 actions blocked in the last minute");
        assert_eq!(group[0].unblock, None);
        assert!(r.blocks(80, &[block("d")], Blocks).is_empty(), "nothing new");
        // A minute after the group, a single new block is told at once again.
        assert_eq!(r.blocks(131, &[block("e"), block("d")], Blocks)[0].title, "Blocked: rm -rf e");
    }

    #[test]
    fn an_admins_answer_to_a_request_is_told_once_with_blocks_and_problems() {
        let req = |state: &str| AskedItem { id: "req_1".into(), what: "rm -rf ./dist".into(), state: state.into(), answered_by: Some("morgan@acme.test".into()), ..Default::default() };
        let mut w = RequestWatch::new();
        assert!(w.observe(&[req("approved")], Blocks).is_empty(), "already answered when the tray started");
        let mut w = RequestWatch::new();
        assert!(w.observe(&[req("waiting")], Blocks).is_empty());
        let t = w.observe(&[req("approved")], Blocks);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "Your request was approved");
        assert_eq!(t[0].text, "rm -rf ./dist · by morgan@acme.test");
        assert!(w.observe(&[req("approved")], Blocks).is_empty(), "once");
        let mut declined = req("declined");
        declined.id = "req_2".into();
        declined.note = Some("Use the clean script".into());
        assert!(w.observe(&[req("approved"), AskedItem { state: "waiting".into(), ..declined.clone() }], Blocks).is_empty());
        let t = w.observe(&[req("approved"), declined.clone()], Blocks);
        assert_eq!(t[0].title, "Your request was declined");
        assert_eq!(t[0].text, "rm -rf ./dist · by morgan@acme.test · \u{201c}Use the clean script\u{201d}");
        let mut quiet = RequestWatch::new();
        quiet.observe(&[AskedItem { state: "waiting".into(), ..declined.clone() }], Problems);
        assert!(quiet.observe(&[declined], Problems).is_empty(), "problems only: not told");
    }

    #[test]
    fn a_single_block_says_where_and_offers_unblock_when_the_person_may_act() {
        let mut b = block("a");
        b.what = "Read .env.production".into();
        b.tool = Some("Claude Code".into());
        b.project = Some("checkout".into());
        b.rule_title = Some("Reading a secret file".into());
        b.can_act = true;
        b.offers = Some(BlockOffers { once: true, ..Default::default() });
        let t = block_toast(std::slice::from_ref(&b)).unwrap();
        assert_eq!(t.title, "Blocked: Read .env.production");
        assert_eq!(t.text, "Claude Code in checkout · Reading a secret file");
        assert_eq!(t.unblock.as_deref(), Some("a"));
        assert_eq!(t.button, Some("Unblock…"));
        b.offers = Some(BlockOffers { ask: true, ..Default::default() });
        let ask = block_toast(std::slice::from_ref(&b)).unwrap();
        assert_eq!((ask.unblock.as_deref(), ask.button), (Some("a"), Some("Ask to unblock…")), "an admin decides");
        b.offers = Some(BlockOffers::default());
        let final_block = block_toast(std::slice::from_ref(&b)).unwrap();
        assert_eq!((final_block.unblock, final_block.button), (None, None), "final: no button");
        assert!(!final_block.text.to_lowercase().contains("setting"), "nothing about a setting the person cannot change");
        b.can_act = false;
        b.offers = None;
        assert_eq!(block_toast(std::slice::from_ref(&b)).unwrap().button, None, "nothing to do: no button");
        assert!(block_toast(&[]).is_none());
        b.what = "x".repeat(300);
        assert_eq!(block_toast(std::slice::from_ref(&b)).unwrap().title.chars().count(), 120);
    }
}
