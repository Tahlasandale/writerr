//! Couche des commandes Tauri (§5.11).
//!
//! Les commandes sont des fonctions **pures sur un contexte injectable** : elles ne
//! dépendent pas du runtime Tauri, ce qui les rend testables sans GTK/WebKit
//! (`tests/commands.rs`). Le binaire n'y ajoute qu'un adapteur dinvoke.
//!
//! Invariants tenus ici :
//! - tout chemin reçu du JS passe par [`paths::resolve`] avant tout effet disque ;
//! - une commande sans racine configurée échoue avec `FsError::NoRoot` ;
//! - `open_external` n'accepte que `https://github.com/…` ;
//! - `write_note` marque le chemin dans `SelfWrites` pour que le watcher ignore
//!   ses propres écritures.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

use crate::config::Config;
use crate::notes::{self, TreeNode};
use crate::{paths, FsError};

/// Contexte injecté dans les commandes. En production, c'est l'état global de
/// l'application, encapsulé ici pour rester testable.
pub struct Ctx<'a> {
    /// Notes root; `None` until the user picks a folder (one root in v1).
    pub root: Option<PathBuf>,
    /// Persistent user settings, mirrored in `config.json`.
    pub config: Mutex<Config>,
    /// Shared with the watcher so our own writes are not reported back.
    pub self_writes: Mutex<crate::selfwrites::SelfWrites>,
    /// In tests: the URLs allowed by `open_external`, captured instead of opened.
    pub open_urls: Mutex<BTreeMap<String, String>>,
    /// How deletions reach the system trash.
    pub trasher: &'a dyn notes::Trasher,
}

/// Réponse d'une commande, dans la forme attendue par `invoke` côté JS.
#[derive(Debug, Serialize)]
pub struct Ok_<T> {
    /// Always `true`; failures are reported as [`Err_`] instead.
    pub ok: bool,
    /// The command payload, omitted when the command returns nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}

/// Erreur sérialisée `{code, message}` (§5.11).
#[derive(Debug, Serialize)]
pub struct Err_ {
    /// Always `false`.
    pub ok: bool,
    /// Stable machine code (`no_root`, `escape`, …) for the JS side.
    pub code: String,
    /// French message, safe to display.
    pub message: String,
}

impl From<FsError> for Err_ {
    fn from(e: FsError) -> Self {
        Self {
            ok: false,
            code: e.code().to_owned(),
            message: e.to_string(),
        }
    }
}

type R<T> = Result<Ok_<T>, Err_>;

/// Renvoie la racine configurée ou `NoRoot` (§12 : un seul dossier en v1).
fn root_of(c: &Ctx<'_>) -> Result<PathBuf, Err_> {
    c.root.clone().ok_or_else(|| FsError::NoRoot.into())
}

/// Résout un chemin relatif contre la racine : aucun autre accès disque n'est possible.
///
/// `paths::resolve` refuse à dessein `""` et `"."` (ils désignent la racine, pas une
/// note). Mais « créer une note à la racine » est un cas légitime : ici `""` est
/// accepté et désigne explicitement la racine.
fn safe(c: &Ctx<'_>, rel: &str) -> Result<PathBuf, Err_> {
    let root = root_of(c)?;
    if rel.is_empty() {
        return Ok(root);
    }
    paths::resolve(&root, rel).map_err(Err_::from)
}

/// Lists the notes tree below the configured root.
#[cfg_attr(feature = "app", tauri::command)]
pub fn list_tree(c: &Ctx<'_>) -> R<Vec<TreeNode>> {
    let root = root_of(c)?;
    Ok(Ok_ {
        ok: true,
        data: Some(notes::list_tree(&root)?),
    })
}

/// Reads one note; rejects any path that escapes the root.
#[cfg_attr(feature = "app", tauri::command)]
pub fn read_note(c: &Ctx<'_>, rel: &str) -> R<NotePayload> {
    let path = safe(c, rel)?;
    let content = notes::read_note(&path)?;
    let mtime = mtime_ms(&path);
    Ok(Ok_ {
        ok: true,
        data: Some(NotePayload { content, mtime }),
    })
}

#[derive(Debug, Serialize)]
/// A note's text and its last modification time, in ms since the epoch.
pub struct NotePayload {
    /// Full text of the note.
    pub content: String,
    /// Last modification time, in ms since the epoch.
    pub mtime: i64,
}

#[derive(Debug, Serialize)]
/// The modification time produced by a write, in ms since the epoch.
pub struct MtimePayload {
    /// Modification time recorded by the write, in ms since the epoch.
    pub mtime: i64,
}

/// Writes a note atomically and marks the path as one of our own writes.
#[cfg_attr(feature = "app", tauri::command)]
pub fn write_note(c: &Ctx<'_>, rel: &str, content: &str) -> R<MtimePayload> {
    let path = safe(c, rel)?;
    notes::write_note_atomic(&path, content)?;
    // anti-boucle : le watcher ne doit pas ré-émettre notre propre écriture
    c.self_writes
        .lock()
        .map_err(|_| poisoned())?
        .mark(&path, Instant::now());
    Ok(Ok_ {
        ok: true,
        data: Some(MtimePayload {
            mtime: mtime_ms(&path),
        }),
    })
}

#[derive(Debug, Serialize)]
/// A relative path (separated by `/`) identifying a note or a folder.
pub struct IdPayload {
    /// Path relative to the root, with `/` separators (invariant I6).
    pub id: String,
}

/// Creates an empty note named after `title` inside `dir`, with a unique name.
#[cfg_attr(feature = "app", tauri::command)]
pub fn create_note(c: &Ctx<'_>, dir: &str, title: &str) -> R<IdPayload> {
    let dir_path = safe(c, dir)?;
    let path = notes::create_note(&dir_path, title)?;
    Ok(Ok_ {
        ok: true,
        data: Some(IdPayload {
            id: rel_of(c, &path)?,
        }),
    })
}

/// Creates a folder (uniquified on collision) below the root.
#[cfg_attr(feature = "app", tauri::command)]
pub fn create_dir(c: &Ctx<'_>, rel: &str) -> R<IdPayload> {
    let root = root_of(c)?;
    // refuse explicitement la racine : créer un dossier qui porte le nom du coffre
    // n'aurait aucun sens et le « renommer » ensuite serait destructeur
    if rel.is_empty() || rel == "." {
        return Err(FsError::Escape.into());
    }
    let path = notes::create_dir(&root, rel)?;
    Ok(Ok_ {
        ok: true,
        data: Some(IdPayload {
            id: rel_of(c, &path)?,
        }),
    })
}

/// Renames a note or a folder, keeping its parent and extension.
#[cfg_attr(feature = "app", tauri::command)]
pub fn rename(c: &Ctx<'_>, rel: &str, to_title: &str) -> R<IdPayload> {
    let from = safe(c, rel)?;
    let path = notes::rename(&from, to_title)?;
    Ok(Ok_ {
        ok: true,
        data: Some(IdPayload {
            id: rel_of(c, &path)?,
        }),
    })
}

/// Sends a note or folder to the system trash; the root itself is refused.
#[cfg_attr(feature = "app", tauri::command)]
pub fn delete(c: &Ctx<'_>, rel: &str) -> R<()> {
    let root = root_of(c)?;
    // delete_within repasse par paths::resolve et refuse explicitement "" / "." :
    // unlike safe(), the empty string must NOT silently mean "the root" here.
    notes::delete_within(&root, rel, c.trasher)?;
    Ok(Ok_ {
        ok: true,
        data: None,
    })
}

/// Returns the current configuration.
#[cfg_attr(feature = "app", tauri::command)]
pub fn get_config(c: &Ctx<'_>) -> R<Config> {
    let cfg = c.config.lock().map_err(|_| poisoned())?.clone();
    Ok(Ok_ {
        ok: true,
        data: Some(cfg),
    })
}

/// Replaces the configuration and echoes it back.
#[cfg_attr(feature = "app", tauri::command)]
pub fn set_config(c: &Ctx<'_>, cfg: Config) -> R<Config> {
    *c.config.lock().map_err(|_| poisoned())? = cfg;
    let back = c.config.lock().map_err(|_| poisoned())?.clone();
    Ok(Ok_ {
        ok: true,
        data: Some(back),
    })
}

/// Enregistre la racine choisie. `picked: None` = dialogue annulé -> `NoRoot`.
#[cfg_attr(feature = "app", tauri::command)]
pub fn pick_root(c: &mut Ctx<'_>, picked: Option<PathBuf>) -> R<PathBuf> {
    let Some(p) = picked else {
        return Err(FsError::NoRoot.into());
    };
    if !p.is_dir() {
        return Err(FsError::NotFound.into());
    }
    c.root = Some(p.clone());
    Ok(Ok_ {
        ok: true,
        data: Some(p),
    })
}

/// Sets the notes root programmatically; `None` clears it.
#[cfg_attr(feature = "app", tauri::command)]
pub fn set_root(c: &mut Ctx<'_>, root: Option<PathBuf>) -> R<PathBuf> {
    match root {
        None => {
            c.root = None;
            Err(FsError::NoRoot.into())
        }
        Some(p) if p.is_dir() => {
            c.root = Some(p.clone());
            Ok(Ok_ {
                ok: true,
                data: Some(p),
            })
        }
        Some(_) => Err(FsError::NotFound.into()),
    }
}

/// The crate version, mirroring `package.json`.
/// Returns an [`Ok_`] wrapper so that the wire format is exercised as well.
#[cfg_attr(feature = "app", tauri::command)]
pub fn app_version(_c: &Ctx<'_>) -> Ok_<&'static str> {
    Ok_ {
        ok: true,
        data: Some(env!("CARGO_PKG_VERSION")),
    }
}

/// Seule `https://github.com/…` est acceptée (§5.11) : le JS ne peut pas faire
/// ouvrir un `file://` ni un `javascript:`.
#[cfg_attr(feature = "app", tauri::command)]
pub fn open_external(c: &Ctx<'_>, url: &str) -> R<String> {
    let ok = url.starts_with("https://github.com/")
        && !url.starts_with("https://github.com.evil")
        && !url.contains("..")
        && !url.contains(char::is_whitespace);
    if !ok {
        return Err(FsError::Io("URL non autorisée".to_owned()).into());
    }
    c.open_urls
        .lock()
        .map_err(|_| poisoned())?
        .insert(url.to_owned(), String::new());
    Ok(Ok_ {
        ok: true,
        data: Some(url.to_owned()),
    })
}

fn poisoned() -> FsError {
    FsError::Io("verrou interne empoisonné".to_owned())
}

fn mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Chemin relatif à la racine, séparateur `/` (invariant I6).
fn rel_of(c: &Ctx<'_>, path: &std::path::Path) -> Result<String, Err_> {
    let root = root_of(c)?;
    let rel = path.strip_prefix(&root).map_err(|_| FsError::Escape)?;
    Ok(rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_of_echappe() {
        let c = Ctx {
            root: Some(PathBuf::from("/vault")),
            config: Mutex::new(Config::default()),
            self_writes: Mutex::new(Default::default()),
            open_urls: Mutex::new(BTreeMap::new()),
            trasher: &crate::notes::SystemTrasher,
        };
        assert_eq!(
            rel_of(&c, std::path::Path::new("/vault/a/b.md")).unwrap(),
            "a/b.md"
        );
        assert!(rel_of(&c, std::path::Path::new("/ailleurs/b.md")).is_err());
    }
}
