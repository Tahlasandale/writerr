/* Cohérence de AGENTS.md, plus le scan anti-artefact.
 *
 * Un fichier d'instructions ment silencieusement : il promet des commandes qui
 * n'existent plus, des chemins disparus, des seuils périmés. Personne ne le
 * relit en vérifiant, et l'agent qui le suit se retrouve à lancer
 * `npm run truc-qui-nexiste-pas`. Ce test le rend faux dès qu'il le devient.
 *
 * Le scan anti-artefact refuse les caractères asiatiques glissés par accident dans
 * du texte français ou anglais. Cela s'est produit trois fois dans ce dépôt, dont
 * une fois dans un fichier DÉJÀ commité : rien ne l'avait signalé. Les CJK sont
 * acceptés dans `src-tauri/`, où ils sont volontaires — les tests de noms de
 * fichiers Unicode.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const AGENTS = 'AGENTS.md';
const lire = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const agents = lire(AGENTS);

// Écrite en échappements et non en littéraux : sinon ce fichier contient
// lui-même des CJK, et le scan se signale comme coupable.
const CJK = new RegExp('[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]', 'u');

/** Sous-chaînes inspectées par le scan anti-artefact. */
const ZONES = ['web', 'tests', 'docs', '.github', 'README.md', 'DECISIONS.md', AGENTS];

function fichiersSous(cible, { rust = false } = {}) {
  const abs = path.join(ROOT, cible);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [cible];
  const out = [];
  (function marcher(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'target', '.tmp', 'gen'].includes(e.name)) continue;
      const rel = path.relative(ROOT, path.join(dir, e.name));
      if (e.isDirectory()) marcher(path.join(dir, e.name));
      else if (rust || /\.(js|mjs|cjs|md|html|css|json|yml|yaml|sh|toml|rs)$/.test(rel)) out.push(rel);
    }
  })(abs);
  return out;
}

/* ------------------------------------------------------------------ contenu */

test('les huit sections attendues sont là', () => {
  // Un fichier d'instructions amputé d'une moitié reste « présent » : sans cette
  // liste, une suppression passerait inaperçue jusqu'à ce qu'un agent choque
  // contre une consigne disparue.
  const attendus = [
    'Le dépôt',
    'Les portes',
    'toolchains Rust',
    'Cycle de travail',
    "Discipline d'investigation",
    'pièges',
    "n'est pas vérifié",
    'Écarts assumés',
  ];
  const titres = [...agents.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  for (const attendu of attendus) {
    assert.ok(titres.some(t => t.includes(attendu)),
      `section « ${attendu} » absente de ${AGENTS} (titres : ${titres.join(' | ')})`);
  }
});

test('les commandes npm citées existent', () => {
  const scripts = JSON.parse(lire('package.json')).scripts;
  const cites = new Set([...agents.matchAll(/npm run ([a-z][\w:-]*)/g)].map(m => m[1]));
  assert.ok(cites.size >= 2, `commandes « npm run » attendues, trouvé ${[...cites].join(', ')}`);
  for (const nom of cites) {
    assert.ok(nom in scripts,
      `AGENTS.md documente « npm run ${nom} », qui n'existe pas dans package.json. `
      + `Scripts réels : ${Object.keys(scripts).join(', ')}`);
  }
});

test('les commandes cargo citées sont des sous-commandes réelles', () => {
  // Liste blanche vérifiée : `cargo` ne signale pas une sous-commande inexistante
  // tant qu'on ne l'exécute pas, et on ne va pas lancer `cargo build` dans un test.
  const REELLES = new Set([
    'test', 'build', 'check', 'clippy', 'fmt', 'run', 'tree', 'metadata', 'doc',
  ]);
  const cites = new Set([...agents.matchAll(/cargo ([a-z]+)/g)].map(m => m[1]));
  assert.ok(cites.size >= 3, `commandes cargo attendues, trouvé ${[...cites].join(', ')}`);
  for (const sous of cites) {
    assert.ok(REELLES.has(sous), `« cargo ${sous} » n'est pas une sous-commande connue`);
  }
  // Sans ces deux-là, la section « portes » ne décrit plus les portes.
  assert.match(agents, /cargo fmt --check/);
  assert.match(agents, /cargo clippy --all-targets -- -D warnings/);
});

test('les chemins cités existent', () => {
  // On ne contrôle que les chemins dont le premier segment est un répertoire
  // réel de premier niveau du dépôt. `dists/` (arborescence apt) ou `pool/main`
  // n'en sont pas, et `tauri-cli/...` désigne un crate publié hors du dépôt.
  const racine = new Set([
    ...fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'node_modules')
      .map(e => e.name),
  ]);
  const cites = new Set(
    [...agents.matchAll(/`([A-Za-z0-9_][\w./-]*)`/g)]
      .map(m => m[1])
      .filter(p => p.includes('/') && racine.has(p.split('/')[0]) && !/[*?]/.test(p)));

  assert.ok(cites.size >= 3, `chemins cités attendus, trouvé ${[...cites].join(', ')}`);
  for (const p of cites) {
    assert.ok(fs.existsSync(path.join(ROOT, p)),
      `AGENTS.md cite « ${p} », qui n'existe pas dans le dépôt`);
  }
});

test('aucun compte de tests dans le fichier', () => {
  // « 109 tests », « 237 tests » : faux au prochain ajout. Un fichier
  // d'instructions qui ment sur ses propres chiffres est le pire défaut
  // possible — on lui fait confiance, donc on ne vérifie pas.
  const faux = [...agents.matchAll(/(\d+)\s+(tests?|suites?|assertions?)/gi)];
  assert.deepEqual(faux.map(m => m[0]), [],
    `AGENTS.md ne doit citer aucun nombre de tests (trouvé : `
    + `${faux.map(m => m[0]).join(', ')})`);
});

test('les seuils Rust cités sont ceux réellement déclarés', () => {
  const cargo = lire('src-tauri/Cargo.toml');
  const declare = /rust-version\s*=\s*"([\d.]+)"/.exec(cargo)[1];
  assert.ok(agents.includes(`≥ ${declare}`),
    `AGENTS.md doit annoncer le MSRV réellement déclaré (${declare})`);
  // Le seuil du binaire n'est pas un champ Cargo : il est dans un commentaire.
  const binaire = /exige rustc >= ([\d.]+)/.exec(cargo);
  assert.ok(binaire, 'le seuil du binaire doit rester documenté dans Cargo.toml');
  assert.ok(agents.includes(`≥ ${binaire[1]}`),
    `AGENTS.md doit annoncer le seuil du binaire (${binaire[1]})`);
});

test('les liens de AGENTS.md résolvent', () => {
  // AGENTS.md renvoie vers README.md et DECISIONS.md pour le « pourquoi ». Si ces
  // liens se cassent, l'agent perd le contexte sans s'en apercevoir.
  const liens = [...agents.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map(m => m[1]);
  for (const l of liens) {
    assert.ok(fs.existsSync(path.join(ROOT, l.split('#')[0])),
      `lien mort dans AGENTS.md : ${l}`);
  }
});

/* ----------------------------------------------------------- anti-artefact */

test('aucun caractère asiatique glissé dans le texte', () => {
  const coupables = [];
  for (const zone of ZONES) {
    for (const f of fichiersSous(zone)) {
      lire(f).split('\n').forEach((l, i) => {
        if (CJK.test(l)) coupables.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`);
      });
    }
  }
  assert.deepEqual(coupables, [],
    `caractères asiatiques dans du texte français/anglais :\n`
    + coupables.map(c => `  ${c}`).join('\n')
    + '\n  (légitimes uniquement dans src-tauri/ : tests de noms de fichiers Unicode)');
});

test('le scan anti-artefact sait détecter un CJK', () => {
  // Un garde qui ne peut pas échouer ne prouve rien : on vérifie qu'il
  // attraperait bien un caractère glissé, en lui en donnant un. Le témoin est
  // lui aussi écrit en échappements, sinon ce fichier contiendrait des CJK.
  assert.ok(CJK.test('caractere : \u6df1\u5904'),
    'la regex doit détecter du CJK');
  assert.ok(!CJK.test('éàçùôûî -- accents, tiret cadratin, \u00a9'),
    'la regex ne doit pas confondre accents et ponctuation avec du CJK');
  // Et que le périmètre inclut bien les fichiers texte, et exclut src-tauri.
  const cibles = fichiersSous('web');
  assert.ok(cibles.some(f => f.endsWith('.js')), 'le scan doit atteindre web/*.js');
  assert.ok(cibles.some(f => f.endsWith('.html')), 'le scan doit atteindre web/*.html');
  assert.ok(!ZONES.includes('src-tauri'),
    'src-tauri doit rester hors des zones : ses CJK sont des tests volontaires '
    + 'de noms de fichiers Unicode');
});
