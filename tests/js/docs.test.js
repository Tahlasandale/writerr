// Vérifie que la documentation ne ment pas : chaque lien markdown pointe vers un
// fichier existant, chaque ancre interne à une section réelle.
// // (Le README pointait vers `index.html`, déplacé dans `web/` : lien mort, jamais vu.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DOCS = ['README.md', 'DECISIONS.md', 'docs/design-doc.md'];

const slug = h => h
  .toLowerCase()
  .replace(/[`*]/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .trim()
  .replace(/\s+/g, '-');

const linksOf = file => {
  const txt = fs.readFileSync(file, 'utf8');
  return [...txt.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map(m => ({ label: m[1], target: m[2] }));
};

for (const doc of DOCS) {
  test(doc + ' : aucun lien de fichier cassé', () => {
    const base = path.dirname(path.join(ROOT, doc));
    const broken = linksOf(path.join(ROOT, doc))
      .filter(l => !/^(https?:|mailto:|#)/.test(l.target))
      .map(l => ({ ...l, resolved: path.join(base, l.target.split('#')[0]) }))
      .filter(l => l.target.split('#')[0] && !fs.existsSync(l.resolved))
      .map(l => l.target);
    assert.deepEqual(broken, [], 'liens cassés : ' + broken.join(', '));
  });

  test(doc + ' : ancres internes valides', () => {
    const full = path.join(ROOT, doc);
    const heads = [...fs.readFileSync(full, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(m => slug(m[1]));
    const bad = linksOf(full)
      .filter(l => l.target.startsWith('#') && l.target.length > 1)
      .map(l => l.target)
      .filter(a => !heads.includes(a.slice(1)));
    assert.deepEqual(bad, [], 'ancres cassées : ' + bad.join(', '));
  });
}

test('le README pointe vers les fichiers qui existent réellement', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // piege du refactor : index.html a ete deplace dans web/
  assert.ok(!/\]\(index\.html\)/.test(readme), 'le README ne doit plus pointer vers index.html à la racine');
  assert.ok(readme.includes('web/index.html'), 'il doit pointer vers web/index.html');
});

test('le README documente les trois façons de tester', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /npm run serve/, 'chemin local');
  assert.match(readme, /writerr-pi\.vercel\.app/, 'site déployé');
  assert.match(readme, /releases/, 'binaire précompilé');
  assert.match(readme, /cargo build --features app/, 'build local');
  assert.match(readme, /libwebkit2gtk/, 'prérequis GTK listés');
});

test('DECISIONS.md signale qu\'aucune recette graphique n\'est faite', () => {
  const d = fs.readFileSync(path.join(ROOT, 'DECISIONS.md'), 'utf8');
  assert.match(d, /Recette manuelle/, 'la section de recette existe');
  assert.ok(/n'a jamais été exécuté|jamais été exécuté/.test(d), 'et dit que le binaire n\'a pas été exécuté');
});

test('le README donne la procédure d\'installation par le dépôt APT', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // Une procédure d'installation qui oublie un morceau est la pire doc possible :
  // l'utilisateur échoue et n'a aucun moyen de savoir pourquoi.
  assert.match(readme, /sudo mkdir -p \/etc\/apt\/keyrings/,
    'la clé doit aller dans /etc/apt/keyrings (debian >= 11)');
  assert.match(readme, /signed-by=\/etc\/apt\/keyrings\//,
    'la source doit être contrainte par signed-by, sinon la clé devient globale au système');
  // La ligne de source doit tenir sur une seule ligne : coupée par un `\`, elle
  // est collée cassée dans le terminal et apt ne comprend plus la ligne.
  const ligneDeb = readme.split('\n').find(l => l.startsWith('echo "deb '));
  assert.ok(ligneDeb, 'la ligne de source apt est présente');
  assert.match(ligneDeb, /\[signed-by=\/etc\/apt\/keyrings\/[a-z0-9-]+\.asc\]/);
  assert.match(ligneDeb, /https:\/\/Tahlasandale\.github\.io\/writerr stable main/);
  assert.match(readme, /sudo apt install writer-deck/, 'la commande d\'installation');
  assert.match(readme, /sudo apt update && sudo apt upgrade writer-deck/,
    'la commande de mise à jour — c\'est tout l\'intérêt du dépôt');
  assert.match(readme, /writerr-apt-key\.asc/, 'le nom du fichier de clé');
  // L'empreinte annoncée doit être celle que le dépôt publie réellement, sinon
  // l'utilisateur compare deux nombres différents et ne peut plus vérifier.
  const fpr = /Clé de signature GPG :\s*([0-9A-F]{40})/
    .exec(fs.readFileSync(path.join(ROOT, '.github/scripts/apt-README.txt'), 'utf8'))[1];
  assert.ok(readme.includes(fpr),
    `le README doit annoncer l\'empreinte publiée (${fpr.slice(0, 16)}…)`);
  // v0.1.0 est le tag published, mais son .deb est ininstallable : le dire évite
  // que l'utilisateur échoue et en conclue que la procédure est fausse.
  assert.match(readme, /à partir de \*\*`v0\.1\.1`\*\*/,
    'la procédure ne vaut qu\'à partir de v0.1.1');
});

test('DECISIONS.md dit où poser le secret CI dont la release a besoin', () => {
  const rel = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const d = fs.readFileSync(path.join(ROOT, 'DECISIONS.md'), 'utf8');
  // GITHUB_TOKEN est fourni par GitHub, il n'y a rien à poser : le documenter
  // serait du bruit.
  const attendus = new Set([...rel.matchAll(/secrets\.(\w+)/g)]
    .map(m => m[1])
    .filter(n => n !== 'GITHUB_TOKEN'));
  assert.ok(attendus.size > 0, 'le workflow utilise au moins un secret à poser');
  for (const secret of attendus) {
    assert.match(d, new RegExp(secret),
      `DECISIONS.md doit mentionner le secret ${secret} : sans cela, la release échoue sur `
      + '"secret absent" et rien ne l\'explique');
  }
});
