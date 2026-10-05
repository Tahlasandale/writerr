//! Note tree traversal, reads, atomic writes and deletion.
//!
//! The web layer never touches the file system: it asks for a tree, reads a
//! note, writes a note, creates / renames / deletes an entry. This module is
//! where those requests become `std::fs` calls.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::names::{natural_cmp, sanitize_file_name, unique_name};
use crate::paths;
use crate::{io_err, FsError};

/// Extensions listed by [`list_tree`], compared case-insensitively.
pub const NOTE_EXTENSIONS: [&str; 2] = ["md", "txt"];

/// Hard cap on directory nesting, so a pathological tree (or a symlink loop the
/// containment check would still accept) cannot blow the stack.
pub const MAX_DEPTH: usize = 32;

/// Largest note accepted by [`read_note`]: 20 MB.
pub const MAX_SIZE: u64 = 20 * 1024 * 1024;

/// Suffix of the temporary file used by [`write_note_atomic`].
pub const TMP_SUFFIX: &str = "wd-tmp";

/// One entry of the notes tree.
///
/// `modified` and `created` are milliseconds since the Unix epoch, as expected
/// by the front-end `Date` handling. The wire format is plain snake_case.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TreeNode {
    /// File or directory name, as shown in the sidebar.
    pub name: String,
    /// Absolute path of the entry.
    pub path: PathBuf,
    /// `true` for a directory.
    pub is_dir: bool,
    /// Last modification time, in milliseconds since the epoch.
    pub modified: i64,
    /// Creation time, when the platform reports one.
    pub created: Option<i64>,
    /// Size in bytes (`0` for a directory).
    pub size: u64,
    /// Children, already sorted and traversed (empty for a file).
    pub children: Vec<TreeNode>,
}

impl TreeNode {
    /// Depth-first iteration over this node and all its descendants.
    pub fn walk<'a>(&'a self, out: &mut Vec<&'a TreeNode>) {
        out.push(self);
        for child in &self.children {
            child.walk(out);
        }
    }
}

/// Lists the notes tree rooted at `root`, without the root node itself.
///
/// * only `.md` and `.txt` files are listed, any extension case;
/// * any name starting with `.` is ignored, files and directories alike;
/// * empty directories are kept;
/// * entries are sorted with [`natural_cmp`] (natural, case-insensitive);
/// * a missing (or non-directory) root gives [`FsError::NotFound`];
/// * an entry whose metadata cannot be read (broken symlink, vanished file) is
///   skipped: one bad entry never fails the whole listing;
/// * a directory symlink leaving the root is never followed, so the listing
///   always stays inside the notes folder.
pub fn list_tree(root: &Path) -> Result<Vec<TreeNode>, FsError> {
    let canonical_root = root.canonicalize()?;
    if !canonical_root.is_dir() {
        return Err(FsError::NotFound);
    }
    let mut visited = HashSet::new();
    visited.insert(canonical_root.clone());
    let entries = read_dir_nodes(&canonical_root, &canonical_root, 0, &mut visited)?;
    Ok(entries)
}

/// Reads a note as UTF-8 text with Windows line endings normalised.
///
/// `\r\n` becomes `\n`; a file above [`MAX_SIZE`] gives [`FsError::TooLarge`];
/// invalid UTF-8 gives [`FsError::NotText`]. The content is only decoded once
/// the size check has passed.
pub fn read_note(path: &Path) -> Result<String, FsError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_SIZE {
        return Err(FsError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|err| io_err("lecture du fichier", &err))?;
    let text = String::from_utf8(bytes).map_err(|_| FsError::NotText)?;
    Ok(normalise_newlines(&text))
}

/// Writes `content` to `path` without ever leaving a half-written note behind.
///
/// The bytes go to `.<name>.wd-tmp` in the **same directory**, the temporary file
/// is flushed and `fsync`ed, then renamed over the target (atomic on every
/// supported platform). Missing parent directories are created. If anything
/// fails, the temporary file is removed before returning, so a failure can never
/// leave a `.wd-tmp` file behind.
pub fn write_note_atomic(path: &Path, content: &str) -> Result<(), FsError> {
    let parent = parent_of(path);
    fs::create_dir_all(parent).map_err(|err| io_err("création du dossier", &err))?;

    let tmp = temporary_path(path);
    let write = (|| -> Result<(), FsError> {
        let mut file =
            File::create(&tmp).map_err(|err| io_err("création du fichier temporaire", &err))?;
        file.write_all(content.as_bytes())
            .map_err(|err| io_err("écriture du fichier temporaire", &err))?;
        // Data must reach the disk before the rename publishes it.
        file.sync_all()
            .map_err(|err| io_err("synchronisation du fichier", &err))?;
        drop(file);
        fs::rename(&tmp, path).map_err(|err| io_err("remplacement du fichier", &err))?;
        Ok(())
    })();

    if write.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write
}

/// Creates an empty note called `title` inside `dir` and returns its path.
///
/// The title is sanitized and made unique, so calling it twice with the same
/// title yields `Note.md` then `Note (2).md`.
pub fn create_note(dir: &Path, title: &str) -> Result<PathBuf, FsError> {
    let name = unique_name(dir, title, "md");
    let path = dir.join(name);
    write_note_atomic(&path, "")?;
    Ok(path)
}

/// Creates the directory `rel` inside `root` and returns its path.
///
/// `rel` goes through [`paths::resolve`], so nothing outside the root is ever
/// created, and each segment is sanitized first (`projet/2026: bilan` becomes
/// `projet/2026  bilan`). When the last segment is already taken — by a
/// directory or by a file — the directory is created under a unique name
/// instead (`Projet` then `Projet (2)`); when `rel` names nested missing folders
/// the whole chain is created.
pub fn create_dir(root: &Path, rel: &str) -> Result<PathBuf, FsError> {
    let target = paths::resolve(root, &sanitise_relative(rel))?;

    // One single rule, whatever the state of `target`: take a free name in the
    // target's parent, then create the (possibly nested) chain.
    let parent = parent_of(&target);
    let name = unique_name(&parent, &file_name_of(&target), "");
    let fresh = parent.join(name);
    fs::create_dir_all(&fresh).map_err(|err| io_err("création du dossier", &err))?;
    Ok(fresh)
}

/// Renames a note or a directory to `to_title` and returns the new path.
///
/// The extension (`.md`, `.txt`, none at all) and the parent folder are kept, the
/// title is sanitized, and a collision gets a ` (n)` suffix. Renaming a note to
/// the name it already has is a no-op, and changing only its case is a plain
/// rename (never `note (2).md`).
pub fn rename(from: &Path, to_title: &str) -> Result<PathBuf, FsError> {
    if !from.exists() {
        return Err(FsError::NotFound);
    }
    let parent = parent_of(from);
    let extension = from
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let title = title_without_extension(to_title, &extension);
    let candidate = parent.join(with_extension(&title, &extension));

    // Renaming `note.md` to `note` is a no-op, not a new `note (2).md`.
    if candidate == from {
        return Ok(from.to_path_buf());
    }
    // `note.md` -> `NOTE.md` only changes the case: the collision check must not
    // turn it into a copy.
    let same_letters = candidate
        .file_name()
        .zip(from.file_name())
        .is_some_and(|(left, right)| {
            left.to_string_lossy()
                .eq_ignore_ascii_case(&right.to_string_lossy())
        });

    let target = if same_letters {
        candidate
    } else {
        parent.join(unique_name(&parent, &title, &extension))
    };

    fs::rename(from, &target).map_err(|err| io_err("renommage", &err))?;
    Ok(target)
}

/// Moves a file or a directory to the system trash.
///
/// The deletion itself is delegated to `trasher` — this function **never** calls
/// `remove_file` / `remove_dir`, so a note is always recoverable from the trash.
/// A path with no parent (the root of a volume) is refused, and so is a path that
/// does not exist.
pub fn delete(path: &Path, trasher: &dyn Trasher) -> Result<(), FsError> {
    if path.parent().is_none() {
        // `/` (or `C:\`): there is no parent to check, refuse rather than trash
        // a whole volume.
        return Err(FsError::Escape);
    }
    if !path.exists() {
        return Err(FsError::NotFound);
    }
    trasher.trash(path)
}

/// Same as [`delete`], but for a path given **relative to the notes root**.
///
/// This is the entry point used by the UI: the vault root itself can never be
/// trashed, and neither can anything outside it.
pub fn delete_within(root: &Path, rel: &str, trasher: &dyn Trasher) -> Result<(), FsError> {
    let target = paths::resolve(root, rel)?;
    delete(&target, trasher)
}

/// Everything that can move a path to the trash.
///
/// Abstracted so tests can record the calls and assert that the file is still on
/// disk, while production uses [`SystemTrasher`].
/// How a deletion reaches the system trash.
///
/// `Send + Sync` is required: the Tauri runtime holds the context in shared state
/// and calls commands from the async runtime, not from the thread that created it.
pub trait Trasher: Send + Sync {
    /// Moves `path` to the trash, or reports why it could not.
    fn trash(&self, path: &Path) -> Result<(), FsError>;
}

/// The real [`Trasher`], delegating to the `trash` crate (XDG / freedesktop,
/// macOS and Windows implementations).
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemTrasher;

impl Trasher for SystemTrasher {
    fn trash(&self, path: &Path) -> Result<(), FsError> {
        trash::delete(path).map_err(|err| FsError::Io(err.to_string()))
    }
}

// --- internals ---------------------------------------------------------------

/// One level of the tree, sorted. `depth` guards against symlink loops.
fn read_dir_nodes(
    canonical_root: &Path,
    dir: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
) -> Result<Vec<TreeNode>, FsError> {
    if depth >= MAX_DEPTH {
        return Ok(Vec::new());
    }

    let mut nodes = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // An unreadable sub-directory is reported as an empty one: the call
        // still succeeds, the tree simply has nothing to show inside it.
        Err(_) => return Ok(nodes),
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();

        // `metadata` follows symlinks: a dangling link has no metadata and is
        // simply not a note.
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let is_dir = metadata.is_dir();

        if is_dir {
            // The single rule that keeps the traversal inside the vault.
            if !paths::may_descend(canonical_root, &path) {
                continue;
            }
        } else if !is_note(&name) {
            continue;
        }

        let children = if is_dir {
            // Cycle guard: a symlink pointing back at an ancestor would make the
            // walk endless. The key is the canonical path, so the loop is caught
            // whichever spelling we came through.
            let key = crate::canonicalize(&path).unwrap_or_else(|| path.clone());
            if visited.insert(key.clone()) {
                let children = read_dir_nodes(canonical_root, &path, depth + 1, visited);
                visited.remove(&key);
                children?
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        nodes.push(TreeNode {
            name,
            path,
            is_dir,
            modified: metadata.modified().map(millis).unwrap_or(0),
            created: metadata.created().ok().map(millis),
            size: if is_dir { 0 } else { metadata.len() },
            children,
        });
    }

    nodes.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Ok(nodes)
}

fn is_note(name: &str) -> bool {
    let Some(extension) = Path::new(name).extension() else {
        return false;
    };
    let extension = extension.to_string_lossy().to_lowercase();
    NOTE_EXTENSIONS.contains(&extension.as_str())
}

fn millis(time: std::time::SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(delta) => delta.as_millis() as i64,
        // A pre-epoch timestamp is pathological; 0 keeps the UI sortable.
        Err(_) => 0,
    }
}

/// `path` with its last component replaced by `.<name>.wd-tmp`.
fn temporary_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(".");
    name.push(
        path.file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("note")),
    );
    name.push(".");
    name.push(TMP_SUFFIX);
    parent_of(path).join(name)
}

/// The directory holding `path`; a bare file name yields `.`.
fn parent_of(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => PathBuf::from("."),
        Some(parent) => parent.to_path_buf(),
        None => PathBuf::from("."),
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `note.md` typed as a title should rename to `note`, not to `note.md.md`.
fn title_without_extension(title: &str, extension: &str) -> String {
    let sanitized = sanitize_file_name(title);
    if extension.is_empty() {
        return sanitized;
    }
    let suffix = format!(".{extension}");
    if sanitized.len() > suffix.len() && sanitized.to_lowercase().ends_with(&suffix) {
        sanitized[..sanitized.len() - suffix.len()].to_string()
    } else {
        sanitized
    }
}

/// Sanitizes every segment of a relative path, leaving `.` and `..` alone so
/// that [`paths::resolve`] still gets the chance to refuse an escape.
fn sanitise_relative(rel: &str) -> String {
    rel.split('/')
        .map(|segment| {
            if segment.is_empty() || segment == "." || segment == ".." {
                segment.to_string()
            } else {
                sanitize_file_name(segment)
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// `base` plus `ext`, `ext` being given without its leading dot.
fn with_extension(base: &str, ext: &str) -> String {
    if ext.is_empty() {
        base.to_string()
    } else {
        format!("{base}.{ext}")
    }
}

fn normalise_newlines(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime};

    use tempfile::TempDir;

    /// Records what it was asked to trash and leaves the disk untouched, so a
    /// test can prove the note is still readable afterwards.
    #[derive(Default)]
    struct FakeTrasher {
        // Mutex et non RefCell : Trasher est Send + Sync (le runtime Tauri partage l'etat).
        calls: Mutex<Vec<PathBuf>>,
        failure: Option<FsError>,
    }

    impl FakeTrasher {
        fn calls(&self) -> Vec<PathBuf> {
            self.calls.lock().map(|c| c.clone()).unwrap_or_default()
        }
    }

    impl Trasher for FakeTrasher {
        fn trash(&self, path: &Path) -> Result<(), FsError> {
            if let Ok(mut c) = self.calls.lock() {
                c.push(path.to_path_buf());
            }
            match &self.failure {
                Some(err) => Err(err.clone()),
                None => Ok(()),
            }
        }
    }

    /// Builds a vault from a list of relative paths; a trailing `/` makes a
    /// directory.
    fn vault(entries: &[&str]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for entry in entries {
            if let Some(name) = entry.strip_suffix('/') {
                fs::create_dir_all(dir.path().join(name)).unwrap();
            } else {
                let path = dir.path().join(entry);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&path, "contenu").unwrap();
            }
        }
        dir
    }

    fn names(nodes: &[TreeNode]) -> Vec<&str> {
        nodes.iter().map(|node| node.name.as_str()).collect()
    }

    fn find<'a>(nodes: &'a [TreeNode], name: &str) -> &'a TreeNode {
        nodes
            .iter()
            .find(|node| node.name == name)
            .unwrap_or_else(|| {
                let listed = nodes
                    .iter()
                    .map(|node| node.name.clone())
                    .collect::<Vec<_>>();
                panic!("{name} introuvable dans {listed:?}")
            })
    }

    /// Temporary files that survived, whatever their exact name.
    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| name.contains(TMP_SUFFIX))
                    .collect()
            })
            .unwrap_or_default()
    }

    // --- list_tree ---------------------------------------------------------

    #[test]
    fn list_tree_lists_markdown_and_text_files_only() {
        let dir = vault(&[
            "a.md",
            "b.txt",
            "c.MD",
            "d.Txt",
            "image.png",
            "data.json",
            "noext",
        ]);
        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["a.md", "b.txt", "c.MD", "d.Txt"]);
    }

    #[test]
    fn list_tree_ignores_dot_names() {
        let dir = vault(&[
            ".hidden.md",
            "visible.md",
            ".git/config.md",
            ".secret/inside.md",
        ]);
        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["visible.md"]);
    }

    #[test]
    fn list_tree_keeps_empty_directories() {
        let dir = vault(&["empty/", "vide/", "plein/note.md"]);
        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["empty", "plein", "vide"]);
        assert!(find(&tree, "empty").is_dir);
        assert!(find(&tree, "empty").children.is_empty());
        assert_eq!(names(&find(&tree, "plein").children), ["note.md"]);
    }

    #[test]
    fn list_tree_sorts_naturally_and_case_insensitively() {
        let dir = vault(&["note10.md", "Note2.md", "note1.md", "beta.md", "Alpha.md"]);
        let tree = list_tree(dir.path()).unwrap();
        // Digits compare numerically and case never decides.
        assert_eq!(
            names(&tree),
            ["Alpha.md", "beta.md", "note1.md", "Note2.md", "note10.md"]
        );
    }

    #[test]
    fn list_tree_sorts_directories_with_their_files() {
        let dir = vault(&["zebra.md", "alpha/", "Bravo/"]);
        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["alpha", "Bravo", "zebra.md"]);
    }

    #[test]
    fn list_tree_reports_a_missing_root() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            list_tree(&dir.path().join("absent")).unwrap_err(),
            FsError::NotFound
        );
    }

    #[test]
    fn list_tree_reports_a_root_that_is_a_file() {
        let dir = vault(&["a.md"]);
        assert_eq!(
            list_tree(&dir.path().join("a.md")).unwrap_err(),
            FsError::NotFound
        );
    }

    #[test]
    fn list_tree_reports_an_empty_tree_for_an_empty_root() {
        let dir = TempDir::new().unwrap();
        assert!(list_tree(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn list_tree_skips_an_entry_whose_metadata_is_unreadable() {
        let dir = vault(&["bon.md"]);
        // A dangling symlink has no metadata: it is not a note, and it must not
        // fail the whole listing.
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("ghost.md"), dir.path().join("broken.md"))
            .unwrap();
        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["bon.md"]);
    }

    #[test]
    fn list_tree_keeps_going_when_a_directory_cannot_be_read() {
        let dir = vault(&["visible.md", "cache/"]);
        let locked = dir.path().join("cache");

        let mut permissions = fs::metadata(&locked).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o000);
        }
        fs::set_permissions(&locked, permissions).unwrap();

        let actually_locked = fs::read_dir(&locked).is_err();
        let tree = list_tree(dir.path());
        fs::remove_dir(&locked).ok();

        if !actually_locked {
            // Running with privileges that ignore the mode bits.
            eprintln!("skipped: the test process can read a 0o000 directory");
            return;
        }
        // The call succeeds and the entry is reported as an empty directory.
        let tree = tree.unwrap();
        assert_eq!(names(&tree), ["cache", "visible.md"]);
        assert!(find(&tree, "cache").children.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn list_tree_never_follows_a_directory_symlink_leaving_the_root() {
        let outside = vault(&["secret.md"]);
        let dir = vault(&["bon.md"]);
        std::os::unix::fs::symlink(outside.path(), dir.path().join("raccourci")).unwrap();

        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["bon.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn list_tree_follows_a_directory_symlink_staying_inside_the_root() {
        let dir = vault(&["reel/深处.md"]);
        std::os::unix::fs::symlink(dir.path().join("reel"), dir.path().join("alias")).unwrap();

        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["alias", "reel"]);
        assert_eq!(names(&find(&tree, "alias").children), ["深处.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn list_tree_survives_a_symlink_loop_inside_the_root() {
        let dir = vault(&["note.md"]);
        // `reel/lasso` points back at the root: a naive walk would never end.
        fs::create_dir_all(dir.path().join("reel")).unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("reel").join("lasso")).unwrap();

        let tree = list_tree(dir.path()).unwrap();
        let reel = find(&tree, "reel");
        assert_eq!(names(&reel.children), ["lasso"]);
        assert!(find(&reel.children, "lasso").children.is_empty());
    }

    #[test]
    fn list_tree_stops_at_the_maximum_depth() {
        let dir = TempDir::new().unwrap();
        let deep = (0..MAX_DEPTH + 4)
            .map(|level| format!("{}/note.md", "d".repeat(level + 1)))
            .collect::<Vec<_>>();
        for entry in deep {
            let path = dir.path().join(entry);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }

        // No panic, and the deepest levels are simply not reported.
        let tree = list_tree(dir.path()).unwrap();
        assert!(!tree.is_empty());
    }

    #[test]
    fn list_tree_reports_size_and_timestamps() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "12345").unwrap();
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let tree = list_tree(dir.path()).unwrap();
        let node = find(&tree, "a.md");
        assert!(!node.is_dir);
        assert_eq!(node.size, 5);
        assert_eq!(node.path, dir.path().join("a.md"));
        assert_eq!(node.children.len(), 0);
        // Milliseconds since the epoch, not seconds and not nanoseconds.
        assert!(node.modified > before - 60_000, "modified is not in ms");
        assert!(node.modified <= before, "modified is in the future");
        if let Some(created) = node.created {
            assert!(created > 1_000_000_000_000, "created is not in ms");
        }
    }

    #[test]
    fn list_tree_reports_a_directory_size_of_zero() {
        let dir = vault(&["sub/note.md"]);
        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(find(&tree, "sub").size, 0);
    }

    #[test]
    fn tree_node_serialises_with_the_documented_field_names() {
        let dir = vault(&["a.md"]);
        let tree = list_tree(dir.path()).unwrap();
        let json = serde_json::to_string(&tree[0]).unwrap();
        for field in [
            "\"name\"",
            "\"path\"",
            "\"is_dir\"",
            "\"modified\"",
            "\"created\"",
            "\"size\"",
            "\"children\"",
        ] {
            assert!(json.contains(field), "{field} missing from {json}");
        }
    }

    #[test]
    fn tree_node_walk_visits_every_descendant() {
        let dir = vault(&["a.md", "sub/b.md", "sub/profond/c.md"]);
        let tree = list_tree(dir.path()).unwrap();
        let mut all = Vec::new();
        for node in &tree {
            node.walk(&mut all);
        }
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].name, "a.md");
    }

    // --- read_note ---------------------------------------------------------

    #[test]
    fn read_note_returns_the_text() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        fs::write(&path, "# Titre\n\nUn paragraphe.\n").unwrap();
        assert_eq!(read_note(&path).unwrap(), "# Titre\n\nUn paragraphe.\n");
    }

    #[test]
    fn read_note_returns_an_empty_string_for_an_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty.md");
        fs::write(&path, "").unwrap();
        assert_eq!(read_note(&path).unwrap(), "");
    }

    #[test]
    fn read_note_normalises_crlf_to_lf() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crlf.md");
        fs::write(&path, "un\r\ndeux\r\ntrois").unwrap();
        assert_eq!(read_note(&path).unwrap(), "un\ndeux\ntrois");
    }

    #[test]
    fn read_note_keeps_a_lone_carriage_return() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("cr.md");
        fs::write(&path, "a\rb").unwrap();
        assert_eq!(read_note(&path).unwrap(), "a\rb");
    }

    #[test]
    fn read_note_keeps_unicode_intact() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("u.md");
        fs::write(&path, "Éléphant 🐘 日本語\n").unwrap();
        assert_eq!(read_note(&path).unwrap(), "Éléphant 🐘 日本語\n");
    }

    #[test]
    fn read_note_rejects_invalid_utf8() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("latin.md");
        fs::write(&path, [0x43, 0x61, 0x66, 0xe9, 0x0a]).unwrap();
        assert_eq!(read_note(&path).unwrap_err(), FsError::NotText);
    }

    #[test]
    fn read_note_rejects_a_utf16_bom() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("utf16.md");
        // BOM FF FE followed by a NUL byte: valid UTF-16, not valid UTF-8.
        fs::write(&path, [0xff, 0xfe, 0x41, 0x00]).unwrap();
        assert_eq!(read_note(&path).unwrap_err(), FsError::NotText);
    }

    #[test]
    fn read_note_rejects_a_file_above_the_size_limit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("huge.md");
        File::create(&path).unwrap().set_len(MAX_SIZE + 1).unwrap();
        assert_eq!(read_note(&path).unwrap_err(), FsError::TooLarge);
    }

    #[test]
    fn read_note_accepts_a_file_at_exactly_the_size_limit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("max.md");
        File::create(&path).unwrap().set_len(MAX_SIZE).unwrap();
        let text = read_note(&path).unwrap();
        assert_eq!(text.len() as u64, MAX_SIZE);
    }

    #[test]
    fn read_note_reports_a_missing_file() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            read_note(&dir.path().join("absent.md")).unwrap_err(),
            FsError::NotFound
        );
    }

    #[test]
    fn read_note_reports_a_directory_as_an_error() {
        let dir = vault(&["sub/"]);
        assert!(read_note(&dir.path().join("sub")).is_err());
    }

    // --- write_note_atomic -------------------------------------------------

    #[test]
    fn write_note_atomic_creates_a_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        write_note_atomic(&path, "bonjour").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "bonjour");
    }

    #[test]
    fn write_note_atomic_overwrites_an_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        fs::write(&path, "ancien contenu").unwrap();
        write_note_atomic(&path, "neuf").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "neuf");
    }

    #[test]
    fn write_note_atomic_creates_the_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a").join("b").join("c.md");
        write_note_atomic(&path, "profond").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "profond");
    }

    #[test]
    fn write_note_atomic_writes_the_content_byte_for_byte() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("u.md");
        let content = "# Titre\r\n\nÉléphant 🐘 日本語\n\n  espaces  \n";
        write_note_atomic(&path, content).unwrap();
        assert_eq!(fs::read(&path).unwrap(), content.as_bytes());
    }

    #[test]
    fn write_note_atomic_adds_no_trailing_newline() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        write_note_atomic(&path, "sans saut de ligne").unwrap();
        assert_eq!(fs::read(&path).unwrap().len(), "sans saut de ligne".len());
    }

    #[test]
    fn write_note_atomic_leaves_no_temporary_file_behind_on_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        write_note_atomic(&path, "ok").unwrap();
        assert_eq!(leftovers(dir.path()), Vec::<String>::new());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn write_note_atomic_uses_a_dotted_temporary_name_in_the_same_directory() {
        let dir = TempDir::new().unwrap();
        // The target is a directory: the rename fails, which is the only way to
        // observe the temporary name.
        let path = dir.path().join("bloque.md");
        fs::create_dir(&path).unwrap();
        assert!(write_note_atomic(&path, "x").is_err());
        // `.<name>.wd-tmp` in the *parent* directory, not a `*.tmp` file.
        assert_eq!(leftovers(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn write_note_atomic_leaves_no_temporary_file_when_the_rename_fails() {
        let dir = TempDir::new().unwrap();
        // A directory cannot be replaced by a file: the rename fails.
        let path = dir.path().join("bloque");
        fs::create_dir(&path).unwrap();

        let err = write_note_atomic(&path, "contenu").unwrap_err();
        assert!(matches!(err, FsError::Io(_)), "unexpected error: {err:?}");
        assert_eq!(leftovers(dir.path()), Vec::<String>::new());
        // The target is untouched.
        assert!(path.is_dir());
        assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    }

    #[test]
    fn write_note_atomic_leaves_no_temporary_file_when_the_parent_is_a_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("fichier"), "x").unwrap();
        let path = dir.path().join("fichier").join("note.md");

        assert!(write_note_atomic(&path, "x").is_err());
        assert_eq!(leftovers(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn write_note_atomic_leaves_no_temporary_file_when_the_content_fails_to_write() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        fs::create_dir(&path).unwrap();
        // Same failure as above, reached with a name that has an extension.
        assert!(write_note_atomic(&path, "x").is_err());
        assert_eq!(leftovers(dir.path()), Vec::<String>::new());
    }

    // --- create_note -------------------------------------------------------

    #[test]
    fn create_note_creates_an_empty_markdown_file() {
        let dir = TempDir::new().unwrap();
        let path = create_note(dir.path(), "Mon idée").unwrap();
        assert_eq!(path, dir.path().join("Mon idée.md"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn create_note_sanitizes_the_title() {
        let dir = TempDir::new().unwrap();
        let path = create_note(dir.path(), "a/b:c*?").unwrap();
        assert_eq!(path, dir.path().join("a b c.md"));
    }

    #[test]
    fn create_note_falls_back_to_sans_titre() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            create_note(dir.path(), "   ").unwrap(),
            dir.path().join("Sans titre.md")
        );
    }

    #[test]
    fn create_note_makes_the_name_unique() {
        let dir = TempDir::new().unwrap();
        let first = create_note(dir.path(), "Note").unwrap();
        let second = create_note(dir.path(), "Note").unwrap();
        let third = create_note(dir.path(), "Note").unwrap();
        assert_eq!(first.file_name().unwrap(), "Note.md");
        assert_eq!(second.file_name().unwrap(), "Note (2).md");
        assert_eq!(third.file_name().unwrap(), "Note (3).md");
        assert!(first.exists() && second.exists() && third.exists());
    }

    #[test]
    fn create_note_detects_a_case_insensitive_collision() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("note.md"), "existant").unwrap();
        let path = create_note(dir.path(), "Note").unwrap();
        assert_eq!(path.file_name().unwrap(), "Note (2).md");
        // The pre-existing note keeps its content.
        assert_eq!(
            fs::read_to_string(dir.path().join("note.md")).unwrap(),
            "existant"
        );
    }

    #[test]
    fn create_note_creates_a_missing_directory() {
        let dir = TempDir::new().unwrap();
        let path = create_note(&dir.path().join("projet"), "Note").unwrap();
        assert!(path.exists());
    }

    // --- create_dir --------------------------------------------------------

    #[test]
    fn create_dir_creates_the_directory_and_returns_its_path() {
        let dir = TempDir::new().unwrap();
        let path = create_dir(dir.path(), "Projet").unwrap();
        assert_eq!(path, dir.path().join("Projet"));
        assert!(path.is_dir());
    }

    #[test]
    fn create_dir_creates_nested_directories() {
        let dir = TempDir::new().unwrap();
        let path = create_dir(dir.path(), "projet/2026").unwrap();
        assert_eq!(path, dir.path().join("projet").join("2026"));
        assert!(path.is_dir());
    }

    #[test]
    fn create_dir_returns_a_unique_name_when_it_already_exists() {
        let dir = TempDir::new().unwrap();
        let first = create_dir(dir.path(), "Projet").unwrap();
        let second = create_dir(dir.path(), "Projet").unwrap();
        assert_eq!(first.file_name().unwrap(), "Projet");
        assert_eq!(second.file_name().unwrap(), "Projet (2)");
        assert!(first.is_dir() && second.is_dir());
    }

    #[test]
    fn create_dir_refuses_to_escape_the_root() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            create_dir(dir.path(), "../ailleurs").unwrap_err(),
            FsError::Escape
        );
        assert_eq!(create_dir(dir.path(), "/tmp").unwrap_err(), FsError::Escape);
        assert_eq!(create_dir(dir.path(), "").unwrap_err(), FsError::Escape);
        assert_eq!(create_dir(dir.path(), ".").unwrap_err(), FsError::Escape);
    }

    #[test]
    fn create_dir_sanitizes_every_segment() {
        let dir = TempDir::new().unwrap();
        let path = create_dir(dir.path(), "projet/2026: bilan").unwrap();
        assert_eq!(path, dir.path().join("projet").join("2026 bilan"));
        assert!(path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn create_dir_refuses_a_symlinked_directory_leaving_the_root() {
        let outside = TempDir::new().unwrap();
        let dir = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("raccourci")).unwrap();

        assert_eq!(
            create_dir(dir.path(), "raccourci/nouveau").unwrap_err(),
            FsError::Escape
        );
    }

    #[test]
    fn create_dir_reports_a_missing_root() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            create_dir(&dir.path().join("absent"), "Projet").unwrap_err(),
            FsError::NotFound
        );
    }

    // --- rename ------------------------------------------------------------

    #[test]
    fn rename_keeps_the_extension() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("ancien.md");
        fs::write(&from, "contenu").unwrap();
        let to = rename(&from, "Nouveau").unwrap();
        assert_eq!(to, dir.path().join("Nouveau.md"));
        assert_eq!(fs::read_to_string(&to).unwrap(), "contenu");
        assert!(!from.exists());
    }

    #[test]
    fn rename_keeps_a_text_extension() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("ancien.txt");
        fs::write(&from, "x").unwrap();
        assert_eq!(
            rename(&from, "Nouveau").unwrap(),
            dir.path().join("Nouveau.txt")
        );
    }

    #[test]
    fn rename_keeps_a_file_without_extension() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("LICENSE");
        fs::write(&from, "x").unwrap();
        let to = rename(&from, "LICENCE").unwrap();
        assert_eq!(to, dir.path().join("LICENCE"));
    }

    #[test]
    fn rename_keeps_the_parent_folder() {
        let dir = vault(&["projet/note.md"]);
        let to = rename(&dir.path().join("projet").join("note.md"), "Titre").unwrap();
        assert_eq!(to, dir.path().join("projet").join("Titre.md"));
    }

    #[test]
    fn rename_makes_the_name_unique_on_collision() {
        let dir = vault(&["prise.md", "autre.md"]);
        let to = rename(&dir.path().join("autre.md"), "prise").unwrap();
        assert_eq!(to, dir.path().join("prise (2).md"));
        // The existing note is not touched.
        assert_eq!(
            fs::read_to_string(dir.path().join("prise.md")).unwrap(),
            "contenu"
        );
    }

    #[test]
    fn rename_to_the_same_name_is_a_no_op() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("note.md");
        fs::write(&from, "x").unwrap();
        let to = rename(&from, "note").unwrap();
        assert_eq!(to, from);
        assert!(from.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rename_to_the_same_name_with_a_different_case_only_changes_the_case() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("note.md");
        fs::write(&from, "contenu").unwrap();
        let to = rename(&from, "NOTE").unwrap();
        assert_eq!(to, dir.path().join("NOTE.md"));
        assert_eq!(fs::read_to_string(&to).unwrap(), "contenu");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rename_strips_a_redundant_extension_from_the_title() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("ancien.md");
        fs::write(&from, "x").unwrap();
        // Typing `note.md` must not produce `note.md.md`.
        assert_eq!(
            rename(&from, "note.md").unwrap(),
            dir.path().join("note.md")
        );
    }

    #[test]
    fn rename_sanitizes_the_title() {
        let dir = TempDir::new().unwrap();
        let from = dir.path().join("ancien.md");
        fs::write(&from, "x").unwrap();
        assert_eq!(rename(&from, "a/b:c").unwrap(), dir.path().join("a b c.md"));
    }

    #[test]
    fn rename_works_on_a_directory() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("ancien")).unwrap();
        fs::write(dir.path().join("ancien").join("note.md"), "x").unwrap();
        let to = rename(&dir.path().join("ancien"), "Nouveau").unwrap();
        assert_eq!(to, dir.path().join("Nouveau"));
        assert!(to.join("note.md").exists());
    }

    #[test]
    fn rename_of_a_directory_adds_no_extension() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("ancien")).unwrap();
        let to = rename(&dir.path().join("ancien"), "Projet 2026").unwrap();
        assert_eq!(to, dir.path().join("Projet 2026"));
        assert!(to.is_dir());
    }

    #[test]
    fn rename_of_a_directory_is_made_unique() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("existant")).unwrap();
        fs::create_dir(dir.path().join("ancien")).unwrap();
        let to = rename(&dir.path().join("ancien"), "existant").unwrap();
        assert_eq!(to, dir.path().join("existant (2)"));
        assert!(to.is_dir());
    }

    #[test]
    fn rename_reports_a_missing_source() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            rename(&dir.path().join("absent.md"), "Titre").unwrap_err(),
            FsError::NotFound
        );
    }

    #[test]
    fn rename_updates_the_tree_listing() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("avant.md"), "x").unwrap();
        rename(&dir.path().join("avant.md"), "apres").unwrap();
        let tree = list_tree(dir.path()).unwrap();
        assert_eq!(names(&tree), ["apres.md"]);
    }

    // --- delete ------------------------------------------------------------

    #[test]
    fn delete_calls_the_trasher_exactly_once() {
        let dir = vault(&["a.md"]);
        let trasher = FakeTrasher::default();
        delete(&dir.path().join("a.md"), &trasher).unwrap();
        assert_eq!(trasher.calls(), [dir.path().join("a.md")]);
    }

    #[test]
    fn delete_never_removes_the_file_itself() {
        let dir = vault(&["a.md"]);
        let path = dir.path().join("a.md");
        let trasher = FakeTrasher::default();
        delete(&path, &trasher).unwrap();
        // The fake only records: the note is still there, so the operation is
        // recoverable.
        assert!(path.exists());
        assert_eq!(read_note(&path).unwrap(), "contenu");
    }

    #[test]
    fn delete_works_on_a_directory() {
        let dir = vault(&["projet/note.md"]);
        let trasher = FakeTrasher::default();
        delete(&dir.path().join("projet"), &trasher).unwrap();
        assert_eq!(trasher.calls(), [dir.path().join("projet")]);
        assert!(dir.path().join("projet").is_dir());
    }

    #[test]
    fn delete_refuses_the_volume_root() {
        let trasher = FakeTrasher::default();
        assert_eq!(
            delete(Path::new("/"), &trasher).unwrap_err(),
            FsError::Escape
        );
        assert!(trasher.calls().is_empty());
    }

    #[test]
    fn delete_reports_a_missing_path_without_calling_the_trasher() {
        let dir = TempDir::new().unwrap();
        let trasher = FakeTrasher::default();
        assert_eq!(
            delete(&dir.path().join("absent.md"), &trasher).unwrap_err(),
            FsError::NotFound
        );
        assert!(trasher.calls().is_empty());
    }

    #[test]
    fn delete_propagates_a_trasher_failure() {
        let dir = vault(&["a.md"]);
        let trasher = FakeTrasher {
            failure: Some(FsError::Io("corbeille indisponible".into())),
            ..FakeTrasher::default()
        };
        assert_eq!(
            delete(&dir.path().join("a.md"), &trasher).unwrap_err(),
            FsError::Io("corbeille indisponible".into())
        );
        assert!(dir.path().join("a.md").exists());
    }

    #[test]
    fn delete_within_trashes_a_relative_path() {
        let dir = vault(&["projet/note.md"]);
        let trasher = FakeTrasher::default();
        delete_within(dir.path(), "projet/note.md", &trasher).unwrap();
        assert_eq!(trasher.calls(), [dir.path().join("projet").join("note.md")]);
        assert!(dir.path().join("projet").join("note.md").exists());
    }

    #[test]
    fn delete_within_refuses_the_root_itself() {
        let dir = vault(&["a.md"]);
        let trasher = FakeTrasher::default();
        for rel in ["", ".", "a/..", "./"] {
            assert_eq!(
                delete_within(dir.path(), rel, &trasher).unwrap_err(),
                FsError::Escape,
                "{rel} should be refused"
            );
        }
        assert!(trasher.calls().is_empty());
    }

    #[test]
    fn delete_within_refuses_to_escape_the_root() {
        let dir = vault(&["a.md"]);
        let trasher = FakeTrasher::default();
        assert_eq!(
            delete_within(dir.path(), "../a.md", &trasher).unwrap_err(),
            FsError::Escape
        );
        assert!(trasher.calls().is_empty());
    }

    #[test]
    fn system_trasher_moves_a_note_to_the_trash() {
        let dir = vault(&["a.md"]);
        let path = dir.path().join("a.md");
        let data_home = dir.path().join("xdg-data");
        let home = dir.path().join("xdg-home");
        fs::create_dir_all(&data_home).unwrap();
        fs::create_dir_all(&home).unwrap();

        // The freedesktop trash lives under `$XDG_DATA_HOME`, which is pointed at
        // the temporary directory so the test never touches the real one.
        let previous_data = std::env::var_os("XDG_DATA_HOME");
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("XDG_DATA_HOME", &data_home);
        std::env::set_var("HOME", &home);

        let result = SystemTrasher.trash(&path);

        match previous_data {
            Some(value) => std::env::set_var("XDG_DATA_HOME", value),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }

        match result {
            Ok(()) => {
                assert!(!path.exists(), "the note is still on disk");
                let trash = data_home.join("Trash").join("files");
                assert!(
                    trash.join("a.md").exists(),
                    "the note is not in the trash directory"
                );
            }
            Err(err) => {
                // Some sandboxes have no usable trash at all; the delegation
                // itself is still verified by the error type.
                eprintln!("trash unavailable in this environment: {err}");
                assert!(matches!(err, FsError::Io(_)));
                assert!(path.exists());
            }
        }
    }

    // --- helpers -----------------------------------------------------------

    #[test]
    fn temporary_path_is_dotted_and_lives_beside_the_target() {
        let got = temporary_path(Path::new("/vault/projet/note.md"));
        assert_eq!(got, Path::new("/vault/projet/.note.md.wd-tmp"));
    }

    #[test]
    fn normalise_newlines_only_touches_crlf() {
        assert_eq!(normalise_newlines("a\r\nb\rc\nd"), "a\nb\rc\nd");
        assert_eq!(normalise_newlines("aucun"), "aucun");
    }

    #[test]
    fn title_without_extension_removes_only_a_matching_suffix() {
        assert_eq!(title_without_extension("note.md", "md"), "note");
        assert_eq!(title_without_extension("NOTE.MD", "md"), "NOTE");
        assert_eq!(title_without_extension("note.txt", "md"), "note.txt");
        assert_eq!(title_without_extension("md", "md"), "md");
        assert_eq!(title_without_extension("autre", ""), "autre");
    }

    #[test]
    fn is_note_accepts_both_extensions_in_any_case() {
        assert!(is_note("a.md"));
        assert!(is_note("a.MD"));
        assert!(is_note("a.txt"));
        assert!(!is_note("a.png"));
        assert!(!is_note(".md"));
        assert!(!is_note("a.md.bak"));
    }

    #[test]
    fn millis_never_panics_on_a_pre_epoch_time() {
        let before_epoch = UNIX_EPOCH - Duration::from_secs(60);
        assert_eq!(millis(before_epoch), 0);
    }
}
