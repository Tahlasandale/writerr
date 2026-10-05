//! Application desktop Writer Deck — point d'entrée Tauri.
//!
//! Le cœur métier est dans la bibliothèque (`writer_deck`) ; ce binaire ne fait
//! que charger la configuration, exposer les commandes et piloter la fenêtre.
//! Toute la logique testable vit dans `commands`/`watcher`, ce qui permet à
//! `cargo test` de tourner **sans** GTK/WebKit (le binaire est derrière le
//! feature `app`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::Emitter;
use tauri::Manager; // state(), manage(), get_webview_window()
use tauri_plugin_dialog::DialogExt; // app.dialog().file()
use tauri_plugin_opener::OpenerExt; // app.opener().open_url()

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

/// Traduit l'erreur d'un plugin (`dialog`, `opener`) dans la même enveloppe
/// `{code, message}` que le reste : le JS ne voit ainsi qu'une seule forme
/// d'échec, quelle que soit sa source.
fn plugin_failed(action: &str, err: impl std::fmt::Display) -> commands::Err_ {
    commands::Err_ {
        ok: false,
        // Le même code qu'un `FsError::Io` : c'est le plugin qui a échoué, pas le
        // disque — et le JS n'a ainsi qu'une forme d'erreur à traiter.
        code: "io".to_owned(),
        message: format!("{action} : {err}"),
    }
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
 *
 * ATTENTION : le nom de la commande vue par le JS est le nom de la fonction
 * (`#[tauri::command]` ne retire aucun préfixe). Ces wrappers portent donc le nom
 * EXACT que le JS invoque (§5.11), et ceux de `commands` sont tous appelés
 * `commands::…` : aucun préfixe n'est nécessaire pour les distinguer.
 * ------------------------------------------------------------------ */

#[tauri::command]
fn list_tree(state: tauri::State<'_, App>) -> Result<commands::Ok_<Vec<TreeNode>>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::list_tree(&ctx)
}

#[tauri::command]
fn read_note(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<commands::NotePayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::read_note(&ctx, &rel)
}

#[tauri::command]
fn write_note(
    state: tauri::State<'_, App>,
    rel: String,
    content: String,
) -> Result<commands::Ok_<commands::MtimePayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::write_note(&ctx, &rel, &content)
}

#[tauri::command]
fn create_note(
    state: tauri::State<'_, App>,
    dir: String,
    title: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::create_note(&ctx, &dir, &title)
}

#[tauri::command]
fn create_dir(
    state: tauri::State<'_, App>,
    rel: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::create_dir(&ctx, &rel)
}

#[tauri::command]
fn rename(
    state: tauri::State<'_, App>,
    rel: String,
    to_title: String,
) -> Result<commands::Ok_<commands::IdPayload>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::rename(&ctx, &rel, &to_title)
}

#[tauri::command]
fn delete(state: tauri::State<'_, App>, rel: String) -> Result<commands::Ok_<()>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::delete(&ctx, &rel)
}

#[tauri::command]
fn get_config(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<config::Config>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::get_config(&ctx)
}

#[tauri::command]
fn set_config(
    state: tauri::State<'_, App>,
    cfg: config::Config,
) -> Result<commands::Ok_<config::Config>, commands::Err_> {
    let ctx = lock(&state)?;
    commands::set_config(&ctx, cfg)
}

#[tauri::command]
fn app_version(
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<&'static str>, commands::Err_> {
    // `commands::app_version` ne peut pas echouer : il renvoie deja l'enveloppe.
    let ctx = lock(&state)?;
    Ok(commands::app_version(&ctx))
}

/// Ouvre l'URL dans le navigateur du système, après l'avoir fait valider par
/// `commands::open_external`.
///
/// `open_url` est non bloquant (le plugin détache le processus), donc cette
/// commande reste synchrone. `None::<&str>` = aucun programme imposé, donc
/// l'application par défaut du système pour un `https://`.
#[tauri::command]
fn open_external(
    app: tauri::AppHandle,
    state: tauri::State<'_, App>,
    url: String,
) -> Result<commands::Ok_<String>, commands::Err_> {
    let ctx = lock(&state)?;
    let res = commands::open_external(&ctx, &url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| plugin_failed("ouverture impossible", err))?;
    Ok(res)
}

/// Recopie la racine courante dans la configuration : c'est elle qui est relue au
/// prochain lancement.
fn remember_root(ctx: &Ctx<'static>, path: &Path) -> Result<(), commands::Err_> {
    let mut cfg = ctx.config.lock().map_err(|_| poisoned())?;
    cfg.root = Some(path.to_string_lossy().into_owned());
    Ok(())
}

/// Ouvre le dialogue NATIF de choix de dossier, puis délègue la validation à
/// `commands::pick_root`.
///
/// Le dialogue est ici, et non côté JS, parce que l'API `@tauri-apps/plugin-dialog`
/// est un paquet npm : ce projet n'a ni bundler ni dépendance runtime, donc
/// `withGlobalTauri` n'injecte que le cœur Tauri. Sans ce dialogue, le bureau n'a
/// aucun moyen de choisir son dossier de notes.
///
/// `blocking_pick_folder` bloque : la commande est donc `async`, ce qui la fait
/// tourner sur le runtime asynchrone et non sur le thread principal (la doc du
/// plugin le dit explicitement).
#[tauri::command]
async fn pick_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, App>,
) -> Result<commands::Ok_<PathBuf>, commands::Err_> {
    let picked = app
        .dialog()
        .file()
        .set_title("Dossier de notes")
        .blocking_pick_folder()
        .map(|path| path.into_path())
        .transpose()
        .map_err(|err| plugin_failed("dossier illisible", err))?;
    let mut ctx = lock(&state)?;
    let res = commands::pick_root(&mut ctx, picked)?;
    if let Some(root) = res.data.as_deref() {
        remember_root(&ctx, root)?;
    }
    Ok(res)
}

/// Fixe la racine choisie par le dialogue natif. `None` = annulation -> `no_root`.
///
/// Délègue à `commands::set_root` : la validation du dossier et l'écriture de
/// `c.root` vivent dans `commands`, donc dans `cargo test`. Ce wrapper n'ajoute
/// que la persistance, que `commands` ne fait pas (il ignore la configuration).
/// Les deux implémentations divergeaient déjà — ici `None` renvoyait `no_root`
/// sans toucher à la racine, là-bas `c.root` repassait à `None` avant l'erreur.
#[tauri::command]
fn set_root(
    state: tauri::State<'_, App>,
    root: Option<String>,
) -> Result<commands::Ok_<String>, commands::Err_> {
    let mut ctx = lock(&state)?;
    let res = commands::set_root(&mut ctx, root.map(PathBuf::from))?;
    let data = res.data;
    if let Some(p) = data.as_deref() {
        remember_root(&ctx, p)?;
    }
    Ok(commands::Ok_ {
        ok: true,
        data: data.map(|p| p.to_string_lossy().into_owned()),
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
            list_tree,
            read_note,
            write_note,
            create_note,
            create_dir,
            rename,
            delete,
            get_config,
            set_config,
            pick_root,
            set_root,
            app_version,
            open_external,
        ])
}

fn main() {
    build()
        .run(tauri::generate_context!())
        .expect("impossible de démarrer l'interface");
}
