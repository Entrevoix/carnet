// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

//! Carnet desktop stub. Single window + system tray with one "Ouvrir Carnet"
//! menu item that re-focuses the main window.
//!
//! Also exposes three Tauri commands that wrap the OS keychain (via the
//! `keyring` crate) so the navetted token never lands in browser
//! localStorage. The TS side calls these via `invoke()` from
//! `src/lib/secureStorage.ts`.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

const KEYRING_SERVICE: &str = "carnet";
const KEYRING_USER: &str = "navetted_token";

#[tauri::command]
async fn get_navetted_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("keyring init: {e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

#[tauri::command]
async fn set_navetted_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("keyring init: {e}"))?;
    entry
        .set_password(&token)
        .map_err(|e| format!("keyring write: {e}"))
}

#[tauri::command]
async fn delete_navetted_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("keyring init: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_navetted_token,
            set_navetted_token,
            delete_navetted_token,
        ])
        .setup(|app| {
            let open = MenuItem::with_id(
                app,
                "open",
                "Ouvrir Carnet",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&open])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                    panic!("default window icon missing — check tauri.conf.json `bundle.icon`")
                }))
                .tooltip("Carnet")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "open" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
