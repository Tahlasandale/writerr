//! Persistent application configuration (`config.json`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::FsError;

/// File name of the configuration inside the application directory.
pub const FILE_NAME: &str = "config.json";

/// Suffix given to a file that could not be parsed.
pub const BACKUP_SUFFIX: &str = ".bak";

/// Directory name created inside the user configuration directory.
pub const APP_DIR_NAME: &str = "writer-deck";

/// Default interface auto-hide delay, in milliseconds.
pub const DEFAULT_IDLE_MS: u32 = 6000;

/// Default sort key of the sidebar.
pub const DEFAULT_SORT_KEY: &str = "modified";

/// Default sort direction of the sidebar.
pub const DEFAULT_SORT_DIR: &str = "desc";

/// The application configuration, as stored in `config.json`.
///
/// Field names are the plain snake_case of this struct. Any field this version
/// does not know about is preserved verbatim in [`Config::extra`] and written
/// back on save, so a newer version never loses data for an older one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Absolute path of the notes root, `None` until the user picks one.
    pub root: Option<String>,
    /// `"light"`, `"dark"`, or `None` to follow the system.
    pub theme: Option<String>,
    /// Interface auto-hide delay in milliseconds (never hide with `0` meaning
    /// the user's explicit choice).
    pub idle_ms: u32,
    /// Sidebar ordering.
    pub sort: Sort,
    /// Relative path of the note that was open last.
    pub last_open: Option<String>,
    /// Everything else found in the file, kept for forward compatibility.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Sidebar ordering. Both fields are plain strings so that a value written by a
/// newer version survives a round trip; use [`Sort::key_enum`] and
/// [`Sort::dir_enum`] to interpret them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Sort {
    /// `name`, `modified`, `created`, `size` or `ext`.
    pub key: String,
    /// `asc` or `desc`.
    pub dir: String,
}

/// Sort keys understood by the front-end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    /// Alphabetical.
    Name,
    /// Last modification time.
    Modified,
    /// Creation time.
    Created,
    /// File size.
    Size,
    /// Extension.
    Ext,
}

/// Sort directions understood by the front-end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    /// Ascending.
    Asc,
    /// Descending.
    Desc,
}

/// The two explicit themes; `None` means "follow the system".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    /// Light theme.
    Light,
    /// Dark theme.
    Dark,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            root: None,
            theme: None,
            idle_ms: DEFAULT_IDLE_MS,
            sort: Sort::default(),
            last_open: None,
            extra: serde_json::Map::new(),
        }
    }
}

impl Default for Sort {
    fn default() -> Self {
        Sort {
            key: DEFAULT_SORT_KEY.to_string(),
            dir: DEFAULT_SORT_DIR.to_string(),
        }
    }
}

impl Sort {
    /// A sort built from two raw strings, empty ones replaced by the defaults.
    pub fn from_parts(key: &str, dir: &str) -> Sort {
        Sort {
            key: if key.is_empty() {
                DEFAULT_SORT_KEY.to_string()
            } else {
                key.to_string()
            },
            dir: if dir.is_empty() {
                DEFAULT_SORT_DIR.to_string()
            } else {
                dir.to_string()
            },
        }
    }

    /// The known key, or [`SortKey::Modified`] for an unknown one.
    pub fn key_enum(&self) -> SortKey {
        match self.key.to_lowercase().as_str() {
            "name" => SortKey::Name,
            "created" => SortKey::Created,
            "size" => SortKey::Size,
            "ext" => SortKey::Ext,
            _ => SortKey::Modified,
        }
    }

    /// The known direction, or [`SortDir::Desc`] for an unknown one.
    pub fn dir_enum(&self) -> SortDir {
        match self.dir.to_lowercase().as_str() {
            "asc" => SortDir::Asc,
            _ => SortDir::Desc,
        }
    }
}

impl Config {
    /// The configuration file inside `dir`.
    pub fn path_in(dir: &Path) -> PathBuf {
        dir.join(FILE_NAME)
    }

    /// Reads the configuration from the user configuration directory.
    ///
    /// Fails with [`FsError::NoRoot`] only when the platform has no user
    /// configuration directory at all.
    pub fn load() -> Result<Config, FsError> {
        Ok(load_from(&config_dir()?))
    }

    /// Writes the configuration to the user configuration directory.
    pub fn save(&self) -> Result<(), FsError> {
        save_to(self, &config_dir()?)
    }

    /// The explicit theme, or `None` when the system preference must be used.
    pub fn theme_value(&self) -> Option<Theme> {
        match self.theme.as_deref().map(str::to_lowercase) {
            Some(value) if value == "light" => Some(Theme::Light),
            Some(value) if value == "dark" => Some(Theme::Dark),
            _ => None,
        }
    }
}

/// Reads the configuration stored in `dir`, falling back to the defaults.
///
/// A missing file simply yields [`Config::default`]. A file that cannot be
/// parsed (broken JSON, wrong field type) also yields the defaults, and the
/// original is renamed to `config.json.bak` so the user can recover it. No
/// input can make this function panic.
pub fn load_from(dir: &Path) -> Config {
    let path = Config::path_in(dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        // Missing (or unreadable): the defaults are a valid answer.
        return Config::default();
    };
    match serde_json::from_str::<Config>(&raw) {
        Ok(config) => config,
        Err(_) => {
            quarantine(&path);
            Config::default()
        }
    }
}

/// Writes `config` into `dir`, atomically.
///
/// Reuses [`crate::notes::write_note_atomic`], so the file is either the old one
/// or the new one, never a half-written mix, and no temporary file survives a
/// failure.
pub fn save_to(config: &Config, dir: &Path) -> Result<(), FsError> {
    let path = Config::path_in(dir);
    let mut json = serde_json::to_string_pretty(config)
        .map_err(|err| FsError::Io(format!("sérialisation de la configuration : {err}")))?;
    // A trailing newline keeps the file tidy for a human reading it.
    json.push('\n');
    crate::notes::write_note_atomic(&path, &json)
}

/// The user configuration directory of the application, `…/writer-deck`.
pub fn config_dir() -> Result<PathBuf, FsError> {
    let base = dirs::config_dir().ok_or(FsError::NoRoot)?;
    Ok(base.join(APP_DIR_NAME))
}

/// Moves an unreadable configuration file aside, ignoring any failure.
fn quarantine(path: &Path) {
    let mut backup = path.as_os_str().to_os_string();
    backup.push(BACKUP_SUFFIX);
    let _ = fs::rename(path, PathBuf::from(backup));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use tempfile::TempDir;

    fn config_path(dir: &Path) -> PathBuf {
        dir.join(FILE_NAME)
    }

    fn write_raw(dir: &Path, content: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(config_path(dir), content).unwrap();
    }

    // --- defaults ----------------------------------------------------------

    #[test]
    fn a_missing_file_yields_the_defaults() {
        let dir = TempDir::new().unwrap();
        let config = load_from(dir.path());
        assert_eq!(config, Config::default());
        assert_eq!(config.idle_ms, DEFAULT_IDLE_MS);
        assert_eq!(config.idle_ms, 6000);
        assert_eq!(config.sort.key, "modified");
        assert_eq!(config.sort.dir, "desc");
        assert_eq!(config.root, None);
        assert_eq!(config.theme, None);
        assert_eq!(config.last_open, None);
        assert!(config.extra.is_empty());
    }

    #[test]
    fn a_missing_directory_yields_the_defaults() {
        let dir = TempDir::new().unwrap();
        assert_eq!(load_from(&dir.path().join("absent")), Config::default());
    }

    #[test]
    fn default_impl_matches_the_documented_defaults() {
        let config = Config::default();
        assert_eq!(config.idle_ms, 6000);
        assert_eq!(config.sort.key, "modified");
        assert_eq!(config.sort.dir, "desc");
    }

    // --- loading -----------------------------------------------------------

    #[test]
    fn load_from_reads_a_complete_file() {
        let dir = TempDir::new().unwrap();
        write_raw(
            dir.path(),
            r#"{"root":"/home/camille/Notes","theme":"dark","idle_ms":12000,
                "sort":{"key":"name","dir":"asc"},"last_open":"projet/note.md"}"#,
        );

        let config = load_from(dir.path());
        assert_eq!(config.root.as_deref(), Some("/home/camille/Notes"));
        assert_eq!(config.theme.as_deref(), Some("dark"));
        assert_eq!(config.idle_ms, 12_000);
        assert_eq!(config.sort.key, "name");
        assert_eq!(config.sort.dir, "asc");
        assert_eq!(config.last_open.as_deref(), Some("projet/note.md"));
    }

    #[test]
    fn load_from_fills_in_the_missing_fields() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), r#"{"idle_ms": 2500}"#);

        let config = load_from(dir.path());
        assert_eq!(config.idle_ms, 2500);
        assert_eq!(config.sort, Sort::default());
        assert_eq!(config.root, None);
        assert_eq!(config.theme, None);
        assert_eq!(config.last_open, None);
    }

    #[test]
    fn load_from_accepts_a_partial_sort() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), r#"{"sort":{"key":"size"}}"#);
        let config = load_from(dir.path());
        assert_eq!(config.sort.key, "size");
        assert_eq!(config.sort.dir, "desc");
    }

    #[test]
    fn load_from_keeps_a_zero_idle_delay() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), r#"{"idle_ms": 0}"#);
        assert_eq!(load_from(dir.path()).idle_ms, 0);
    }

    // --- corrupted file ----------------------------------------------------

    #[test]
    fn load_from_falls_back_to_defaults_on_broken_json() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), "{ ceci n'est pas du json");

        let config = load_from(dir.path());
        assert_eq!(config, Config::default());
    }

    #[test]
    fn load_from_quarantines_a_corrupted_file() {
        let dir = TempDir::new().unwrap();
        let broken = "{ ceci n'est pas du json";
        write_raw(dir.path(), broken);

        load_from(dir.path());
        let backup = dir.path().join(format!("{FILE_NAME}{BACKUP_SUFFIX}"));
        assert!(backup.exists(), "the corrupted file was not renamed");
        assert_eq!(fs::read_to_string(&backup).unwrap(), broken);
    }

    #[test]
    fn load_from_quarantines_a_file_with_a_wrong_field_type() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), r#"{"idle_ms": "beaucoup"}"#);

        assert_eq!(load_from(dir.path()), Config::default());
        assert!(dir
            .path()
            .join(format!("{FILE_NAME}{BACKUP_SUFFIX}"))
            .exists());
    }

    #[test]
    fn load_from_quarantines_a_file_with_a_negative_idle_delay() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), r#"{"idle_ms": -1}"#);

        assert_eq!(load_from(dir.path()), Config::default());
        assert!(dir
            .path()
            .join(format!("{FILE_NAME}{BACKUP_SUFFIX}"))
            .exists());
    }

    #[test]
    fn load_from_quarantines_a_json_array() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), "[1, 2, 3]");

        assert_eq!(load_from(dir.path()), Config::default());
        assert!(dir
            .path()
            .join(format!("{FILE_NAME}{BACKUP_SUFFIX}"))
            .exists());
    }

    #[test]
    fn load_from_survives_a_directory_named_like_the_config() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(config_path(dir.path())).unwrap();

        // No panic, no quarantine: there is no file to move.
        assert_eq!(load_from(dir.path()), Config::default());
    }

    #[test]
    fn load_from_survives_a_truncated_file() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), r#"{"idle_ms": 12000, "theme":"da"#);
        assert_eq!(load_from(dir.path()), Config::default());
    }

    #[test]
    fn a_new_config_can_be_saved_after_a_corruption() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), "cassé");
        load_from(dir.path());

        let config = Config {
            idle_ms: 9000,
            ..Config::default()
        };
        save_to(&config, dir.path()).unwrap();

        assert_eq!(load_from(dir.path()).idle_ms, 9000);
    }

    // --- saving ------------------------------------------------------------

    #[test]
    fn save_to_writes_a_readable_file() {
        let dir = TempDir::new().unwrap();
        let config = Config {
            root: Some("/home/camille/Notes".into()),
            theme: Some("dark".into()),
            idle_ms: 3000,
            sort: Sort {
                key: "name".into(),
                dir: "asc".into(),
            },
            last_open: Some("note.md".into()),
            ..Config::default()
        };

        save_to(&config, dir.path()).unwrap();
        assert_eq!(load_from(dir.path()), config);
    }

    #[test]
    fn save_to_creates_the_application_directory() {
        let dir = TempDir::new().unwrap();
        let nested = dir.path().join("writer-deck");
        save_to(&Config::default(), &nested).unwrap();
        assert!(nested.join(FILE_NAME).exists());
    }

    #[test]
    fn save_to_is_atomic() {
        let dir = TempDir::new().unwrap();
        save_to(&Config::default(), dir.path()).unwrap();
        let entries = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(entries, [FILE_NAME]);
    }

    #[test]
    fn save_to_overwrites_the_previous_file() {
        let dir = TempDir::new().unwrap();
        save_to(&Config::default(), dir.path()).unwrap();

        let updated = Config {
            idle_ms: 4200,
            ..Config::default()
        };
        save_to(&updated, dir.path()).unwrap();

        assert_eq!(load_from(dir.path()).idle_ms, 4200);
    }

    #[test]
    fn save_to_reports_an_unwritable_directory() {
        let dir = TempDir::new().unwrap();
        // A file where the application directory should be.
        fs::write(dir.path().join(FILE_NAME), "{}").unwrap();
        let blocked = dir.path().join(FILE_NAME).join("config.json");
        assert!(save_to(&Config::default(), blocked.parent().unwrap()).is_err());
    }

    // --- forward compatibility ---------------------------------------------

    #[test]
    fn unknown_fields_are_preserved_on_save() {
        let dir = TempDir::new().unwrap();
        write_raw(
            dir.path(),
            r#"{"idle_ms": 3000, "futureOption": {"nested": [1, 2]}, "beta": true}"#,
        );

        let mut config = load_from(dir.path());
        config.idle_ms = 4000;
        save_to(&config, dir.path()).unwrap();

        let raw = fs::read_to_string(config_path(dir.path())).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["futureOption"]["nested"][1], 2);
        assert_eq!(json["beta"], true);
        assert_eq!(json["idle_ms"], 4000);
    }

    #[test]
    fn unknown_fields_survive_a_load_save_load_cycle() {
        let dir = TempDir::new().unwrap();
        write_raw(dir.path(), r#"{"futureOption": "garder"}"#);

        let first = load_from(dir.path());
        assert_eq!(first.extra["futureOption"], "garder");
        save_to(&first, dir.path()).unwrap();

        let second = load_from(dir.path());
        assert_eq!(second.extra["futureOption"], "garder");
        assert_eq!(second, first);
    }

    #[test]
    fn unknown_sort_values_are_kept_but_fall_back_to_the_default() {
        let dir = TempDir::new().unwrap();
        write_raw(
            dir.path(),
            r#"{"sort": {"key": "colour", "dir": "sideways"}}"#,
        );

        let config = load_from(dir.path());
        // Forward compatible: the value is neither lost nor fatal.
        assert_eq!(config.sort.key, "colour");
        assert_eq!(config.sort.dir, "sideways");
        assert_eq!(config.sort.key_enum(), SortKey::Modified);
        assert_eq!(config.sort.dir_enum(), SortDir::Desc);
    }

    // --- helpers -----------------------------------------------------------

    #[test]
    fn sort_key_enum_maps_every_known_value() {
        for (raw, expected) in [
            ("name", SortKey::Name),
            ("modified", SortKey::Modified),
            ("created", SortKey::Created),
            ("size", SortKey::Size),
            ("ext", SortKey::Ext),
        ] {
            assert_eq!(Sort::from_parts(raw, "asc").key_enum(), expected);
        }
    }

    #[test]
    fn sort_dir_enum_maps_every_known_value() {
        assert_eq!(Sort::from_parts("name", "asc").dir_enum(), SortDir::Asc);
        assert_eq!(Sort::from_parts("name", "desc").dir_enum(), SortDir::Desc);
        assert_eq!(Sort::from_parts("name", "").dir_enum(), SortDir::Desc);
    }

    #[test]
    fn sort_dir_enum_is_case_insensitive() {
        assert_eq!(Sort::from_parts("name", "ASC").dir_enum(), SortDir::Asc);
    }

    #[test]
    fn sort_key_enum_is_case_insensitive() {
        assert_eq!(Sort::from_parts("NAME", "asc").key_enum(), SortKey::Name);
    }

    #[test]
    fn theme_value_maps_light_and_dark() {
        let config = Config {
            theme: Some("light".into()),
            ..Config::default()
        };
        assert_eq!(config.theme_value(), Some(Theme::Light));
        let config = Config {
            theme: Some("dark".into()),
            ..Config::default()
        };
        assert_eq!(config.theme_value(), Some(Theme::Dark));
    }

    #[test]
    fn theme_value_ignores_an_unknown_theme() {
        let config = Config {
            theme: Some("néon".into()),
            ..Config::default()
        };
        assert_eq!(config.theme_value(), None);
        assert_eq!(Config::default().theme_value(), None);
    }

    #[test]
    fn config_dir_is_named_after_the_application() {
        match config_dir() {
            Ok(path) => {
                assert_eq!(path.file_name().unwrap(), APP_DIR_NAME);
                assert!(path.is_absolute(), "{path:?} is not absolute");
            }
            Err(err) => assert_eq!(err, FsError::NoRoot),
        }
    }

    #[test]
    fn path_in_points_at_the_config_file() {
        let dir = TempDir::new().unwrap();
        assert_eq!(Config::path_in(dir.path()), dir.path().join(FILE_NAME));
    }

    #[test]
    fn load_uses_the_user_configuration_directory() {
        // Whatever the machine, this must not panic and must be consistent.
        match config_dir() {
            Ok(dir) => {
                let loaded = load_from(&dir);
                assert_eq!(loaded, load_from(&dir));
            }
            Err(err) => assert_eq!(err, FsError::NoRoot),
        }
    }
}
