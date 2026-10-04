//! File-name sanitation, collision-free naming and natural ordering.
//!
//! A note title typed by a human is a hostile input for a file system: it can
//! contain path separators, control bytes, or a Windows device name. Everything
//! that reaches the disk goes through [`sanitize_file_name`] first.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::Path;

/// Maximum length of a sanitized name, counted in **characters** (not bytes).
pub const MAX_CHARS: usize = 120;

/// Name used when sanitation leaves nothing usable behind.
pub const FALLBACK: &str = "Sans titre";

/// How many ` (n)` candidates [`unique_name`] probes before giving up.
pub const MAX_ATTEMPTS: u32 = 1_000;

/// Characters that are illegal in a path on at least one supported platform.
/// `\0` and the other control characters are handled separately.
pub const FORBIDDEN: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Device names reserved by Windows (compared case-insensitively).
pub const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Turns a user title into a safe file name (without extension).
///
/// * forbidden characters (`/ \ : * ? " < > |`), `NUL` and any other control
///   character become a single space, and runs of spaces are squeezed;
/// * accents and non-Latin letters are kept;
/// * leading and trailing spaces and dots are trimmed, twice: once before and
///   once after truncation;
/// * the result is truncated to [`MAX_CHARS`] characters, never in the middle
///   of a code point;
/// * an empty result becomes [`FALLBACK`];
/// * a Windows reserved device name (`CON`, `NUL`, `COM1`…) gets a `_` suffix.
pub fn sanitize_file_name(title: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|ch| {
            if FORBIDDEN.contains(&ch) || ch == '\0' || ch.is_control() {
                ' '
            } else {
                ch
            }
        })
        .collect();

    // Characters, never bytes: an emoji or an accent can never be cut in half.
    let truncated: String = squeezed(&replaced).chars().take(MAX_CHARS).collect();

    let trimmed = trimmed(&truncated);
    if trimmed.is_empty() {
        return FALLBACK.to_string();
    }
    if is_reserved(&trimmed) {
        // `CON_` is no longer a device name, so the loop terminates.
        return format!("{trimmed}_");
    }
    trimmed
}

/// Returns a file name (not a path) built from `base` and `ext` that does not
/// collide with an existing entry of `dir`.
///
/// `Note` + `md` gives `Note.md`, then `Note (2).md`, `Note (3).md`…
/// Collisions are detected case-insensitively (`note.MD` collides with `Note.md`)
/// and directories count as taken, so the same helper serves `create_note` and
/// `create_dir`. `ext` is given without its leading dot and may be empty.
/// A missing directory simply has no collision.
pub fn unique_name(dir: &Path, base: &str, ext: &str) -> String {
    let base = sanitize_file_name(base);
    let ext = ext.trim_start_matches('.');
    let taken = taken_names(dir);

    let first = join_extension(&base, ext);
    if !taken.contains(&first.to_lowercase()) {
        return first;
    }

    let dot_ext = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    for index in 2..=MAX_ATTEMPTS {
        let candidate = format!("{base} ({index}){dot_ext}");
        if !taken.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }

    // Every candidate is taken: hand back a name that does not exist rather
    // than spinning forever.
    format!("{base} ({}){dot_ext}", MAX_ATTEMPTS + 1)
}

/// Natural, case-insensitive comparison used to order trees and lists.
///
/// Digit runs compare numerically (`note2` < `note10`), letters compare
/// case-insensitively (`Note` == `note`). Accents are *not* folded: that needs
/// Unicode normalisation tables, and the front-end already folds them.
/// The raw bytes act as a tie-breaker, which keeps the order total.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut left = a.chars().peekable();
    let mut right = b.chars().peekable();

    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(lc), Some(rc)) => {
                if lc.is_ascii_digit() && rc.is_ascii_digit() {
                    let l = take_digits(&mut left);
                    let r = take_digits(&mut right);
                    let lv = l.trim_start_matches('0');
                    let rv = r.trim_start_matches('0');
                    let by_len = lv.len().cmp(&rv.len());
                    if by_len != Ordering::Equal {
                        return by_len;
                    }
                    let by_value = lv.cmp(rv);
                    if by_value != Ordering::Equal {
                        return by_value;
                    }
                } else {
                    let lower_l = lc.to_lowercase().next();
                    let lower_r = rc.to_lowercase().next();
                    let by_char = lower_l.cmp(&lower_r);
                    if by_char != Ordering::Equal {
                        return by_char;
                    }
                    left.next();
                    right.next();
                }
            }
        }
    }
    a.cmp(b)
}

/// Lower-cased names currently present in `dir`, files and directories alike.
fn taken_names(dir: &Path) -> HashSet<String> {
    let mut taken = HashSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return taken;
    };
    for entry in entries.flatten() {
        taken.insert(entry.file_name().to_string_lossy().to_lowercase());
    }
    taken
}

fn join_extension(base: &str, ext: &str) -> String {
    if ext.is_empty() {
        base.to_string()
    } else {
        format!("{base}.{ext}")
    }
}

/// Collapses every run of whitespace into a single space and drops the ends.
fn squeezed(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

/// Trims spaces and dots from both ends.
fn trimmed(input: &str) -> String {
    input
        .trim_matches(|ch: char| ch == '.' || ch.is_whitespace())
        .to_string()
}

fn is_reserved(name: &str) -> bool {
    RESERVED
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

fn take_digits(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while let Some(ch) = chars.peek() {
        if ch.is_ascii_digit() {
            digits.push(*ch);
            chars.next();
        } else {
            break;
        }
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // --- sanitize_file_name ------------------------------------------------

    #[test]
    fn sanitize_keeps_a_plain_title_untouched() {
        assert_eq!(sanitize_file_name("Mon brouillon"), "Mon brouillon");
    }

    #[test]
    fn sanitize_strips_forbidden_characters() {
        let got = sanitize_file_name("a/b\\c:d*e?f\"g<h>i|j");
        for forbidden in FORBIDDEN {
            assert!(!got.contains(forbidden), "{forbidden} survived in {got}");
        }
        assert_eq!(got, "a b c d e f g h i j");
    }

    #[test]
    fn sanitize_strips_the_nul_byte() {
        let got = sanitize_file_name("note\0.md");
        assert!(!got.contains('\0'));
        assert_eq!(got, "note .md");
    }

    #[test]
    fn sanitize_keeps_accents_and_unicode_letters() {
        assert_eq!(
            sanitize_file_name("Éléphant à l'épaule"),
            "Éléphant à l'épaule"
        );
        assert_eq!(sanitize_file_name("Пирог"), "Пирог");
        assert_eq!(sanitize_file_name("日本語"), "日本語");
        assert_eq!(sanitize_file_name("Naïve café"), "Naïve café");
        assert_eq!(sanitize_file_name("🎯 objectif"), "🎯 objectif");
    }

    #[test]
    fn sanitize_trims_spaces_and_dots() {
        assert_eq!(sanitize_file_name("  ..note..  "), "note");
        assert_eq!(sanitize_file_name("...\t.."), "Sans titre");
        assert_eq!(sanitize_file_name(" .hidden"), "hidden");
        assert_eq!(sanitize_file_name(" note. "), "note");
    }

    #[test]
    fn sanitize_collapses_runs_of_spaces() {
        assert_eq!(sanitize_file_name("a    b"), "a b");
        assert_eq!(sanitize_file_name("a\t\tb"), "a b");
        assert_eq!(sanitize_file_name("a\n\nb"), "a b");
        assert_eq!(sanitize_file_name("  a  b  "), "a b");
    }

    #[test]
    fn sanitize_falls_back_to_sans_titre_when_empty() {
        assert_eq!(sanitize_file_name(""), "Sans titre");
        assert_eq!(sanitize_file_name("   "), "Sans titre");
        assert_eq!(sanitize_file_name("///"), "Sans titre");
        assert_eq!(sanitize_file_name("..."), "Sans titre");
        assert_eq!(sanitize_file_name("\0"), "Sans titre");
    }

    #[test]
    fn sanitize_truncates_to_120_characters() {
        let title = "a".repeat(500);
        assert_eq!(sanitize_file_name(&title).chars().count(), MAX_CHARS);
    }

    #[test]
    fn sanitize_truncation_never_splits_a_code_point() {
        let title = "é".repeat(500);
        let got = sanitize_file_name(&title);
        assert_eq!(got.chars().count(), MAX_CHARS);
        assert!(got.chars().all(|ch| ch == 'é'));
    }

    #[test]
    fn sanitize_truncation_never_splits_an_emoji() {
        let title = "😀".repeat(500);
        let got = sanitize_file_name(&title);
        assert_eq!(got.chars().count(), MAX_CHARS);
        assert_eq!(got, "😀".repeat(MAX_CHARS));
    }

    #[test]
    fn sanitize_retrims_after_truncation() {
        // 119 letters then dots: the cut leaves a trailing dot behind.
        let title = format!("{}...", "a".repeat(MAX_CHARS - 1));
        assert_eq!(sanitize_file_name(&title), "a".repeat(MAX_CHARS - 1));
    }

    #[test]
    fn sanitize_suffixes_windows_reserved_names() {
        assert_eq!(sanitize_file_name("CON"), "CON_");
        assert_eq!(sanitize_file_name("con"), "con_");
        assert_eq!(sanitize_file_name("PrN"), "PrN_");
        assert_eq!(sanitize_file_name("aux"), "aux_");
        assert_eq!(sanitize_file_name("NUL"), "NUL_");
        assert_eq!(sanitize_file_name("COM1"), "COM1_");
        assert_eq!(sanitize_file_name("com9"), "com9_");
        assert_eq!(sanitize_file_name("LPT1"), "LPT1_");
        assert_eq!(sanitize_file_name("lpt9"), "lpt9_");
    }

    #[test]
    fn sanitize_keeps_names_that_only_look_reserved() {
        assert_eq!(sanitize_file_name("COM0"), "COM0");
        assert_eq!(sanitize_file_name("console"), "console");
        assert_eq!(sanitize_file_name("CONS"), "CONS");
        assert_eq!(sanitize_file_name("COM10"), "COM10");
        assert_eq!(sanitize_file_name("LPT0"), "LPT0");
        assert_eq!(sanitize_file_name("auxiliary"), "auxiliary");
    }

    #[test]
    fn sanitize_reserved_check_is_case_insensitive() {
        assert_eq!(sanitize_file_name("cOn"), "cOn_");
        assert_eq!(sanitize_file_name("NuL"), "NuL_");
    }

    // --- unique_name -------------------------------------------------------

    #[test]
    fn unique_name_returns_the_bare_name_when_the_directory_is_empty() {
        let dir = TempDir::new().unwrap();
        assert_eq!(unique_name(dir.path(), "Note", "md"), "Note.md");
    }

    #[test]
    fn unique_name_suffixes_on_collision() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("Note.md"), "").unwrap();
        assert_eq!(unique_name(dir.path(), "Note", "md"), "Note (2).md");
    }

    #[test]
    fn unique_name_increments_the_suffix() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("Note.md"), "").unwrap();
        fs::write(dir.path().join("Note (2).md"), "").unwrap();
        assert_eq!(unique_name(dir.path(), "Note", "md"), "Note (3).md");
    }

    #[test]
    fn unique_name_detects_collisions_case_insensitively() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("note.MD"), "").unwrap();
        assert_eq!(unique_name(dir.path(), "Note", "md"), "Note (2).md");
    }

    #[test]
    fn unique_name_collision_is_case_insensitive_on_the_generated_name_too() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("note.md"), "").unwrap();
        fs::write(dir.path().join("NOTE (2).md"), "").unwrap();
        assert_eq!(unique_name(dir.path(), "Note", "md"), "Note (3).md");
    }

    #[test]
    fn unique_name_ignores_unrelated_names() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("Notes.md"), "").unwrap();
        fs::write(dir.path().join("Note (9).md"), "").unwrap();
        assert_eq!(unique_name(dir.path(), "Note", "md"), "Note.md");
    }

    #[test]
    fn unique_name_extension_is_optional() {
        let dir = TempDir::new().unwrap();
        assert_eq!(unique_name(dir.path(), "Dossier", ""), "Dossier");
        fs::create_dir(dir.path().join("Dossier")).unwrap();
        assert_eq!(unique_name(dir.path(), "Dossier", ""), "Dossier (2)");
    }

    #[test]
    fn unique_name_tolerates_a_dotted_extension() {
        let dir = TempDir::new().unwrap();
        assert_eq!(unique_name(dir.path(), "Note", ".md"), "Note.md");
    }

    #[test]
    fn unique_name_sanitizes_the_base() {
        let dir = TempDir::new().unwrap();
        assert_eq!(unique_name(dir.path(), "a/b:c", "md"), "a b c.md");
        assert_eq!(unique_name(dir.path(), "", "md"), "Sans titre.md");
    }

    #[test]
    fn unique_name_also_avoids_directory_collisions() {
        let dir = TempDir::new().unwrap();
        // A directory occupies the name just like a file does.
        fs::create_dir(dir.path().join("Projet.md")).unwrap();
        assert_eq!(unique_name(dir.path(), "Projet", "md"), "Projet (2).md");
    }

    #[test]
    fn unique_name_handles_a_missing_directory() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(unique_name(&missing, "Note", "md"), "Note.md");
    }

    #[test]
    fn unique_name_gives_up_gracefully_when_every_candidate_is_taken() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("Note.md"), "").unwrap();
        for index in 2..=MAX_ATTEMPTS {
            fs::write(dir.path().join(format!("Note ({index}).md")), "").unwrap();
        }
        let got = unique_name(dir.path(), "Note", "md");
        assert!(!got.is_empty());
        assert!(!dir.path().join(&got).exists());
    }

    // --- natural_cmp -------------------------------------------------------

    #[test]
    fn natural_cmp_orders_digit_runs_numerically() {
        assert_eq!(natural_cmp("note2", "note10"), Ordering::Less);
        assert_eq!(natural_cmp("note10", "note2"), Ordering::Greater);
        assert_eq!(natural_cmp("chapitre 9", "chapitre 10"), Ordering::Less);
    }

    #[test]
    fn natural_cmp_ignores_leading_zeroes_in_length() {
        // Numerically equal digit runs are the same number; the raw bytes then
        // break the tie so that the order stays total.
        assert_eq!(natural_cmp("note007", "note7"), Ordering::Less);
        assert_eq!(natural_cmp("note7", "note007"), Ordering::Greater);
        assert_eq!(natural_cmp("note07", "note7"), Ordering::Less);
        assert_eq!(natural_cmp("note70", "note7"), Ordering::Greater);
    }

    #[test]
    fn natural_cmp_is_case_insensitive() {
        assert_eq!(natural_cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(natural_cmp("Zoo", "apple"), Ordering::Greater);
        // Equal letters differ only by case, which the raw-byte tie-break
        // resolves deterministically instead of leaving the order ambiguous.
        assert_eq!(natural_cmp("Note", "note"), Ordering::Less);
        assert_eq!(natural_cmp("note", "Note"), Ordering::Greater);
    }

    #[test]
    fn natural_cmp_keeps_a_total_order_for_equal_letters() {
        // Case-insensitive equality must still produce a stable ordering.
        let mut names = vec!["b", "A", "a", "B", "1", "10", "2"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, vec!["1", "2", "10", "A", "a", "B", "b"]);
    }

    #[test]
    fn natural_cmp_handles_empty_and_mixed_names() {
        assert_eq!(natural_cmp("", "a"), Ordering::Less);
        assert_eq!(natural_cmp("a", ""), Ordering::Greater);
        assert_eq!(natural_cmp("", ""), Ordering::Equal);
        assert_eq!(natural_cmp("v2 final", "v10 final"), Ordering::Less);
        assert_eq!(natural_cmp("x9y", "x9a"), Ordering::Greater);
    }
}
