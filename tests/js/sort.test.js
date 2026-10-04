// Tests de tri / réconciliation / panneau À propos (spec §5.7 et §5.9).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WD = require('../../web/lib.js');

const N = (name, o = {}) => Object.assign({ name, is_dir: false, modified: 100, created: 100, size: 10, children: [] }, o);
const D = (name, children = [], o = {}) => N(name, Object.assign({ is_dir: true, children }, o));

test('sortNodes : dossiers toujours avant fichiers, quel que soit le sens', () => {
  const input = [N('b.md'), D('z'), N('a.md'), D('a')];
  for (const dir of ['asc', 'desc']) {
    const out = WD.sortNodes(input, { key: 'name', dir });
    assert.equal(out[0].is_dir, true, 'dossier en premier (' + dir + ')');
    assert.equal(out[1].is_dir, true, '2e dossier en premier (' + dir + ')');
    assert.equal(out[2].is_dir, false);
  }
});

test('sortNodes : nom naturel, insensible à la casse et aux accents', () => {
  const input = [N('note10.md'), N('Note2.md'), N('éclair.md'), N('Zebre.md')];
  const asc = WD.sortNodes(input, { key: 'name', dir: 'asc' }).map(n => n.name);
  assert.deepEqual(asc, ['éclair.md', 'Note2.md', 'note10.md', 'Zebre.md']);
  const desc = WD.sortNodes(input, { key: 'name', dir: 'desc' }).map(n => n.name);
  assert.deepEqual(desc, ['Zebre.md', 'note10.md', 'Note2.md', 'éclair.md']);
});

test('sortNodes : ne modifie pas l\'entrée et renvoie une copie', () => {
  const input = [N('b.md'), N('a.md')];
  const copy = JSON.parse(JSON.stringify(input));
  const out = WD.sortNodes(input, { key: 'name', dir: 'asc' });
  assert.deepEqual(input, copy, 'entrée intacte');
  assert.notEqual(out, input, 'nouvelle liste renvoyée');
  assert.notEqual(out[0], input[0], 'nouveaux objets');
});

test('sortNodes : modified / created / size numériques, extension puis nom', () => {
  const input = [N('a.md', { modified: 5 }), N('b.md', { modified: 9 })];
  assert.deepEqual(WD.sortNodes(input, { key: 'modified', dir: 'desc' }).map(n => n.name), ['b.md', 'a.md']);
  assert.deepEqual(WD.sortNodes(input, { key: 'modified', dir: 'asc' }).map(n => n.name), ['a.md', 'b.md']);
  assert.deepEqual(WD.sortNodes([N('a', { size: 9 }), N('b', { size: 90 })], { key: 'size', dir: 'asc' }).map(n => n.name), ['a', 'b']);
  assert.deepEqual(WD.sortNodes([N('a', { created: 1 }), N('b', { created: 2 })], { key: 'created', dir: 'desc' }).map(n => n.name), ['b', 'a']);
  const byExt = WD.sortNodes([N('b.md'), N('a.txt'), N('c.md')], { key: 'ext', dir: 'asc' }).map(n => n.name);
  assert.deepEqual(byExt, ['b.md', 'c.md', 'a.txt'], 'extension par ordre alphabétique (md < txt), puis nom');
  assert.deepEqual(WD.sortNodes([N('b.md'), N('a.txt'), N('c.md')], { key: 'ext', dir: 'desc' }).map(n => n.name),
    ['a.txt', 'c.md', 'b.md'], 'sens inverse appliqué à l\'extension ET au nom de départage');
});

test('sortNodes : trie aussi les enfants (récursif)', () => {
  const input = [D('dossier', [N('z.md'), N('a.md')]), N('racine.md')];
  const out = WD.sortNodes(input, { key: 'name', dir: 'asc' });
  assert.deepEqual(out[0].children.map(n => n.name), ['a.md', 'z.md']);
  assert.equal(out[1].name, 'racine.md');
});

test('sortNodes : stable et tolérant aux entrées invalides', () => {
  assert.deepEqual(WD.sortNodes(null), []);
  assert.deepEqual(WD.sortNodes([], { key: 'name' }), []);
  const one = WD.sortNodes([N('seul.md')]);
  assert.equal(one.length, 1);
});

test('reconcile : trois issues', () => {
  assert.equal(WD.reconcile({ dirty: false, knownMtime: 5, diskMtime: 5 }), 'none');
  assert.equal(WD.reconcile({ dirty: true, knownMtime: 5, diskMtime: 5 }), 'none');
  assert.equal(WD.reconcile({ dirty: false, knownMtime: 5, diskMtime: 9 }), 'reload');
  assert.equal(WD.reconcile({ dirty: true, knownMtime: 5, diskMtime: 9 }), 'conflict');
});

test('detectPlatform', () => {
  assert.equal(WD.detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(WD.detectPlatform('Mozilla/5.0 (Windows NT 10.0)'), 'windows');
  assert.equal(WD.detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'), 'mac');
  assert.equal(WD.detectPlatform('Mozilla/5.0 (Linux; Android 14)'), 'android');
  assert.equal(WD.detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'ios');
  assert.equal(WD.detectPlatform('curl/8'), 'unknown');
  assert.equal(WD.detectPlatform(''), 'unknown');
});

test('aboutLinks : dérivés du dépôt, sans slash final', () => {
  const l = WD.aboutLinks({ repo: 'https://github.com/Tahlasandale/writerr' });
  assert.equal(l.repo, 'https://github.com/Tahlasandale/writerr');
  assert.equal(l.releases, 'https://github.com/Tahlasandale/writerr/releases');
  assert.equal(l.latest, 'https://github.com/Tahlasandale/writerr/releases/latest');
  assert.equal(l.issues, 'https://github.com/Tahlasandale/writerr/issues');
  assert.equal(l.placeholder, false);
  assert.equal(WD.aboutLinks({ repo: 'https://github.com/a/b/' }).repo, 'https://github.com/a/b');
});

test('aboutLinks : dépôt placeholder signalé', () => {
  assert.equal(WD.aboutLinks({ repo: 'https://github.com/OWNER/writer-deck' }).placeholder, true);
  assert.equal(WD.aboutLinks({}).placeholder, true);
  assert.equal(WD.aboutLinks({ repo: '' }).placeholder, true);
});

test('assetHint : par plateforme', () => {
  assert.match(WD.assetHint('linux'), /AppImage/);
  assert.match(WD.assetHint('windows'), /\.msi|\.exe/);
  assert.equal(WD.assetHint('mac'), '.dmg');
  assert.match(WD.assetHint('android'), /PWA/);
  assert.match(WD.assetHint('ios'), /PWA/);
  assert.match(WD.assetHint('unknown'), /versions/);
});