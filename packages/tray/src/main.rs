// The Scopebond tray for Windows: a tray icon and its menu. No console window, ever.
#![windows_subsystem = "windows"]

use scopebond_tray::icon::{self, IconState};
use scopebond_tray::menu::{self, AgentLink, Autostart, Command, Entry, MenuContext};
use scopebond_tray::model::Notifications;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, RunEvent, Runtime};

const TRAY_ID: &str = "scopebond";

fn icon_image(state: IconState) -> Image<'static> {
    Image::new_owned(icon::render(state, 32), 32, 32)
}

fn menu_item<R: Runtime>(app: &AppHandle<R>, entry: &Entry) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    Ok(match entry {
        Entry::Item { id, label, enabled } => Box::new(MenuItem::with_id(app, id.clone(), label, *enabled, None::<&str>)?),
        Entry::Check { id, label, checked, enabled } => {
            Box::new(CheckMenuItem::with_id(app, id.clone(), label, *enabled, *checked, None::<&str>)?)
        }
        Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        Entry::Submenu { label, entries } => {
            let sub = Submenu::new(app, label, true)?;
            for e in entries {
                sub.append(&*menu_item(app, e)?)?;
            }
            Box::new(sub)
        }
    })
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, spec: &[Entry]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for entry in spec {
        menu.append(&*menu_item(app, entry)?)?;
    }
    Ok(menu)
}

fn on_command<R: Runtime>(app: &AppHandle<R>, command: Command) {
    if command == Command::HideIcon {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_visible(false);
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let ctx = MenuContext { link: AgentLink::NotAnswering, autostart: Autostart::Off, notifications: Notifications::Problems };
            let tray_menu = build_menu(&handle, &menu::menu_spec(None, &ctx))?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon_image(IconState::Offline))
                .tooltip("Scopebond")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if let Some(command) = menu::command_for(event.id().as_ref(), None) {
                        on_command(app, command);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Scopebond tray could not start");
    app.run(|_app, event| {
        // The tray lives on with no window open: only an exit asked for in code ends it.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
