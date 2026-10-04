//! Sandboxed resolution of user supplied relative paths.
//!
//! Every path that comes from the web layer is a *relative* path inside the
//! notes root. [`resolve`] is the single gate that turns such a string into an
//! absolute [`PathBuf`] that is guaranteed to stay inside the root, symlinks
//! included.

use std::path::{Component, Path, PathBuf};

use crate::FsError;

/// Resolves `rel` against `root`, refusing anything that leaves the root.
///
/// Accepted: `a/b.md`, `./a.md`, `a.md`, `a/../a.md`.
/// Refused with [`FsError::Escape`]: an empty path, `.`, a parent segment that
/// would climb out (`../x`, `a/../../x`), an absolute path, a `NUL` byte, a
/// backslash (never a separator here, and a Windows payload must not slip
/// through), and a **symlink** whose target resolves outside the root.
/// The root itself must exist and be a directory, otherwise
/// [`FsError::NotFound`] is returned: an unknown root is a configuration error,
/// never an invitation to create something somewhere else.
///
/// The returned path keeps the spelling the caller used (a symlink inside the
/// root stays a symlink in the result), because that is the path the tree
/// displays; only the containment *check* follows symlinks. Segments that do
/// not exist yet are kept, so the result can be handed to a creating operation.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, FsError> {
    let relative = normalise(rel)?;
    let canonical_root = canonical_dir(root)?;

    let mut current = canonical_root.clone();
    let mut vetting = true;
    for component in relative.components() {
        current.push(component);
        if !vetting {
            continue;
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                // A symlink we cannot resolve cannot be vetted: refuse it.
                let target = current.canonicalize().map_err(|_| FsError::Escape)?;
                if !is_inside(&canonical_root, &target) {
                    return Err(FsError::Escape);
                }
            }
            Ok(_) => {}
            // The first missing segment means every following one is missing
            // too, so no further component can be a symlink.
            Err(_) => vetting = false,
        }
    }

    Ok(current)
}

/// Lexical containment test: is `path` the `root` or one of its descendants?
///
/// Both arguments must already be absolute and normalised (canonical, or the
/// output of [`resolve`]): the comparison is component based and does not
/// resolve `.`, `..` or symlinks. That makes `/tmp/vault-2` *not* inside
/// `/tmp/vault`, which is exactly the prefix trap we want to avoid.
pub fn is_inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// May the tree traversal descend into `dir`?
///
/// True only for an existing directory (symlinks are followed) whose canonical
/// target stays inside `root`. This is the helper that keeps a directory
/// symlink pointing outside the notes folder out of [`crate::notes::list_tree`],
/// and also breaks symlink loops.
pub fn may_descend(root: &Path, dir: &Path) -> bool {
    let Some(canonical_root) = root.canonicalize().ok() else {
        return false;
    };
    let Some(target) = dir.canonicalize().ok() else {
        return false;
    };
    target.is_dir() && is_inside(&canonical_root, &target)
}

/// Turns a user string into a normalised relative path, or refuses it.
fn normalise(rel: &str) -> Result<PathBuf, FsError> {
    if rel.contains('\0') || rel.contains('\\') {
        return Err(FsError::Escape);
    }

    let mut segments: Vec<std::ffi::OsString> = Vec::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(segment) => segments.push(segment.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if segments.pop().is_none() {
                    return Err(FsError::Escape);
                }
            }
            Component::RootDir | Component::Prefix(_) => return Err(FsError::Escape),
        }
    }

    if segments.is_empty() {
        // `""`, `"."` and `"a/.."` all point at the root, not at a note.
        return Err(FsError::Escape);
    }
    Ok(segments.iter().collect())
}

fn canonical_dir(root: &Path) -> Result<PathBuf, FsError> {
    let canonical = root.canonicalize()?;
    if canonical.is_dir() {
        Ok(canonical)
    } else {
        Err(FsError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn root_with(files: &[&str]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for file in files {
            let path = dir.path().join(file);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, "x").unwrap();
        }
        dir
    }

    fn read_note_for_test(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    // --- resolve: accepted paths ------------------------------------------

    #[test]
    fn resolve_accepts_a_plain_relative_path() {
        let dir = TempDir::new().unwrap();
        let got = resolve(dir.path(), "a.md").unwrap();
        assert_eq!(got, dir.path().join("a.md"));
    }

    #[test]
    fn resolve_accepts_a_nested_relative_path() {
        let dir = root_with(&["a/b.md"]);
        let got = resolve(dir.path(), "a/b.md").unwrap();
        assert_eq!(got, dir.path().join("a").join("b.md"));
    }

    #[test]
    fn resolve_accepts_a_leading_dot_slash() {
        let dir = root_with(&["a.md"]);
        let got = resolve(dir.path(), "./a.md").unwrap();
        assert_eq!(got, dir.path().join("a.md"));
    }

    #[test]
    fn resolve_normalises_inner_parent_segments() {
        let dir = root_with(&["a/b.md"]);
        let got = resolve(dir.path(), "a/../a/b.md").unwrap();
        assert_eq!(got, dir.path().join("a").join("b.md"));
    }

    #[test]
    fn resolve_strips_a_trailing_separator() {
        let dir = root_with(&["a/b"]);
        let got = resolve(dir.path(), "a/b/").unwrap();
        assert_eq!(got, dir.path().join("a").join("b"));
    }

    #[test]
    fn resolve_accepts_a_path_that_does_not_exist_yet() {
        let dir = TempDir::new().unwrap();
        let got = resolve(dir.path(), "brand/new.md").unwrap();
        assert_eq!(got, dir.path().join("brand").join("new.md"));
    }

    #[test]
    fn resolved_path_is_always_inside_the_root() {
        let dir = root_with(&["a/b.md"]);
        for rel in ["a.md", "./a.md", "a/b.md", "a/../a/b.md", "a/b/"] {
            let got = resolve(dir.path(), rel).unwrap();
            assert!(
                is_inside(dir.path(), &got),
                "{rel} resolved outside the root: {got:?}"
            );
        }
    }

    // --- resolve: rejected paths ------------------------------------------

    #[test]
    fn resolve_rejects_a_single_parent_escape() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            resolve(dir.path(), "../x").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[test]
    fn resolve_rejects_a_deep_parent_escape() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            resolve(dir.path(), "a/../../x").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[test]
    fn resolve_rejects_an_absolute_path() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            resolve(dir.path(), "/etc/passwd").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[test]
    fn resolve_rejects_a_nul_byte_anywhere() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            resolve(dir.path(), "a\0.md").unwrap_err(),
            crate::FsError::Escape
        );
        assert_eq!(
            resolve(dir.path(), "\0").unwrap_err(),
            crate::FsError::Escape
        );
        assert_eq!(
            resolve(dir.path(), "a/b\0/c.md").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[test]
    fn resolve_rejects_an_empty_path() {
        let dir = TempDir::new().unwrap();
        assert_eq!(resolve(dir.path(), "").unwrap_err(), crate::FsError::Escape);
    }

    #[test]
    fn resolve_rejects_the_bare_root_reference() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            resolve(dir.path(), ".").unwrap_err(),
            crate::FsError::Escape
        );
        assert_eq!(
            resolve(dir.path(), "a/..").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[test]
    fn resolve_rejects_a_backslash_on_every_platform() {
        // A backslash is never a separator here, and a Windows style payload
        // (`..\x`, `C:\x`) must not be accepted on Unix either.
        let dir = TempDir::new().unwrap();
        for rel in [r"..\x", r"C:\Windows\win.ini", r"sub\a.md"] {
            assert_eq!(
                resolve(dir.path(), rel).unwrap_err(),
                crate::FsError::Escape,
                "{rel} should be refused"
            );
        }
    }

    #[test]
    fn resolve_reports_a_missing_root() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(
            resolve(&missing, "a.md").unwrap_err(),
            crate::FsError::NotFound
        );
    }

    #[test]
    fn resolve_reports_a_root_that_is_a_file() {
        let dir = root_with(&["a.md"]);
        let got = resolve(&dir.path().join("a.md"), "b.md").unwrap_err();
        assert_eq!(got, crate::FsError::NotFound);
    }

    // --- resolve: symlinks -------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn resolve_refuses_a_symlink_pointing_outside_the_root() {
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.md"), "secret").unwrap();
        let dir = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();

        assert_eq!(
            resolve(dir.path(), "out/secret.md").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_refuses_a_symlinked_file_pointing_outside_the_root() {
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.md"), "secret").unwrap();
        let dir = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), dir.path().join("l.md"))
            .unwrap();

        assert_eq!(
            resolve(dir.path(), "l.md").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_follows_a_symlink_that_stays_inside_the_root() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        fs::write(dir.path().join("real").join("n.md"), "n").unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("real").join("n.md"),
            dir.path().join("alias.md"),
        )
        .unwrap();

        // The spelling the caller used survives: the alias is what the tree
        // displays, and the target is known to be inside the root.
        let got = resolve(dir.path(), "alias.md").unwrap();
        assert_eq!(got, dir.path().join("alias.md"));
        assert_eq!(read_note_for_test(&got), "n");
        assert!(is_inside(dir.path(), &got));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_refuses_an_escaping_symlink_in_the_middle_of_the_path() {
        let outside = TempDir::new().unwrap();
        fs::create_dir(outside.path().join("inner")).unwrap();
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("inner")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("inner"),
            dir.path().join("inner").join("hop"),
        )
        .unwrap();

        assert_eq!(
            resolve(dir.path(), "inner/hop/note.md").unwrap_err(),
            crate::FsError::Escape
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_accepts_a_root_that_is_itself_a_symlink() {
        let real = TempDir::new().unwrap();
        let link = TempDir::new().unwrap();
        std::os::unix::fs::symlink(real.path(), link.path().join("root")).unwrap();

        let got = resolve(&link.path().join("root"), "a.md").unwrap();
        assert_eq!(got, real.path().join("a.md"));
    }

    // --- is_inside ---------------------------------------------------------

    #[test]
    fn is_inside_accepts_the_root_and_its_descendants() {
        let dir = TempDir::new().unwrap();
        assert!(is_inside(dir.path(), dir.path()));
        assert!(is_inside(dir.path(), &dir.path().join("a/b.md")));
    }

    #[test]
    fn is_inside_does_not_confuse_a_sibling_with_the_same_prefix() {
        let dir = TempDir::new().unwrap();
        // `/tmp/x-2` starts with `/tmp/x` but is a different directory.
        let sibling = dir.path().with_extension("sibling");
        assert!(!is_inside(dir.path(), &sibling.join("a.md")));
        assert!(!is_inside(dir.path(), &sibling));
        assert!(!is_inside(dir.path(), dir.path().parent().unwrap()));
        assert!(is_inside(dir.path(), &dir.path().join("nope/deep/a.md")));
    }

    // --- may_descend -------------------------------------------------------

    #[test]
    fn may_descend_accepts_a_real_subdirectory() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        assert!(may_descend(dir.path(), &dir.path().join("sub")));
    }

    #[test]
    fn may_descend_accepts_the_root_itself() {
        let dir = TempDir::new().unwrap();
        assert!(may_descend(dir.path(), dir.path()));
    }

    #[test]
    fn may_descend_rejects_a_plain_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(!may_descend(dir.path(), &dir.path().join("a.md")));
    }

    #[test]
    fn may_descend_rejects_a_missing_directory() {
        let dir = TempDir::new().unwrap();
        assert!(!may_descend(dir.path(), &dir.path().join("nope")));
    }

    #[cfg(unix)]
    #[test]
    fn may_descend_rejects_a_directory_symlink_leaving_the_root() {
        let outside = TempDir::new().unwrap();
        fs::create_dir(outside.path().join("far")).unwrap();
        let dir = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path().join("far"), dir.path().join("far")).unwrap();

        assert!(!may_descend(dir.path(), &dir.path().join("far")));
    }

    #[cfg(unix)]
    #[test]
    fn may_descend_accepts_a_directory_symlink_staying_inside_the_root() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("alias")).unwrap();

        assert!(may_descend(dir.path(), &dir.path().join("alias")));
    }

    #[test]
    fn may_descend_rejects_a_broken_symlink() {
        let dir = TempDir::new().unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("ghost"), dir.path().join("dangling"))
                .unwrap();
            assert!(!may_descend(dir.path(), &dir.path().join("dangling")));
        }
        #[cfg(not(unix))]
        assert!(!may_descend(dir.path(), &dir.path().join("dangling")));
    }
}
