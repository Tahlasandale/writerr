//! Integration tests: the public API of `writer_deck` used the way the Tauri
//! command layer will use it.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tempfile::TempDir;

use writer_deck::config::{self, Config, Sort};
use writer_deck::names;
use writer_deck::notes::{self, Trasher};
use writer_deck::paths;
use writer_deck::selfwrites::SelfWrites;
use writer_deck::FsError;

/// Records the calls instead of trashing: proves the note is recoverable.
#[derive(Default)]
struct RecordingTrasher {
    calls: RefCell<Vec<PathBuf>>,
}

impl RecordingTrasher {
    fn calls(&self) -> Vec<PathBuf> {
        self.calls.borrow().clone()
    }
}

impl Trasher for RecordingTrasher {
    fn trash(&self, path: &Path) -> Result<(), FsError> {
        self.calls.borrow_mut().push(path.to_path_buf());
        Ok(())
    }
}

/// A vault with a small realistic tree.
fn sample_vault() -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("projet").join("chapters")).unwrap();
    fs::write(root.join("accueil.md"), "# Accueil\n").unwrap();
    fs::write(root.join("liste.txt"), "- un\n- deux\n").unwrap();
    fs::write(root.join("projet").join("chapters").join("01.md"), "# Un\n").unwrap();
    fs::write(root.join("projet").join("plan.md"), "plan\n").unwrap();
    fs::write(root.join("projet").join("image.png"), b"\x89PNG").unwrap();
    fs::create_dir_all(root.join("vide")).unwrap();
    dir
}

#[test]
fn a_note_can_be_created_read_renamed_and_deleted() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    // Create.
    let created = notes::create_note(root, "Première note").unwrap();
    assert_eq!(created, root.join("Première note.md"));
    assert_eq!(notes::read_note(&created).unwrap(), "");

    // Write and read back, through the sandbox.
    notes::write_note_atomic(&created, "Bonjour 🐘\n").unwrap();
    let resolved = paths::resolve(root, "Première note.md").unwrap();
    assert_eq!(notes::read_note(&resolved).unwrap(), "Bonjour 🐘\n");

    // Rename.
    let renamed = notes::rename(&created, "Seconde note").unwrap();
    assert_eq!(renamed, root.join("Seconde note.md"));
    assert_eq!(notes::read_note(&renamed).unwrap(), "Bonjour 🐘\n");
    assert!(!created.exists());

    // List.
    let tree = notes::list_tree(root).unwrap();
    assert_eq!(tree.len(), 1);
    assert_eq!(tree[0].name, "Seconde note.md");
    assert!(!tree[0].is_dir);

    // Delete: the file is still there, the trash just received the call.
    let trasher = RecordingTrasher::default();
    notes::delete_within(root, "Seconde note.md", &trasher).unwrap();
    assert_eq!(trasher.calls(), vec![renamed.clone()]);
    assert!(renamed.exists(), "delete must never unlink the note");
}

#[test]
fn the_whole_tree_is_listed_sorted_and_serialisable() {
    let dir = sample_vault();
    let tree = notes::list_tree(dir.path()).unwrap();

    let top: Vec<&str> = tree.iter().map(|node| node.name.as_str()).collect();
    assert_eq!(top, ["accueil.md", "liste.txt", "projet", "vide"]);

    let projet = tree.iter().find(|node| node.name == "projet").unwrap();
    let chapters: Vec<&str> = projet
        .children
        .iter()
        .map(|node| node.name.as_str())
        .collect();
    assert_eq!(chapters, ["chapters", "plan.md"]);
    assert_eq!(
        projet.children[0].children[0].name, "01.md",
        "the tree is recursive"
    );

    // The image is filtered out, the empty directory is kept.
    assert!(top.contains(&"vide"));

    // The wire format is valid JSON with numeric timestamps.
    let json = serde_json::to_string(&tree).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed[0]["name"], "accueil.md");
    assert_eq!(parsed[0]["is_dir"], false);
    assert_eq!(parsed[0]["size"], 10);
    assert!(parsed[0]["modified"].as_i64().unwrap() > 1_000_000_000_000);
}

#[test]
fn a_vault_cannot_be_escaped() {
    let dir = sample_vault();
    let root = dir.path();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.md"), "secret").unwrap();

    for payload in ["../secret.md", "projet/../../secret.md", "/etc/passwd", ""] {
        assert_eq!(
            paths::resolve(root, payload).unwrap_err(),
            FsError::Escape,
            "{payload:?} should be refused"
        );
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), root.join("evasion")).unwrap();
        assert_eq!(
            paths::resolve(root, "evasion/secret.md").unwrap_err(),
            FsError::Escape
        );
        // And the traversal does not list it either.
        let tree = notes::list_tree(root).unwrap();
        let listed: Vec<&str> = tree.iter().map(|node| node.name.as_str()).collect();
        assert!(!listed.contains(&"evasion"));
    }
}

#[test]
fn titles_with_accents_and_separators_survive_the_whole_trip() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    let path = notes::create_note(root, "Été: 2026 / épaule").unwrap();
    assert_eq!(path, root.join("Été 2026 épaule.md"));
    notes::write_note_atomic(&path, "Éléphant 🐘\n日本語\n").unwrap();

    let tree = notes::list_tree(root).unwrap();
    assert_eq!(tree[0].name, "Été 2026 épaule.md");
    assert_eq!(tree[0].size, "Éléphant 🐘\n日本語\n".len() as u64);
    assert_eq!(
        notes::read_note(&tree[0].path).unwrap(),
        "Éléphant 🐘\n日本語\n"
    );
}

#[test]
fn colliding_titles_get_a_counter() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    fs::write(root.join("note.md"), "déjà là").unwrap();

    let first = notes::create_note(root, "Note").unwrap();
    let second = notes::create_note(root, "Note").unwrap();
    let third = notes::create_note(root, "note").unwrap();

    assert_eq!(first.file_name().unwrap(), "Note (2).md");
    assert_eq!(second.file_name().unwrap(), "Note (3).md");
    assert_eq!(third.file_name().unwrap(), "note (4).md");
    // Nothing was overwritten.
    assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "déjà là");
    for path in [first, second, third] {
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
    }
}

#[test]
fn a_failed_write_never_leaves_a_temporary_file() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    // A directory in the way: the atomic rename cannot succeed.
    let blocked = root.join("bloque.md");
    fs::create_dir(&blocked).unwrap();
    assert!(notes::write_note_atomic(&blocked, "contenu").is_err());

    let entries = fs::read_dir(root)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(entries, ["bloque.md"]);
    assert!(blocked.is_dir());
}

#[test]
fn a_directory_can_be_created_renamed_and_trashed() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    let trasher = RecordingTrasher::default();

    let created = notes::create_dir(root, "projet/2026").unwrap();
    assert_eq!(created, root.join("projet").join("2026"));

    // A second call with the same name does not clash.
    let again = notes::create_dir(root, "projet/2026").unwrap();
    assert_eq!(again, root.join("projet").join("2026 (2)"));

    let renamed = notes::rename(&created, "Annee 2026").unwrap();
    assert_eq!(renamed, root.join("projet").join("Annee 2026"));
    assert!(renamed.is_dir());

    notes::delete_within(root, "projet/Annee 2026", &trasher).unwrap();
    assert_eq!(trasher.calls(), vec![renamed.clone()]);
    assert!(renamed.is_dir());
    assert!(again.is_dir());
}

#[test]
fn the_vault_root_itself_is_never_trashed() {
    let dir = sample_vault();
    let trasher = RecordingTrasher::default();
    assert_eq!(
        notes::delete_within(dir.path(), ".", &trasher).unwrap_err(),
        FsError::Escape
    );
    assert_eq!(
        notes::delete(Path::new("/"), &trasher).unwrap_err(),
        FsError::Escape
    );
    assert!(trasher.calls().is_empty());
}

#[test]
fn the_configuration_round_trips_and_stays_forward_compatible() {
    let dir = TempDir::new().unwrap();

    let config = Config {
        root: Some("/home/camille/Notes".into()),
        theme: Some("dark".into()),
        idle_ms: 9000,
        sort: Sort::from_parts("name", "asc"),
        last_open: Some("projet/plan.md".into()),
        ..Config::default()
    };
    config::save_to(&config, dir.path()).unwrap();

    let loaded = config::load_from(dir.path());
    assert_eq!(loaded, config);
    assert_eq!(loaded.theme_value(), Some(config::Theme::Dark));

    // A field written by a future version survives our own save.
    let raw = fs::read_to_string(dir.path().join(config::FILE_NAME)).unwrap();
    let mut json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    json["readingWidth"] = serde_json::json!(680);
    fs::write(dir.path().join(config::FILE_NAME), json.to_string()).unwrap();

    let loaded = config::load_from(dir.path());
    assert_eq!(loaded.extra["readingWidth"], 680);
    config::save_to(&loaded, dir.path()).unwrap();

    let raw = fs::read_to_string(dir.path().join(config::FILE_NAME)).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(saved["readingWidth"], 680);
    assert_eq!(saved["root"], "/home/camille/Notes");
}

#[test]
fn a_corrupted_configuration_falls_back_and_is_kept_aside() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join(config::FILE_NAME);
    fs::write(&path, "{ truncated").unwrap();

    let config = config::load_from(dir.path());
    assert_eq!(config, Config::default());
    assert_eq!(config.idle_ms, 6000);

    let backup = dir
        .path()
        .join(format!("{}{}", config::FILE_NAME, config::BACKUP_SUFFIX));
    assert_eq!(fs::read_to_string(backup).unwrap(), "{ truncated");
}

#[test]
fn the_watcher_anti_loop_ignores_our_own_writes() {
    // The sequence a real watcher goes through after `write_note`.
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    let note = root.join("note.md");
    let mut self_writes = SelfWrites::new();
    let origin = Instant::now();

    notes::write_note_atomic(&note, "première version").unwrap();
    self_writes.mark(&note, origin);

    // The watcher fires a few milliseconds later: ours, must be ignored.
    let at = origin + Duration::from_millis(20);
    assert!(self_writes.is_self(&note, at));
    assert!(self_writes.is_self(&note, at));

    // A file touched by somebody else is not ours.
    assert!(!self_writes.is_self(&root.join("autre.md"), at));

    // Long afterwards the mark is stale, and a new write re-arms it.
    let later = origin + Duration::from_millis(2000);
    notes::write_note_atomic(&note, "seconde version").unwrap();
    assert!(!self_writes.is_self(&note, later));
    self_writes.mark(&note, later);
    assert!(self_writes.is_self(&note, later + Duration::from_millis(10)));
    assert_eq!(notes::read_note(&note).unwrap(), "seconde version");
}

#[test]
fn names_helpers_are_reachable_and_consistent() {
    assert_eq!(names::sanitize_file_name("CON"), "CON_");
    assert_eq!(names::sanitize_file_name("  ..a/b..  "), "a b");

    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("note.MD"), "").unwrap();
    assert_eq!(names::unique_name(dir.path(), "Note", "md"), "Note (2).md");

    assert!(names::natural_cmp("note2", "note10").is_lt());
}

#[test]
fn a_large_tree_is_listed_quickly() {
    // Generous bound: the point is to catch an accidental O(n²), not to
    // measure the machine.
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    for index in 0..10_000 {
        fs::write(root.join(format!("note{index:05}.md")), "").unwrap();
    }

    let started = Instant::now();
    let tree = notes::list_tree(root).unwrap();
    let elapsed = started.elapsed();

    assert_eq!(tree.len(), 10_000);
    assert_eq!(tree[0].name, "note00000.md");
    assert_eq!(tree[9_999].name, "note09999.md");
    assert!(
        elapsed < Duration::from_secs(5),
        "listing 10 000 files took {elapsed:?}"
    );
}

#[test]
fn the_crate_never_panics_on_hostile_input() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    let hostile = [
        "",
        ".",
        "..",
        "/",
        "//",
        "a/../..",
        "\0",
        "a\0b",
        "\\",
        "a\\b",
        "con",
        &"x".repeat(5_000),
        &format!("{}/..", "d".repeat(300)),
        "projet/../../..",
    ];

    for payload in hostile {
        // Every one of these must be answered, never a panic.
        let _ = paths::resolve(root, payload);
        let _ = notes::create_note(root, payload);
        let _ = notes::create_dir(root, payload);
        let _ = config::load_from(Path::new(payload));
        assert!(names::sanitize_file_name(payload).len() <= 4 * names::MAX_CHARS);
        assert!(!names::sanitize_file_name(payload).is_empty());
    }
}
