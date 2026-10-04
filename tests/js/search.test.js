// Tests de SearchIndex (spec §5.8) : normalisation, ET logique, préfixes de mot,
// pondération du titre, snippets, mise à jour/suppression, performance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WD = require('../../web/lib.js');
const { SearchIndex } = require('../../web/search.js');

const idx = docs => docs.reduce((i, d) => i.add(d), new SearchIndex(WD.norm));

test('query vide ou sans terme → []', () => {
  const s = idx([{ id: '1', title: 'Note', content: 'du texte' }]);
  assert.deepEqual(s.query(''), []);
  assert.deepEqual(s.query('   '), []);
  assert.deepEqual(s.query('!!!'), [], 'aucun caractère alphanumérique');
});

test('trouve par contenu et par titre', () => {
  const s = idx([
    { id: 'a', title: 'Courses', content: 'lait pain' },
    { id: 'b', title: 'Idées', content: 'un projet de roman' },
  ]);
  assert.deepEqual(s.query('pain').map(r => r.id), ['a']);
  assert.deepEqual(s.query('roman').map(r => r.id), ['b']);
  assert.deepEqual(s.query('courses').map(r => r.id), ['a'], 'le titre est indexé');
});

test('plusieurs termes → ET logique', () => {
  const s = idx([
    { id: 'a', title: 'A', content: 'alpha bêta' },
    { id: 'b', title: 'B', content: 'alpha gamma' },
  ]);
  assert.deepEqual(s.query('alpha').map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(s.query('alpha bêta').map(r => r.id), ['a']);
  assert.deepEqual(s.query('alpha gamma').map(r => r.id), ['b']);
  assert.deepEqual(s.query('alpha.delta'), [], 'ET : aucun résultat si un terme manque');
});

test('correspondance par préfixe de mot', () => {
  const s = idx([{ id: 'a', title: 'X', content: 'Algorithmique avancée' }]);
  assert.deepEqual(s.query('algo').map(r => r.id), ['a'], 'algo -> Algorithmique');
  assert.deepEqual(s.query('algoi').map(r => r.id), [], 'prefixe invalide');
  assert.deepEqual(s.query('riqué').map(r => r.id), [], 'pas de suffixe');
});

test('normalisation : casse et accents', () => {
  const s = idx([{ id: 'a', title: 'Élève', content: 'ÉCRITURE accentuée' }]);
  assert.deepEqual(s.query('eleve').map(r => r.id), ['a']);
  assert.deepEqual(s.query('ÉCRITURE').map(r => r.id), ['a']);
  assert.deepEqual(s.query('ecriture').map(r => r.id), ['a']);
  assert.deepEqual(s.query('ÉLÈVE').map(r => r.id), ['a']);
});

test('le titre pèse plus que le corps (×3)', () => {
  const s = idx([
    { id: 'dans_titre', title: 'mystère', content: 'rien' },
    { id: 'dans_corps', title: 'autre', content: 'mystère et aussi dans le titre de l\'autre' },
  ]);
  const r = s.query('mystère');
  assert.equal(r[0].id, 'dans_titre', 'le titre est classé en premier');
  assert.ok(r[0].score > r[1].score, 'score du titre supérieur');
});

test('ordre : score décroissant puis updatedAt décroissant', () => {
  const s = idx([
    { id: 'faible', title: 'T', content: 'zzz commun', updatedAt: 9 },
    { id: 'fort', title: 'zzz', content: 'rien', updatedAt: 1 },
  ]);
  const r = s.query('zzz');
  assert.equal(r[0].id, 'fort');
  const egal = idx([
    { id: 'ancien', title: 'T', content: 'mot', updatedAt: 1 },
    { id: 'recent', title: 'T', content: 'mot', updatedAt: 5 },
  ]).query('mot');
  assert.deepEqual(egal.map(x => x.id), ['recent', 'ancien'], 'à score égal, le plus récent d\'abord');
});

test('limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'd' + i, title: 'T', content: 'commun' }));
  const s = idx(many);
  assert.equal(s.query('commun').length, 20, 'limit par défaut = 20');
  assert.equal(s.query('commun', { limit: 5 }).length, 5);
});

test('update remplace sans doublon', () => {
  const s = idx([{ id: 'a', title: 'Avant', content: 'alpha' }]);
  s.update({ id: 'a', title: 'Après', content: 'bêta' });
  assert.equal(s.size(), 1, 'toujours un seul document');
  assert.deepEqual(s.query('alpha'), [], 'l\'ancien contenu a disparu de l\'index');
  assert.deepEqual(s.query('bêta').map(r => r.id), ['a']);
  s.update({ id: 'a', title: 'Après', content: 'bêta bis' });
  assert.equal(s.size(), 1);
  assert.deepEqual(s.query('bis').map(r => r.id), ['a']);
});

test('remove supprime le document', () => {
  const s = idx([{ id: 'a', title: 'A', content: 'alpha' }]);
  s.remove('a');
  assert.equal(s.size(), 0);
  assert.deepEqual(s.query('alpha'), []);
  s.remove('inexistant');            // ne doit pas lever
  assert.equal(s.size(), 0);
});

test('snippet : autour de l\'occurrence, marqueurs Markdown retirés', () => {
  const s = idx([{ id: 'a', title: 'T', content: 'Intro\n\n## Titre\n\n> **important** : voir algo #1 et `code`.' }]);
  const r = s.query('algo')[0];
  assert.ok(r.snippet.includes('algo'));
  assert.ok(!r.snippet.includes('**'), 'gras retiré');
  assert.ok(!r.snippet.includes('##'), 'titre retiré');
  assert.ok(!r.snippet.includes('`'), 'code retiré');
  assert.ok(r.snippet.length <= 100, 'snippet court : ' + r.snippet.length);
});

test('snippet : aucun terme dans le corps → repli sur le titre', () => {
  const s = idx([{ id: 'a', title: 'Mon titre', content: 'rien ici' }]);
  const r = s.query('Mon titre')[0];
  assert.ok(r.snippet.length > 0);
});

test('résultat : id, title, snippet, score', () => {
  const s = idx([{ id: 'x', title: 'T', content: 'mot' }]);
  const r = s.query('mot')[0];
  assert.deepEqual(Object.keys(r).sort(), ['id', 'score', 'snippet', 'title']);
  assert.equal(r.id, 'x');
  assert.equal(r.title, 'T');
  assert.equal(typeof r.score, 'number');
});

test('performance : indexation et requête sous seuils larges (spec §5.8, voir DECISIONS.md)', () => {
  // 2 000 notes de 500 mots, vocabulaire majoritairement distinct : proportions
  // réalistes (des notes qui partagent tout leur vocabulaire ne sont pas un cas d'usage).
  const NB = 2000, NW = 500;
  const docs = Array.from({ length: NB }, (_, i) => ({
    id: 'n' + i,
    title: 'Note ' + i,
    content: Array.from({ length: NW }, (_, j) => 'mot' + i + 'x' + j).join(' '),
    updatedAt: i,
  }));
  const t0 = Date.now();
  const s = idx(docs);
  const indexMs = Date.now() - t0;
  assert.equal(s.size(), NB);
  assert.ok(indexMs < 15000, 'indexation de ' + (NB * NW / 1000) + 'k mots sous 15 s (mesuré ' + indexMs + ' ms)');
  const t1 = Date.now();
  const r = s.query('mot1999x499');
  const queryMs = Date.now() - t1;
  assert.equal(r.length, 1, 'un seul résultat pertinent');
  assert.equal(r[0].id, 'n1999');
  assert.ok(queryMs < 1000, 'requête sous 1 s (mesuré ' + queryMs + ' ms)');
});