//! Keeping the agent running, as plain decisions (the tray's supervision thread observes, this decides, the thread acts),
//! so every case is tested without starting anything.
//!
//! - Nothing answers and nothing is starting: start the agent (at once the first time).
//! - It exits on its own (a crash, or it was ended from Task Manager): start it again after 2 s, then 4 s, 8 s … at most
//!   60 s apart. The wait starts over once it has answered for five minutes.
//! - It exits cleanly (exit code 0, or it removed its endpoint file): either someone stopped it on purpose, or it is
//!   handing over to its updated replacement. Stopped on purpose (`scopebond-agent stop`: the agent leaves
//!   `agent-stopped.json`): leave it stopped until the person asks for it (the menu offers to start it). Otherwise wait a
//!   minute for a replacement to answer; if none does, say so (a notification) and start it again, with the same waits
//!   as after a crash.
//! - Its pipe accepts connections but it has given no model, or only errors, for half a minute: it is shown as not
//!   answering, and after another half minute it is ended (only the process that is the agent beside this tray) and
//!   started again, with the same waits.
//! - Another agent is starting (its lock file is fresh and its process is alive): wait for it. Never two.

use std::time::{Duration, Instant};

use crate::menu::AgentLink;

/// The waits between starts after unexpected exits: 2 s, 4 s, 8 s … at most 60 s.
#[derive(Debug, Clone, Default)]
pub struct Backoff {
    failures: u32,
}

impl Backoff {
    pub const FIRST: Duration = Duration::from_secs(2);
    pub const MAX: Duration = Duration::from_secs(60);

    /// The wait before the next start, counting this failure.
    pub fn next(&mut self) -> Duration {
        let secs = Self::FIRST.as_secs().saturating_mul(1u64 << self.failures.min(10));
        self.failures = self.failures.saturating_add(1);
        Duration::from_secs(secs).min(Self::MAX)
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

/// How long the agent must answer before earlier failures stop counting.
pub const STABLE_AFTER: Duration = Duration::from_secs(5 * 60);
/// How long a clean exit waits for a replacement (an update's handover) before the tray calls it stopped.
pub const HANDOVER_WAIT: Duration = Duration::from_secs(60);
/// The agent's own rule: a lock younger than this belongs to an agent that is still starting.
pub const LOCK_STARTING_MS: u64 = 60_000;
/// An agent whose pipe accepts connections but that gives no model (or only errors) this long is not answering.
pub const UNRESPONSIVE_AFTER: Duration = Duration::from_secs(30);
/// How long an agent shown as not answering is given before it is ended and started again.
pub const RESTART_HUNG_AFTER: Duration = Duration::from_secs(30);
/// What the agent leaves in the Scopebond folder when this computer's user stops it (`scopebond-agent stop`); it removes
/// the file when it starts.
pub const STOPPED_FILE: &str = "agent-stopped.json";

/// Something supervision did that the person should be told about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    /// The agent exited cleanly, nothing replaced it within HANDOVER_WAIT and nobody asked it to stop: it is started again.
    StartingAgain,
    /// The agent did not answer for UNRESPONSIVE_AFTER + RESTART_HUNG_AFTER: it is ended and started again.
    Restarting,
}

/// What the tray's own child (the agent it started) did since the last look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Child {
    /// The tray has no child running.
    None,
    Running,
    /// It exited, with this exit code (none when Windows did not give one). Reported once.
    Exited(Option<i32>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Observation {
    /// Something accepts connections on the agent's pipe.
    pub answering: bool,
    pub child: Child,
    /// Another agent holds a fresh lock and is alive (it is starting).
    pub other_starting: bool,
    /// The agent's endpoint file is there (a clean stop removes it; a crash leaves it).
    pub endpoint_file: bool,
    /// The agent program is beside the tray.
    pub agent_present: bool,
    /// The pipe accepts connections but the agent has given no model, or only errors, for UNRESPONSIVE_AFTER.
    pub unresponsive: bool,
    /// The agent was stopped by this computer's user (it left STOPPED_FILE).
    pub stopped_on_purpose: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Wait,
    Start,
    /// End the agent that does not answer (only if it is the agent beside the tray), then start it.
    Restart,
}

#[derive(Debug, Clone)]
pub struct Supervisor {
    backoff: Backoff,
    /// No start before this.
    not_before: Option<Instant>,
    answering_since: Option<Instant>,
    was_answering: bool,
    /// A clean exit, waiting to see whether a replacement answers.
    clean_exit_at: Option<Instant>,
    /// Stopped on purpose: no start until asked.
    stopped: bool,
    /// Since when it has been shown as not answering although its pipe accepts connections.
    hung_since: Option<Instant>,
    notice: Option<Notice>,
    link: AgentLink,
}

impl Default for Supervisor {
    fn default() -> Self {
        Supervisor::new()
    }
}

impl Supervisor {
    pub fn new() -> Supervisor {
        Supervisor {
            backoff: Backoff::default(),
            not_before: None,
            answering_since: None,
            was_answering: false,
            clean_exit_at: None,
            stopped: false,
            hung_since: None,
            notice: None,
            link: AgentLink::Starting,
        }
    }

    pub fn link(&self) -> AgentLink {
        self.link
    }

    /// What to tell the person since the last look, once.
    pub fn take_notice(&mut self) -> Option<Notice> {
        self.notice.take()
    }

    /// The person asked for the agent (the menu's "Start the Scopebond Agent"): start it at the next look.
    pub fn start_requested(&mut self) {
        self.stopped = false;
        self.clean_exit_at = None;
        self.not_before = None;
        self.backoff.reset();
    }

    /// Starting failed (the program could not be run): try again after the next wait.
    pub fn start_failed(&mut self, now: Instant) {
        self.not_before = Some(now + self.backoff.next());
        self.link = AgentLink::NotAnswering;
    }

    fn unexpected_exit(&mut self, now: Instant) {
        self.not_before = Some(now + self.backoff.next());
    }

    pub fn tick(&mut self, o: &Observation, now: Instant) -> Decision {
        if o.answering && o.unresponsive {
            // Hung: its pipe accepts connections, but no model comes. Shown as not answering; after a further wait it is
            // ended and started again, with the waits that grow after each failure.
            self.answering_since = None;
            self.link = AgentLink::NotAnswering;
            let since = *self.hung_since.get_or_insert(now);
            if now.duration_since(since) >= RESTART_HUNG_AFTER && self.not_before.is_none_or(|t| now >= t) {
                self.hung_since = None;
                self.not_before = Some(now + self.backoff.next());
                self.notice = Some(Notice::Restarting);
                return Decision::Restart;
            }
            return Decision::Wait;
        }
        self.hung_since = None;
        if o.answering {
            self.stopped = false;
            self.clean_exit_at = None;
            self.was_answering = true;
            let since = *self.answering_since.get_or_insert(now);
            if now.duration_since(since) >= STABLE_AFTER {
                self.backoff.reset();
            }
            self.link = AgentLink::Answering;
            return Decision::Wait;
        }
        self.answering_since = None;
        let lost_one = std::mem::replace(&mut self.was_answering, false);
        match o.child {
            Child::Running => {
                self.link = AgentLink::Starting;
                return Decision::Wait;
            }
            Child::Exited(Some(0)) => self.clean_exit_at = Some(now),
            Child::Exited(_) => self.unexpected_exit(now),
            // An agent the tray did not start went away: its endpoint file says how.
            Child::None if lost_one => {
                if o.endpoint_file {
                    self.unexpected_exit(now)
                } else {
                    self.clean_exit_at = Some(now)
                }
            }
            Child::None => {}
        }
        if !o.agent_present {
            self.link = AgentLink::Missing;
            return Decision::Wait;
        }
        if o.other_starting {
            self.link = AgentLink::Starting;
            return Decision::Wait;
        }
        if let Some(at) = self.clean_exit_at {
            if o.stopped_on_purpose {
                self.clean_exit_at = None;
                self.stopped = true;
            } else if now.duration_since(at) < HANDOVER_WAIT {
                self.link = AgentLink::Waiting;
                return Decision::Wait;
            } else {
                // No replacement, and nobody asked it to stop: start it again, after the wait a crash would get.
                self.clean_exit_at = None;
                self.not_before = Some(now + self.backoff.next());
                self.notice = Some(Notice::StartingAgain);
            }
        }
        if self.stopped {
            self.link = AgentLink::Stopped;
            return Decision::Wait;
        }
        if self.not_before.is_none_or(|t| now >= t) {
            self.not_before = None;
            self.link = AgentLink::Starting;
            return Decision::Start;
        }
        self.link = AgentLink::NotAnswering;
        Decision::Wait
    }
}

/// The agent's lock file says `<pid> <milliseconds since 1970>`. The holder's pid, and whether the lock is still young
/// enough to belong to an agent that is starting.
pub fn read_lock(text: &str, now_ms: u64) -> Option<(u32, bool)> {
    let mut parts = text.split_whitespace();
    let pid: u32 = parts.next()?.parse().ok().filter(|p| *p > 0)?;
    let at: u64 = parts.next()?.parse().ok()?;
    Some((pid, now_ms.saturating_sub(at) < LOCK_STARTING_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(answering: bool, child: Child) -> Observation {
        Observation { answering, child, other_starting: false, endpoint_file: true, agent_present: true, unresponsive: false, stopped_on_purpose: false }
    }

    struct Clock(Instant);
    impl Clock {
        fn at(&self, secs: u64) -> Instant {
            self.0 + Duration::from_secs(secs)
        }
    }

    #[test]
    fn the_backoff_doubles_from_two_seconds_to_a_minute() {
        let mut b = Backoff::default();
        let waits: Vec<u64> = (0..8).map(|_| b.next().as_secs()).collect();
        assert_eq!(waits, [2, 4, 8, 16, 32, 60, 60, 60]);
        b.reset();
        assert_eq!(b.next().as_secs(), 2);
        let mut long = Backoff::default();
        for _ in 0..200 {
            assert!(long.next() <= Backoff::MAX);
        }
    }

    #[test]
    fn starts_the_agent_at_once_when_nothing_answers() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        assert_eq!(s.tick(&obs(false, Child::None), c.at(0)), Decision::Start);
        assert_eq!(s.link(), AgentLink::Starting);
        // While its child starts, nothing else is started.
        for t in 1..30 {
            assert_eq!(s.tick(&obs(false, Child::Running), c.at(t)), Decision::Wait);
        }
        assert_eq!(s.tick(&obs(true, Child::Running), c.at(30)), Decision::Wait);
        assert_eq!(s.link(), AgentLink::Answering);
    }

    #[test]
    fn an_agent_that_already_answers_is_left_alone() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        for t in 0..100 {
            assert_eq!(s.tick(&obs(true, Child::None), c.at(t)), Decision::Wait);
        }
    }

    #[test]
    fn a_crash_restarts_it_with_growing_waits() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        let mut t = 0;
        assert_eq!(s.tick(&obs(false, Child::None), c.at(t)), Decision::Start);
        let mut waits = Vec::new();
        for _ in 0..6 {
            t += 1;
            assert_eq!(s.tick(&obs(false, Child::Exited(Some(1))), c.at(t)), Decision::Wait, "not at once");
            let crashed = t;
            loop {
                t += 1;
                if s.tick(&obs(false, Child::None), c.at(t)) == Decision::Start {
                    break;
                }
                assert_eq!(s.link(), AgentLink::NotAnswering);
            }
            waits.push(t - crashed);
        }
        assert_eq!(waits, [2, 4, 8, 16, 32, 60]);
    }

    #[test]
    fn five_minutes_of_answering_forgets_earlier_crashes() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        s.tick(&obs(false, Child::None), c.at(0));
        s.tick(&obs(false, Child::Exited(Some(1))), c.at(1));
        assert_eq!(s.tick(&obs(false, Child::None), c.at(3)), Decision::Start);
        s.tick(&obs(true, Child::Running), c.at(4));
        s.tick(&obs(true, Child::Running), c.at(4 + 301));
        s.tick(&obs(false, Child::Exited(Some(3221225477u32 as i32))), c.at(400));
        assert_eq!(s.tick(&obs(false, Child::None), c.at(401)), Decision::Wait);
        assert_eq!(s.tick(&obs(false, Child::None), c.at(402)), Decision::Start, "back to a two-second wait");
    }

    #[test]
    fn a_clean_exit_waits_for_the_replacement_and_never_starts_a_second() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        s.tick(&obs(false, Child::None), c.at(0));
        s.tick(&obs(true, Child::Running), c.at(5));
        // An update: the agent exits with 0 and its replacement starts a few seconds later.
        assert_eq!(s.tick(&obs(false, Child::Exited(Some(0))), c.at(100)), Decision::Wait);
        assert_eq!(s.link(), AgentLink::Waiting);
        for t in 101..110 {
            assert_eq!(s.tick(&obs(false, Child::None), c.at(t)), Decision::Wait);
        }
        let starting = Observation { other_starting: true, ..obs(false, Child::None) };
        for t in 110..200 {
            assert_eq!(s.tick(&starting, c.at(t)), Decision::Wait, "the replacement is starting");
        }
        assert_eq!(s.tick(&obs(true, Child::None), c.at(200)), Decision::Wait);
        assert_eq!(s.link(), AgentLink::Answering);
    }

    #[test]
    fn stopped_on_purpose_stays_stopped_until_asked() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        s.tick(&obs(false, Child::None), c.at(0));
        s.tick(&obs(true, Child::Running), c.at(5));
        // `scopebond-agent stop`: the agent exits with 0 and leaves its note.
        let stopped = Observation { stopped_on_purpose: true, ..obs(false, Child::Exited(Some(0))) };
        assert_eq!(s.tick(&stopped, c.at(100)), Decision::Wait);
        assert_eq!(s.link(), AgentLink::Stopped, "no wait for a replacement");
        let still = Observation { stopped_on_purpose: true, ..obs(false, Child::None) };
        for t in 101..1000 {
            assert_eq!(s.tick(&still, c.at(t)), Decision::Wait);
        }
        assert_eq!(s.link(), AgentLink::Stopped);
        assert_eq!(s.take_notice(), None, "nothing to tell: the person stopped it");
        s.start_requested();
        assert_eq!(s.tick(&still, c.at(1000)), Decision::Start);
    }

    #[test]
    fn a_clean_exit_with_no_replacement_is_told_and_started_again_with_growing_waits() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        s.tick(&obs(false, Child::None), c.at(0));
        s.tick(&obs(true, Child::Running), c.at(5));
        let mut t = 100;
        let mut waits = Vec::new();
        for _ in 0..4 {
            assert_eq!(s.tick(&obs(false, Child::Exited(Some(0))), c.at(t)), Decision::Wait);
            assert_eq!(s.link(), AgentLink::Waiting);
            let exited = t;
            // A minute for a replacement; none comes.
            while c.at(t).duration_since(c.at(exited)) < HANDOVER_WAIT {
                t += 1;
                assert_eq!(s.tick(&obs(false, Child::None), c.at(t)), Decision::Wait);
                if c.at(t).duration_since(c.at(exited)) < HANDOVER_WAIT {
                    assert_eq!(s.link(), AgentLink::Waiting);
                    assert_eq!(s.take_notice(), None);
                }
            }
            assert_eq!(s.take_notice(), Some(Notice::StartingAgain), "told once");
            assert_eq!(s.take_notice(), None);
            assert_ne!(s.link(), AgentLink::Stopped, "not left stopped");
            let gave_up = t;
            loop {
                t += 1;
                if s.tick(&obs(false, Child::None), c.at(t)) == Decision::Start {
                    break;
                }
                assert_eq!(s.link(), AgentLink::NotAnswering);
            }
            waits.push(t - gave_up);
            t += 1;
            assert_eq!(s.tick(&obs(false, Child::Running), c.at(t)), Decision::Wait);
            t += 1;
            assert_eq!(s.tick(&obs(true, Child::Running), c.at(t)), Decision::Wait);
            t += 1;
        }
        assert_eq!(waits, [2, 4, 8, 16]);
    }

    #[test]
    fn an_agent_that_accepts_but_gives_no_model_is_not_answering_then_restarted() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        s.tick(&obs(false, Child::None), c.at(0));
        s.tick(&obs(true, Child::Running), c.at(5));
        assert_eq!(s.link(), AgentLink::Answering);
        // The pipe accepts, but no model for half a minute (the tray decides that): not answering, not "starting".
        let hung = Observation { unresponsive: true, ..obs(true, Child::Running) };
        let first = 40;
        for t in first..first + RESTART_HUNG_AFTER.as_secs() {
            assert_eq!(s.tick(&hung, c.at(t)), Decision::Wait);
            assert_eq!(s.link(), AgentLink::NotAnswering);
        }
        assert_eq!(s.tick(&hung, c.at(first + RESTART_HUNG_AFTER.as_secs())), Decision::Restart);
        assert_eq!(s.take_notice(), Some(Notice::Restarting));
        // The new agent starts, then hangs as well: shown as not answering again, then restarted again.
        assert_eq!(s.tick(&obs(false, Child::Running), c.at(80)), Decision::Wait);
        assert_eq!(s.link(), AgentLink::Starting);
        let mut t = 81;
        let restarted = loop {
            if s.tick(&hung, c.at(t)) == Decision::Restart {
                break t;
            }
            t += 1;
            assert!(t < 400, "never restarted");
        };
        assert!(restarted - 81 >= RESTART_HUNG_AFTER.as_secs());
        // A model again: answering, and nothing is restarted.
        for t in restarted + 1..restarted + 100 {
            assert_eq!(s.tick(&obs(true, Child::Running), c.at(t)), Decision::Wait);
        }
        assert_eq!(s.link(), AgentLink::Answering);
    }

    #[test]
    fn an_agent_that_keeps_hanging_is_restarted_ever_less_often() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        s.tick(&obs(false, Child::None), c.at(0));
        let hung = Observation { unresponsive: true, ..obs(true, Child::Running) };
        let mut restarts = Vec::new();
        for t in 1..1000 {
            if s.tick(&hung, c.at(t)) == Decision::Restart {
                restarts.push(t);
            }
        }
        let gaps: Vec<u64> = restarts.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(restarts[0], 1 + RESTART_HUNG_AFTER.as_secs(), "half a minute shown as not answering first");
        assert!(gaps.iter().all(|g| *g >= RESTART_HUNG_AFTER.as_secs()), "{gaps:?}");
        assert_eq!(gaps.last(), Some(&Backoff::MAX.as_secs()), "at most once a minute: {gaps:?}");
    }

    #[test]
    fn an_agent_the_tray_did_not_start_is_judged_by_its_endpoint_file() {
        let c = Clock(Instant::now());
        // Killed: the file stays, so it is restarted after the first wait.
        let mut s = Supervisor::new();
        s.tick(&obs(true, Child::None), c.at(0));
        assert_eq!(s.tick(&obs(false, Child::None), c.at(10)), Decision::Wait);
        assert_eq!(s.tick(&obs(false, Child::None), c.at(12)), Decision::Start);
        // Stopped with `scopebond-agent stop`: it removed its file and left its note, so the tray leaves it stopped.
        let mut s = Supervisor::new();
        s.tick(&obs(true, Child::None), c.at(0));
        let stopped = Observation { endpoint_file: false, stopped_on_purpose: true, ..obs(false, Child::None) };
        for t in 10..200 {
            assert_eq!(s.tick(&stopped, c.at(t)), Decision::Wait);
        }
        assert_eq!(s.link(), AgentLink::Stopped);
        // It removed its file but nobody stopped it, and no replacement came: started again after a minute and the wait.
        let mut s = Supervisor::new();
        s.tick(&obs(true, Child::None), c.at(0));
        let gone = Observation { endpoint_file: false, ..obs(false, Child::None) };
        let first_start = (10..200).find(|t| s.tick(&gone, c.at(*t)) == Decision::Start);
        assert_eq!(first_start, Some(10 + HANDOVER_WAIT.as_secs() + 2));
        assert_eq!(s.take_notice(), Some(Notice::StartingAgain));
    }

    #[test]
    fn without_the_agent_program_nothing_is_started() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        let missing = Observation { agent_present: false, ..obs(false, Child::None) };
        for t in 0..100 {
            assert_eq!(s.tick(&missing, c.at(t)), Decision::Wait);
        }
        assert_eq!(s.link(), AgentLink::Missing);
    }

    #[test]
    fn a_failed_start_is_tried_again_after_the_wait() {
        let c = Clock(Instant::now());
        let mut s = Supervisor::new();
        assert_eq!(s.tick(&obs(false, Child::None), c.at(0)), Decision::Start);
        s.start_failed(c.at(0));
        assert_eq!(s.tick(&obs(false, Child::None), c.at(1)), Decision::Wait);
        assert_eq!(s.tick(&obs(false, Child::None), c.at(2)), Decision::Start);
    }

    #[test]
    fn the_agents_lock_file() {
        assert_eq!(read_lock("4242 1000000", 1_030_000), Some((4242, true)));
        assert_eq!(read_lock("4242 1000000", 1_070_000), Some((4242, false)));
        assert_eq!(read_lock("", 0), None);
        assert_eq!(read_lock("0 5", 10), None);
        assert_eq!(read_lock("x 5", 10), None);
    }
}
