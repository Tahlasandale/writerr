// `tauri::generate_context!` lit des fichiers générés dans OUT_DIR : build.rs doit
// donc toujours exister. Mais `tauri-build` exige rustc 1.90, ce qui empêcherait
// `cargo test` sur les machines en 1.85 (comme celle du dev). La dépendance est donc
// `optional` et activée par le feature `app` ; sans lui, on ne fait rien.
//
// Le garde est un vrai `#[cfg]` : Rust résout le symbole même à l'intérieur d'un
// `if` runtime, donc un test d'environnement ne suffirait pas.

#[cfg(feature = "app")]
fn main() {
    tauri_build::build()
}

#[cfg(not(feature = "app"))]
fn main() {}
