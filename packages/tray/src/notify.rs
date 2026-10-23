//! When the tray shows a Windows notification, as plain decisions (tested here; the tray only shows what this returns):
//!
//! - one when the state gets worse: at once for a problem or a lost connection to the workspace, and for "needs
//!   attention" only once it has lasted five minutes, so sleep and wake or a short hiccup do not flap;
//! - one when it is protected again after one of those;
//! - with notifications on, one for each new block (with *Unblock…* when the person may act on it), at most three an hour;
//!   blocks past that wait and are told in one summary ("5 more blocked · Open Scopebond") ten minutes after the first of
//!   them, or as soon as the hour's three allow, and at most one summary an hour;
//! - never one for a block of Scopebond's always-on protection or one the person chose to keep blocked without being asked:
//!   there is nothing to do about it, and it is in the list;
//! - one when an admin answers one of the person's requests ("Approved: ask Claude Code to try again"), unless
//!   notifications are off: the person asked and is waiting for it;
//! - one per block, never again for the coding agent's retries of it (the agent folds them into the block);
//! - with notifications off, only what the person must act on: a problem (protection is off, the workspace refused this
//!   computer) and the word that it is fixed. Never a block, an admin's answer or "needs attention";
//! - when the agent could not be brought back (two failed restarts within ten minutes, supervise.rs), the problem told is
//!   "Protection is off on this computer" with *Restart it*; restarts before that are silent.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::icon::IconState;
use std::collections::HashMap;

use crate::model::{AskedItem, Notifications, RecentBlock, Updated};
use crate::panel::block_button;

/// "Needs attention" must last this long before it is worth a notification.
pub const ATTENTION_AFTER: Duration = Duration::from_secs(5 * 60);
/// At most this many block notifications in an hour (BUDGET_WINDOW); the rest are told in one summary.
pub const BLOCK_BUDGET: usize = 3;
pub const BUDGET_WINDOW: Duration = Duration::from_secs(60 * 60);
/// Blocks past the budget are summed up this long after the first of them (at most one summary an hour).
pub const SUMMARY_AFTER: Duration = Duration::from_secs(10 * 60);
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
    /// The first sign-in finished: "Connected to <workspace>".
    Connected,
    /// The client was updated: "Updated to Scopebond 0.11.5".
    Updated,
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

/// What the tray knows besides the state, for the notifications about it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Situation<'a> {
    /// The agent has not supplied a block history on this poll. This is different from a known empty history.
    pub block_history_unavailable: bool,
    /// Supervision could not bring the agent back (two failed restarts within ten minutes): the problem told is that
    /// protection is off, with *Restart it*.
    pub protection_off: bool,
    /// This computer's first sign-in is still to come (the agent's `first_sign_in`): nothing about the state is told.
    pub first_sign_in: bool,
    /// The workspace's name, for "Connected to …".
    pub workspace: Option<&'a str>,
}

/// After the first sign-in, "Connected to …" waits at most this long for the workspace's name.
pub const NAME_WAIT: Duration = Duration::from_secs(60);

/// The one notification after the first sign-in, in place of "Scopebond is protecting again".
pub fn connected_toast(workspace: Option<&str>) -> Toast {
    Toast {
        kind: Kind::Connected,
        title: cut(&format!("Connected to {}", workspace.unwrap_or("your workspace")), 120),
        text: "Scopebond is set up on this computer and uses your workspace's rules.".into(),
        unblock: None,
        button: None,
    }
}

/// The button of the "protection is off" notification: it starts the agent at once.
pub const RESTART_IT: &str = "Restart it";

/// The one notification when the agent could not be brought back: protection is off, and *Restart it*.
pub fn protection_off_toast() -> Toast {
    Toast {
        kind: Kind::Problem,
        title: "Protection is off on this computer".into(),
        text: "The Scopebond Agent stopped and didn't start again. Restart it.".into(),
        unblock: None,
        button: Some(RESTART_IT),
    }
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

/// Whether a block is never worth a notification: Scopebond's always-on protection (nothing to do), or one the person chose
/// to keep blocked without being asked.
pub fn silent(block: &RecentBlock) -> bool {
    matches!(block.outcome.as_deref(), Some("always_on") | Some("quiet")) || block.acted.as_deref() == Some("quiet")
}

/// The one notification for blocks past the hour's budget: how many, and where to see them.
pub fn summary_toast(more: usize) -> Toast {
    Toast {
        kind: Kind::Block,
        title: format!("{more} more blocked · Open Scopebond"),
        text: "Scopebond kept them blocked. Open it to see what was blocked and why.".into(),
        unblock: None,
        button: None,
    }
}

/// The notification for one block in plain words (with *Unblock…* when the person may act on it); more than one is a
/// summary.
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
            let text = [place, Some(one.rule_name().to_string())].into_iter().flatten().collect::<Vec<_>>().join(" · ");
            let button = block_button(one);
            Some(Toast {
                kind: Kind::Block,
                title: cut(&format!("Blocked: {}", one.words()), 120),
                text: cut(&text, 200),
                unblock: button.and(one.action_id.clone()),
                button,
            })
        }
        many => Some(summary_toast(many.len())),
    }
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max - 1).chain(std::iter::once('…')).collect() }
}

/// The one notification after an update, once per version: "Updated to Scopebond 0.11.5". `told` is the version already
/// told about (the tray keeps it in its own settings file). The version to remember comes back with it, also when
/// notifications are off: nothing is shown then, nor later.
pub fn update_toast(updated: Option<&Updated>, told: Option<&str>, setting: Notifications) -> Option<(String, Option<Toast>)> {
    let updated = updated?;
    let to = updated.to.trim();
    if to.is_empty() || told == Some(to) {
        return None;
    }
    let from = updated.from.trim();
    let toast = Toast {
        kind: Kind::Updated,
        title: cut(&format!("Updated to Scopebond {to}"), 120),
        text: if from.is_empty() { "Nothing for you to do.".into() } else { cut(&format!("Updated from {from}. Nothing for you to do."), 200) },
        unblock: None,
        button: None,
    };
    Some((to.to_string(), (setting != Notifications::Off).then_some(toast)))
}

#[derive(Debug, Default)]
pub struct Notifier {
    /// The worse state last told about, until protected again.
    told: Option<IconState>,
    /// Since when the state has been worth telling about.
    worse_since: Option<Instant>,
    /// Blocks already seen (None until the first look, so blocks from before the tray started are not announced).
    seen: Option<VecDeque<String>>,
    /// When each block notification of the last hour was shown (the budget).
    told_blocks: VecDeque<Instant>,
    /// Blocks past the budget, waiting for the summary, and since when.
    over: Vec<RecentBlock>,
    over_since: Option<Instant>,
    /// When the last summary was shown.
    last_summary: Option<Instant>,
    /// This computer's first sign-in was seen waiting, and "Connected to …" is not told yet.
    signing_in: bool,
    /// Since when the first sign-in has been done (waiting to be protected, and for the workspace's name).
    connected_since: Option<Instant>,
}

impl Notifier {
    pub fn new() -> Notifier {
        Notifier::default()
    }

    /// Look at the state now; the notifications to show, if any.
    pub fn observe(&mut self, state: IconState, headline: &str, blocks: &[RecentBlock], setting: Notifications, situation: Situation<'_>, now: Instant) -> Vec<Toast> {
        let mut out = Vec::new();
        if situation.first_sign_in {
            // Not signed in yet is not a problem (the panel says what to do): nothing about the state is told meanwhile.
            self.signing_in = true;
            self.connected_since = None;
            self.worse_since = None;
        } else if self.signing_in {
            // The first sign-in finished: "Connected to …" once, in place of "protecting again", once it is protected (with
            // the workspace's name, which may come a moment later).
            let since = *self.connected_since.get_or_insert(now);
            let workspace = situation.workspace.map(str::trim).filter(|w| !w.is_empty());
            if state == IconState::Protected && (workspace.is_some() || now.duration_since(since) >= NAME_WAIT) {
                out.push(connected_toast(workspace));
                self.signing_in = false;
                self.connected_since = None;
                self.told = None;
            }
        }
        if rank(state) >= 2 && !situation.first_sign_in {
            self.worse_since.get_or_insert(now);
        } else {
            self.worse_since = None;
        }
        let due = self.worse_since.is_some_and(|since| state != IconState::Attention || now.duration_since(since) >= ATTENTION_AFTER);
        if due && self.told != Some(state) {
            // Better than what was told (a problem eased to attention) is remembered without a word.
            if self.told.is_none_or(|told| rank(state) > rank(told)) {
                let kind = if rank(state) >= 3 { Kind::Problem } else { Kind::Attention };
                if kind == Kind::Problem && situation.protection_off {
                    out.push(protection_off_toast());
                } else {
                    out.push(Toast { kind, title: "Scopebond".into(), text: headline.to_string(), unblock: None, button: None });
                }
            }
            self.told = Some(state);
        } else if state == IconState::Protected && self.told.is_some() && !situation.first_sign_in {
            out.push(Toast { kind: Kind::Recovered, title: "Scopebond".into(), text: "Scopebond is protecting again".into(), unblock: None, button: None });
            self.told = None;
        }

        // A retry keeps its block's group id, so it is not a new block.
        let ids = blocks.iter().filter_map(|b| b.group_id.clone().or_else(|| b.action_id.clone()).map(|id| (id, b)));
        let mut fresh_blocks: Vec<RecentBlock> = Vec::new();
        match &mut self.seen {
            None => self.seen = Some(ids.map(|(id, _)| id).collect()),
            Some(seen) => {
                // Oldest first, so blocks are told in the order they happened.
                let fresh: Vec<(String, &RecentBlock)> = ids.filter(|(id, _)| !seen.contains(id)).collect();
                for (id, block) in fresh.into_iter().rev() {
                    if setting == Notifications::Blocks && !silent(block) {
                        fresh_blocks.push(block.clone());
                    }
                    seen.push_back(id);
                    if seen.len() > REMEMBERED_BLOCKS {
                        seen.pop_front();
                    }
                }
            }
        }
        if setting == Notifications::Blocks {
            out.extend(self.budget(fresh_blocks, now));
        } else {
            self.over.clear();
            self.over_since = None;
        }
        if setting == Notifications::Off {
            out.retain(|t| matches!(t.kind, Kind::Problem | Kind::Recovered | Kind::Connected));
        }
        out
    }
}

impl Notifier {
    /// One notification per new block while the hour's budget allows; past it, the blocks wait and are told in one summary
    /// (SUMMARY_AFTER after the first of them, or as soon as the budget allows; at most one summary an hour). A single
    /// block waiting when the budget allows again is told on its own.
    fn budget(&mut self, fresh: Vec<RecentBlock>, now: Instant) -> Vec<Toast> {
        let mut out = Vec::new();
        while self.told_blocks.front().is_some_and(|at| now.duration_since(*at) >= BUDGET_WINDOW) {
            self.told_blocks.pop_front();
        }
        for block in fresh {
            if self.over.is_empty() && self.told_blocks.len() < BLOCK_BUDGET {
                out.extend(block_toast(std::slice::from_ref(&block)));
                self.told_blocks.push_back(now);
            } else {
                self.over_since.get_or_insert(now);
                self.over.push(block);
            }
        }
        if self.over.is_empty() {
            return out;
        }
        let room = self.told_blocks.len() < BLOCK_BUDGET;
        if room && self.over.len() == 1 {
            out.extend(block_toast(&self.over));
            self.told_blocks.push_back(now);
        } else {
            let due = room || self.over_since.is_some_and(|since| now.duration_since(since) >= SUMMARY_AFTER);
            let allowed = self.last_summary.is_none_or(|at| now.duration_since(at) >= BUDGET_WINDOW);
            if !(due && allowed) {
                return out;
            }
            out.push(summary_toast(self.over.len()));
            self.last_summary = Some(now);
        }
        self.over.clear();
        self.over_since = None;
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
                if answered && was != Some(r.state.as_str()) && setting != Notifications::Off {
                    let by = r.answered_by.as_deref().map(|b| format!(" · by {b}")).unwrap_or_default();
                    let note = r.note.as_deref().map(|n| format!(" · \u{201c}{n}\u{201d}")).unwrap_or_default();
                    let tool = r.tool.as_deref().unwrap_or("your coding agent");
                    out.push(Toast {
                        kind: Kind::Request,
                        title: if r.state == "approved" { format!("Approved: ask {tool} to try again") } else { "Your request was declined".to_string() },
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
            self.n.observe(state, "headline", &[], setting, Situation::default(), self.start + Duration::from_secs(secs)).into_iter().map(|t| t.kind).collect()
        }
        fn blocks(&mut self, secs: u64, blocks: &[RecentBlock], setting: Notifications) -> Vec<Toast> {
            self.n.observe(IconState::Protected, "", blocks, setting, Situation::default(), self.start + Duration::from_secs(secs))
        }
    }

    const NONE: [Kind; 0] = [];
    use IconState::*;
    use Notifications::{Blocks, Off};

    #[test]
    fn a_problem_is_told_once_and_the_recovery_once() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Protected, Blocks), NONE);
        assert_eq!(r.at(30, Problem, Blocks), [Kind::Problem]);
        for t in 31..100 {
            assert_eq!(r.at(t, Problem, Blocks), NONE, "once");
        }
        assert_eq!(r.at(100, Protected, Blocks), [Kind::Recovered]);
        assert_eq!(r.at(130, Protected, Blocks), NONE);
    }

    #[test]
    fn attention_waits_five_minutes() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Attention, Blocks), NONE);
        assert_eq!(r.at(299, Attention, Blocks), NONE);
        assert_eq!(r.at(300, Attention, Blocks), [Kind::Attention]);
        // A short spell that clears before five minutes says nothing, and no recovery either.
        let mut r = Run::new();
        r.at(0, Attention, Blocks);
        assert_eq!(r.at(120, Protected, Blocks), NONE);
        assert_eq!(r.at(200, Attention, Blocks), NONE);
        assert_eq!(r.at(499, Attention, Blocks), NONE, "the five minutes start again");
        assert_eq!(r.at(500, Attention, Blocks), [Kind::Attention]);
    }

    #[test]
    fn protection_off_is_told_once_with_restart_it_and_its_return_once() {
        let mut n = Notifier::new();
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let off = Situation { protection_off: true, ..Default::default() };
        let t = n.observe(Problem, "The Scopebond Agent is not answering", &[], Blocks, off, at(0));
        assert_eq!(t, vec![protection_off_toast()]);
        assert_eq!(t[0].title, "Protection is off on this computer");
        assert_eq!((t[0].button, t[0].unblock.as_deref()), (Some("Restart it"), None));
        for s in 1..100 {
            assert!(n.observe(Problem, "The Scopebond Agent is not answering", &[], Blocks, off, at(s)).is_empty(), "once");
        }
        // Started again meanwhile (working): nothing; protected again: told once.
        assert!(n.observe(Working, "", &[], Blocks, Situation::default(), at(100)).is_empty());
        let back = n.observe(Protected, "Protected", &[], Blocks, Situation::default(), at(110));
        assert_eq!(back.iter().map(|t| t.kind).collect::<Vec<_>>(), [Kind::Recovered]);
        // With notifications off it is told all the same: the person must act.
        let mut quiet = Notifier::new();
        assert_eq!(quiet.observe(Problem, "", &[], Off, off, at(0)), vec![protection_off_toast()]);
        // Any other problem is told in the agent's words.
        let mut other = Notifier::new();
        assert_eq!(other.observe(Problem, "Not connected to your workspace", &[], Blocks, Situation::default(), at(0))[0].text, "Not connected to your workspace");
    }

    fn kinds(toasts: &[Toast]) -> Vec<Kind> {
        toasts.iter().map(|t| t.kind).collect()
    }

    #[test]
    fn nothing_about_the_state_while_the_first_sign_in_waits_then_connected_once() {
        let mut n = Notifier::new();
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let first = Situation { first_sign_in: true, ..Default::default() };
        // Not signed in yet (shown as not connected): no problem told, however long.
        for s in 0..1000 {
            assert!(n.observe(Disconnected, "Not signed in to a workspace yet", &[], Blocks, first, at(s)).is_empty(), "{s}");
        }
        // Signing in (working), then signed in: "Connected to Avouro" once it is protected, and no "protecting again".
        assert!(n.observe(Working, "Approve this computer in your workspace: code BCDF-GHJK", &[], Blocks, first, at(1000)).is_empty());
        let done = Situation { workspace: Some("Avouro"), ..Default::default() };
        assert!(n.observe(Working, "Checking the rules", &[], Blocks, done, at(1010)).is_empty(), "not protected yet");
        let t = n.observe(Protected, "Protected", &[], Blocks, done, at(1020));
        assert_eq!(kinds(&t), [Kind::Connected]);
        assert_eq!(t[0].title, "Connected to Avouro");
        assert_eq!(t[0], connected_toast(Some("Avouro")));
        for s in 1021..1100 {
            assert!(n.observe(Protected, "Protected", &[], Blocks, done, at(s)).is_empty(), "once");
        }
        // Later problems are told as usual.
        assert_eq!(kinds(&n.observe(Problem, "Not connected to your workspace", &[], Blocks, done, at(1200))), [Kind::Problem]);
    }

    #[test]
    fn connected_waits_a_moment_for_the_workspaces_name_and_is_told_with_notifications_off() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let first = Situation { first_sign_in: true, ..Default::default() };
        let mut n = Notifier::new();
        n.observe(Disconnected, "", &[], Blocks, first, at(0));
        let unnamed = Situation::default();
        assert!(n.observe(Protected, "Protected", &[], Blocks, unnamed, at(10)).is_empty(), "the name may come a moment later");
        assert!(n.observe(Protected, "Protected", &[], Blocks, unnamed, at(10 + NAME_WAIT.as_secs() - 1)).is_empty());
        let t = n.observe(Protected, "Protected", &[], Blocks, unnamed, at(10 + NAME_WAIT.as_secs()));
        assert_eq!(t[0].title, "Connected to your workspace");
        // A blank name is no name.
        assert_eq!(connected_toast(Some("Avouro")).title, "Connected to Avouro");
        let mut blank = Notifier::new();
        blank.observe(Disconnected, "", &[], Blocks, first, at(0));
        assert!(blank.observe(Protected, "", &[], Blocks, Situation { workspace: Some("  "), ..Default::default() }, at(1)).is_empty());
        // Notifications off: told all the same, it answers the person's own sign-in.
        let mut off = Notifier::new();
        off.observe(Disconnected, "", &[], Off, first, at(0));
        let named = Situation { workspace: Some("Avouro"), ..Default::default() };
        assert_eq!(kinds(&off.observe(Protected, "Protected", &[], Off, named, at(5))), [Kind::Connected]);
        // A computer already connected when the tray started is never told.
        let mut already = Notifier::new();
        assert!(already.observe(Protected, "Protected", &[], Blocks, named, at(0)).is_empty());
    }

    #[test]
    fn a_problem_told_while_the_first_sign_in_waited_ends_with_connected_not_protecting_again() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let mut n = Notifier::new();
        n.observe(Disconnected, "", &[], Blocks, Situation { first_sign_in: true, ..Default::default() }, at(0));
        // The agent could not be brought back meanwhile: that is told.
        let off = Situation { protection_off: true, ..Default::default() };
        assert_eq!(n.observe(Problem, "", &[], Blocks, off, at(10)), vec![protection_off_toast()]);
        // Back, and signed in: one notification, "Connected to Avouro".
        let named = Situation { workspace: Some("Avouro"), ..Default::default() };
        assert_eq!(kinds(&n.observe(Protected, "Protected", &[], Blocks, named, at(20))), [Kind::Connected]);
        assert!(n.observe(Protected, "Protected", &[], Blocks, named, at(30)).is_empty());
    }

    #[test]
    fn an_update_is_told_once_per_version() {
        let u = |from: &str, to: &str| Updated { from: from.into(), to: to.into(), at: "2026-10-21T12:00:00.000Z".into() };
        let (version, toast) = update_toast(Some(&u("0.11.4", "0.11.5")), None, Blocks).expect("told");
        assert_eq!(version, "0.11.5");
        let toast = toast.expect("shown");
        assert_eq!((toast.kind, toast.title.as_str(), toast.text.as_str()), (Kind::Updated, "Updated to Scopebond 0.11.5", "Updated from 0.11.4. Nothing for you to do."));
        assert_eq!((toast.unblock, toast.button), (None, None));
        assert_eq!(update_toast(Some(&u("0.11.4", "0.11.5")), Some("0.11.5"), Blocks), None, "once");
        assert_eq!(update_toast(Some(&u("0.11.5", "0.11.6")), Some("0.11.5"), Blocks).map(|(v, _)| v).as_deref(), Some("0.11.6"), "the next update is told");
        assert_eq!(update_toast(None, None, Blocks), None);
        assert_eq!(update_toast(Some(&u("0.11.4", " ")), None, Blocks), None);
        assert_eq!(update_toast(Some(&u("", "0.11.5")), None, Blocks).and_then(|(_, t)| t).map(|t| t.text).as_deref(), Some("Nothing for you to do."));
        // Notifications off: nothing shown, but remembered, so it is not shown later either.
        assert_eq!(update_toast(Some(&u("0.11.4", "0.11.5")), None, Off), Some(("0.11.5".to_string(), None)));
    }

    #[test]
    fn offline_and_working_are_not_worth_a_notification() {
        let mut r = Run::new();
        for t in 0..1000 {
            assert_eq!(r.at(t, if t % 2 == 0 { Offline } else { Working }, Blocks), NONE);
        }
    }

    #[test]
    fn worse_again_is_told_and_better_is_not() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Problem, Blocks), [Kind::Problem]);
        assert_eq!(r.at(400, Attention, Blocks), NONE, "eased, still not protected");
        assert_eq!(r.at(410, Disconnected, Blocks), [Kind::Problem]);
        assert_eq!(r.at(420, Protected, Blocks), [Kind::Recovered]);
    }

    #[test]
    fn off_keeps_only_what_the_person_must_act_on() {
        let mut r = Run::new();
        assert_eq!(r.at(0, Problem, Off), [Kind::Problem], "protection is off: always told");
        assert_eq!(r.at(10, Protected, Off), [Kind::Recovered]);
        assert_eq!(r.at(20, Attention, Off), NONE);
        assert_eq!(r.at(400, Attention, Off), NONE, "needs attention is not a must-act alert");
        r.blocks(500, &[block("a")], Off);
        assert!(r.blocks(510, &[block("b"), block("a")], Off).is_empty(), "no blocks");
    }

    #[test]
    fn a_new_block_is_told_once_and_none_with_notifications_off() {
        let mut r = Run::new();
        // Blocks from before the tray started are not announced.
        assert!(r.blocks(0, &[block("a")], Blocks).is_empty());
        let toasts = r.blocks(5, &[block("b"), block("a")], Blocks);
        assert_eq!(toasts.len(), 1);
        assert_eq!(toasts[0].title, "Blocked: rm -rf b");
        assert_eq!(toasts[0].text, "A Scopebond rule", "no rule name from the agent: a plain name, never the rule id");
        assert!(r.blocks(100, &[block("b"), block("a")], Blocks).is_empty(), "once");
        assert!(r.blocks(200, &[block("c"), block("b")], Off).is_empty(), "off: no blocks");
        assert_eq!(r.blocks(300, &[block("d"), block("c")], Blocks).len(), 1, "c was seen meanwhile");
    }

    #[test]
    fn startup_without_an_agent_answer_does_not_replay_old_blocks() {
        let mut r = Run::new();
        let unavailable = Situation { block_history_unavailable: true, ..Default::default() };
        for seconds in [0, 1, 2] {
            assert!(r.n.observe(Working, "", &[], Blocks, unavailable, r.start + Duration::from_secs(seconds)).is_empty());
        }
        assert!(r.blocks(3, &[block("old")], Blocks).is_empty(), "the first real history is the baseline");
        let fresh = r.blocks(4, &[block("new"), block("old")], Blocks);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].title, "Blocked: rm -rf new");
        r.n.observe(Working, "", &[], Blocks, unavailable, r.start + Duration::from_secs(5));
        assert!(r.blocks(6, &[block("new"), block("old")], Blocks).is_empty(), "reconnection preserves the baseline");
        assert_eq!(r.blocks(7, &[block("later"), block("new")], Blocks).len(), 1);
    }

    /// The list as the agent sends it: newest first.
    fn newest_first(ids: &[&str]) -> Vec<RecentBlock> {
        ids.iter().rev().map(|id| block(id)).collect()
    }

    #[test]
    fn three_blocks_an_hour_then_one_summary() {
        let mut r = Run::new();
        r.blocks(0, &[], Blocks);
        assert_eq!(r.blocks(10, &newest_first(&["a"]), Blocks).len(), 1, "the first at once");
        assert_eq!(r.blocks(20, &newest_first(&["a", "b"]), Blocks)[0].title, "Blocked: rm -rf b", "one per block");
        assert_eq!(r.blocks(30, &newest_first(&["a", "b", "c"]), Blocks).len(), 1, "the third");
        assert!(r.blocks(40, &newest_first(&["a", "b", "c", "d"]), Blocks).is_empty(), "past three an hour: held");
        assert!(r.blocks(100, &newest_first(&["a", "b", "c", "d", "e", "f", "g", "h"]), Blocks).is_empty());
        assert!(r.blocks(600, &newest_first(&["a", "b", "c", "d", "e", "f", "g", "h"]), Blocks).is_empty(), "not ten minutes yet");
        let summary = r.blocks(640, &newest_first(&["a", "b", "c", "d", "e", "f", "g", "h"]), Blocks);
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].title, "5 more blocked · Open Scopebond");
        assert_eq!((summary[0].unblock.as_ref(), summary[0].button), (None, None), "it opens the panel");
        // More blocks in the same hour: no second summary, nothing on its own.
        assert!(r.blocks(700, &newest_first(&["h", "i"]), Blocks).is_empty());
        assert!(r.blocks(1400, &newest_first(&["h", "i", "j"]), Blocks).is_empty(), "one summary an hour");
        // An hour after the summary (the budget has renewed too), what waited is summed up, then each block is told again.
        assert!(r.blocks(3_700, &newest_first(&["i", "j"]), Blocks).is_empty(), "the budget renewed, but one summary an hour");
        let renewed = r.blocks(4_300, &newest_first(&["i", "j"]), Blocks);
        assert_eq!(renewed.len(), 1);
        assert_eq!(renewed[0].title, "2 more blocked · Open Scopebond");
        assert_eq!(r.blocks(4_400, &newest_first(&["j", "k"]), Blocks)[0].title, "Blocked: rm -rf k");
    }

    #[test]
    fn a_single_block_that_waited_is_told_on_its_own_when_the_budget_allows() {
        let mut r = Run::new();
        r.blocks(0, &[], Blocks);
        for (t, ids) in [(10, vec!["a"]), (20, vec!["a", "b"]), (30, vec!["a", "b", "c"])] {
            assert_eq!(r.blocks(t, &newest_first(&ids), Blocks).len(), 1);
        }
        assert!(r.blocks(40, &newest_first(&["a", "b", "c", "d"]), Blocks).is_empty());
        // Before ten minutes nothing; the summary of one is the block itself once the hour allows.
        assert!(r.blocks(500, &newest_first(&["d"]), Blocks).is_empty());
        let one = r.blocks(640, &newest_first(&["d"]), Blocks);
        assert_eq!(one[0].title, "1 more blocked · Open Scopebond", "ten minutes: the summary, even of one");
        let mut s = Run::new();
        s.blocks(0, &[], Blocks);
        for (t, ids) in [(10, vec!["a"]), (20, vec!["a", "b"]), (30, vec!["a", "b", "c"]), (3_000, vec!["d"])] {
            s.blocks(t, &newest_first(&ids), Blocks);
        }
        let alone = s.blocks(3_611, &newest_first(&["d"]), Blocks);
        assert_eq!(alone[0].title, "Blocked: rm -rf d", "the budget allows again before the summary was due");
    }

    #[test]
    fn always_on_protection_and_kept_blocks_are_never_told() {
        let mut r = Run::new();
        r.blocks(0, &[], Blocks);
        let always_on = RecentBlock { outcome: Some("always_on".into()), ..block("a") };
        let kept = RecentBlock { outcome: Some("quiet".into()), ..block("b") };
        let kept_acted = RecentBlock { acted: Some("quiet".into()), ..block("c") };
        assert!(r.blocks(10, &[kept_acted.clone(), kept.clone(), always_on.clone()], Blocks).is_empty());
        // They took nothing from the hour's budget: three more are each told.
        for (t, id) in [(20, "d"), (30, "e"), (40, "f")] {
            let list = [block(id), kept_acted.clone(), kept.clone(), always_on.clone()];
            assert_eq!(r.blocks(t, &list, Blocks).len(), 1, "{id}");
        }
        assert!(silent(&always_on) && silent(&kept) && silent(&kept_acted) && !silent(&block("x")));
    }

    #[test]
    fn an_admins_answer_to_a_request_is_told_once_unless_notifications_are_off() {
        let req = |state: &str| AskedItem { id: "req_1".into(), what: "rm -rf ./dist".into(), state: state.into(), answered_by: Some("morgan@acme.test".into()), ..Default::default() };
        let mut w = RequestWatch::new();
        assert!(w.observe(&[req("approved")], Blocks).is_empty(), "already answered when the tray started");
        let mut w = RequestWatch::new();
        assert!(w.observe(&[req("waiting")], Blocks).is_empty());
        let t = w.observe(&[req("approved")], Blocks);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "Approved: ask your coding agent to try again");
        assert_eq!(t[0].text, "rm -rf ./dist · by morgan@acme.test");
        assert!(w.observe(&[req("approved")], Blocks).is_empty(), "once");
        let mut declined = req("declined");
        declined.id = "req_2".into();
        declined.note = Some("Use the clean script".into());
        assert!(w.observe(&[req("approved"), AskedItem { state: "waiting".into(), ..declined.clone() }], Blocks).is_empty());
        let t = w.observe(&[req("approved"), declined.clone()], Blocks);
        assert_eq!(t[0].title, "Your request was declined");
        assert_eq!(t[0].text, "rm -rf ./dist · by morgan@acme.test · \u{201c}Use the clean script\u{201d}");
        // An admin's answer is told while notifications are on: the person asked and is waiting.
        let mut off = RequestWatch::new();
        off.observe(&[AskedItem { state: "waiting".into(), ..declined.clone() }], Off);
        assert!(off.observe(&[declined], Off).is_empty(), "off: not told");
        let mut named = RequestWatch::new();
        let tool = |state: &str| AskedItem { tool: Some("Claude Code".into()), ..req(state) };
        named.observe(&[tool("waiting")], Blocks);
        assert_eq!(named.observe(&[tool("approved")], Blocks)[0].title, "Approved: ask Claude Code to try again");
    }

    #[test]
    fn a_retry_of_a_block_is_not_told_again() {
        let mut r = Run::new();
        r.blocks(0, &[], Blocks);
        let first = RecentBlock { group_id: Some("g1".into()), ..block("a1") };
        assert_eq!(r.blocks(10, std::slice::from_ref(&first), Blocks).len(), 1);
        // The agent tried again: the folded block now carries the newest try's id, and the same group id.
        let retried = RecentBlock { group_id: Some("g1".into()), tries: 2, ..block("a2") };
        assert!(r.blocks(200, std::slice::from_ref(&retried), Blocks).is_empty(), "a retry is not a new block");
    }

    #[test]
    fn a_single_block_says_where_and_offers_unblock_when_the_person_may_act() {
        let mut b = block("a");
        b.what = "Read .env.production".into();
        b.tool = Some("Claude Code".into());
        b.project = Some("checkout".into());
        b.rule_title = Some("Read passwords, keys or secrets".into());
        b.can_act = true;
        b.offers = Some(BlockOffers { once: true, ..Default::default() });
        let t = block_toast(std::slice::from_ref(&b)).unwrap();
        assert_eq!(t.title, "Blocked: Read .env.production");
        assert_eq!(t.text, "Claude Code in checkout · Read passwords, keys or secrets");
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

    #[test]
    fn a_block_without_a_rule_name_says_a_scopebond_rule_never_the_rule_id() {
        // An older agent sends no rule name: the toast names "A Scopebond rule", not the id ("no-destroy").
        let b = block("a");
        let t = block_toast(std::slice::from_ref(&b)).unwrap();
        assert_eq!(t.text, "A Scopebond rule");
        assert!(!t.text.contains("no-destroy"));
        let mut blank = block("b");
        blank.rule_title = Some("  ".into());
        blank.tool = Some("Claude Code".into());
        blank.project = Some("checkout".into());
        assert_eq!(block_toast(std::slice::from_ref(&blank)).unwrap().text, "Claude Code in checkout · A Scopebond rule");
    }
}
