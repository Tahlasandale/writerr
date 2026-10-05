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

use tauri::Emitter;
use tauri::Manager; // state(), manage(), get_webview_window()

use writer_deck::commands::{self, Ctx};
use writer_deck::notes::SystemTrasher;
use writer_deck::watcher::{FsWatcher, WatchEvent, DEBOUNCE};
use writer_deck::{config, selfwrites::SelfWrites, FsError};

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
    let root = app.state::<App>().ctx.root.clone();
    let Some(root) = root else {
        return;
    };
    let shared = Arc::clone(&app.state::<App>().self_writes);
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

/* ------------------------------------------------------------------ *
 * Adaptateurs Tauri
 *
 * Les fonctions de `commands` sont pures et prennent `&Ctx`. Tauri, lui, n'accepte
 * qu'un `State<'_, T>` : ces wrappers font la traduction. Toute la logique testable
 * reste dans `commands` (tests/commands.rs), ces wrappers ne font que déballer.
 * ------------------------------------------------------------------ */
/* Les wrappers sont ecrits a plat, sans macro_rules : `impl Serialize` dans un type
de retour n'est pas exprimable simplement par une macro, et un aller-retour CI pour
une erreur de syntaxe de macro n'en vaut pas le coup. */

#[tauri::command]
fn cmd_list_tree(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<Vec<writer_deck::notes::TreeNode>>, commands::Err_> {
    commands::list_tree(&state.ctx)
}

#[tauri::command]
fn cmd_read_note(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<commands::NotePayload>, commands::Err_> {
    commands::read_note(&state.ctx, &rel)
}

#[tauri::command]
fn cmd_write_note(
    state: tauri::State<'_, App>,
    rel: String,
    content: String,
) -> Result<commands::Ok_<commands::MtimePayload>, commands::Err_> {
    commands::write_note(&state.ctx, &rel, &content)
}

#[tauri::command]
fn cmd_create_note(
    state: tauri::State<'_, App>,
    dir: String,
    title: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    commands::create_note(&state.ctx, &dir, &title)
}

#[tauri::command]
fn cmd_create_dir(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    commands::create_dir(&state.ctx, &rel)
}

#[tauri::command]
fn cmd_rename(
    state: tauri::State<'_, App>,
    rel: String,
    to_title: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    commands::rename(&state.ctx, &rel, &to_title)
}

#[tauri::command]
fn cmd_delete(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<()>, commands::Err_> {
    commands::delete(&state.ctx, &rel)
}

#[tauri::command]
fn cmd_get_config(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<config::Config>, commands::Err_> {
    commands::get_config(&state.ctx)
}

#[tauri::command]
fn cmd_set_config(
    state: tauri::State<'_, App>,
    cfg: config::Config,
) -> Result<commands::Ok_<config::Config>, commands::Err_> {
    commands::set_config(&state.ctx, cfg)
}

#[tauri::command]
fn cmd_app_version(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<&'static str>, commands::Err_> {
    commands::app_version(&state.ctx)
}

#[tauri::command]
fn cmd_open_external(
    state: tauri::State<'_, App>,
    url: String,
) -> Result<commands::Ok_<String>, commands::Err_> {
    commands::open_external(&state.ctx, &url)
}

/// Le dialogue natif vit dans le plugin `dialog`, cote JS : cette commande ne fait
/// que refuser un etat sans racine, ce qui declenche l'ecran « Choisir le dossier ».
#[tauri::command]
fn pick_root(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<impl serde::Serialize>, commands::Err_> {
    match state.ctx.root.clone() {
        Some(p) => Ok(commands::Ok_ {
            ok: true,
            data: Some(p),
        }),
        None => Err(commands::Err_::from(FsError::NoRoot)),
    }
}

/// Fixe la racine choisie par le dialogue natif. `None` = annulation -> `no_root`.
#[tauri::command]
fn set_root(
    state: tauri::State<'_, App>,
    root: Option<String>,
) -> Result<commands::Ok_<impl serde::Serialize>, commands::Err_> {
    match root {
        Some(p) => {
            let path = PathBuf::from(p);
            if !path.is_dir() {
                return Err(commands::Err_::from(FsError::NotFound));
            }
            // `State` donne un &mut interieur : on ecrit la racine sans prendre le
            // verrou config (champs disjoints, donc pas de deadlock).
            let slot = &mut state.ctx.root;
            *slot = Some(path);
            Ok(commands::Ok_ {
                ok: true,
                data: Some(()),
            })
        }
        None => Err(commands::Err_::from(FsError::NoRoot)),
    }
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
            // Le registre anti-boucle est partage : une seule instance, celle que
            // le watcher consulte ET que les commandes alimentent via Ctx.
            let self_writes = Arc::new(Mutex::new(SelfWrites::new()));
            // MutexGuard n'est pas Clone : on clone l'intérieur déréférencé.
            let for_ctx = self_writes
                .lock()
                .map(|g| SelfWrites::clone(&g))
                .unwrap_or_else(|_| SelfWrites::new());

            app.manage(App {
                ctx: Ctx {
                    root: cfg.root.as_ref().map(PathBuf::from),
                    config: Mutex::new(cfg),
                    self_writes: Mutex::new(for_ctx),
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
            cmd_list_tree,
            cmd_read_note,
            cmd_write_note,
            cmd_create_note,
            cmd_create_dir,
            cmd_rename,
            cmd_delete,
            cmd_get_config,
            cmd_set_config,
            pick_root,
            set_root,
            cmd_app_version,
            cmd_open_external,
        ])
}

fn main() {
    build()
        .run(tauri::generate_context!())
        .expect("impossible de démarrer l'interface");
}
