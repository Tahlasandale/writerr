//! Application desktop Writer Deck — point d'entrée Tauri.
//!
//! Le cœur métier est dans la bibliothèque (`writer_deck`) ; ce binaire ne fait
//! que charger la configuration, exposer les commandes et piloter la fenêtre.
//! Toute la logique testable vit dans `commands`/`watcher`, ce qui permet à
//! `cargo test` de tourner **sans** GTK/WebKit (le binaire est derrière le
//! feature `app`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use writer_deck::commands::{self, Ctx};
use writer_deck::notes::SystemTrasher;
use writer_deck::watcher::{FsWatcher, WatchEvent, DEBOUNCE};
use writer_deck::{config, selfwrites::SelfWrites};

/// État global partagé par les commandes et le watcher.
struct App {
    ctx: Ctx<'static>,
    /// Clone partagé du registre anti-boucle : le watcher filtre avec exactement
    /// le même registre que celui où `write_note` marque nos écritures.
    self_writes: Arc<Mutex<SelfWrites>>,
}

/// Démarre le watcher sur la racine configurée, s'il y en a une.
///
/// Le watcher est un bonus : sans racine, ou si l'OS refuse l'observation,
/// l'application fonctionne en lecture/écriture directes.
fn start_watcher(app: &tauri::AppHandle) {
    let state = app.state::<App>();
    let Some(root) = state.ctx.root.clone() else {
        return;
    };
    let shared = Arc::clone(&state.self_writes);
    let Ok(watcher) = FsWatcher::start(&root, shared) else {
        return;
    };
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(DEBOUNCE);
        match watcher.poll(std::time::Instant::now()) {
            Some(WatchEvent::TreeChanged) => {
                let _ = handle.emit("tree-changed", ());
            }
            Some(WatchEvent::NoteChanged { path, mtime }) => {
                let _ = handle.emit("note-changed", (path, mtime));
            }
            None => {}
        }
    });
}

fn build() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let cfg = config::Config::load().unwrap_or_default();
            // Box::leak : le Trasher doit vivre aussi longtemps que l'état global.
            let trasher: &'static dyn writer_deck::notes::Trasher =
                Box::leak(Box::new(SystemTrasher));
            let self_writes = Arc::new(Mutex::new(SelfWrites::new()));

            app.manage(App {
                ctx: Ctx {
                    root: cfg.root.as_ref().map(PathBuf::from),
                    config: Mutex::new(cfg),
                    self_writes: Mutex::new(
                        self_writes.lock().map(|g| g.clone()).unwrap_or_default(),
                    ),
                    open_urls: Mutex::new(BTreeMap::new()),
                    trasher,
                },
                self_writes,
            });

            // La fermeture demande d'abord une sauvegarde au JS (§6.8).
            let handle = app.handle().clone();
            if let Some(win) = app.get_webview_window("main") {
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.emit("app-close-requested", ());
                    }
                });
            }

            start_watcher(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tree,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::create_dir,
            commands::rename,
            commands::delete,
            commands::get_config,
            commands::set_config,
            commands::pick_root,
            commands::set_root,
            commands::app_version,
            commands::open_external,
        ])
}

fn main() {
    build()
        .run(tauri::generate_context!())
        .expect("impossible de démarrer l'interface");
}
