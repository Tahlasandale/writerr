/* Packaging Debian : la dépendance GTK3.
 *
 * Contexte (spec §8, release v0.1.0). Le .deb produit par Tauri déclarait
 *
 *     Depends: libwebkit2gtk-4.1-0, libgtk-3-0
 *
 * Or `libgtk-3-0` n'existe plus : sur Debian 13 / Ubuntu 24.04+ la transition
 * t64 a renommé le paquet en `libgtk-3-0t64`. Le paquet était donc
 * ININSTALLABLE sur la distro de référence, et `apt install ./writer-deck.deb`
 * échouait sur « dépendances non satisfaites ».
 *
 * Le correctif ne peut PAS passer par tauri.conf.json. tauri-cli-2.12.1
 * (src/interface/rust.rs) fait :
 *
 *     let mut depends_deb = config.linux.deb.depends.unwrap_or_default();
 *     ...
 *     depends_deb.push("libwebkit2gtk-4.1-0".to_string());
 *     depends_deb.push("libgtk-3-0".to_string());
 *
 * Les deux `push` sont inconditionnels et il n'y a pas de déduplication : la
 * config sert de base, et les deux noms historiques sont ajoutés par-dessus.
 * Écrire `libgtk-3-0t64 | libgtk-3-0` dans la config donnerait donc
 *
 *     Depends: libgtk-3-0t64 | libgtk-3-0, libwebkit2gtk-4.1-0, libgtk-3-0
 *
 * où le `libgtk-3-0` final est une dépendance DURE : l'alternative ne couvre que
 * la première entrée, le paquet reste ininstallable. D'où la réécriture du
 * fichier de contrôle après le bundling (scripts/fix-deb-deps.sh).
 *
 * Ces tests exécutent vraiment le script sur un .deb fabriqué à la volée : un
 * simple grep de « la chaîne est présente » ne prouverait pas que la
 * transformation produit un paquet valide.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPT = path.join(ROOT, '.github/scripts/fix-deb-deps.sh');

// La forme attendue : UNE dépendance GTK3, exprimée comme alternative Debian
// pour couvrir l'ancien et le nouveau nom.
const ATTENDU = 'libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0';

const dpkg = (() => {
  try {
    execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Fabrique un .deb minimal dont le Depends est paramétrable. */
function fabriquerDeb(dir, depends) {
  const pkg = path.join(dir, 'pkg');
  fs.mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'usr/bin'), { recursive: true });

  fs.writeFileSync(path.join(pkg, 'usr/bin/outil'), 'contenu de test\n');
  const md5 = execFileSync('md5sum', [path.join(pkg, 'usr/bin/outil')])
    .toString().split(/\s+/)[0];
  fs.writeFileSync(path.join(pkg, 'DEBIAN/md5sums'), `${md5}  usr/bin/outil\n`);

  fs.writeFileSync(path.join(pkg, 'DEBIAN/control'), [
    'Package: wd-fixture',
    'Version: 0.0.1',
    'Architecture: amd64',
    'Maintainer: test <test@example.invalid>',
    'Section: utils',
    'Priority: optional',
    ...(depends === null ? [] : [`Depends: ${depends}`]),
    'Description: paquet de test',
    ' pour verifier la reecriture du Depends',
    '',
  ].join('\n'));

  const deb = path.join(dir, 'fixture.deb');
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', pkg, deb]);
  return deb;
}

function avecDeb(depends, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-deb-'));
  try {
    return fn(fabriquerDeb(dir, depends), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('le script existe et est exécutable', () => {
  const stat = fs.statSync(SCRIPT);
  assert.ok(stat.mode & 0o111, 'le bit exécutable est requis : le workflow l\'appelle directement');
  assert.match(read('.github/scripts/fix-deb-deps.sh'), /^#!\/usr\/bin\/env bash/);
});

test('le workflow appelle le script, sinon le .deb reste cassé', () => {
  const rel = read('.github/workflows/release.yml');
  assert.match(rel, /fix-deb-deps\.sh/,
    'l\'étape de correction a disparu de release.yml');
  // L'asset téléversé par tauri-action porte la mauvaise dépendance : sans
  // --clobber, la correction locale ne servirait à rien côté téléchargement.
  assert.match(rel, /gh release upload[\s\S]*--clobber/,
    'l\'asset déjà téléversé doit être écrasé');
  // L'ordre compte : la correction doit venir APRÈS tauri-action, sinon il n'y
  // a pas encore de .deb.
  assert.ok(rel.indexOf('tauri-apps/tauri-action') < rel.indexOf('fix-deb-deps.sh'),
    'corriger avant d\'construire ne peut pas fonctionner');
});

test('la config Tauri documente l\'intention, sans reliance dessus', () => {
  const cfg = JSON.parse(read('src-tauri/tauri.conf.json'));
  const depends = cfg.bundle.linux.deb.depends;
  assert.ok(Array.isArray(depends), 'bundle.linux.deb.depends doit être une liste');
  assert.ok(depends.some(d => d.includes('libgtk-3-0t64') && d.includes('|')),
    'la config doit au moins porter l\'alternative t64 ; elle ne suffit pas seule, '
    + 'le script fait le travail');
  assert.equal(cfg.bundle.linux.deb.section, 'utils');
});

test('le script réécrit le Depends en une alternative', { skip: !dpkg && 'dpkg-deb absent' }, () => {
  avecDeb('libwebkit2gtk-4.1-0, libgtk-3-0', deb => {
    execFileSync(SCRIPT, [deb], { stdio: 'pipe' });
    const champs = execFileSync('dpkg-deb', ['-f', deb]).toString();
    assert.match(champs, new RegExp(`^Depends: ${ATTENDU.replace(/[|+]/g, '\\$&')}$`, 'm'),
      'le champ Depends doit être exactement l\'alternative attendue');
    // Le piège qu'on veut éviter : un `libgtk-3-0` dur hors alternative.
    assert.equal((champs.match(/libgtk-3-0(?!t64)/g) || []).length, 1,
      '`libgtk-3-0` ne doit apparaître que dans l\'alternative, jamais seul');
  });
});

test('le script préserve le reste du paquet', { skip: !dpkg && 'dpkg-deb absent' }, () => {
  avecDeb('libwebkit2gtk-4.1-0, libgtk-3-0', deb => {
    const avant = execFileSync('dpkg-deb', ['-f', deb, 'Package', 'Version', 'Architecture', 'Section'])
      .toString();
    execFileSync(SCRIPT, [deb], { stdio: 'pipe' });
    const apres = execFileSync('dpkg-deb', ['-f', deb, 'Package', 'Version', 'Architecture', 'Section'])
      .toString();
    assert.equal(apres, avant, 'Package/Version/Architecture/Section ne doivent pas bouger');

    // dpkg refuse d'installer un paquet dont les md5sums ne correspondent plus :
    // c'est le contrôle d'intégrité que le script ne doit pas casser.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-verify-'));
    try {
      execFileSync('dpkg-deb', ['-R', deb, dir]);
      // LC_ALL=C : sans lui, `md5sum -c` répond « Réussi » sur une locale
      // française et le test devient faux. Le code de sortie reste la preuve.
      const check = execFileSync('md5sum', ['-c', 'DEBIAN/md5sums'], {
        cwd: dir,
        env: { ...process.env, LC_ALL: 'C' },
      });
      assert.match(check.toString(), /usr\/bin\/outil: OK/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('le script refuse un paquet sans champ Depends', { skip: !dpkg && 'dpkg-deb absent' }, () => {
  // Échouer bruyamment vaut mieux que laisser passer un .deb dont la
  // dépendance n'a pas été corrigée : l'utilisateur verrait un échec d'apt
  // incompréhensible.
  avecDeb(null, deb => {
    assert.throws(() => execFileSync(SCRIPT, [deb], { stdio: 'pipe' }),
      /aucun champ Depends/);
  });
});

test('le seuil de taille reflète la taille réelle du binaire', () => {
  const rel = read('.github/workflows/release.yml');
  const seuils = [...rel.matchAll(/test "\$size" -lt (\d+)/g)].map(m => Number(m[1]));
  assert.equal(seuils.length, 1, `un seul seuil attendu, trouvé ${seuils.length}`);
  const seuil = seuils[0];
  assert.equal(seuil, 17 * 1024 * 1024, 'le seuil est 17 Mio (voir DECISIONS.md)');

  // Un seuil inférieur à la taille mesurée ferait échouer le contrôle à chaque
  // release : c'est exactement le bug que la spec d'origine contenait.
  assert.ok(seuil > 16_456_520,
    `le seuil (${seuil}) doit dépasser la taille mesurée de v0.1.0 `
    + '(16 456 520 octets), sinon le contrôle échouerait à chaque release');
});

test('le script refuse une entrée qui n\'est pas un .deb', () => {
  assert.throws(
    () => execFileSync(SCRIPT, ['/etc/hostname'], { stdio: 'pipe' }),
    /pas un \.deb/,
  );
});
