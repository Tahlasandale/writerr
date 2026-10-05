# SPEC AGENT — Writer Deck : PWA + application desktop Tauri (TDD, one-shot)

> ⚠️ **Ce document est la SPEC D'ORIGINE, pas l'état actuel du code.**
> Il a été écrit avant l'implémentation et décrit donc un état qui n'existe pas :
> `index.html` à la racine du dépôt (aujourd'hui `web/index.html`), `sw.js` et
> `pages.yml` (abandonnés), `rayon` et `notify-debouncer-full` (retirés),
> le placeholder `OWNER` (remplacé), et des seuils de performance qui n'ont pas
> été tenus tels quels.
> **Pour savoir ce qui est réellement en place, et pourquoi : [`DECISIONS.md`](../DECISIONS.md).**

> **Destinataire : un agent IA de développement autonome.**
> Ce document est ta seule source de vérité. Tu n'as **aucune question à poser** : toute ambiguïté est tranchée en §12. Si un point reste ouvert, choisis l'option la plus simple et note-la dans `DECISIONS.md`.
> Les mots **DOIT / NE DOIT PAS / PEUT** ont leur sens RFC 2119.

---

## 0. Entrée, mission, livrables

**Entrée** : un fichier `index.html` monofichier (~26 Ko, JS vanilla, zéro dépendance) = la PWA « Writer Deck » : éditeur Markdown WYSIWYG par ligne (`contenteditable`, un `<div class="l">` par ligne), commandes `/`, plan (ToC), thème, masquage auto de l'UI, import/export, persistance IndexedDB (repli `localStorage`).

**Mission** : à partir de cette PWA, produire dans **un seul dépôt** :
1. la **PWA** (comportement et rendu **identiques**, + 3 ajouts : recherche, tri, panneau « À propos & téléchargements ») ;
2. l'**app desktop Tauri 2 (Rust)** qui réutilise **le même frontend**, mais stocke les notes en **fichiers `.md` dans un dossier** avec arborescence, tri, recherche instantanée, surveillance du disque ;
3. la **CI/CD GitHub** (tests, release automatique des binaires, déploiement de la PWA sur GitHub Pages) ;
4. un `README.md` (français), un `DECISIONS.md`.

**Méthode imposée : TDD strict** (§4). Aucun code de production sans test rouge préalable, sauf glue UI listée en §6 (couverte par la checklist §11).

---

## 1. Invariants (NE DOIT PAS être violé)

- **I1** — Aucun changement visuel ni de comportement d'édition : mêmes classes CSS, mêmes variables, mêmes raccourcis, mêmes commandes `/`, mêmes exports. Le code d'édition (`html`, `render`, `split`, `fix`, slash, cases à cocher, ToC) est **déplacé tel quel**, pas réécrit.
- **I2** — Un seul frontend (`web/`) pour PWA et desktop. Le backend est choisi à l'exécution (`window.__TAURI__` présent ou non).
- **I3** — Zéro requête réseau au runtime (polices locales, pas de CDN, pas de télémétrie).
- **I4** — Aucune perte de données : écritures atomiques, suppression vers la corbeille système.
- **I5** — Le dossier de notes ne contient que des fichiers de l'utilisateur (`.md`/`.txt`) ; config et caches vivent dans le répertoire de config de l'OS.
- **I6** — Titre d'un document = **nom du fichier** (sans extension) ; `id` = chemin relatif à la racine, séparateur `/`.

---

## 2. Arborescence cible

```
writer-deck/
├─ web/                       # frontend partagé (servi tel quel par la PWA ET par Tauri)
│  ├─ index.html              # balisage + CSS (inline autorisé) ; plus de <script> inline
│  ├─ lib.js                  # fonctions PURES (script classique, expose window.WD ET module.exports)
│  ├─ storage.js              # interface Storage + adaptateurs IDB / Tauri
│  ├─ search.js               # SearchIndex (pur, sans dépendance)
│  ├─ app.js                  # logique UI existante (déplacée) + glue
│  ├─ config.js               # window.WD_CONFIG = { repo, version }
│  ├─ fonts/                  # JetBrains Mono woff2 (400, 400 italic, 700) + OFL.txt
│  ├─ manifest.json, sw.js, icons/   # PWA (créer si absents)
├─ tests/js/                  # node:test
├─ src-tauri/
│  ├─ Cargo.toml, tauri.conf.json, build.rs, capabilities/default.json, icons/
│  └─ src/ { main.rs, lib.rs, paths.rs, names.rs, notes.rs, config.rs, selfwrites.rs, watcher.rs, commands.rs }
├─ package.json               # scripts : test, test:js, test:rust, lint
├─ .github/workflows/ { ci.yml, release.yml, pages.yml }
├─ README.md, DECISIONS.md, LICENSE (MIT, titulaire laissé `OWNER`)
```

Les scripts sont des **scripts classiques** (pas de modules ES) pour que `file://` et la CSP `script-src 'self'` fonctionnent. `lib.js`/`search.js` se terminent par :
`if (typeof module!=='undefined') module.exports = WD; else window.WD = WD;`

---

## 3. Placeholders à ne PAS inventer

| Clé | Valeur par défaut | Où |
|---|---|---|
| `repo` | `https://github.com/OWNER/writer-deck` | `web/config.js` (**source unique** des liens GitHub) |
| `version` | `0.1.0` | `web/config.js`, `package.json`, `tauri.conf.json`, `Cargo.toml` (test de cohérence §5.6) |
| Identifiant Tauri | `app.writerdeck.desktop` | `tauri.conf.json` |

Liste-les en tête du `README.md` sous « À remplacer avant publication ».

---

## 4. Protocole TDD (ordre d'exécution OBLIGATOIRE)

Pour chaque étape : **écris les tests → vérifie qu'ils échouent pour la bonne raison → implémente le minimum → vert → refactor**. Commits atomiques `test:` puis `feat:`.

| Étape | Contenu | Gate (commande qui DOIT passer) |
|---|---|---|
| **S0** | Squelette : `package.json`, `cargo new`, CI vide. Déplacer `index.html` → `web/`, extraire le `<script>` en `web/app.js`, les fonctions pures en `web/lib.js` **sans en changer le corps** | Page s'ouvre comme avant |
| **S1** | **Tests de caractérisation** de l'existant (§5.1), écrits **avant** toute modification des fonctions pures | `npm run test:js` |
| **S2** | Rust : `names`, `paths` (§5.2) | `cargo test` |
| **S3** | Rust : `notes` (§5.3), `config` (§5.4), `selfwrites` (§5.5) | `cargo test` |
| **S4** | JS : `sortNodes`, `SearchIndex`, `reconcile`, `about` (§5.7–5.9) | `npm run test:js` |
| **S5** | JS : contrat `Storage` + adaptateurs (§5.10) | `npm run test:js` |
| **S6** | Rust : `commands`, `watcher` (intégration sur dossier temporaire) | `cargo test` |
| **S7** | Glue UI (§6), polices locales, panneau À propos (§7), PWA (manifest/sw) | Checklist §11 |
| **S8** | Tauri : `tauri.conf.json`, capabilities, CSP, icônes, build | `cargo check` + `cargo tauri build --no-bundle` si les libs système sont présentes |
| **S9** | CI/CD, README, DECISIONS | `npm test` + `cargo clippy -- -D warnings` + `cargo fmt --check` |

**Commandes** : `npm test` = `npm run test:js && cargo test --manifest-path src-tauri/Cargo.toml`. JS : `node --test tests/js/`. Dev-dépendances JS autorisées : **`fake-indexeddb` uniquement**. Dev-dépendances Rust : `tempfile`.

---

## 5. Spécifications testables

Format : *Given / When / Then*. Chaque ligne = **au moins un test nommé** (nom suggéré en `code`).

### 5.1 Caractérisation de l'existant (`tests/js/characterization.test.js`)
À écrire **d'abord**, en exécutant le code d'origine ; ajoute au moins 5 cas par fonction en plus de ceux-ci.

| Fonction | Entrée | Attendu |
|---|---|---|
| `html` | `'---'` | `cls:'hr'`, `ind:0` |
| `html` | `'# Titre'` | `cls:'h1'`, `h` = `<span class="m"># </span>Titre` |
| `html` | `''` | `h` = `<br>` |
| `html` | `'  - [x] fait'` | `cls` contient `li` et `done`, `ind:2`, `data-g="☑"` |
| `html` | `'**a** et *b*'` | `<b>a</b>` et `<i>b</i>` avec marqueurs `.m` |
| `html` | `'<b>'` | échappé (`&lt;b&gt;`) |
| `plain` | `'- [x] a'` / `'## T'` / `'**g**'` | `'☑ a'` / `'T'` / `'g'` |
| `toHtml` | liste imbriquée, citation, `---` | `<ul><li>`, `<blockquote>`, `<hr>`, document complet `lang="fr"` |
| `stats` | `''` / 200 mots / 201 mots | `{w:0,r:0}` / `r:1` / `r:2` |
| `norm` | `'Élève'` | `'eleve'` |
| `slug` | `'Mon doc: v2!'` / `''` | `'Mon_doc_v2_'` / `'document'` |

Ces fonctions (`html, plain, toHtml, stats, norm, slug, esc`) sont **pures** : refactore-les seulement pour qu'elles ne dépendent plus du DOM (`esc`, `toHtml` etc. prennent leurs entrées en paramètres).

### 5.2 Rust — `names.rs` & `paths.rs`
`names::sanitize_file_name(title) -> String`
- retire `/ \ : * ? " < > |` et NUL ; conserve accents/Unicode ;
- trim espaces et points en début/fin ; vide → `"Sans titre"` ;
- tronque à 120 **caractères** (jamais au milieu d'un code point) ;
- noms réservés Windows (`CON`, `NUL`…) suffixés `_`.

`names::unique_name(dir, base, ext) -> String` : `Note` existe → `Note (2)`, puis `Note (3)`… (insensible à la casse).

`paths::resolve(root, rel) -> Result<PathBuf, FsError>`
- OK : `a/b.md`, `./a.md` ; `FsError::Escape` : `../x`, `a/../../x`, chemin absolu, NUL ;
- refuse un **lien symbolique** dont la cible sort de la racine ;
- ne suit jamais un symlink de dossier hors racine lors du listing.

### 5.3 Rust — `notes.rs`
| Fonction | Comportement testé |
|---|---|
| `list_tree(root)` | ne liste que `.md`/`.txt` ; ignore tout nom commençant par `.` ; garde les dossiers vides ; renvoie `{name,path,is_dir,modified,created?,size,children}` (ms epoch) ; tri alphabétique naturel par défaut ; racine inexistante → `FsError::NotFound` ; dossier avec fichier illisible → l'ignore sans échouer |
| `read_note` | retourne le texte UTF‑8 ; `\r\n` → `\n` ; fichier non-UTF‑8 → `FsError::NotText` ; > 20 Mo → `FsError::TooLarge` |
| `write_note_atomic` | écrit via `.<nom>.wd-tmp` **dans le même dossier** puis `fsync` + `rename` ; **aucun** `.wd-tmp` ne subsiste, même si l'écriture échoue ; écrase l'existant ; crée les dossiers parents ; contenu final identique octet pour octet |
| `create_note(dir,title)` | nom assaini + unique, extension `.md`, fichier vide ; renvoie le `path` final |
| `create_dir(path)` | crée ; si existe → nom unique ; refuse hors racine |
| `rename(from,to_title)` | garde l'extension et le dossier ; unique en cas de collision (sauf renommage identique) ; fonctionne sur un dossier ; renvoie le nouveau `path` |
| `delete(path, &dyn Trasher)` | appelle `Trasher::trash` ; **jamais** `remove_file` ; refuse la racine elle-même ; implémentation réelle = crate `trash` |

### 5.4 Rust — `config.rs`
Fichier `config.json` dans `dirs::config_dir()/writer-deck/`. Champs : `root: Option<String>`, `theme: Option<"light"|"dark">`, `idle_ms: u32 (déf. 6000)`, `sort: {key,dir}` (déf. `modified`/`desc`), `last_open: Option<String>`.
- absent → valeurs par défaut ; JSON corrompu → défauts **sans panique** et ancien fichier renommé `.bak` ;
- sauvegarde atomique (réutilise `write_note_atomic`) ;
- champs inconnus conservés (forward-compat).

### 5.5 Rust — `selfwrites.rs` (anti-boucle du watcher)
`SelfWrites::mark(path, now)` / `is_self(path, now) -> bool`
- vrai si marqué depuis < 1500 ms, faux après ; `is_self` ne consomme pas la marque ; purge des entrées expirées ; horloge **injectée** (pas de `sleep` dans les tests).

### 5.6 Cohérence de version (`tests/js/version.test.js`)
`package.json`, `web/config.js`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` portent la **même** version.

### 5.7 JS — `WD.sortNodes(nodes, {key,dir})` (récursif)
- **dossiers toujours avant fichiers**, quel que soit `dir` ;
- `name` : naturel (`note2` < `note10`), insensible à la casse et aux accents ;
- `modified` / `created` / `size` numériques ; `ext` puis nom ;
- stable ; n'altère pas l'entrée (renvoie une copie) ; trie aussi les `children`.

### 5.8 JS — `SearchIndex` (`search.js`) — **pas de FlexSearch**
API : `add({id,title,content})`, `update(…)`, `remove(id)`, `query(q,{limit=20}) -> [{id,title,snippet,score}]`.
- normalisation = `WD.norm` (casse + accents) ;
- multi-termes en **ET** ; chaque terme en **préfixe** de mot (`algo` trouve « Algorithmique ») ;
- titre pondéré ×3 par rapport au corps ; ordre = score décroissant puis `updatedAt` ;
- `snippet` ≈ 80 caractères autour de la 1re occurrence, marqueurs Markdown retirés ;
- `update` remplace sans doublon ; `remove` supprime ; requête vide → `[]` ;
- **perf** : 5 000 notes de 2 000 mots indexées en < 3 s, requête < 30 ms (test avec seuil large pour éviter les faux rouges en CI).

### 5.9 JS — `WD.reconcile` et `WD.about`
`reconcile({dirty, knownMtime, diskMtime}) -> 'none'|'reload'|'conflict'`
- `diskMtime == knownMtime` → `none` ; changé et `!dirty` → `reload` ; changé et `dirty` → `conflict`.

`WD.detectPlatform(ua) -> 'linux'|'windows'|'mac'|'android'|'ios'|'unknown'`.
`WD.aboutLinks(cfg) -> {repo, releases, latest, issues}` : dérivés de `cfg.repo` (`/releases`, `/releases/latest`, `/issues`) ; `repo` sans slash final ; si `repo` contient `OWNER` → `placeholder:true`.
`WD.assetHint(platform) -> string` : `linux` → « AppImage, .deb ou .rpm » ; `windows` → « installeur .msi/.exe » ; `mac` → « .dmg » ; `android|ios` → « Installez la PWA depuis votre navigateur » ; autre → « Voir la page des versions ».

### 5.10 JS — Contrat `Storage` (`tests/js/storage.contract.js`)
Une **suite de contrat unique** exécutée sur chaque adaptateur : `IdbAdapter` (via `fake-indexeddb`) et `TauriAdapter` (avec un `invoke` factice adossé à un FS en mémoire).

Interface :
```js
Storage = {
  kind: 'idb' | 'tauri',
  supportsFolders: boolean,
  init(): Promise<void>,
  list(): Promise<Node[]>,                 // arbre (plat pour idb)
  read(id): Promise<{content, mtime}>,
  write(id, content): Promise<{mtime}>,
  create(dirId, title): Promise<{id}>,
  rename(id, newTitle): Promise<{id}>,
  remove(id): Promise<void>,
  onExternalChange(cb): () => void,        // retourne un unsubscribe ; no-op pour idb
}
```
Tests : create→read vide ; write→read identique ; rename conserve le contenu et change l'id ; remove→absent de `list` ; collision de titre → suffixe `(2)` ; `list` renvoie `modified` numérique. Spécifique Tauri : mappe chaque méthode sur la commande Rust correspondante (§5.11) avec les bons arguments.
`IdbAdapter` = le code IndexedDB/localStorage **existant** déplacé (`supportsFolders:false`, `id` = UUID existant, migration `mwd:docs` conservée).

### 5.11 Rust — `commands.rs` & `watcher.rs`
Commandes (`#[tauri::command]`, erreurs sérialisées `{code,message}`) : `get_config`, `set_config`, `pick_root` (dialogue natif), `set_root`, `list_tree`, `read_note`, `write_note`, `create_note`, `create_dir`, `rename`, `delete`, `open_external`, `app_version`.
- Toute commande qui prend un chemin passe par `paths::resolve` ; **test** : un chemin hors racine → `Escape`, aucun effet disque ;
- appelée sans racine définie → `FsError::NoRoot` ;
- `write_note` appelle `SelfWrites::mark` ;
- `open_external(url)` n'accepte que `https://github.com/…` (test : `http://`, `file://`, `javascript:`, autre domaine → refus) et ouvre via le système (`tauri-plugin-opener` utilisé **côté Rust uniquement**, non exposé au JS).

Watcher (`notify` + debounce 300 ms) : émet `tree-changed` (créations/suppressions/renommages) et `note-changed {path, mtime}` ; ignore `.wd-tmp`, fichiers cachés et `is_self`. Test d'intégration sur dossier temporaire avec **timeout 5 s** : création externe → `tree-changed` ; modification externe → `note-changed` ; écriture via `write_note_atomic` → **aucun** événement.

---

## 6. Glue UI (S7) — modifications autorisées de l'existant

Seul point d'insertion : `dbAll/dbPut/dbDel/open/create/save/list`. Le reste de `app.js` est **inchangé**.

1. **Démarrage** : `store = window.__TAURI__ ? TauriAdapter : IdbAdapter ; await store.init()`. En desktop sans racine configurée → écran minimal (même style) « Choisir le dossier de notes » → `pick_root`.
2. **Documents en mémoire** : métadonnées seules ; `content` chargé à l'ouverture (`await store.read(id)`), `open()` devient `async`. Les identifiants deviennent des chaînes (UUID ou chemin).
3. **Titre** (`#title`) : en mode fichier, renommage **debounce 800 ms** via `store.rename`, l'`id` du document courant est mis à jour ; jamais de renommage pendant la frappe d'un caractère composé (`isComposing`).
4. **Arbre** (uniquement si `store.supportsFolders`) dans `#list` : lignes indentées 14 px/niveau, `▸/▾` pour plier, état plié persisté ; clic = ouvrir ; actions `+ Nouveau document`, `+ Nouveau dossier`, `×` avec la **même confirmation « sûr ? »** qu'aujourd'hui (corbeille). En PWA, la liste plate actuelle reste **identique**.
5. **Tri** : `<select id="sort">` (Nom · Modifié · Créé · Taille · Extension) + bouton ↑/↓, **même style** que `#idle` ; persistance : `config.json` (desktop) / `localStorage mwd:sort` (PWA). Sur `idb`, `size`/`ext` sont masqués.
6. **Recherche** : `<input id="q" type="search" placeholder="Rechercher…">` en tête du tiroir Documents ; index construit au démarrage (desktop : lecture de tous les `.md` via `read_note` en parallèle par lots de 32) puis mis à jour sur `save`, `rename`, `remove`, `note-changed`, `tree-changed` ; résultats = titre + snippet, clic = ouvrir, `Échap` efface ; filtrage dès la 1re frappe, sans bouton.
7. **Modifications externes** (desktop) : `reconcile` → `reload` silencieux (conserver la position du curseur par numéro de ligne) ; `conflict` → bandeau discret dans `#bot` « Modifié ailleurs · Recharger · Garder » ; **aucune fusion**.
8. **Fermeture** : `pagehide` (existant) + en desktop `getCurrentWindow().onCloseRequested` → `preventDefault`, `await save()`, puis `destroy()`.
9. **Polices** : retirer le `<link>` Google Fonts ; `@font-face` vers `web/fonts/*.woff2` (récupérer via `npm i -D @fontsource/jetbrains-mono`, copier les `.woff2` 400/400i/700 latin + latin-ext et `OFL.txt`, puis désinstaller le paquet).
10. **Nettoyage desktop** : le `<meta Cache-Control>` peut rester (inoffensif) ; `manifest.json`/`sw.js` ne sont enregistrés que si `!window.__TAURI__`.
11. **PWA** : si `manifest.json` est absent, le créer (`name`, `short_name`, `display:standalone`, `theme_color:#000000`, `background_color`, icônes 192/512) ; `sw.js` = cache-first des fichiers de `web/` (versionné par `WD_CONFIG.version`).

---

## 7. Panneau « À propos & téléchargements » (menu discret)

- **Accès** : bouton `#bAbout` « À propos & téléchargements » tout en bas du tiroir Documents (après « Masquage de l'interface »), style `.act-b`. Aucun autre point d'entrée : l'écran principal reste **inchangé**.
- **Panneau** : `<aside id="about" class="dr">` (tiroir gauche, même mécanique `panel('#about')` que `#docs`/`#toc`).
- **Contenu** (tout en français, sobre, même typographie) :
  1. **Writer Deck** — une ligne de présentation ; version (`WD_CONFIG.version`, ou `app_version` en desktop) ;
  2. **Code source sur GitHub** → `aboutLinks().repo` ;
  3. **Télécharger la dernière version** → `aboutLinks().latest`, avec la phrase `assetHint(detectPlatform(navigator.userAgent))` ;
  4. **Toutes les versions** → `…/releases` ; **Signaler un problème** → `…/issues` ;
  5. **Installer l'application web** (PWA uniquement) : bouton visible seulement si l'événement `beforeinstallprompt` a eu lieu ;
  6. **Raccourcis** : liste des commandes `/` et des raccourcis (lue depuis le tableau `CMD` existant, pas dupliquée) ;
  7. Si `placeholder:true` : afficher les liens grisés avec la mention « dépôt non configuré » (ne jamais pointer vers `OWNER`).
- **Liens** : PWA → `<a target="_blank" rel="noopener noreferrer">` ; desktop → `invoke('open_external', {url})` (interception du clic).
- **Tests** : §5.9 (logique) ; le rendu DOM est vérifié par la checklist §11.

---

## 8. Configuration Tauri 2

- `tauri.conf.json` : `build.frontendDist: "../web"`, `app.withGlobalTauri: true`, fenêtre `1000×760` min `360×480`, titre « Writer Deck », `bundle.targets: ["appimage","deb","rpm"]`, `identifier` §3.
- **CSP** : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost`.
- **Capabilities** (`default.json`) : uniquement `core:default`, `core:window:allow-destroy`, `core:event:default`, `dialog:allow-open` ; **pas** de plugin `fs` ni `shell` exposé au JS.
- Plugins Rust : `tauri-plugin-dialog`, `tauri-plugin-opener` (usage interne).
- Dépendances Rust : `serde`, `serde_json`, `notify`, `notify-debouncer-full`, `trash`, `dirs`, `thiserror`, `rayon` (optionnel) ; versions = dernières stables, verrouillées par `Cargo.lock` (à committer).
- Libs système Linux pour la CI : `libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.

---

## 9. CI/CD (`.github/workflows`)

- **`ci.yml`** (push + PR) : Node LTS → `npm ci` → `npm run test:js` ; ubuntu + libs §8 → `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- **`release.yml`** (tag `v*`) : `tauri-apps/tauri-action` sur matrice ubuntu (obligatoire) + windows/macos (`continue-on-error: true`) ; crée une **GitHub Release** avec AppImage, `.deb`, `.rpm` ; notes générées automatiquement.
- **`pages.yml`** (push `main`) : publie `web/` sur GitHub Pages (c'est la PWA installable).
- Permissions minimales (`contents: write` uniquement dans `release.yml`).

---

## 10. Performances et robustesse (tests ou mesures consignées dans `README`)

Binaire < 15 Mo · ouverture d'une note < 50 ms · `list_tree` de 10 000 fichiers < 500 ms (test Rust avec seuil large) · aucun `unwrap()` hors tests · aucune panique sur entrée utilisateur.

---

## 11. Checklist d'acceptation (Definition of Done)

**Automatisé** : `npm test` vert · `cargo clippy -- -D warnings` propre · `cargo fmt --check` propre · tests §5 tous présents.

**Manuel / smoke (à exécuter et à cocher dans `DECISIONS.md`)** — si le runtime graphique est indisponible, l'indiquer explicitement :
- [ ] PWA : ouverture, frappe, accents, `/`, cases à cocher, ToC, thème, masquage UI — **identiques** à l'`index.html` d'origine (comparer côte à côte).
- [ ] PWA : aucun appel réseau (onglet Réseau vide hors fichiers locaux), police JetBrains Mono active.
- [ ] Recherche et tri fonctionnent en PWA (liste plate) et en desktop (arbre).
- [ ] Desktop : choix du dossier, création/renommage/suppression (corbeille), dossiers imbriqués.
- [ ] Desktop : modifier un `.md` depuis un éditeur externe → rechargement ou bandeau « Modifié ailleurs ».
- [ ] Desktop : fermer la fenêtre en pleine frappe → contenu bien enregistré.
- [ ] Panneau « À propos » : accessible uniquement via le tiroir Documents ; liens GitHub / Releases corrects ; grisés si `OWNER`.
- [ ] Import `.json` d'une sauvegarde PWA → chaque document devient un `.md` nommé d'après son titre.

---

## 12. Décisions déjà prises (ne pas rouvrir)

1. Titre = nom de fichier ; `id` = chemin relatif (I6).
2. **Un seul dossier racine** en v1.
3. Recherche **100 % JS** maison (§5.8), pas de `tantivy`, pas de FlexSearch.
4. Pas de front-matter ajouté aux notes ; `createdAt/updatedAt` = métadonnées du FS (ou valeurs IDB en PWA).
5. Pas de fusion de conflits : l'utilisateur choisit Recharger ou Garder.
6. Scripts classiques (pas d'ES modules), un seul fichier CSS inline conservé dans `index.html`.
7. Hors périmètre : synchronisation, rendu Markdown riche (tableaux, images), plugins, application mobile native, auto-update intégré (le panneau À propos renvoie vers les Releases).
8. Signature de code, notarisation macOS, Flatpak : non traités (mentionnés « à venir » dans le README).
9. Langue : interface, README et messages d'erreur utilisateur en **français** ; code et commits en anglais.
10. En cas de dépendance indisponible (réseau), ne pas la remplacer par un CDN : implémenter la fonction minimale en interne et le noter dans `DECISIONS.md`.

**Fin de spec. Commence par S0, ne t'arrête qu'après S9, et termine par un résumé : tests passés, cases §11 cochées, écarts éventuels.**
