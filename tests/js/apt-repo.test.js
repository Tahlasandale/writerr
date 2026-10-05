/* Dépôt APT signé, servi par GitHub Pages.
 *
 * Objectif : que `sudo apt install writer-deck` puis
 * `sudo apt update && sudo apt upgrade writer-deck` fonctionnent, sans script
 * d'installation chez l'utilisateur.
 *
 * Le contrat apt est strict et ses erreurs sont muettes. Les trois pièges
 * rencontrés pendant la mise au point, tous vérifiés ici :
 *
 *  1. Préfixe `dists/`. En écrivant `site/stable/Release` au lieu de
 *     `site/dists/stable/Release`, tout le reste est correct et apt répond
 *     « Le dépôt ... n'a pas de fichier Release ».
 *
 *  2. Le Release se hache lui-même. `apt-ftparchive release dist > dist/Release`
 *     pose un tiroir : le shell crée le fichier de sortie AVANT d'exécuter la
 *     commande, donc apt-ftparchive hache un Release vide et inscrit son propre
 *     nom dans sa liste de sommes. Le dépôt devient muet.
 *
 *  3. `Packages.gz` seul ne suffit plus. Un apt 3.x (Debian 13, Ubuntu 24.04+)
 *     ne dérive aucune cible d'un Release qui ne publie que le .gz : il récupère
 *     l'InRelease, valide la signature, puis `apt install` répond
 *     « Unable to locate package » — sans aucun avertissement. Il faut
 *     `Packages.xz`, plus le `Packages` non compressé pour les apt anciens.
 *
 * Ces tests EXÉCUTENT le script (mode APT_DRY_RUN) sur un .deb fabriqué, avec
 * une clé GPG jetable, et contrôlent l'arborescence produite et sa signature.
 * Un grep de chaînes ne prouverait qu'une chose : que le texte dit ce qu'il dit.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPT = path.join(ROOT, '.github/scripts/publish-apt-repo.sh');
const CLE_PUBLIQUE = 'writerr-apt-key.asc';
const FPR_PUBLIE = '10433B2A24900E8F5A6FBA660CFFC7C5CB907F46';

const dispo = nom => {
  try {
    execFileSync(nom, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const outils = ['dpkg-deb', 'dpkg-scanpackages', 'apt-ftparchive', 'xz', 'gpg', 'git'];
const manquants = outils.filter(o => !dispo(o));
const peutGenerer = manquants.length === 0;
const raison = `outils absents: ${manquants.join(', ')}`;

/** Clé GPG jetable, dans un GNUPGHOME jetable. */
function cleJetable() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-gpg-'));
  const env = { ...process.env, GNUPGHOME: home };
  execFileSync('gpg', [
    '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
    '--quick-generate-key', 'Test Writer Deck <test@example.invalid>',
    'rsa2048', 'sign', 'never',
  ], { env, stdio: 'ignore' });
  const armored = execFileSync('gpg', ['--armor', '--export-secret-keys'], { env });
  return { armored: armored.toString(), env, home };
}

/**
 * `gpg --import` démarre un agent qui survit au processus. Dans un GNUPGHOME
 * jetable il ne peut jamais être réutilisé : sans ce kill, chaque exécution de
 * la suite fuit un daemon, et la machine finit par manquer de sockets — ce qui
 * fait échouer des tests sans rapport, en l'occurrence ceux du watcher Rust avec
 * un `TooManyOpenFiles`. Constaté : 54 agents survivants, et 3 tests Rust rouges
 * sur un simple `cargo test` alors que rien n'avait changé côté Rust.
 */
function tuerAgent(home) {
  try {
    execFileSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' });
  } catch {
    // gpgconf absent sur un système minimal : l'agent partira avec le tmpdir.
  }
}

/** .deb minimal, dépendances paramétrables. */
function fabriquerDeb(dir, depends) {
  const pkg = path.join(dir, 'pkg');
  fs.mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'usr/bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'usr/bin/outil'), 'test\n');
  const md5 = execFileSync('md5sum', [path.join(pkg, 'usr/bin/outil')]).toString().split(/\s+/)[0];
  fs.writeFileSync(path.join(pkg, 'DEBIAN/md5sums'), `${md5}  usr/bin/outil\n`);
  fs.writeFileSync(path.join(pkg, 'DEBIAN/control'), [
    'Package: writer-deck',
    'Version: 9.9.9',
    'Architecture: amd64',
    'Maintainer: test <test@example.invalid>',
    'Section: utils',
    'Priority: optional',
    `Depends: ${depends}`,
    'Description: paquet de test',
    ' pour verifier le depot apt',
    '',
  ].join('\n'));
  const deb = path.join(dir, 'writer-deck.deb');
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', pkg, deb]);
  return deb;
}

/** Lance le script en dry-run, renvoie le site produit. */
function genererDepot(depends = 'libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0') {
  const { armored, env, home } = cleJetable();
  const debDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-debs-'));
  try {
    fabriquerDeb(debDir, depends);
    const out = execFileSync(SCRIPT, [], {
      env: {
        ...env,
        APT_GPG_PRIVATE_KEY: armored,
        APT_DEB_DIR: debDir,
        APT_DRY_RUN: '1',
        TAG: 'v9.9.9',
        REPO: 'Tahlasandale/writerr',
        GITHUB_WORKSPACE: ROOT,
      },
      encoding: 'utf8',
    });
    const site = /\[dry-run\] site : (.+)/.exec(out)[1].trim();
    return { site, sortie: out, cle: armored };
  } finally {
    tuerAgent(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(debDir, { recursive: true, force: true });
  }
}

test('le script existe, est exécutable et se déclare en bash', () => {
  assert.ok(fs.statSync(SCRIPT).mode & 0o111, 'bit exécutable requis');
  assert.match(read('.github/scripts/publish-apt-repo.sh'), /^#!\/usr\/bin\/env bash/);
});

test('le workflow publie le dépôt et fournit les outils', () => {
  const rel = read('.github/workflows/release.yml');
  assert.match(rel, /publish-apt-repo\.sh/, 'l\'étape de publication a disparu');
  // La clé doit venir d'un secret, jamais d'un fichier versionné.
  assert.match(rel, /APT_GPG_PRIVATE_KEY: \$\{\{ secrets\.APT_GPG_PRIVATE_KEY \}\}/,
    'la clé privée doit lire le secret CI');
  // apt-ftparchive (apt-utils) n'est pas sur un runner Ubuntu par défaut.
  assert.match(rel, /apt-get install -y apt-utils dpkg-dev/,
    'sans apt-utils, le Release ne peut pas être généré sur le runner');
  // La correction du .deb doit précéder la publication, sinon le script publie
  // un paquet à la mauvaise dépendance (et il refuse, ce qui est le but).
  assert.ok(rel.indexOf('fix-deb-deps.sh') < rel.indexOf('publish-apt-repo.sh'),
    'corriger le .deb doit venir avant de publier le dépôt');
});

test('la clé publique est versionnée et exploitable', () => {
  const asc = read(CLE_PUBLIQUE);
  assert.match(asc, /^-----BEGIN PGP PUBLIC KEY BLOCK-----/,
    `${CLE_PUBLIQUE} doit être une clé ASCII-armored : c'est elle que le README
    fait installer dans /etc/apt/keyrings`);
  // L'empreinte citée dans la page du dépôt et dans DECISIONS doit être celle
  // de la clé réellement versionnée.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-key-'));
  try {
    execFileSync('gpg', ['--batch', '--quiet', '--import', path.join(ROOT, CLE_PUBLIQUE)],
      { env: { ...process.env, GNUPGHOME: home } });
    const liste = execFileSync('gpg', ['--batch', '--with-colons', '--list-keys'],
      { env: { ...process.env, GNUPGHOME: home } }).toString();
    const fprs = [...liste.matchAll(/^fpr:+([0-9A-F]{40,})/gm)].map(m => m[1]);
    assert.deepEqual(fprs, [FPR_PUBLIE],
      'la clé versionnée doit être exactement celle dont l\'empreinte est publiée');
  } finally {
    tuerAgent(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('le dépôt produit a la forme qu\'apt exige', { skip: !peutGenerer && raison }, () => {
  const { site } = genererDepot();
  for (const f of [
    'dists/stable/InRelease',
    'dists/stable/Release',
    'dists/stable/main/binary-amd64/Packages',
    'dists/stable/main/binary-amd64/Packages.xz',
    'pool/main/w/writer-deck/writer-deck_9.9.9_amd64.deb',
    CLE_PUBLIQUE,
  ]) {
    assert.ok(fs.existsSync(path.join(site, f)),
      `${f} absent — apt ne publishable pas de dépôt sans lui`);
  }
  // Piège 3 : un .gz seul produit un dépôt muet sous apt 3.x.
  assert.ok(!fs.existsSync(path.join(site, 'dists/stable/main/binary-amd64/Packages.gz')),
    'ne pas publier Packages.gz : un apt 3.x n\'en dérive aucune cible');
  // Piège 1 : le préfixe dists/ est obligatoire.
  assert.ok(fs.existsSync(path.join(site, 'dists')),
    'les indices doivent être sous dists/, jamais à la racine du site');
  // Piège 2 : le Release ne doit pas se lister lui-même.
  const release = fs.readFileSync(path.join(site, 'dists/stable/Release'), 'utf8');
  assert.ok(!/^\s*[0-9a-f]+\s+\d+\s+Release$/m.test(release),
    'le Release se hache lui-même : apt-ftparchive a scanné le fichier de sortie');
  // Les sommes annoncées doivent correspondre aux fichiers réels.
  const sha = /SHA256:\n((?: [0-9a-f]+ +\d+ \S+\n)+)/.exec(release)[1];
  for (const [, hash, taille, rel] of sha.matchAll(/ ([0-9a-f]+) +(\d+) (\S+)\n/g)) {
    const reel = execFileSync('sha256sum', [path.join(site, 'dists/stable', rel)]).toString().split(/\s+/)[0];
    assert.equal(reel, hash, `somme SHA256 fausse pour ${rel}`);
    assert.equal(String(fs.statSync(path.join(site, 'dists/stable', rel)).size), taille,
      `taille fausse dans le Release pour ${rel}`);
  }
});

test('l\'index pointe vers le pool et porte la bonne dépendance', { skip: !peutGenerer && raison }, () => {
  const { site } = genererDepot();
  const index = fs.readFileSync(
    path.join(site, 'dists/stable/main/binary-amd64/Packages'), 'utf8');
  assert.match(index, /^Package: writer-deck$/m);
  // `Filename` est relatif à la racine du SITE, pas au répertoire dists/.
  assert.match(index, /^Filename: pool\/main\/w\/writer-deck\/writer-deck_9\.9\.9_amd64\.deb$/m,
    'apt résout le téléchargement par ce champ : un chemin relatif à dists/ 404');
  assert.match(index, /^Depends: libwebkit2gtk-4\.1-0, libgtk-3-0t64 \| libgtk-3-0$/m);
  // Le .xz doit décompresser sur exactement le même contenu.
  const xz = execFileSync('xz', ['-dc',
    path.join(site, 'dists/stable/main/binary-amd64/Packages.xz')]).toString();
  assert.equal(xz, index, 'Packages.xz et Packages doivent être identiques');
});

test('l\'InRelease est réellement signé et vérifiable', { skip: !peutGenerer && raison }, () => {
  // La clé doit être CELLE qui a signé le dépôt : en générer une seconde ne
  // prouverait rien et l'échec serait trompeur.
  const { site, cle } = genererDepot();
  try {
    assert.match(fs.readFileSync(path.join(site, 'dists/stable/InRelease'), 'utf8'),
      /^-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n/,
      'InRelease doit être un message clair-signé (--clearsign)');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-vrf-'));
    try {
      fs.writeFileSync(path.join(home, 'k.asc'), cle);
      execFileSync('gpg', ['--batch', '--quiet', '--import', path.join(home, 'k.asc')],
        { env: { ...process.env, GNUPGHOME: home } });
      execFileSync('gpg', ['--batch', '--verify', path.join(site, 'dists/stable/InRelease')],
        { env: { ...process.env, GNUPGHOME: home }, stdio: 'pipe' });
    } finally {
      tuerAgent(home);
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

test('le script refuse de publier un .deb à la mauvaise dépendance', { skip: !peutGenerer && raison }, () => {
  // Le .deb de v0.1.0 a la mauvaise dépendance : le publier produirait un dépôt
  // où `apt install writer-deck` échoue. Mieux vaut un build rouge.
  const { armored, env, home } = cleJetable();
  const debDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-bad-'));
  try {
    fabriquerDeb(debDir, 'libwebkit2gtk-4.1-0, libgtk-3-0');
    assert.throws(() => execFileSync(SCRIPT, [], {
      env: {
        ...env,
        APT_GPG_PRIVATE_KEY: armored,
        APT_DEB_DIR: debDir,
        APT_DRY_RUN: '1',
        TAG: 'v9.9.9',
        GITHUB_WORKSPACE: ROOT,
      },
      stdio: 'pipe',
      encoding: 'utf8',
    }), /mauvaise dépendance GTK3/);
  } finally {
    tuerAgent(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(debDir, { recursive: true, force: true });
  }
});

test('le script refuse de tourner sans clé privée', () => {
  assert.throws(() => execFileSync(SCRIPT, [], {
    env: { ...process.env, APT_GPG_PRIVATE_KEY: '', TAG: 'v9.9.9', GITHUB_WORKSPACE: ROOT },
    stdio: 'pipe',
    encoding: 'utf8',
  }), /APT_GPG_PRIVATE_KEY absent/);
});

// Le README (procédure d'installation et nom du secret CI) est vérifié par
// tests/js/docs.test.js, qui lit la documentation plutôt que le code.
