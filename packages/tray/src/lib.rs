//! The parts of the Scopebond tray that do not need a window system, so they are tested on their own: the icon, the
//! agent's tray model and the menu worked out from it, the HTTP spoken over the agent's pipe and the client that speaks
//! it, the panel's placement and wording, the live prompt, the tray's log, and this computer's machine id (worked out as the
//! hook, the agent and the gateway work it out).

pub mod agent;
pub mod http;
pub mod icon;
pub mod live;
pub mod log;
pub mod machine_id;
pub mod menu;
pub mod model;
pub mod notify;
pub mod panel;
pub mod supervise;
#[cfg(windows)]
pub mod win;
