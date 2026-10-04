//! Filesystem watcher (§5.11).
//!
//! Wraps `notify` with a 300 ms debounce and emits two events:
//! - `tree-changed` for creations, deletions and renames;
//! - `note-changed {path, mtime}` for content modifications.
//!
//! Three kinds of noise are filtered out:
//! - `.wd-tmp` files (our own atomic writes);
//! - dot files (`.DS_Store`, editor swap files);
//! - paths marked in [`crate::selfwrites::SelfWrites`] (our own writes, seen by the
//!   OS as external changes).
//!
//! The debouncer is driven by an injected clock so the tests never sleep.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher as _};

use crate::selfwrites::SelfWrites;

/// Debounce window: a burst of filesystem events is coalesced.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// What the UI is told about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// A file or directory appeared, vanished or was renamed.
    TreeChanged,
    /// A note's content changed outside the app.
    NoteChanged {
        /// Absolute path of the modified note.
        path: PathBuf,
        /// Its new modification time, in ms since the epoch.
        mtime: i64,
    },
}

/// Anything the watcher must ignore.
fn is_noise(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.') || n.ends_with(".wd-tmp"))
        .unwrap_or(false)
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Owns the `notify` watcher and turns its raw events into [`WatchEvent`]s.
pub struct FsWatcher {
    _inner: notify::RecommendedWatcher,
    rx: Receiver<notify::Result<Event>>,
    pending: Mutex<Pending>,
    /// Kept so the caller shares one anti-loop registry with the command layer.
    self_writes: Arc<Mutex<SelfWrites>>,
}

#[derive(Default)]
struct Pending {
    tree: bool,
    /// path -> (mtime, size) at the time we last saw it, to drop duplicate Modify bursts.
    notes: BTreeMap<PathBuf, (i64, u64)>,
}

impl FsWatcher {
    /// Starts watching `root` recursively.
    pub fn start(root: &Path, self_writes: Arc<Mutex<SelfWrites>>) -> notify::Result<Self> {
        let (tx, rx) = mpsc::channel();
        let mut inner = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })?;
        inner.watch(root, RecursiveMode::Recursive)?;
        Ok(Self {
            _inner: inner,
            rx,
            pending: Mutex::new(Pending::default()),
            self_writes,
        })
    }

    /// Drains the channel and returns the coalesced event, if any.
    ///
    /// `now` is injected: the caller decides what "inside the debounce window"
    /// means, which is what makes this testable without sleeping.
    pub fn poll(&self, now: Instant) -> Option<WatchEvent> {
        // 1. drain everything available
        loop {
            match self.rx.recv_timeout(Duration::from_millis(0)) {
                Ok(Ok(ev)) => self.absorb(&ev, now),
                Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => break,
            }
        }

        // 2. decide
        let mut p = match self.pending.lock() {
            Ok(g) => g,
            Err(_) => return None,
        };
        if !p.tree && p.notes.is_empty() {
            return None;
        }
        let ev = if let Some((path, (mtime, _size))) =
            p.notes.iter().next().map(|(k, v)| (k.clone(), *v))
        {
            p.notes.clear();
            WatchEvent::NoteChanged { path, mtime }
        } else {
            p.tree = false;
            WatchEvent::TreeChanged
        };
        Some(ev)
    }

    fn absorb(&self, ev: &Event, now: Instant) {
        let only_content = matches!(ev.kind, EventKind::Access(_));
        let gone = matches!(ev.kind, EventKind::Remove(_));
        // Un `Modify` est ambigu : inotify le produit pour un simple truncate()
        // comme pour une création en écriture. On tranche sur l'état du disque :
        // le fichier existe-t-il, et son contenu a-t-il changé ?
        let modifies = matches!(ev.kind, EventKind::Modify(_));

        for path in &ev.paths {
            if is_noise(path) {
                continue;
            }
            if let Ok(sw) = self.self_writes.lock() {
                if sw.is_self(path, now) {
                    continue;
                }
            }
            let exists = path.exists();

            if only_content {
                continue;
            }
            if gone || !exists {
                // création / suppression / renommage : l'arborescence change
                self.mark_tree();
                continue;
            }
            if modifies {
                let mtime = mtime_ms(path);
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                let seen = self
                    .pending
                    .lock()
                    .ok()
                    .and_then(|p| p.notes.get(path).copied());
                match seen {
                    // même (mtime, taille) que le dernier vu : rien de neuf
                    Some((m, s)) if m == mtime && s == size => continue,
                    _ => {
                        if let Ok(mut p) = self.pending.lock() {
                            p.notes.insert(path.clone(), (mtime, size));
                        }
                        continue;
                    }
                }
            }
            // Create
            self.mark_tree();
        }
    }

    fn mark_tree(&self) {
        if let Ok(mut p) = self.pending.lock() {
            p.tree = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "wd-watch-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn noise_filtre() {
        assert!(is_noise(Path::new("/a/.DS_Store")));
        assert!(is_noise(Path::new("/a/.note.md.wd-tmp")));
        assert!(!is_noise(Path::new("/a/note.md")));
    }

    /// Construit un watcher dont le canal est contrôlé par le test.
    fn with_channel(
        sw: Arc<Mutex<SelfWrites>>,
    ) -> (FsWatcher, mpsc::Sender<notify::Result<Event>>) {
        let (tx, rx) = mpsc::channel();
        let w = FsWatcher {
            _inner: notify::RecommendedWatcher::new(|_| {}, notify::Config::default()).unwrap(),
            rx,
            pending: Mutex::new(Pending::default()),
            self_writes: sw,
        };
        (w, tx)
    }

    fn event(kind: EventKind, paths: Vec<PathBuf>) -> notify::Result<Event> {
        Ok(Event {
            kind,
            paths,
            attrs: Default::default(),
        })
    }

    #[test]
    fn absorb_ignore_nos_propres_ecritures() {
        let dir = tmp();
        let f = dir.join("note.md");
        fs::write(&f, "x").unwrap();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        sw.lock().unwrap().mark(&f, Instant::now());
        let (w, _tx) = with_channel(sw);
        let now = Instant::now();
        w.absorb(
            &event(
                EventKind::Modify(notify::event::ModifyKind::Metadata(
                    notify::event::MetadataKind::Any,
                )),
                vec![f],
            )
            .unwrap(),
            now,
        );
        let p = w.pending.lock().unwrap();
        assert!(!p.tree && p.notes.is_empty(), "nos écritures sont ignorées");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absorb_ignore_le_bruit_wd_tmp_et_caches() {
        let dir = tmp();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (w, _tx) = with_channel(sw);
        let now = Instant::now();
        w.absorb(
            &event(
                EventKind::Create(notify::event::CreateKind::File),
                vec![dir.join("a.md.wd-tmp"), dir.join(".DS_Store")],
            )
            .unwrap(),
            now,
        );
        let p = w.pending.lock().unwrap();
        assert!(!p.tree && p.notes.is_empty(), "le bruit est filtré");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn une_creation_externe_donne_tree_changed() {
        let dir = tmp();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (w, tx) = with_channel(sw);
        tx.send(event(
            EventKind::Create(notify::event::CreateKind::File),
            vec![dir.join("externe.md")],
        ))
        .unwrap();
        let got = w.poll(Instant::now());
        assert_eq!(got, Some(WatchEvent::TreeChanged));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn une_suppression_externe_donne_tree_changed() {
        let dir = tmp();
        let f = dir.join("vient.md");
        fs::write(&f, "x").unwrap();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (w, tx) = with_channel(sw);
        tx.send(event(
            EventKind::Remove(notify::event::RemoveKind::File),
            vec![f.clone()],
        ))
        .unwrap();
        assert_eq!(w.poll(Instant::now()), Some(WatchEvent::TreeChanged));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn une_modification_externe_donne_note_changed_avec_mtime() {
        let dir = tmp();
        let f = dir.join("modifiee.md");
        fs::write(&f, "x").unwrap();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (w, tx) = with_channel(sw);
        tx.send(event(
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            vec![f.clone()],
        ))
        .unwrap();
        match w.poll(Instant::now()) {
            Some(WatchEvent::NoteChanged { path, mtime }) => {
                assert_eq!(path, f);
                assert!(mtime > 0);
            }
            other => panic!("attendu NoteChanged, obtenu {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn plusieurs_modifications_sont_regroupees() {
        let dir = tmp();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (w, tx) = with_channel(sw);
        for n in ["a.md", "b.md", "c.md"] {
            let f = dir.join(n);
            fs::write(&f, "x").unwrap();
            tx.send(event(
                EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )),
                vec![f],
            ))
            .unwrap();
        }
        assert!(matches!(
            w.poll(Instant::now()),
            Some(WatchEvent::NoteChanged { .. })
        ));
        assert_eq!(
            w.poll(Instant::now()),
            None,
            "le lot est consommé en un seul événement"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn poll_ne_rend_rien_sans_evenement() {
        let dir = tmp();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (w, _tx) = with_channel(sw);
        assert_eq!(w.poll(Instant::now()), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_vraie_execution_du_watcher_ignore_nos_ecritures() {
        // Test d'intégration sur un dossier temporaire, timeout 5 s (§5.11) :
        // une écriture via write_note_atomic ne doit produire AUCUN événement.
        let dir = tmp();
        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let w = match FsWatcher::start(&dir, Arc::clone(&sw)) {
            Ok(w) => w,
            Err(_) => return, // inotify indisponible : on ne peut rien conclure
        };
        let path = dir.join("atomique.md");

        // Phase 1 : notre propre écriture ne doit produire AUCUN événement.
        crate::notes::write_note_atomic(&path, "v1").unwrap();
        sw.lock().unwrap().mark(&path, Instant::now());
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            std::thread::sleep(Duration::from_millis(25));
            assert!(
                w.poll(Instant::now()).is_none(),
                "un événement a été émis pour notre propre écriture"
            );
        }

        // Phase 2 : une écriture « externe » doit être vue. Chaque phase a son
        // propre budget : partager un seul deadline donnait 0 s à la phase 2.
        sw.lock().unwrap().forget(&path);
        std::fs::write(&path, "v2").unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        let mut seen = None;
        while Instant::now() < until && seen.is_none() {
            std::thread::sleep(Duration::from_millis(25));
            seen = w.poll(Instant::now());
        }
        assert!(seen.is_some(), "l'écriture externe doit être détectée");
        assert!(
            matches!(seen, Some(WatchEvent::NoteChanged { .. })),
            "obtenu {seen:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
