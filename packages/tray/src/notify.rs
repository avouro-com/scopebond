//! When the tray shows a Windows notification, as plain decisions (tested here; the tray only shows what this returns):
//!
//! - one when the state gets worse: at once for a problem or a lost connection to the workspace, and for "needs
//!   attention" only once it has lasted five minutes, so sleep and wake or a short hiccup do not flap;
//! - one when it is protected again after one of those;
//! - none for blocks, unless the person chose *All* (then one per new block);
//! - nothing at all when the person chose *Off*.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::icon::IconState;
use crate::model::{Notifications, RecentBlock};

/// "Needs attention" must last this long before it is worth a notification.
pub const ATTENTION_AFTER: Duration = Duration::from_secs(5 * 60);
/// How many block ids are remembered, so a block is announced once.
const REMEMBERED_BLOCKS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Problem,
    Attention,
    Recovered,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub kind: Kind,
    pub title: String,
    pub text: String,
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

#[derive(Debug, Default)]
pub struct Notifier {
    /// The worse state last told about, until protected again.
    told: Option<IconState>,
    /// Since when the state has been worth telling about.
    worse_since: Option<Instant>,
    /// Blocks already seen (None until the first look, so blocks from before the tray started are not announced).
    seen: Option<VecDeque<String>>,
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
                out.push(Toast { kind, title: "Scopebond".into(), text: headline.to_string() });
            }
            self.told = Some(state);
        } else if state == IconState::Protected && self.told.is_some() {
            out.push(Toast { kind: Kind::Recovered, title: "Scopebond".into(), text: "Scopebond is protecting again".into() });
            self.told = None;
        }

        let ids = blocks.iter().filter_map(|b| b.action_id.clone().map(|id| (id, b)));
        match &mut self.seen {
            None => self.seen = Some(ids.map(|(id, _)| id).collect()),
            Some(seen) => {
                for (id, block) in ids {
                    if seen.contains(&id) {
                        continue;
                    }
                    if setting == Notifications::All {
                        let text = match &block.rule {
                            Some(rule) => format!("{} (rule: {rule})", block.summary),
                            None => block.summary.clone(),
                        };
                        out.push(Toast { kind: Kind::Block, title: "Scopebond blocked an action".into(), text });
                    }
                    seen.push_back(id);
                    if seen.len() > REMEMBERED_BLOCKS {
                        seen.pop_front();
                    }
                }
            }
        }
        if setting == Notifications::Off {
            out.clear();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: &str) -> RecentBlock {
        RecentBlock { action_id: Some(id.into()), summary: format!("rm -rf {id}"), at: String::new(), rule: Some("no-destroy".into()), can_act: false, acted: None }
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
    }

    const NONE: [Kind; 0] = [];
    use IconState::*;
    use Notifications::{All, Off, Problems};

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
    }

    #[test]
    fn blocks_only_with_all_and_each_once() {
        let mut n = Notifier::new();
        let t = Instant::now();
        // Blocks from before the tray started are not announced.
        assert!(n.observe(Protected, "", &[block("a")], All, t).is_empty());
        let toasts = n.observe(Protected, "", &[block("b"), block("a")], All, t);
        assert_eq!(toasts.len(), 1);
        assert_eq!(toasts[0].text, "rm -rf b (rule: no-destroy)");
        assert!(n.observe(Protected, "", &[block("b"), block("a")], All, t).is_empty());
        assert!(n.observe(Protected, "", &[block("c")], Problems, t).is_empty(), "problems only: no blocks");
        assert_eq!(n.observe(Protected, "", &[block("c"), block("d")], All, t).len(), 1, "c was seen meanwhile");
    }
}
