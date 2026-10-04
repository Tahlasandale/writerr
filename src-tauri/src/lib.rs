//! Writer Deck — core Rust library.
//!
//! The crate holds the whole desktop backend except the Tauri command layer
//! (added in a later stage): file-name sanitation, sandboxed path resolution,
//! note tree traversal / atomic writes / trash, the JSON configuration, and the
//! watcher anti-loop bookkeeping.
//!
//! Conventions:
//! * every identifier, comment and doc-comment is written in **English**;
//! * every user facing message (`FsError`) is written in **French**;
//! * nothing may panic on user input, and `unwrap` / `expect` are denied
//!   outside of tests (see the crate level lints below).

// Mechanical enforcement of the "no panic on user input" rule: the lints are
// enabled crate wide and switched off again for the unit tests, which are
// allowed to `unwrap`.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::todo,
    clippy::unimplemented
)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]
#![warn(missing_docs)]

pub mod commands;
pub mod config;
pub mod names;
pub mod notes;
pub mod paths;
pub mod selfwrites;
pub mod watcher;

use std::path::Path;
use thiserror::Error;

/// Every failure the desktop backend can report to the UI.
///
/// The `Display` text is the message shown to the user and is therefore in
/// French; it never contains a raw path so that a message can safely be
/// serialised and handed to the web layer.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FsError {
    /// The requested file or directory does not exist.
    #[error("Fichier introuvable.")]
    NotFound,
    /// The path would leave the notes root (or is not a relative path at all).
    #[error("Chemin refusé : il sort du dossier de notes.")]
    Escape,
    /// The file exists but is not valid UTF-8 text.
    #[error("Ce fichier n'est pas du texte UTF-8.")]
    NotText,
    /// The file is above the maximum note size (20 MB).
    #[error("Ce fichier est trop volumineux (20 Mo maximum).")]
    TooLarge,
    /// No notes root has been configured yet.
    #[error("Aucun dossier de notes n'est configuré.")]
    NoRoot,
    /// Any other file-system failure, with the underlying message.
    #[error("Erreur du système de fichiers : {0}")]
    Io(String),
}

impl FsError {
    /// Stable machine readable code, used by the Tauri error serialisation
    /// (`{ code, message }`) and by the web layer to branch on the failure.
    pub fn code(&self) -> &'static str {
        match self {
            FsError::NotFound => "not_found",
            FsError::Escape => "escape",
            FsError::NotText => "not_text",
            FsError::TooLarge => "too_large",
            FsError::NoRoot => "no_root",
            FsError::Io(_) => "io",
        }
    }
}

impl From<std::io::Error> for FsError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => FsError::NotFound,
            _ => FsError::Io(err.to_string()),
        }
    }
}

/// Turns any file-system error into a French user facing message.
pub(crate) fn io_err(context: &str, err: &std::io::Error) -> FsError {
    match err.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound,
        _ => FsError::Io(format!("{context} : {err}")),
    }
}

/// Best-effort canonicalisation used by the traversal and by `resolve`.
///
/// Returns `None` instead of failing so that callers can skip the entry.
pub(crate) fn canonicalize(path: &Path) -> Option<std::path::PathBuf> {
    path.canonicalize().ok()
}

#[cfg(test)]
mod tests {
    use super::FsError;

    #[test]
    fn error_display_is_in_french() {
        let messages = [
            FsError::NotFound.to_string(),
            FsError::Escape.to_string(),
            FsError::NotText.to_string(),
            FsError::TooLarge.to_string(),
            FsError::NoRoot.to_string(),
            FsError::Io("boom".into()).to_string(),
        ];
        for message in messages {
            // A French message never leaves ASCII-only words out of the set
            // below; checking a few markers is enough to catch a stray
            // English sentence.
            let french_markers = [
                "Fichier",
                "Chemin",
                "texte",
                "volumineux",
                "dossier",
                "Erreur",
                "configuré",
            ];
            assert!(
                french_markers.iter().any(|m| message.contains(m)),
                "message non français : {message}"
            );
        }
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(FsError::NotFound.code(), "not_found");
        assert_eq!(FsError::Escape.code(), "escape");
        assert_eq!(FsError::NotText.code(), "not_text");
        assert_eq!(FsError::TooLarge.code(), "too_large");
        assert_eq!(FsError::NoRoot.code(), "no_root");
        assert_eq!(FsError::Io("x".into()).code(), "io");
    }

    #[test]
    fn io_error_not_found_maps_to_not_found() {
        let err = std::io::Error::new(std::io::ErrorKind::NotFound, "nope");
        assert_eq!(FsError::from(err), FsError::NotFound);
    }

    #[test]
    fn io_error_other_keeps_the_underlying_message() {
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "boom");
        match FsError::from(err) {
            FsError::Io(message) => assert!(message.contains("boom")),
            other => panic!("expected Io, got {other:?}"),
        }
    }
}
