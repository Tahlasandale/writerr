// Recherche plein texte 100 % JS, sans dépendance (spec §5.8).
// Normalisation via WD.norm (casse + accents), correspondance par préfixe de mot,
// titre pondéré ×3, score décroissant puis updatedAt.
//
// Index : par document, un Map(terme -> {n: nombre d'occurrences, p: 1re position,
// t: présent dans le titre}). On ne stocke PAS toutes les positions : uniquement la
// première (pour le snippet) et le compte (pour le score). Sans cela, 5 000 notes
// de 2 000 mots consomment 10 millions d'entrées et l'indexation dépasse 30 s.
(function (root) {

  var WORD = /[\p{L}\p{N}]+/gu;
  var BOOST = 3;   // poids du titre
  var CAP = 10;    // au-delà, une répétition n'apporte plus grand-chose

  function SearchIndex(norm) {
    this._norm = norm;
    this._docs = new Map();   // id -> {id, title, content, terms:Map, updatedAt}
  }

  // texte normalisé -> Map(terme -> [positions])
  SearchIndex.prototype._scan = function (text) {
    var n = this._norm(text), out = new Map(), m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(n)) !== null) {
      var a = out.get(m[0]);
      if (a === undefined) out.set(m[0], [m.index]);
      else a.push(m.index);
    }
    return out;
  };

  SearchIndex.prototype.add = function (doc) {
    if (!doc || doc.id === undefined || doc.id === null) throw new Error('id manquant');
    return this.update(doc);
  };

  SearchIndex.prototype.update = function (doc) {
    var id = String(doc.id);
    var title = doc.title || '';
    var content = doc.content || '';
    var terms = new Map();
    var body = this._scan(content), m;

    WORD.lastIndex = 0;
    var nt = this._norm(title);
    while ((m = WORD.exec(nt)) !== null) {
      var w = m[0], e = terms.get(w);
      if (e === undefined) terms.set(w, { n: 1, p: 0, t: true });
      else { e.n++; e.t = true; }
    }
    body.forEach(function (positions, term) {
      var e = terms.get(term);
      if (e === undefined) terms.set(term, { n: positions.length, p: positions[0], t: false });
      else e.n += positions.length;
    });

    this._docs.set(id, {
      id: id,
      title: title,
      content: content,
      terms: terms,
      updatedAt: doc.updatedAt || 0,
    });
    return this;
  };

  SearchIndex.prototype.remove = function (id) {
    this._docs.delete(String(id));
    return this;
  };

  SearchIndex.prototype.get = function (id) { return this._docs.get(String(id)); };
  SearchIndex.prototype.size = function () { return this._docs.size; };

  SearchIndex.prototype._markdownFree = function (text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^#{1,6} +/gm, '')
      .replace(/^> +/gm, '')
      .replace(/^(\s*)([-*]|\d+\.) +/gm, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
  };

  // environ 80 caractères autour de la 1re occurrence, marqueurs Markdown retirés
  SearchIndex.prototype._snippet = function (doc, term) {
    var plain = this._markdownFree(doc.content);
    var at = this._norm(plain).indexOf(term);
    if (at < 0) return (plain.replace(/\s+/g, ' ').trim().slice(0, 80)) || doc.title || '';
    var start = Math.max(0, at - 30), end = Math.min(plain.length, at + term.length + 50);
    var s = plain.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) s = '…' + s;
    if (end < plain.length) s = s + '…';
    return s;
  };

  // chaque terme doit être un préfixe d'au moins un mot (ET logique)
  SearchIndex.prototype.query = function (q, opts) {
    var limit = (opts && opts.limit) || 20;
    var terms = (this._norm(q || '').match(WORD) || []);
    if (!terms.length) return [];
    var out = [];
    this._docs.forEach(function (doc) {
      var score = 0, ok = true;
      for (var i = 0; i < terms.length; i++) {
        var term = terms[i], best = 0, matched = false;
        doc.terms.forEach(function (e, word) {
          if (word.lastIndexOf(term, 0) !== 0) return;   // préfixe de mot uniquement
          matched = true;
          var s = Math.min(e.n, CAP) * (e.t ? BOOST : 1);
          if (s > best) best = s;
        });
        if (!matched) { ok = false; return; }
        score += best;
      }
      if (!ok) return;
      out.push({ id: doc.id, title: doc.title, snippet: this._snippet(doc, terms[0]), score: score, _u: doc.updatedAt });
    }, this);
    out.sort(function (a, b) { return b.score - a.score || b._u - a._u; });
    return out.slice(0, limit).map(function (r) { delete r._u; return r; });
  };

  var api = { SearchIndex: SearchIndex };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WDSEARCH = api;
})(typeof window !== 'undefined' ? window : globalThis);