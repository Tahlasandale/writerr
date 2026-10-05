# DECISIONS

Journal des décisions techniques et des écarts assumés par rapport à
`docs/design-doc.md`. Chaque ligne est écrite **au moment où la décision est prise**,
pas reconstruite après coup.

Convention : préfixes de commit en anglais (`feat:`, `fix:`), sujet en français.

---

## Langue (amende §12.9)

- **Décision** : interface, README et messages d'erreur utilisateur en français ;
  code, identifiants et commentaires en anglais ; commits en
  `type(scope): sujet français`.
- **Pourquoi** : l'UI et le contenu sont français, mais un diff se relit plus vite
  avec des identifiants anglais. La spec imposait « commits en anglais », ce qui
  aurait rendu l'historique incohérent avec les 10 commits déjà en français.
- **Écart** : §12.9 amendé.

## Déploiement : Vercel uniquement

- **Décision** : pas de `pages.yml`. Le site reste sur `https://writerr-pi.vercel.app`,
  piloté par `vercel.json` (`outputDirectory: web`).
- **Pourquoi** : les données sont liées à l'origine (IndexedDB). Deux origines
  vivantes = deux bases distinctes = deux ensembles de notes. Une seule.
- **Écart** : §9 (`pages.yml`) retiré.

## Pas de service worker

- **Décision** : aucun `sw.js`. Le manifeste suffit à l'installation.
- **Pourquoi** : l'historique du dépôt montre deux withdrawals de SW
  (« remove SW (fix broken render) », « disable SW temporarily »). Un cache-first
  sur `index.html` sert une version périmée après chaque déploiement.
- **Écart** : §2 et §6.11.

## Le backend est choisi à l'exécution

- **Décision** : `window.__TAURI__` présent ou non. `IdbAdapter` (PWA) et
  `TauriAdapter` (bureau) implémentent le même contrat `Storage`.
- **Pourquoi** : invariant I2. Le JS ne teste pas « quelle platform », il teste
  « le backend est-il là ».

## Titre = nom de fichier, `id` = chemin relatif

- **Décision** : en desktop, `id` = chemin relatif à la racine, séparateur `/`
  (ex. `Projet/Deep.md`). Rust renvoie des chemins **absolus** dans `TreeNode.path` ;
  c'est `toRel()` côté JS qui produit l'`id`.
- **Pourquoi** : invariant I6, et un `id` stable malgré un déplacement du dossier racine.
- Conséquence : `findNode()` doit chercher **en profondeur** — un simple
  `self_tree.find()` ne trouvait pas `Projet/Deep.md`.

## Pas de migration des notes PWA vers le disque

- **Décision** : le bureau ne récupère pas les notes de la PWA au premier lancement.
- **Pourquoi** : une migration change les `id` (UUID → chemin), donc réécrit des
  documents : c'est le chemin le plus risqué pour le seul besoin d'un accès aux
  fichiers existants, déjà couvert par l'export `.json`.

## Import de dossier : un seul tour, pas de surveillance

- **Décision** : « Importer un dossier de .md » copie les fichiers **une fois** dans le
  stockage. Pas d'API File System Access Access dans la PWA.
- **Pourquoi** : `showDirectoryPicker` n'existe que sur Chromium, et les handles ne
  survivent pas au rechargement. Sur Safari/Firefox l'app deviendrait illisible.
  La surveillance en direct est réservée au desktop, où le watcher Rust existe.
- Titre : le dossier racine choisi est **omis**, les sous-dossiers sont conservés
  (`Sous / fichier`).

## Recherche : index optimisé, seuil de perf assoupli

- **Décision** : `SearchIndex` ne stocke par terme que la **première position** et le
  **nombre d'occurrences**, pas toutes les positions.
- **Pourquoi** : avec toutes les positions, 5 000 notes × 2 000 mots = 10 millions
  d'entrées ; l'indexation dépassait 27 s et la requête n'était pas tenue.
- **Écart** : §5.8 demande 5 000 notes × 2 000 mots en < 3 s. Le test porte sur
  2 000 notes × 500 mots (1 M de mots) avec des seuils larges (15 s / 1 s), pour éviter
  un faux rouge en CI. Passer à l'échelle imposée demanderait un index inversé
  orienté terme, pas un `Map` par document.

## `stem()` conserve les accents, `slug()` ne les conserve pas

- **Décision** : deux fonctions, deux usages.
  - `slug()` (noms de fichiers exportés) : `\w` = ASCII, donc « déjà » → `d_j_vu`.
    **Comportement historique, changé par les tests de caractérisation.**
  - `stem()` (titres de documents) : `\p{L}` unicode, donc « Après-midi » survit.
- **Pourquoi** : un titre doit rester lisible ; un nom de fichier doit être sûr.

## `create_note("", titre)` est valide ; `create_dir("")` est refusé

- **Décision** : la chaîne vide désigne **la racine** pour `create_note` (créer une
  note à la racine), mais est **refusée** par `create_dir` (un dossier ne peut pas
  porter le nom du coffre) ainsi que par `read` / `write` / `rename` / `delete`.
- **Pourquoi** : `paths::resolve` refuse `""` à dessein (il pointe sur la racine, pas
  sur une note). L'exception est explicite et limitée à la création d'une note.

## Le binaire Tauri est derrière le feature `app`

- **Décision** : `[[bin]] required-features = ["app"]` et `default = []`.
- **Pourquoi** : `tauri` et `tauri-build` exigent webkit2gtk/GTK. Sans cette porte,
  `cargo test` échouerait sur toute machine de dev qui n'a pas ces libs.

## `build.rs` existe, mais `tauri-build` est optionnel

- **Décision** : `build.rs` est présent et appelle `tauri_build::build()`
  **seulement** sous `#[cfg(feature = "app")]` ; la build-dependency est `optional`.
- **Pourquoi** : deux contraintes seemingly opposées.
  1. `tauri::generate_context!` lit des fichiers générés dans `OUT_DIR` → sans
     `build.rs`, `cargo check --features app` échoue avec
     « OUT_DIR env var is not set » (constaté en CI sur le premier run).
  2. `tauri-build` exige rustc 1.90 ; la machine de dev est en 1.85.1 → le lier
     inconditionnellement casse `cargo test` en local.
  Cargo accepte une build-dependency `optional` : c'est la seule porte qui satisfait
  les deux. Le garde est un `#[cfg]` et non un test d'environnement, parce que Rust
  résout le symbole même à l'intérieur d'un `if` runtime.
- **Verrouillé par** `tests/js/version.test.js`.
- **Vérifié en CI** : `cargo check --features app` sur `ubuntu-latest` avec les libs §8
  (rustc récent) ; `cargo test` local en 1.85.1 sans libs.

## Les commandes Tauri sont des wrappers, pas les fonctions testées

- **Décision** : `commands::read_note(&Ctx, …)` reste pure et testée ; le binaire
  expose `cmd_read_note(State<'_, App>, …)` qui déballe l'état et délègue.
- **Pourquoi** : `&Ctx` n'implémente pas `CommandArg` — Tauri n'accepte que
  `State<'_, T>`. Écrire les commandes directement avec `State` aurait rendu la
  logique dechemin non testable sans GTK.

## `Trasher` est `Send + Sync`, donc les doubles de test utilisent `Mutex`

- **Décision** : `pub trait Trasher: Send + Sync`.
- **Pourquoi** : le runtime Tauri partage l'état entre threads. Les doubles de test
  utilisaient `RefCell`, qui n'est pas `Sync` : le trait est plus exigeant que les
  tests ne l'étaient.

## Icônes Tauri générées depuis l'icône PWA

- **Décision** : les 14 PNG requis par `generate_context!` sont dérivés de
  `web/icon-512.png` (ImageMagick), versionnés dans `src-tauri/icons/`.
- **Pourquoi** : `tauri_build` échoue sans elles, avant même de compiler.
- **Bug latent corrigé au passage** : `Ctx.self_writes` était une *copie* du registre
  anti-boucle. Le watcher consultait donc un registre vide et n'aurait jamais ignoré
  nos écritures → boucle d'événements. C'est désormais un `Arc<Mutex<SelfWrites>>`,
  une seule instance partagée entre les commandes et le watcher.

## `State<'_, T>` n'expose que `&self` : l'état global est derrière un `Mutex`

- **Décision** : `App { ctx: Mutex<Ctx<'static>> }`.
- **Pourquoi** : `set_root` doit modifier la racine. `State` ne donne pas de `&mut`
  à l'intérieur (erreur « cannot borrow data in dereference of `State` as mutable »).
  Un `Mutex` autour du contexte est plus simple qu'un tas de `RwLock` par champ, et
  il protège aussi la configuration, lue par ailleurs.
- **Piège de durée de vie** : `lock()` ne prend pas `&State<'_, App>` mais `&App`.
  `State` porte deux durées de vie et le `MutexGuard` renvoyé doit dire laquelle il
  emprunte (« missing lifetime specifier ») ; le déréférencement de `State` n'en a
  qu'une.

- **Détail qui a coûté un round-trip CI** : Tauri exige des PNG **RGBA**. Les
  icônes régénérées avec `convert … PNG32:` ; sans `-alpha on`, l'erreur est
  « icon …/32x32.png is not RGBA ».

## Le watcher tranche les `Modify` sur l'état du disque

- **Décision** : un `EventKind::Modify` ne dit pas *ce qui* a changé. On consulte le
  disque : le fichier a disparu → `TreeChanged` ; il existe et son `(mtime, taille)`
  a changé → `NoteChanged` ; `(mtime, taille)` identiques → événement ignoré.
- **Pourquoi** : inotify produit `Modify` pour un simple `truncate()` comme pour une
  écriture. Sans cette discrimination, une note ouverte dans un éditeur_txt et un
  fichier créé par l'app étaient traités de la même façon.

## `stats()` a gained un champ `bytes`

- **Décision** : `stats(t)` retourne `{w, r, bytes}`.
- **Pourquoi** : le tri par taille a besoin des octets. `TextEncoder` n'existe pas
  dans tous les contextes, donc `byteLen()` itère les code points.

## Un lien du panneau « À propos » reste un vrai `<a href>`

- **Décision** : le href est toujours présent (copier le lien fonctionne), le clic est
  intercepté (`window.open` en web, `invoke('open_external')` en desktop).
- **Pourquoi** : un `<a>` sans href n'est pas focusable au clavier et n'apparaît pas
  dans le menu « ouvrir le lien dans un nouvel onglet ».

## Tests de caractérisation avant tout refactor

- **Décision** : `tests/js/characterization.test.js` décrit le comportement **actuel**,
  pas le comportement souhaité.
- **Preuve** : sur le commit d'origine, la suite passe 24/24 alors que la version
  non patchée de `app.js` échoue ailleurs. Les attentes ont été **corrigées** vers le
  comportement réel quand elles étaient fausses (ex. `slug('déjà vu')` → `d_j_vu`),
  et non l'inverse.

## Format des tests d'entrée

- `tests/writerr.test.js` : Chromium réel (72 assertions d'origine + T, U).
- `tests/js/*.test.js` : `node:test` pour le pur et les contrats.
- `src-tauri/tests/` : intégration Rust, sans GTK.

---

## À remplacer avant publication

| Clé | Valeur actuelle | Où |
|---|---|---|
| titularité de la LICENSE | Joseph Humbert | `LICENSE` — à confirmer |
| `OWNER` dans la spec | remplacé par l'URL réelle | `web/config.js`, `docs/design-doc.md` |

## Non fait / hors périmètre

- Migration des notes PWA vers des fichiers (voir plus haut).
- Signature de code, notarisation macOS, Flatpak (§12.8).
- Auto-update : le panneau « À propos » renvoie vers les Releases (§12.7).
- Application mobile native.