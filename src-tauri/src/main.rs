//! Application desktop Writer Deck — point d'entrée Tauri.
//!
//! Le cœur métier est dans la bibliothèque (`writer_deck`) ; ce binaire ne fait
//! que charger la configuration, exposer les commandes et piloter la fenêtre.
//! Toute la logique testable vit dans `commands`/`watcher`, ce qui permet à
//! `cargo test` de tourner **sans** GTK/WebKit (le binaire est derrière le
//! feature `app`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::Emitter;
use tauri::Manager; // state(), manage(), get_webview_window()

use writer_deck::commands::{self, Ctx};
use writer_deck::notes::{SystemTrasher, TreeNode};
use writer_deck::watcher::{FsWatcher, WatchEvent, DEBOUNCE};
use writer_deck::{config, selfwrites::SelfWrites, FsError};

/// État global : le contexte des commandes, derrière un verrou.
///
/// `State<'_, T>` n'expose que `&self`, donc tout ce que les commandes doivent
/// modifier (la racine, la configuration) passe par des interieurs `Mutex`.
struct App {
    ctx: Mutex<Ctx<'static>>,
}

/// Erreur interne : un verrou empoisonné signifie qu'un panic a eu lieu ailleurs.
fn poisoned() -> commands::Err_ {
    commands::Err_::from(FsError::Io("verrou interne empoisonné".to_owned()))
}

/// `&App` et non `&State<'_, App>` : `State` porte DEUX durees de vie (celle du
/// runtime et celle de la reference interne), et le garde renvoye doit dire
/// laquelle il emprunte. En prenant `&App` — le dereferencement de `State` — il n'y
/// en a qu'une.
fn lock(app: &App) -> Result<MutexGuard<'_, Ctx<'static>>, commands::Err_> {
    app.ctx.lock().map_err(|_| poisoned())
}

/// Démarre le watcher sur la racine configurée, s'il y en a une.
///
/// Le watcher est un bonus : sans racine, ou si l'OS refuse l'observation,
/// l'application fonctionne en lecture/écriture directes.
fn start_watcher(app: &tauri::AppHandle) {
    let state = app.state::<App>();
    let (root, shared) = match state.ctx.lock() {
        Ok(ctx) => (ctx.root.clone(), Arc::clone(&ctx.self_writes)),
        Err(_) => return,
    };
    let Some(root) = root else {
        return;
    };
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
 * reste dans `commands` (tests/commands.rs) ; ces wrappers ne font que déballer.
 * ------------------------------------------------------------------ */

#[tauri::command]
fn cmd_list_tree(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<Vec<TreeNode>>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::list_tree(&ctx)
}

#[tauri::command]
fn cmd_read_note(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<commands::NotePayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::read_note(&ctx, &rel)
}

#[tauri::command]
fn cmd_write_note(
    state: tauri::State<'_, App>,
    rel: String,
    content: String,
) -> Result<commands::Ok_<commands::MtimePayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::write_note(&ctx, &rel, &content)
}

#[tauri::command]
fn cmd_create_note(
    state: tauri::State<'_, App>,
    dir: String,
    title: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::create_note(&ctx, &dir, &title)
}

#[tauri::command]
fn cmd_create_dir(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::create_dir(&ctx, &rel)
}

#[tauri::command]
fn cmd_rename(
    state: tauri::State<'_, App>,
    rel: String,
    to_title: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::rename(&ctx, &rel, &to_title)
}

#[tauri::command]
fn cmd_delete(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<()>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::delete(&ctx, &rel)
}

#[tauri::command]
fn cmd_get_config(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<config::Config>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::get_config(&ctx)
}

#[tauri::command]
fn cmd_set_config(
    state: tauri::State<'_, App>,
    cfg: config::Config,
) -> Result<commands::Ok_<config::Config>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::set_config(&ctx, cfg)
}

#[tauri::command]
fn cmd_app_version(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<&'static str>, commands::Err_> {
    // `commands::app_version` ne peut pas echouer : il renvoie deja l'enveloppe.
    let ctx = lock(&state)?;
    Ok(commands::app_version(&ctx))
}

#[tauri::command]
fn cmd_open_external(
    state: tauri::State<'_, App>,
    url: String,
) -> Result<commands::Ok_<String>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::open_external(&ctx, &url)
}

/// Renvoie la racine courante. Le dialogue natif est piloté par le plugin
/// `dialog` côté JS, puis le JS appelle `set_root`.
#[tauri::command]
fn pick_root(state: tauri::State<'_, App>) -> Result<commands::Ok_<String>, commands::Err_> {
    let ctx = lock(&state)?;
    match ctx.root.clone() {
        Some(p) => Ok(commands::Ok_ {
            ok: true,
            data: Some(p.to_string_lossy().into_owned()),
        }),
        None => Err(commands::Err_::from(FsError::NoRoot)),
    }
}

/// Fixe la racine choisie par le dialogue natif. `None` = annulation -> `no_root`.
#[tauri::command]
fn set_root(
    state: tauri::State<'_, App>,
    root: Option<String>,
) -> Result<commands::Ok_<String>, commands::Err_> {
    let Some(p) = root else {
        return Err(commands::Err_::from(FsError::NoRoot));
    };
    let path = PathBuf::from(p);
    if !path.is_dir() {
        return Err(commands::Err_::from(FsError::NotFound));
    }
    {
        let mut ctx = lock(&state)?;
        ctx.root = Some(path.clone());
        // On enregistre aussi dans la configuration : c'est elle qui est relue au
        // prochain lancement.
        let mut cfg = ctx.config.lock().map_err(|_| poisoned())?;
        cfg.root = Some(path.to_string_lossy().into_owned());
    }
    Ok(commands::Ok_ {
        ok: true,
        data: Some(path.to_string_lossy().into_owned()),
    })
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

            app.manage(App {
                ctx: Mutex::new(Ctx {
                    root: cfg.root.as_ref().map(PathBuf::from),
                    config: Mutex::new(cfg),
                    // UNE seule instance, partagée avec le watcher.
                    self_writes: Arc::new(Mutex::new(SelfWrites::new())),
                    open_urls: Mutex::new(BTreeMap::new()),
                    trasher,
                }),
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
