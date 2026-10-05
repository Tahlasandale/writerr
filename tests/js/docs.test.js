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
