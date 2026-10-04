// Contrat Storage + adaptateur IndexedDB/localStorage (spec §5.10).
// La forme est celle de la spec : un seul adaptateur PWA ici, l'adaptateur Tauri
// branché sur src-tauri/sera validé par le même contrat.
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * IdbAdapter : le code IndexedDB / localStorage existant, sans changement
   * de comportement (invariant I1). `id` = UUID, aucune arborescence.
   * ------------------------------------------------------------------ */
  function IdbAdapter(win, dbName) {
    this._win = win || (typeof window !== 'undefined' ? window : null);
    // Nom de base par défaut inchangé (comportement existant) ; surchargeable
    // pour isoler plusieurs instances dans les tests.
    this._dbName = dbName || 'writer-deck';
    this.kind = 'idb';
    this.supportsFolders = false;
    this._db = null;
  }

  IdbAdapter.prototype._idb = function () {
    var self = this;
    return new Promise(function (res) {
      try {
        var r = self._win.indexedDB.open(self._dbName, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('docs', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  };

  IdbAdapter.prototype._tx = function (mode, f) {
    var self = this;
    return new Promise(function (res) {
      try {
        var t = self._db.transaction('docs', mode), q = f(t.objectStore('docs'));
        t.oncomplete = function () { res(q && q.result); };
        t.onerror = t.onabort = function () { res(null); };
      } catch (e) { res(null); }
    });
  };

  // repli localStorage : les helpers l/sv existent aussi dans app.js, on les refait ici
  IdbAdapter.prototype._ld = function (k, d) {
    try { var v = this._win.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  };
  IdbAdapter.prototype._sv = function (k, v) {
    try { this._win.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ }
  };

  IdbAdapter.prototype.init = function () {
    var self = this;
    return this._idb().then(function (db) {
      self._db = db;
      if (db) return self.all();
      // migration : ce qui existait en localStorage passe en IndexedDB
      var old = self._ld('mwd:docs', []);
      self._mem = old;
      return null;
    });
  };

  IdbAdapter.prototype.all = function () {
    if (!this._db) return Promise.resolve(this._mem || []);
    return this._tx('readonly', function (s) { return s.getAll(); }).then(function (r) { return r || []; });
  };

  IdbAdapter.prototype._put = function (d) {
    var self = this;
    if (!this._db) {
      var m = this._mem || (this._mem = this._ld('mwd:docs', []));
      var i = m.findIndex(function (x) { return x.id === d.id; });
      if (i >= 0) m[i] = d; else m.push(d);
      this._sv('mwd:docs', m);
      return Promise.resolve({ mtime: d.updatedAt });
    }
    return this._tx('readwrite', function (s) { return s.put(JSON.parse(JSON.stringify(d))); })
      .then(function () { return { mtime: d.updatedAt }; });
  };

  function newId() {
    var c = (typeof crypto !== 'undefined' ? crypto : null);
    if (c && c.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = Math.random() * 16 | 0;
      return (ch === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  // Nettoie un titre SANS perdre les accents (\p{L} unicode, contrairement à \w).
  // Note : le slug() historique de l'app retire les accents — comportement conservé.
  function stem(title) {
    var s = String(title || '').replace(/[^\p{L}\p{N}_\- ]+/gu, '').replace(/\s+/g, ' ').trim();
    return s || 'Sans titre';
  }

  // titre unique : "Note" -> "Note (2)" -> "Note (3)", insensible à la casse
  function uniqueTitle(all, title) {
    var base = stem(title), taken = {};
    all.forEach(function (d) { taken[String(d.title || '').trim().toLowerCase()] = true; });
    if (!taken[base.toLowerCase()]) return base;
    for (var i = 2; ; i++) {
      var cand = base + ' (' + i + ')';
      if (!taken[cand.toLowerCase()]) return cand;
    }
  }

  function toNode(d) {
    return {
      id: String(d.id),
      name: d.title || 'Sans titre',
      title: d.title || 'Sans titre',
      is_dir: false,
      modified: d.updatedAt || 0,
      created: d.createdAt || d.updatedAt || 0,
      size: statsOf(d.content).size,
      children: [],
    };
  }

  function statsOf(content) {
    var t = String(content || ''), s = statsSize(t);
    return { size: s };
  }
  function statsSize(t) { return new TextEncoder().encode(t).length; }

  IdbAdapter.prototype.list = function () {
    return this.all().then(function (all) {
      return all.map(toNode);
    });
  };

  IdbAdapter.prototype.read = function (id) {
    var self = this;
    return this.all().then(function (all) {
      var d = all.find(function (x) { return String(x.id) === String(id); });
      if (!d) throw new Error('document introuvable: ' + id);
      void self;
      return { content: d.content || '', mtime: d.updatedAt || 0 };
    });
  };

  IdbAdapter.prototype.write = function (id, content) {
    return this.all().then(function (all) {
      var d = all.find(function (x) { return String(x.id) === String(id); });
      if (!d) throw new Error('document introuvable: ' + id);
      d.content = content;
      d.updatedAt = Date.now();
      d.size = statsSize(content);
      return this._put(d).then(function () { return { mtime: d.updatedAt }; });
    }.bind(this));
  };

  IdbAdapter.prototype.create = function (dirId, title) {
    var self = this;
    void dirId;   // pas d'arborescence en PWA
    return this.all().then(function (all) {
      var t = uniqueTitle(all, title);
      var n = Date.now();
      var d = { id: newId(), title: t, content: '', createdAt: n, updatedAt: n, wordCount: 0, readingTime: 0, size: 0 };
      all.push(d);
      return self._put(d).then(function () { return { id: d.id }; });
    });
  };

  IdbAdapter.prototype.rename = function (id, newTitle) {
    return this.all().then(function (all) {
      var d = all.find(function (x) { return String(x.id) === String(id); });
      if (!d) throw new Error('document introuvable: ' + id);
      var others = all.filter(function (x) { return String(x.id) !== String(id); });
      var t = String(newTitle || '').trim();
      var base = stem(t);
      var taken = {};
      others.forEach(function (x) { taken[String(x.title || '').trim().toLowerCase()] = true; });
      if (!t || taken[base.toLowerCase()]) base = uniqueTitle(others.concat([{ title: base }]), base);
      d.title = base;
      d.updatedAt = Date.now();
      return this._put(d).then(function () { return { id: d.id }; });
    }.bind(this));
  };

  IdbAdapter.prototype.remove = function (id) {
    var self = this;
    return this.all().then(function (all) {
      var rest = all.filter(function (x) { return String(x.id) !== String(id); });
      if (!this._db) {
        this._mem = rest; this._sv('mwd:docs', rest);
        return null;
      }
      return self._tx('readwrite', function (s) { return s.delete(String(id)); });
    }.bind(this)).then(function () { return null; });
  };

  // aucune modification externe observable en PWA
  IdbAdapter.prototype.onExternalChange = function () { return function () { }; };

  /* ------------------------------------------------------------------ *
   * Adaptateur de test : même contrat, mémoire vive. Sert de doublure
   * pour TauriAdapter et à la vérification du contrat elle-même.
   * ------------------------------------------------------------------ */
  function MemAdapter() {
    this.kind = 'mem';
    this.supportsFolders = true;
    this._docs = new Map();
    this._seq = 0;
  }
  MemAdapter.prototype.init = function () { return Promise.resolve(); };
  MemAdapter.prototype.list = function () {
    var self = this;
    var out = [];
    this._docs.forEach(function (d) {
      out.push({
        id: d.id,
        name: d.title,
        title: d.title,
        is_dir: false,
        modified: d.updatedAt,
        created: d.created,
        size: statsSize(d.content),
        children: [],
      });
    });
    void self;
    return Promise.resolve(out);
  };
  MemAdapter.prototype.read = function (id) {
    var d = this._docs.get(String(id));
    if (!d) throw new Error('document introuvable: ' + id);
    return Promise.resolve({ content: d.content, mtime: d.updatedAt });
  };
  MemAdapter.prototype.write = function (id, content) {
    var d = this._docs.get(String(id));
    if (!d) throw new Error('document introuvable: ' + id);
    d.content = content; d.updatedAt = ++this._seq;
    return Promise.resolve({ mtime: d.updatedAt });
  };
  MemAdapter.prototype.create = function (dirId, title) {
    var id = 'mem-' + (++this._seq);
    this._docs.set(id, { id: id, title: stem(title), content: '', updatedAt: this._seq, created: this._seq });
    void dirId;
    return Promise.resolve({ id: id });
  };
  MemAdapter.prototype.rename = function (id, newTitle) {
    var d = this._docs.get(String(id));
    if (!d) throw new Error('document introuvable: ' + id);
    d.title = stem(newTitle);
    return Promise.resolve({ id: id });
  };
  MemAdapter.prototype.remove = function (id) { this._docs.delete(String(id)); return Promise.resolve(); };
  MemAdapter.prototype.onExternalChange = function () { return function () { }; };

  var api = { IdbAdapter: IdbAdapter, MemAdapter: MemAdapter };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WDSTORE = api;
})(typeof window !== 'undefined' ? window : globalThis);