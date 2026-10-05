/* Câblage entre `src-tauri/src/main.rs` et le JS du runtime.
 *
 * POURQUOI DES TESTS STATIQUES. Les wrappers `#[tauri::command]` vivent dans le
 * binaire, derrière le feature `app` : ils exigent GTK et WebKit. La suite
 * `cargo test` teste `commands.rs` — pur, injectable, sans runtime — et donc
 * JAMAIS `main.rs`. Un oubli de câblage y est invisible : le bureau a pu être
 * totalement inutilisable (aucune interaction avec le disque) pendant que
 * quatre cents tests passaient. Aucun test ne peut rien voir de l'intérieur,
 * alors on analyse les deux côtés comme du texte et on les confronte.
 *
 * Les quatre règles, et ce que chacune attrape :
 *   1. annotées == enregistrées  -> une commande jamais enregistrée, ou un nom
 *      enregistré qui ne pointe sur rien ;
 *   2. chaque `invoke` du JS est enregistré -> le bug le plus grave : le nom
 *      d'une commande est le nom de la FONCTION (`tauri-macros-2.7.1`,
 *      `command/wrapper.rs:294-298` fait `stringify!(#ident)` hors attribut
 *      `rename`). Un préfixe de travers = « command not found » au clic ;
 *   3. chaque wrapper délègue à `commands::` -> un wrapper qui refait la
 *      logique dans le binaire est du code non testable, et c'est ainsi
 *      qu'une URL put être validée sans jamais être ouverte ;
 *   4. aucun nom en double -> `generate_handler!` compile en un `match` sur le
 *      nom de la commande (`command/handler.rs:174-181`) : le second bras
 *      devient inatteignable et le premier l'emporte, sans le moindre avertis-
 *      sement à l'exécution.
 *
 * DÉLÉGUER EST LA RÈGLE DU DÉPÔT (`DECISIONS.md`, « Les commandes Tauri sont
 * des wrappers, pas les fonctions testées ») : `&Ctx` n'implémente pas
 * `CommandArg`, Tauri n'accepte que `State<'_, T>`, donc le wrapper déballe
 * l'état et délègue. Un wrapper qui ne délègue à rien est soit inutile, soit
 * une promesse non tenue au code qu'il est censé appeler.
 *
 * Les regex sont tolérantes à la mise en forme : rien n'est ancré sur une
 * indentation ni sur un numéro de ligne. Aucun décompte de tests n'est codé en
 * dur — les listes sont lues, jamais comptées à l'avance.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_RS = 'src-tauri/src/main.rs';
const lire = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const mainRs = lire(MAIN_RS);

/* Le JS est énuméré, jamais figé dans une liste : un sixième fichier ajouté à
 * `web/` doit être analysé sans qu'on ait pense à le nommer ici. C'est
 * exactement le genre d'oubli que ce fichier existe pour attraper. */
const jsRuntime = fs.readdirSync(path.join(ROOT, 'web'))
  .filter(n => n.endsWith('.js'))
  .sort()
  .map(n => ({ nom: `web/${n}`, src: lire(path.join('web', n)) }));

const ligneDe = (src, index) => src.slice(0, index).split('\n').length;

/* ------------------------------------------------------------------ extracteurs */

/** `#[tauri::command]`, puis la signature qui suit (éventuels autres attributs
 *  et qualificatifs `pub`/`default`/`async` tolérés). */
const ATTRIBUT_COMMANDE = /#\s*\[\s*tauri\s*::\s*command\b([^\]]*)\]/g;
const SIGNE_FN = /^(?:\s*#\s*\[[^\]]*\])*\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/;

/**
 * Les commandes déclarées par une annotation, avec le nom que le JS invoque :
 * celui de la fonction, sauf `rename = "…"` qui le remplace. `debut` est
 * l'index du premier caractère du corps, pour l'extraction de test 3.
 */
function commandesAnnotees(src) {
  const trouvees = [];
  for (const m of src.matchAll(ATTRIBUT_COMMANDE)) {
    const apres = src.slice(m.index + m[0].length);
    const sig = SIGNE_FN.exec(apres);
    if (!sig) continue; // attribut sans fonction derrière : ce n'est pas une commande
    const rename = /\brename\s*=\s*"([^"]+)"/.exec(m[1]);
    trouvees.push({
      fn: sig[1],
      nom: rename ? rename[1] : sig[1],
      debut: m.index + m[0].length + sig[0].length,
    });
  }
  return trouvees;
}

/** La liste de `tauri::generate_handler![…]`, dans l'ordre, commentaires retirés. */
const GENERATE_HANDLER = /tauri\s*::\s*generate_handler\s*!\s*\[([\s\S]*?)\]/;

function listeEnregistree(src) {
  const bloc = GENERATE_HANDLER.exec(src);
  if (!bloc) return [];
  return bloc[1]
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Les mêmes entrées, résolues vers le nom JS. `nom === null` = entrée sans
 *  fonction correspondante dans le fichier (le nom enregistré n'existe pas). */
function commandesEnregistrees(src, annotees) {
  const parFn = new Map(annotees.map(a => [a.fn, a.nom]));
  return listeEnregistree(src).map(entree => {
    const fn = entree.split('::').pop(); // un chemin (`commands::x`) désigne son dernier segment
    return { entree, fn, nom: parFn.get(fn) ?? null };
  });
}

/** Le corps d'une fonction : du premier `{` après sa signature à son `}`
 *  correspondant. Les commentaires et les littéraux sont sautés, sinon une
 *  accolade dans `format!("{action} : {err}")` décale tout le comptage. */
const JETON = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|r\#*"[\s\S]*?"\#*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

function corpsDe(src, depuis) {
  const ouvert = src.indexOf('{', depuis);
  if (ouvert < 0) return null;
  let prof = 0;
  for (let i = ouvert; i < src.length; i++) {
    JETON.lastIndex = i;
    const jeton = JETON.exec(src);
    if (jeton && jeton.index === i) { i += jeton[0].length - 1; continue; }
    const c = src[i];
    if (c === '{') prof++;
    else if (c === '}' && --prof === 0) return src.slice(ouvert + 1, i);
  }
  return null;
}

/* ------------------------------------------------- extracteurs JS : les invocations */

/* Deux formes, et il faut les deux. `web/app.js` invoque la plupart des
 * commandes littéralement (`invoke('read_note', …)`) mais aussi par une boucle :
 *
 *     ['get_config','set_config','list_tree','create_dir','app_version']
 *       .forEach(k => { TauriAdapter.prototype[k] = () => invoke(k); });
 *
 * Un extracteur qui ne lit que `invoke('…')` voit ZERO de ces cinq commandes et
 * laisse passer exactement le bug qu'il est censé attraper. D'où les deux
 * passes : les littéraux passés à `invoke`, et les littéraux d'un tableau dont
 * les éléments sont ensuite passés à `invoke` par la boucle. */
const INVOKE_LITTERAL = /(?<![\w.$])invoke\s*\(\s*(['"])([A-Za-z_]\w*)\1/g;
const TABLEAU_BOUCLE = /\[\s*([^[\]]*?)\s*\]\s*\.\s*forEach\s*\(\s*([A-Za-z_]\w*)\s*=>/g;

/** Les noms passés à `invoke`, avec leurs sites d'appel. `indirectes` compte
 *  ceux qui ne sont venus que d'un tableau (la forme boucle) : c'est le
 *  témoin que la passe indirecte fait son travail, sans quoi le test 2 ne
 *  couvrirait plus que la moitié des commandes. */
function invocationsJs() {
  const noms = new Map();
  const indirectes = new Set();
  const noter = (nom, fichier, ligne, forme) => {
    if (!noms.has(nom)) noms.set(nom, []);
    noms.get(nom).push(`${fichier}:${ligne} (${forme})`);
    if (forme === 'boucle') indirectes.add(nom);
  };
  for (const { nom: fichier, src } of jsRuntime) {
    for (const m of src.matchAll(INVOKE_LITTERAL)) {
      noter(m[2], fichier, ligneDe(src, m.index), 'littéral');
    }
    for (const m of src.matchAll(TABLEAU_BOUCLE)) {
      const [, contenu, variable] = m;
      // Le tableau n'est une liste de commandes que si la boucle les invoque.
      const passe = new RegExp(`(?<![\\w.$])invoke\\s*\\(\\s*${variable}\\b`).test(src);
      if (!passe) continue;
      for (const l of contenu.matchAll(/(['"])([A-Za-z_]\w*)\1/g)) {
        noter(l[2], fichier, ligneDe(src, m.index), 'boucle');
      }
    }
  }
  return { noms, indirectes };
}

const annotees = commandesAnnotees(mainRs);
const enregistrees = commandesEnregistrees(mainRs, annotees);
const nomEnregistre = new Set(enregistrees.filter(r => r.nom).map(r => r.nom));
const { noms: invoques, indirectes } = invocationsJs();

/* ------------------------------------------------------------------ les tests */

test('toute commande annotée est enregistrée, et rien n’est enregistré en trop', () => {
  const nomAnnote = new Set(annotees.map(a => a.nom));
  const orphelines = enregistrees.filter(r => !r.nom).map(r => r.entree);
  const absent = [...nomAnnote].filter(n => !nomEnregistre.has(n));

  const ecarts = [];
  if (absent.length) {
    // `generate_handler!` retombe sur `_ => return false` : la commande compile,
    // le binaire démarre, et l'invocation seule échoue, sans trace côté Rust.
    ecarts.push(`annotées mais absentes de generate_handler! : ${absent.join(', ')}`);
  }
  if (orphelines.length) {
    ecarts.push(`enregistrées sans fonction correspondante dans ${MAIN_RS} : ${orphelines.join(', ')}`);
  }
  assert.equal(ecarts.length, 0,
    `les deux ensembles doivent être égaux.\n  ${ecarts.join('\n  ')}\n`
    + `  Annotées : ${[...nomAnnote].sort().join(', ')}\n`
    + `  Enregistrées : ${[...nomEnregistre].sort().join(', ') || '(aucune)'}`);
});

test('tout ce que le JS invoque est une commande enregistrée', () => {
  // Témoin de l'extracteur indirect : sans cette porte, un extracteur réduit à
  // `invoke('…')` passerait au vert en ignorant toute la forme par boucle.
  assert.ok(indirectes.size > 0,
    `aucune invocation n'a été trouvée par la forme « tableau.forEach(k => invoke(k)) ». `
    + `Cette forme existe dans web/app.js ; si elle a disparu, c'est l'extracteur qu'il `
    + `faut mettre à jour, pas le test qu'il faut affaiblir.`);

  for (const [nom, sites] of [...invoques].sort(([a], [b]) => (a < b ? -1 : 1))) {
    assert.ok(nomEnregistre.has(nom),
      `le JS invoque « ${nom} » (${sites.join(', ')}) mais aucune commande enregistrée ne `
      + `porte ce nom : l'appel échoue en « command not found ». Le nom d'une commande est `
      + `le nom de sa fonction Rust (tauri-macros, command/wrapper.rs:294-298), donc le `
      + `wrapper doit s'appeler exactement comme le JS l'invoque. Commandes enregistrées : `
      + `${[...nomEnregistre].sort().join(', ')}.`);
  }
});

test('aucun wrapper ne fait sa logique lui-même', () => {
  // `Ok_` et `Err_` sont les enveloppes de transport, pas de la logique : les
  // construire à la main est précisément ce que fait un wrapper qui délègue…
  // mais aussi ce que ferait un wrapper qui n'a rien à déléguer.
  const ENVELOPPE = new Set(['Ok_', 'Err_']);

  for (const a of annotees) {
    const corps = corpsDe(mainRs, a.debut);
    assert.ok(corps, `le corps de \`${a.fn}\` est introuvable dans ${MAIN_RS} : `
      + `l'extracteur ne suit plus la mise en forme du fichier.`);
    const delegue = [...corps.matchAll(/commands\s*::\s*([A-Za-z_]\w*)\s*(?:::)?\s*\(/g)]
      .map(m => m[1])
      .filter(n => !ENVELOPPE.has(n));
    assert.ok(delegue.length > 0,
      `le wrapper \`${a.fn}\` n'appelle aucune fonction de \`commands::\` : sa logique vit `
      + `dans le binaire, donc hors de portée de \`cargo test\` (le feature \`app\` exige GTK). `
      + `DECISIONS.md impose que le wrapper ne fasse que déballer l'état et déléguer.`);
  }
});

test('aucun nom de commande en double', () => {
  // `generate_handler!` produit un `match` sur le nom (tauri-macros,
  // command/handler.rs:174-181). Deux bras identiques : le second est
  // inatteignable, le premier l'emporte, et le second wrapper n'est jamais
  // appelé — un avertissement de compilateur au mieux, rien à l'exécution.
  const vues = new Map();
  for (const r of enregistrees) {
    const liste = vues.get(r.nom ?? `?${r.entree}`) ?? [];
    liste.push(r.entree);
    vues.set(r.nom ?? `?${r.entree}`, liste);
  }
  const doublons = [...vues].filter(([, liste]) => liste.length > 1)
    .map(([nom, liste]) => `${nom} (${liste.join(', ')})`);
  assert.deepEqual(doublons, [],
    `un nom de commande ne peut pas apparaître deux fois dans generate_handler! :\n  `
    + doublons.join('\n  '));
});