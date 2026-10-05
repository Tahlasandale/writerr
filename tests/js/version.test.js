/* Cohérence de la version entre les 4 manifestes (spec §5.6).
   Une divergence ici = l'app desktop, la PWA et le dépôt neuries木马 diverger. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const cfg = require('../../web/config.js');
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoToml = read('src-tauri/Cargo.toml');

test('la version est la même partout', () => {
  const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml)[1];
  assert.equal(cfg.version, pkg.version, 'web/config.js vs package.json');
  assert.equal(tauri.version, pkg.version, 'tauri.conf.json vs package.json');
  assert.equal(cargoVersion, pkg.version, 'Cargo.toml vs package.json');
});

test('le binaire Tauri est optionnel (cargo test sans libs GTK)', () => {
  const cargo = read('src-tauri/Cargo.toml');
  // le binaire ne doit pas être construit par défaut, sinon `cargo test`
  // exigerait webkit2gtk sur chaque machine
  assert.match(cargo, /\[\[bin\]\][\s\S]*required-features = \["app"\]/);
  assert.match(cargo, /\[features\][\s\S]*default = \[\]/);
  // build.rs DOIT exister : tauri::generate_context! lit des fichiers dans OUT_DIR.
  // Mais tauri-build exige rustc 1.90, donc il doit rester optionnel, sinon
  // `cargo test` est cassé sur les machines en 1.85.
  const buildRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
  assert.match(buildRs, /#\[cfg\(feature = "app"\)\]/,
    "build.rs conditionne l'appel à tauri_build au feature app");
  assert.match(cargo, /tauri-build = \{[^}]*optional = true/,
    'tauri-build est une build-dependency optionnelle');
});

test('le MSRV est coherent avec ce que chaque chemin exige', () => {
  const cargo = read('src-tauri/Cargo.toml');
  // Le coeur (cargo test / clippy) doit rester jouable sur un toolchain ancien.
  assert.match(cargo, /rust-version = "1\.85"/,
    'la bibliotheque seule declare 1.85 : 237 tests y passent');
  // ...et le seuil du feature `app` doit etre ecrit quelque part, sinon personne
  // ne comprend pourquoi `cargo build --features app` echoue sur 1.85.
  assert.match(cargo, /1\.90/,
    'le seuil 1.90 du binaire Tauri est documente dans Cargo.toml');
  const lock = read('src-tauri/Cargo.lock');
  assert.match(lock, /name = "tauri-utils"/,
    'Cargo.lock contient bien le graphe Tauri : le seuil doit être justifié');
  const readme = read('README.md');
  assert.match(readme, /≥ 1\.85[\s\S]*≥ 1\.90/,
    'le README annonce les deux seuils');
});

test('une seule release par tag (pas de matrice)', () => {
  const rel = read('.github/workflows/release.yml');
  // Une matrice de N jobs, tous appelant tauri-action avec le même tagName,
  // crée N brouillons concurrents pour le même tag (constaté sur v0.1.0).
  const bundle = rel.slice(rel.indexOf('bundle:'), rel.indexOf('smoke:'));
  assert.ok(!/matrix:/.test(bundle), 'le job bundle ne doit pas être une matrice');
  assert.match(bundle, /--bundles appimage,deb,rpm/,
    'un seul job construit les trois formats');
  assert.match(rel, /releaseDraft: true/,
    'les releases restent en brouillon tant que le binaire n\'a pas été lancé');
});
test('le binaire Tauri est optionnel (cargo test sans libs GTK)', () => {
  const cargo = read('src-tauri/Cargo.toml');
  // le binaire ne doit pas être construit par défaut, sinon `cargo test`
  // exigerait webkit2gtk sur chaque machine
  assert.match(cargo, /\[\[bin\]\][\s\S]*required-features = \["app"\]/);
  assert.match(cargo, /\[features\][\s\S]*default = \[\]/);
  // build.rs DOIT exister : tauri::generate_context! lit des fichiers dans OUT_DIR.
  // Mais tauri-build exige rustc 1.90, donc il doit rester optionnel, sinon
  // `cargo test` est casse sur les machines en 1.85.
  const buildRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
  assert.match(buildRs, /#\[cfg\(feature = "app"\)\]/,
    "build.rs conditionne l'appel à tauri_build au feature app");
  assert.match(cargo, /tauri-build = \{[^}]*optional = true/,
    'tauri-build est une build-dependency optionnelle');
});

test('l’identifiant Tauri est fixé', () => {
  assert.equal(tauri.identifier, 'app.writerdeck.desktop');
});

test('le dépôt GitHub est configuré (pas de placeholder OWNER)', () => {
  assert.match(cfg.repo, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  assert.ok(!cfg.repo.includes('OWNER'), 'web/config.js ne doit pas garder le placeholder');
});

test('les franchises de version sont cohérentes entre elles', () => {
  const major = v => v.split('.')[0];
  const versions = [cfg.version, pkg.version, tauri.version];
  assert.equal(new Set(versions.map(major)).size, 1, 'même version majeure partout');
});

test('tauri.conf.json pointe sur le frontend partagé', () => {
  assert.equal(tauri.build.frontendDist, '../web');
  assert.equal(tauri.app.withGlobalTauri, true);
});

test('le bundle Linux est ciblé', () => {
  assert.deepEqual(tauri.bundle.targets, ['appimage', 'deb', 'rpm']);
});

test('la CSP interdit le réseau et n’expose pas fs/shell', () => {
  const csp = tauri.app.security.csp;
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /font-src 'self'/);
  assert.ok(!/unsafe-eval/.test(csp), 'pas de unsafe-eval');
  const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
  const flat = JSON.stringify(caps);
  assert.ok(!/"fs:/.test(flat), 'plugin fs non exposé');
  assert.ok(!/"shell:/.test(flat), 'plugin shell non exposé');
});