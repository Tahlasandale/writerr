// Tests de CARACTÉRISATION des fonctions pures existantes (§5.1 de la spec).
// Ils décrivent le comportement ACTUEL : toute modification de comportement doit
// faire échouer un test ici (invariant I1 : pas de changement d'édition).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WD = require('../../web/lib.js');

test('esc : échappe &, <, >', () => {
  assert.equal(WD.esc('<b>'), '&lt;b&gt;');
  assert.equal(WD.esc('a & b'), 'a &amp; b');
  assert.equal(WD.esc('&lt;'), '&amp;lt;');          // pas de double échappement
  assert.equal(WD.esc('rien'), 'rien');
  assert.equal(WD.esc(''), '');
});

test('html : séparateur horizontal', () => {
  const r = WD.html('---');
  assert.equal(r.cls, 'hr');
  assert.equal(r.ind, 0);
  assert.equal(r.h, '<span class="m">---</span>');
});

test('html : ligne vide → <br>', () => {
  const r = WD.html('');
  assert.equal(r.h, '<br>');
  assert.equal(r.cls, '');
  assert.equal(r.ind, 0);
});

test('html : titre H1', () => {
  const r = WD.html('# Titre');
  assert.equal(r.cls, 'h1');
  assert.equal(r.h, '<span class="m"># </span>Titre');
});

test('html : titres H2 / H3 et citation', () => {
  assert.equal(WD.html('## B').cls, 'h2');
  assert.equal(WD.html('### C').cls, 'h3');
  assert.equal(WD.html('#### D').cls, '');            // 4 # ne sont pas un titre
  const q = WD.html('> cite');
  assert.equal(q.cls, 'q');
  assert.equal(q.h, '<span class="m">&gt; </span>cite');
  assert.equal(WD.html('>sans espace').cls, '');      // il faut "> "
});

test('html : case à cocher cochée, indentée, avec glyphe', () => {
  const r = WD.html('  - [x] fait');
  assert.ok(r.cls.includes('li'));
  assert.ok(r.cls.includes('done'));
  assert.equal(r.ind, 2);
  assert.ok(r.h.includes('data-c="1"'));
  assert.ok(r.h.includes('data-g="☑"'));
  assert.ok(r.h.includes('  '), 'le retrait est conservé dans le HTML');
});

test('html : case à cocher non cochée, X majuscule accepté', () => {
  assert.ok(WD.html('- [ ] a').h.includes('data-g="☐"'));
  const x = WD.html('- [X] a');
  assert.ok(x.cls.includes('done'));
  assert.ok(x.h.includes('data-g="☑"'));
});

test('html : listes à puces et numérotée', () => {
  const b = WD.html('- puce');
  assert.equal(b.cls, 'li');
  assert.equal(b.ind, 0);
  assert.ok(b.h.includes('data-g="•"'));
  assert.equal(WD.html('* autre puce').cls, 'li');
  const n = WD.html('3. troisième');
  assert.equal(n.cls, 'li');
  assert.ok(n.h.includes('<span class="n">3. </span>'));
  assert.equal(WD.html('    - profonde').ind, 4);
});

test('html : gras et italique avec marqueurs .m', () => {
  const r = WD.html('**a** et *b*');
  assert.ok(r.h.includes('<span class="m">**</span><b>a</b>'));
  assert.ok(r.h.includes('<span class="m">*</span><i>b</i>'));
});

test('html : gras italique non géré (limite connue)', () => {
  // le triple astérisque n'est pas supporté : il reste un * littéral autour du gras
  const r = WD.html('***x***');
  assert.ok(r.h.includes('<b>x</b>'));
});

test('html : échappement du HTML brut', () => {
  assert.ok(WD.html('<script>').h.includes('&lt;script&gt;'));
  assert.ok(!WD.html('<script>').h.includes('<script>'));
});

test('norm : casse + accents retirés', () => {
  assert.equal(WD.norm('Élève'), 'eleve');
  assert.equal(WD.norm('ÀÉÎÕÜ'), 'aeiou');
  assert.equal(WD.norm('déjà VU'), 'deja vu');
  assert.equal(WD.norm(''), '');
});

test('slug : nom de fichier sûr', () => {
  assert.equal(WD.slug('Mon doc: v2!'), 'Mon_doc_v2_');
  assert.equal(WD.slug(''), 'document');
  assert.equal(WD.slug(null), 'document');
  assert.equal(WD.slug('d_j_vu'), 'd_j_vu');
  assert.equal(WD.slug('déjà vu'), 'd_j_vu', 'les accents sont retirés (\w = A-Za-z0-9_)');
  assert.equal(WD.slug('x'.repeat(100)).length, 60);
});

test('stats : comptage de mots, temps de lecture et taille en octets', () => {
  // `bytes` a été ajouté après le refactor (tri par taille) : il ne casse pas I1
  assert.deepEqual(WD.stats(''), { w: 0, r: 0, bytes: 0 });
  assert.deepEqual(WD.stats('   \n  '), { w: 0, r: 0, bytes: 6 });
  assert.equal(WD.stats('é').bytes, 2, 'accents comptés en UTF-8');
  assert.equal(WD.stats('abc').bytes, 3);
  assert.equal(WD.stats('😀').bytes, 4, 'astral : 4 octets');
  assert.equal(WD.stats('un deux trois').w, 3);
  assert.equal(WD.stats('**gras** et *ital*').w, 3);
  assert.equal(WD.stats('# Titre\n\n> cite').w, 2);
  const words = n => Array.from({ length: n }, (_, i) => 'mot' + i).join(' ');
  assert.equal(WD.stats(words(200)).r, 1);
  assert.equal(WD.stats(words(201)).r, 2);
  assert.equal(WD.stats(words(400)).r, 2);
});

test('plain : conversion en texte brut', () => {
  assert.equal(WD.plain('- [x] a'), '☑ a');
  assert.equal(WD.plain('- [ ] a'), '☐ a');
  assert.equal(WD.plain('## T'), 'T');
  assert.equal(WD.plain('# Titre'), 'Titre');
  assert.equal(WD.plain('> quote'), 'quote');
  assert.equal(WD.plain('**g**'), 'g');
  assert.equal(WD.plain('*i*'), 'i');
  assert.equal(WD.plain('---'), '———');
  assert.equal(WD.plain('  - [x] a'), '  ☑ a');
  assert.equal(WD.plain('1. un'), '1. un', 'les listes numérotées sont conservées');
});

test('plain : lignes vides et jointures', () => {
  assert.equal(WD.plain('a\n\nb'), 'a\n\nb');
  assert.equal(WD.plain(''), '');
  assert.equal(WD.plain('**a** et *b*'), 'a et b');
});

test('inl : HTML inline échappé puisbalisé', () => {
  assert.equal(WD.inl('**a**'), '<strong>a</strong>');
  assert.equal(WD.inl('*b*'), '<em>b</em>');
  assert.equal(WD.inl('<i>'), '&lt;i&gt;');
});

test('toHtml : document complet', () => {
  const out = WD.toHtml({ title: 'Mon doc', content: 'bonjour' });
  assert.ok(out.startsWith('<!DOCTYPE html>'));
  assert.ok(out.includes('<html lang="fr">'));
  assert.ok(out.includes('<title>Mon doc</title>'));
  assert.ok(out.includes('<p>bonjour</p>'));
  assert.ok(out.trimEnd().endsWith('</body></html>'));
});

test('toHtml : titres, citation, séparateur', () => {
  const out = WD.toHtml({ title: 'T', content: '# H1\n## H2\n### H3\n> q\n\n---' });
  assert.ok(out.includes('<h1>H1</h1>'));
  assert.ok(out.includes('<h2>H2</h2>'));
  assert.ok(out.includes('<h3>H3</h3>'));
  assert.ok(out.includes('<blockquote>q</blockquote>'));
  assert.ok(out.includes('<hr>'));
  assert.ok(!out.includes('<blockquote></blockquote>'), 'pas de citation vide');
});

test('toHtml : listes à puces, numérotées et imbriquées', () => {
  const out = WD.toHtml({ title: 'L', content: '- a\n- b\n  - nest\n\n1. x\n2. y' });
  assert.ok(out.includes('<ul><li>a\n</li><li>b\n<ul><li>nest\n</li></ul>\n</li></ul>'),
    'liste à puces avec sous-liste imbriquée dans le 2e <li>');
  assert.ok(out.includes('<ol><li>x\n</li><li>y\n</li></ol>'));
  assert.ok(!out.includes('<li>\n<input'), 'pas de saut de ligne entre <li> et son contenu');
});

test('toHtml : cases à cocher', () => {
  const out = WD.toHtml({ title: 'C', content: '- [ ] a\n- [x] b' });
  assert.ok(out.includes('<input type="checkbox" disabled> a'));
  assert.ok(out.includes('<input type="checkbox" disabled checked> b'));
});

test('toHtml :gras / italique et échappement', () => {
  const out = WD.toHtml({ title: 'E', content: '**b** *i*\n\n<script>' });
  assert.ok(out.includes('<strong>b</strong>'));
  assert.ok(out.includes('<em>i</em>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<p><script></p>'));
});

test('toHtml : titre absent → "Sans titre"', () => {
  assert.ok(WD.toHtml({ content: 'x' }).includes('<title>Sans titre</title>'));
});

test('uid : identifiants uniques et format UUID', () => {
  const a = WD.uid(), b = WD.uid();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});