// Tests d'intégration des commandes (§5.11) : toute commande qui prend un chemin
// passe par paths::resolve, refuse un chemin hors racine et n'a aucun effet disque ;
// `open_external` n'accepte que `https://github.com/…`.
//
// Ces tests n'utilisent PAS le runtime Tauri : les commandes sont des fonctions
// pures sur un contexte injectable, donc testables sans GTK/WebKit.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use writer_deck::commands::{self, Ctx};
use writer_deck::notes::{self, Trasher, TreeNode};
use writer_deck::FsError;

/// Déballe `Ok<T>` : les tests portent sur le payload utile, pas sur l'enveloppe
/// d'invocation (celle-ci est vérifiée dans `envelope_is_json_shaped`).
fn data<T>(r: commands::Ok_<T>) -> T {
    r.data.expect("payload attendu")
}

fn err_code(e: commands::Err_) -> String {
    e.code
}

/// Enregistre les appels à la corbeille au lieu de supprimer.
#[derive(Default)]
struct FakeTrasher {
    trashed: Mutex<Vec<PathBuf>>,
}

impl Trasher for FakeTrasher {
    fn trash(&self, path: &Path) -> Result<(), FsError> {
        self.trashed.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

/// Un dossier temporaire et une racine de notes dedans.
struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Env {
    /// Un fichier placé juste à côté de la racine : ne doit jamais être touché.
    fn outside(&self) -> PathBuf {
        self._dir.path().join("secret.md")
    }
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("notes");
    std::fs::create_dir_all(&root).unwrap();
    Env { _dir: dir, root }
}

fn ctx<'a>(e: &'a Env, trasher: &'a dyn Trasher) -> Ctx<'a> {
    Ctx {
        root: Some(e.root.clone()),
        config: Mutex::new(Default::default()),
        self_writes: Mutex::new(Default::default()),
        open_urls: Mutex::new(BTreeMap::new()),
        trasher,
    }
}

#[test]
fn envelope_is_json_shaped() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let ok = serde_json::to_value(commands::app_version(&c)).unwrap();
    assert_eq!(ok["ok"], serde_json::json!(true));
    assert_eq!(ok["data"], serde_json::json!("0.1.0"));
    let err = commands::list_tree(&Ctx {
        root: None,
        ..ctx(&e, &t)
    })
    .unwrap_err();
    assert!(!err.ok);
    assert!(!err.message.is_empty(), "message utilisateur non vide");
    assert_eq!(err_code(err), "no_root");
}

#[test]
fn list_tree_needs_a_root() {
    let e = env();
    let t = FakeTrasher::default();
    let mut c = ctx(&e, &t);
    c.root = None;
    let err = commands::list_tree(&c).unwrap_err();
    assert_eq!(err_code(err), "no_root");
}

#[test]
fn list_tree_only_lists_md_and_txt() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    notes::write_note_atomic(&e.root.join("a.md"), "a").unwrap();
    notes::write_note_atomic(&e.root.join("b.txt"), "b").unwrap();
    notes::write_note_atomic(&e.root.join("c.markdown"), "c").unwrap();
    std::fs::write(e.root.join(".cache.md"), "cache").unwrap();
    let tree = data(commands::list_tree(&c).unwrap());
    let names: Vec<&str> = tree.iter().map(|n: &TreeNode| n.name.as_str()).collect();
    assert_eq!(names, ["a.md", "b.txt"], "ni .markdown ni les cachés");
}

#[test]
fn create_then_read_rename_delete() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let created = data(commands::create_note(&c, "", "Ma note").unwrap());
    assert_eq!(created.id, "Ma note.md", "id = chemin relatif (I6)");
    assert_eq!(
        data(commands::read_note(&c, &created.id).unwrap()).content,
        ""
    );

    commands::write_note(&c, &created.id, "# Contenu").unwrap();
    let read = data(commands::read_note(&c, &created.id).unwrap());
    assert_eq!(read.content, "# Contenu");
    assert!(read.mtime > 0);

    let renamed = data(commands::rename(&c, &created.id, "Autre titre").unwrap());
    assert_eq!(
        renamed.id, "Autre titre.md",
        "extension et dossier conservés"
    );
    assert_eq!(
        data(commands::read_note(&c, &renamed.id).unwrap()).content,
        "# Contenu",
        "le contenu survit au renommage"
    );

    commands::delete(&c, &renamed.id).unwrap();
    assert!(
        e.root.join("Autre titre.md").exists(),
        "la corbeille ne supprime pas"
    );
    assert_eq!(t.trashed.lock().unwrap().len(), 1);
}

#[test]
fn title_collision_gets_a_suffix() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let a = data(commands::create_note(&c, "", "Note").unwrap());
    let b = data(commands::create_note(&c, "", "Note").unwrap());
    assert_eq!(a.id, "Note.md");
    assert_eq!(b.id, "Note (2).md");
}

#[test]
fn create_dir_nested_and_unique() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let d1 = data(commands::create_dir(&c, "Projet").unwrap());
    assert_eq!(d1.id, "Projet");
    let d2 = data(commands::create_dir(&c, "Projet").unwrap());
    assert_eq!(d2.id, "Projet (2)");
    let sub = data(commands::create_dir(&c, "Projet/Sous").unwrap());
    assert_eq!(sub.id, "Projet/Sous");
    let n = data(commands::create_note(&c, "Projet/Sous", "Note").unwrap());
    assert_eq!(n.id, "Projet/Sous/Note.md", "id = chemin relatif avec /");
    assert!(e.root.join("Projet/Sous/Note.md").exists());
}

#[test]
fn a_path_outside_the_root_is_refused_without_disk_effect() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let outside = e.outside();
    std::fs::write(&outside, "ne pas toucher").unwrap();

    // Chemins qui ne peuvent pas désigner une note : tous doivent être refusés.
    //
    // Cas particuliers assumés :
    // - `""` = la racine : ACCEPTÉ par create_note/create_dir (créer à la racine),
    //   refusé par read/write/rename/delete (un dossier n'est pas une note).
    // - `"."` et `"Projet/.."` : la racine, donc refusés partout.
    // On exige « refusée » sans imposer le code (`io` vs `escape` selon que le chemin
    // désigne un dossier existant) ; la distinction fine est couverte par paths.rs.
    let refuses = |c: &Ctx<'_>, bad: &str| -> bool {
        [
            commands::read_note(c, bad).err(),
            commands::write_note(c, bad, "x").err(),
            commands::delete(c, bad).err(),
            commands::rename(c, bad, "x").err(),
        ]
        .into_iter()
        .all(|r| r.is_some())
    };

    for bad in [
        "../secret.md",
        "Projet/../../secret.md",
        "/etc/passwd",
        ".",
        "Projet/..",
        "Projet/Sous/../../../../etc/passwd",
    ] {
        assert!(refuses(&c, bad), "{bad:?} doit être refusé partout");
        assert_eq!(
            err_code(commands::create_dir(&c, bad).unwrap_err()),
            "escape",
            "create_dir({bad:?})"
        );
        assert!(
            commands::create_note(&c, bad, "x").is_err(),
            "create_note({bad:?})"
        );
    }

    // `""` : create_note l'accepte (créer une note à la racine) ; tout le reste refuse
    assert!(refuses(&c, ""));
    assert_eq!(
        err_code(commands::create_dir(&c, "").unwrap_err()),
        "escape",
        "un dossier ne peut pas porter le nom du coffre"
    );
    let at_root = data(commands::create_note(&c, "", "A la racine").unwrap());
    assert_eq!(at_root.id, "A la racine.md");

    // Et les traversées de répertoire, elles, sont bien classées « escape ».
    for bad in ["../secret.md", "Projet/../../secret.md"] {
        assert_eq!(
            err_code(commands::read_note(&c, bad).unwrap_err()),
            "escape"
        );
        assert_eq!(
            err_code(commands::write_note(&c, bad, "x").unwrap_err()),
            "escape"
        );
        assert_eq!(err_code(commands::delete(&c, bad).unwrap_err()), "escape");
    }
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "ne pas toucher",
        "aucun effet disque"
    );
    assert!(
        t.trashed.lock().unwrap().is_empty(),
        "rien mis à la corbeille"
    );
}

#[test]
fn the_root_itself_is_protected() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let err = commands::delete(&c, ".").unwrap_err();
    assert_eq!(err_code(err), "escape");
    assert!(e.root.exists());
    assert!(t.trashed.lock().unwrap().is_empty());
}

#[test]
fn open_external_only_accepts_github_over_https() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let good = "https://github.com/Tahlasandale/writerr/releases/latest";
    assert_eq!(data(commands::open_external(&c, good).unwrap()), good);
    for bad in [
        "http://github.com/x/y",
        "https://gitlab.com/x/y",
        "https://github.com.evil.com/x",
        "https://github.com/../x",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<script>",
        "",
    ] {
        let err = commands::open_external(&c, bad).unwrap_err();
        assert!(!err.ok, "{bad:?} doit être refusé");
    }
    assert_eq!(
        c.open_urls.lock().unwrap().len(),
        1,
        "seule l'URL valide est transmise"
    );
}

#[test]
fn config_defaults_then_persists() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let cfg = data(commands::get_config(&c).unwrap());
    assert_eq!(cfg.idle_ms, 6000, "défaut de la spec");
    commands::set_config(&c, cfg.clone()).unwrap();
    assert_eq!(data(commands::get_config(&c).unwrap()).idle_ms, 6000);
}

#[test]
fn atomic_write_leaves_no_temporary_file() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let created = data(commands::create_note(&c, "", "Atomique").unwrap());
    commands::write_note(&c, &created.id, "v1").unwrap();
    commands::write_note(&c, &created.id, "v2").unwrap();
    let leftovers: Vec<String> = std::fs::read_dir(&e.root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|d| d.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("wd-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "aucun .wd-tmp : {leftovers:?}");
    assert_eq!(
        data(commands::read_note(&c, &created.id).unwrap()).content,
        "v2"
    );
}

#[test]
fn mtime_changes_on_write() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let created = data(commands::create_note(&c, "", "Horodatage").unwrap());
    let a = data(commands::read_note(&c, &created.id).unwrap()).mtime;
    std::thread::sleep(std::time::Duration::from_millis(20));
    let w = data(commands::write_note(&c, &created.id, "contenu").unwrap());
    assert!(w.mtime > a, "mtime strictement croissant");
    assert_eq!(
        data(commands::read_note(&c, &created.id).unwrap()).mtime,
        w.mtime
    );
}

#[test]
fn a_write_is_marked_as_our_own() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let created = data(commands::create_note(&c, "", "AntiBoucle").unwrap());
    let now = std::time::Instant::now();
    commands::write_note(&c, &created.id, "x").unwrap();
    assert!(
        c.self_writes
            .lock()
            .unwrap()
            .is_self(&e.root.join(&created.id), now),
        "le watcher doit pouvoir ignorer notre écriture"
    );
}

#[test]
fn app_version_is_exposed() {
    let e = env();
    let t = FakeTrasher::default();
    let c = ctx(&e, &t);
    let v = data(commands::app_version(&c));
    assert_eq!(v, env!("CARGO_PKG_VERSION"));
    assert_eq!(v, "0.1.0", "cohérent avec package.json (spec §5.6)");
}

#[test]
fn pick_root_refuses_a_cancellation() {
    let e = env();
    let t = FakeTrasher::default();
    let mut c = ctx(&e, &t);
    let err = commands::pick_root(&mut c, None).unwrap_err();
    assert_eq!(err_code(err), "no_root");
}

#[test]
fn pick_root_then_set_root_round_trip() {
    let e = env();
    let t = FakeTrasher::default();
    let mut c = ctx(&e, &t);
    c.root = None;
    let picked = data(commands::pick_root(&mut c, Some(e.root.clone())).unwrap());
    assert_eq!(picked, e.root);
    // les commandes fonctionnent une fois la racine choisie
    let created = data(commands::create_note(&c, "", "Après choix").unwrap());
    assert_eq!(created.id, "Après choix.md");
    let _ = commands::set_root(&mut c, None).unwrap_err();
    assert!(c.root.is_none());
}

#[test]
fn a_root_that_is_not_a_directory_is_refused() {
    let e = env();
    let t = FakeTrasher::default();
    let mut c = ctx(&e, &t);
    let file = e.root.join("pas-un-dossier.md");
    std::fs::write(&file, "x").unwrap();
    let err = commands::pick_root(&mut c, Some(file)).unwrap_err();
    assert_eq!(err_code(err), "not_found");
}
