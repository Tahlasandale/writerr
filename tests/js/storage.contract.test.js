// Contrat Storage (spec §5.10) : une SEULE suite exécutée sur chaque adaptateur.
// Ajout d'un adaptateur = ajouter une ligne dans ADAPTERS, rien d'autre.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IdbAdapter, MemAdapter } = require('../../web/storage.js');

// IndexedDB simulé : la seule dépendance de dev autorisée par la spec.
require('fake-indexeddb/auto');

function fakeWindow() {
  const store = new Map();
  return {
    indexedDB: globalThis.indexedDB,
    localStorage: {
      _m: store,
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
  };
}

let seq = 0;
const ADAPTERS = [
  // base IndexedDB unique par instance : fake-indexeddb partage le stockage global
  { nom: 'IdbAdapter', kind: 'idb', supportsFolders: false, make: () => new IdbAdapter(fakeWindow(), 'test-' + (++seq)) },
  { nom: 'MemAdapter', kind: 'mem', supportsFolders: true, make: () => new MemAdapter() },
];

const setup = async a => { const s = a.make(); await s.init(); return s; };
const fresh = nom => new IdbAdapter(fakeWindow(), 'test-' + (++seq));

for (const A of ADAPTERS) {
  test('contrat ' + A.nom + ' : kind, supportsFolders, API complète', async () => {
    const s = await setup(A);
    assert.equal(s.kind, A.kind);
    assert.equal(s.supportsFolders, A.supportsFolders);
    for (const m of ['init', 'list', 'read', 'write', 'create', 'rename', 'remove', 'onExternalChange']) {
      assert.equal(typeof s[m], 'function', A.nom + '.' + m + ' existe');
    }
    assert.equal(typeof s.onExternalChange(function () { }), 'function', 'onExternalChange renvoie un unsubscribe');
  });

  test('contrat ' + A.nom + ' : create puis read renvoie un contenu vide', async () => {
    const s = await setup(A);
    const { id } = await s.create(null, 'Première note');
    assert.ok(id, 'un id est renvoyé');
    const r = await s.read(id);
    assert.equal(r.content, '');
    assert.equal(typeof r.mtime, 'number');
  });

  test('contrat ' + A.nom + ' : write puis read est identique', async () => {
    const s = await setup(A);
    const { id } = await s.create(null, 'Note');
    const content = '# Titre\n\n- [x] fait\n\n**gras** et *ital*\n';
    const w = await s.write(id, content);
    assert.equal(typeof w.mtime, 'number');
    const r = await s.read(id);
    assert.equal(r.content, content, 'contenu identique octet pour octet');
  });

  test('contrat ' + A.nom + ' : rename conserve le contenu et renvoie un id exploitable', async () => {
    const s = await setup(A);
    const { id } = await s.create(null, 'Avant');
    await s.write(id, 'contenuImportant');
    const r = await s.rename(id, 'Après');
    assert.equal(r.id, id, 'l\'id reste le même pour cet adaptateur plat');
    assert.equal((await s.read(r.id)).content, 'contenuImportant', 'contenu conservé');
    const names = (await s.list()).map(n => n.title || n.name);
    assert.ok(names.includes('Après'), 'nouveau titre visible dans list()');
    assert.ok(!names.includes('Avant'));
  });

  test('contrat ' + A.nom + ' : remove retire le document de list()', async () => {
    const s = await setup(A);
    const a = (await s.create(null, 'Un')).id;
    const b = (await s.create(null, 'Deux')).id;
    assert.equal((await s.list()).length, 2);
    await s.remove(a);
    const rest = await s.list();
    assert.equal(rest.length, 1, 'un seul document restant');
    assert.ok(!rest.some(n => String(n.id) === String(a)));
    await s.remove(b);
    assert.equal((await s.list()).length, 0);
  });

  test('contrat ' + A.nom + ' : list renvoie modified numérique et nodes triables', async () => {
    const s = await setup(A);
    await s.create(null, 'A');
    await s.create(null, 'B');
    const list = await s.list();
    assert.equal(list.length, 2);
    for (const n of list) {
      assert.equal(typeof n.modified, 'number', 'modified numérique');
      assert.ok(Array.isArray(n.children));
      assert.equal(typeof n.is_dir, 'boolean');
    }
  });
}

test('IdbAdapter : collision de titres → suffixe (2)', async () => {
  const s = fresh();
  await s.init();
  const a = (await s.create(null, 'Note')).id;
  const b = (await s.create(null, 'Note')).id;
  const c = (await s.create(null, 'Note')).id;
  const titles = (await s.list()).map(n => n.title).sort();
  assert.deepEqual(titles, ['Note', 'Note (2)', 'Note (3)']);
  assert.equal(new Set([a, b, c]).size, 3, 'ids distincts');
});

test('IdbAdapter : collision de titres insensible à la casse', async () => {
  const s = fresh();
  await s.init();
  await s.create(null, 'note');       // créé en premier : il garde son titre
  await s.create(null, 'NOTE');       // collision -> suffixe
  const titles = (await s.list()).map(n => n.title);
  assert.deepEqual(titles.sort(), ['NOTE (2)', 'note']);
});

test('IdbAdapter : les accents sont conservés dans les titres', async () => {
  const s = fresh();
  await s.init();
  const { id } = await s.create(null, 'Après-midi chez Éloïse');
  assert.equal((await s.list()).find(n => n.id === id).title, 'Après-midi chez Éloïse');
  await s.rename(id, 'Réunion : échos');
  assert.equal((await s.list()).find(n => n.id === id).title, 'Réunion échos',
    'accents conservés, mais les caractères interdits aux noms de fichiers retirés');
});

test('IdbAdapter : rename vers un titre déjà pris → suffixe, et libère l\'ancien', async () => {
  const s = fresh();
  await s.init();
  const a = (await s.create(null, 'Alpha')).id;
  await s.create(null, 'Beta');
  await s.rename(a, 'Beta');
  const titles = (await s.list()).map(n => n.title).sort();
  assert.deepEqual(titles, ['Beta', 'Beta (2)']);
  await s.rename(a, 'Gamma');
  assert.ok((await s.list()).map(n => n.title).includes('Gamma'));
});

test('IdbAdapter : titre vide → "Sans titre"', async () => {
  const s = fresh();
  await s.init();
  const { id } = await s.create(null, '');
  assert.equal((await s.list()).find(n => n.id === id).title, 'Sans titre');
});

test('IdbAdapter : read/rename/write sur un id inconnu rejette', async () => {
  const s = fresh();
  await s.init();
  await assert.rejects(() => s.read('inexistant'), /introuvable/);
  await assert.rejects(() => s.write('inexistant', 'x'), /introuvable/);
  await assert.rejects(() => s.rename('inexistant', 'y'), /introuvable/);
});

test('IdbAdapter : repli localStorage quand IndexedDB est indisponible', async () => {
  const win = {
    get indexedDB() { throw new Error('bloqué'); },
    localStorage: (() => {
      const m = new Map();
      return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
    })(),
  };
  const s = new IdbAdapter(win);
  await s.init();                       // ne doit pas lever
  const { id } = await s.create(null, 'Repli');
  await s.write(id, 'écrit en repli');
  const relu = await s.read(id);
  assert.equal(relu.content, 'écrit en repli');
  assert.equal((await s.list()).length, 1);
});

test('IdbAdapter : migration des données localStorage existantes', async () => {
  const win = fakeWindow();
  win.localStorage.setItem('mwd:docs', JSON.stringify([{ id: 'legacy-1', title: 'Ancienne', content: 'vieux', updatedAt: 1 }]));
  // forcer le repli : on coupe IndexedDB
  const sansIdb = { get indexedDB() { throw new Error('bloqué'); }, localStorage: win.localStorage };
  const s = new IdbAdapter(sansIdb, "test-repli-" + (++seq));
  await s.init();
  const list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Ancienne');
  assert.equal((await s.read('legacy-1')).content, 'vieux');
});

test('IdbAdapter : content.stats size en octets', async () => {
  const s = fresh();
  await s.init();
  const { id } = await s.create(null, 'Mesure');
  await s.write(id, 'ééé');            // 3 caractères, 6 octets en UTF-8
  const node = (await s.list()).find(n => n.id === id);
  assert.equal(node.size, 6);
});