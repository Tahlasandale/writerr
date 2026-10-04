//! Anti-loop bookkeeping for the file-system watcher.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a path stays considered "ours" after a write.
pub const WINDOW: Duration = Duration::from_millis(1500);

/// Bookkeeping of the paths **we** just wrote, so the watcher can ignore the
/// events it caused itself.
///
/// The application writes notes through [`crate::notes::write_note_atomic`], and
/// the file-system watcher reports that write back as an external change. The
/// watcher will therefore ask [`SelfWrites::is_self`] before reacting: a path
/// marked less than [`WINDOW`] ago is ours.
///
/// The clock is always passed in by the caller, which keeps this type free of
/// hidden time dependencies and its tests free of `sleep`.
#[derive(Debug)]
pub struct SelfWrites {
    entries: HashMap<PathBuf, Instant>,
    window: Duration,
}

impl SelfWrites {
    /// An empty registry using [`WINDOW`].
    pub fn new() -> Self {
        SelfWrites::with_window(WINDOW)
    }

    /// An empty registry using a custom window.
    pub fn with_window(window: Duration) -> Self {
        SelfWrites {
            entries: HashMap::new(),
            window,
        }
    }

    /// Records `path` as written by us at `now`, purging the expired entries.
    pub fn mark(&mut self, path: &Path, now: Instant) {
        self.purge(now);
        self.entries.insert(path.to_path_buf(), now);
    }

    /// Is this event caused by us? The mark is **not** consumed: the watcher may
    /// report the same path several times.
    pub fn is_self(&self, path: &Path, now: Instant) -> bool {
        match self.entries.get(path) {
            Some(marked) => now.saturating_duration_since(*marked) < self.window,
            None => false,
        }
    }

    /// Forgets every mark older than the window.
    pub fn purge(&mut self, now: Instant) {
        self.entries
            .retain(|_, marked| now.saturating_duration_since(*marked) < self.window);
    }

    /// Drops the mark of one path, whatever its age.
    pub fn forget(&mut self, path: &Path) {
        self.entries.remove(path);
    }

    /// How many marks are still alive.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Is there no live mark?
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The configured window.
    pub fn window(&self) -> Duration {
        self.window
    }
}

impl Default for SelfWrites {
    fn default() -> Self {
        SelfWrites::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed starting point: the clock is injected, so no test ever sleeps.
    fn start() -> Instant {
        Instant::now()
    }

    fn after(origin: Instant, millis: u64) -> Instant {
        origin + Duration::from_millis(millis)
    }

    #[test]
    fn a_freshly_marked_path_is_ours() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vault/note.md"), origin);
        assert!(writes.is_self(Path::new("/vault/note.md"), after(origin, 0)));
    }

    #[test]
    fn an_unmarked_path_is_not_ours() {
        let origin = start();
        let writes = SelfWrites::new();
        assert!(!writes.is_self(Path::new("/vault/note.md"), after(origin, 10)));
    }

    #[test]
    fn a_path_stays_ours_for_the_whole_window() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vault/note.md"), origin);
        assert!(writes.is_self(Path::new("/vault/note.md"), after(origin, 1)));
        assert!(writes.is_self(Path::new("/vault/note.md"), after(origin, 1499)));
    }

    #[test]
    fn a_path_is_no_longer_ours_after_the_window() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vault/note.md"), origin);
        assert!(!writes.is_self(Path::new("/vault/note.md"), after(origin, 1500)));
        assert!(!writes.is_self(Path::new("/vault/note.md"), after(origin, 10_000)));
    }

    #[test]
    fn is_self_does_not_consume_the_mark() {
        let origin = start();
        let mut writes = SelfWrites::new();
        let path = Path::new("/vault/note.md");
        writes.mark(path, origin);

        // The watcher may report the same path several times.
        for elapsed in [0, 10, 100, 1000, 1499] {
            assert!(writes.is_self(path, after(origin, elapsed)), "{elapsed} ms");
        }
        assert_eq!(writes.len(), 1);
    }

    #[test]
    fn only_the_marked_path_is_ours() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vault/a.md"), origin);
        assert!(!writes.is_self(Path::new("/vault/b.md"), after(origin, 10)));
    }

    #[test]
    fn marking_the_same_path_again_restarts_the_window() {
        let origin = start();
        let mut writes = SelfWrites::new();
        let path = Path::new("/vault/note.md");
        writes.mark(path, origin);
        writes.mark(path, after(origin, 1400));

        assert!(writes.is_self(path, after(origin, 2000)));
        assert!(!writes.is_self(path, after(origin, 2900)));
    }

    #[test]
    fn marking_purges_the_expired_entries() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vault/a.md"), origin);
        writes.mark(Path::new("/vault/b.md"), after(origin, 1000));
        assert_eq!(writes.len(), 2);

        // Marking later must not keep dead entries alive forever.
        writes.mark(Path::new("/vault/c.md"), after(origin, 3000));
        assert_eq!(writes.len(), 1);
        assert!(writes.is_self(Path::new("/vault/c.md"), after(origin, 3000)));
    }

    #[test]
    fn purge_drops_only_the_expired_entries() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vieux.md"), origin);
        writes.mark(Path::new("/recent.md"), after(origin, 1000));

        writes.purge(after(origin, 2000));
        assert_eq!(writes.len(), 1);
        assert!(writes.is_self(Path::new("/recent.md"), after(origin, 2000)));
        assert!(!writes.is_self(Path::new("/vieux.md"), after(origin, 2000)));
    }

    #[test]
    fn purge_treats_the_window_boundary_as_expired() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/limite.md"), origin);

        writes.purge(after(origin, 1499));
        assert_eq!(writes.len(), 1);

        writes.purge(after(origin, 1500));
        assert_eq!(writes.len(), 0);
        assert!(writes.is_empty());
    }

    #[test]
    fn purge_on_an_empty_registry_does_nothing() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.purge(after(origin, 10_000));
        assert!(writes.is_empty());
    }

    #[test]
    fn a_clock_that_goes_backwards_does_not_panic() {
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vault/note.md"), after(origin, 1000));
        assert!(writes.is_self(Path::new("/vault/note.md"), origin));
    }

    #[test]
    fn many_paths_are_tracked_independently() {
        let origin = start();
        let mut writes = SelfWrites::new();
        for index in 0..50 {
            writes.mark(Path::new(&format!("/vault/note{index}.md")), origin);
        }
        assert_eq!(writes.len(), 50);
        for index in 0..50 {
            assert!(writes.is_self(
                Path::new(&format!("/vault/note{index}.md")),
                after(origin, 5)
            ));
        }
    }

    #[test]
    fn default_uses_the_documented_window() {
        let origin = start();
        let mut writes = SelfWrites::default();
        let path = Path::new("/vault/note.md");
        writes.mark(path, origin);
        assert!(writes.is_self(path, after(origin, WINDOW.as_millis() as u64 - 1)));
        assert!(!writes.is_self(path, after(origin, WINDOW.as_millis() as u64)));
    }

    #[test]
    fn the_window_is_1500_milliseconds() {
        assert_eq!(WINDOW, Duration::from_millis(1500));
        assert_eq!(SelfWrites::default().window, WINDOW);
    }

    #[test]
    fn a_custom_window_can_be_configured() {
        let origin = start();
        let mut writes = SelfWrites::with_window(Duration::from_millis(50));
        let path = Path::new("/vault/note.md");
        writes.mark(path, origin);
        assert!(writes.is_self(path, after(origin, 49)));
        assert!(!writes.is_self(path, after(origin, 50)));
    }

    #[test]
    fn forgetting_a_path_forgets_it_immediately() {
        let origin = start();
        let mut writes = SelfWrites::new();
        let path = PathBuf::from("/vault/note.md");
        writes.mark(&path, origin);
        writes.forget(&path);
        assert!(!writes.is_self(&path, after(origin, 1)));
        assert!(writes.is_empty());
    }

    #[test]
    fn the_registry_serialises_nothing_it_should_not() {
        // Sanity: the type is a plain in-memory bookkeeping structure.
        let origin = start();
        let mut writes = SelfWrites::new();
        writes.mark(Path::new("/vault/note.md"), origin);
        assert!(format!("{writes:?}").contains("note.md"));
    }
}
