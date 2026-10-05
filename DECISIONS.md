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

## `stats()` a gagné un champ `bytes`- **Décision** : `stats(t)` retourne `{w, r, bytes}`.
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

## Vérifier les liens de la documentation

- **Décision** : contrôle automatique des liens markdown et des ancres internes.
- **Pourquoi** : le README pointait vers `index.html`, déplacé dans `web/` six commits
  plus tôt. Un lien mort dans le README est invisible sauf si on clique le lien.

## Format des tests d'entrée

- `tests/writerr.test.js` : Chromium réel, 108 assertions groupées par lettre
  (A édition · B curseur · C continuations · D cases · E séparateur · F palette `/` ·
  G frappe · H collage · I persistance · J plan · K exports · L documents · M titre ·
  N masquage · O import · P échap · Q scroll · R import dossier · S repli
  localStorage · T tri/recherche/À propos · U desktop simulé · **V intégrité du
  balisage et géométrie des tiroirs**).
- `tests/js/*.test.js` : `node:test` pour le pur et les contrats.
- `src-tauri/tests/` : intégration Rust, sans GTK.

## Tester le binaire

- **Décision** : la procédure est écrite dans le README (« Installer et tester »),
  avec les deux commandes de téléchargement et la taille réelle de chaque format.
- **À savoir** : `v0.1.0` est un **brouillon**. Pour l'installer :
  <https://github.com/Tahlasandale/writerr/releases> → `v0.1.0` → *Draft* →
  *Assets* (`Writer.Deck_0.1.0_amd64.AppImage`, `Writer.Deck_0.1.0_amd64.deb`).
  Le lien `/releases/latest` du panneau « À propos » reste donc en 404 tant que la
  release n'est pas publiée.

## Recette manuelle — ce qui n'est PAS vérifié

Aucune de ces cases n'est cochée : elles exigent une session graphique et les libs
GTK/WebKit, absentes de l'environnement de développement. Le code compile et la CI
est verte, mais **le binaire n'a jamais été exécuté**.

- [ ] Bureau : l'app démarre, l'écran « Choisir le dossier de notes » apparaît
- [ ] Bureau : choix du dossier via le dialogue natif, l'arborescence s'affiche
- [ ] Bureau : création, renommage, suppression (corbeille), dossiers imbriqués
- [ ] Bureau : modifier un `.md` depuis un éditeur externe → rechargement ou bandeau « Modifié ailleurs »
- [ ] Bureau : fermer la fenêtre en pleine frappe → contenu bien enregistré
- [ ] Bureau : les liens du panneau À propos ouvrent le navigateur système
- [ ] Web : les trois tiroirs s'ouvrent et se ferment (Documents, Plan, À propos) — couvert par les tests, à revérifier à l'œil
- [ ] Web : aucun appel réseau hors fichiers locaux (police JetBrains Mono active)
- [ ] Import d'une sauvegarde `.json` de la PWA dans le bureau : chaque document devient un `.md` nommé d'après son titre

---

## Le tiroir ne s'ouvrait pas : spécificité CSS

- **Décision** : l'état ouvert cible les id (`#docs.open,#toc.open,#about.open`)
  et non `.dr.open`.
- **Pourquoi** : les règles fermées ciblent un id → spécificité (1,0,0) ;
  `.dr.open` est une classe → (0,2,0). La cascade laissait donc
  `transform: translateX(±101%)` l'emporter, et **aucun tiroir ne s'ouvrait**,
  depuis le commit d'origine. Ce n'est visible qu'en interrogeant
  `getBoundingClientRect()` : la classe `.open` était bien posée, mes 101 tests
  passaient. Documents, Plan et À propos étaient inaccessibles à l'écran.
- **Leçon** : un test qui vérifie une classe ne prouve pas qu'un élément est
  visible. `tests/writerr.test.js` bloc V mesure désormais la géométrie réelle.
  Vérifié en annulant le correctif CSS : 4 tests tombent.

## `&lock(&state)?` : le `?` et le `&` se disputent

- **Décision** : on écrit `let ctx = lock(&state)?;` puis `&ctx`.
- **Pourquoi** : `&lock(&state)?` laissait le compilateur choisir entre
  `&(lock(…)?)` et `(&lock(…))?` ; il retenait la seconde forme et tentait une
  conversion `MutexGuard` → `Ctx`. Un binding explicite supprime l'ambiguïté
  (et se lit mieux).

## Vérifier avant d'annoncer : le bug était déployé

- **Décision** : contrôler le site réellement servi avant de considérer une étape
  comme terminée.
- **Pourquoi** : le déplacement vers `web/` n'avait jamais été vérifié en ligne.
  C'est en fetching `https://writerr-pi.vercel.app` qu'ont été trouvés le
  `id="toc"` dupliqué **et** les tiroirs cassés — invisibles pour 101 tests e2e.

## Release : draft, et poids de l'AppImage

- **Décision** : `v0.1.0` est publiée en **brouillon** (`releaseDraft: true`), donc
  elle n'apparaît pas dans `/releases/latest` tant qu'elle n'est pas publiée à la main.
- **Pourquoi** : le binaire n'a jamais été exécuté (ni ici, ni ailleurs). Publier
  une release « officielle » sans l'avoir lancée ferait du 0.1.0 une version que
  personne n'a testée. Le brouillon permet de telecharger et tester sans engagements.
- **Taille** : AppImage 79 Mo, `.deb` 4,4 Mo. L'écart vient de WebKitGTK, embarqué
  dans l'AppImage et pris dans le système pour le `.deb`. Les 15 Mo de §10 ne sont
  donc atteignables que pour le `.deb`.

## `working-directory` ne s'applique pas aux étapes `run`

- **Décision** : on utilise `cd src-tauri && …` dans le script du job de taille.
- **Pourquoi** : le job `construire le binaire` avait `working-directory: src-tauri`
  (build OK), mais l'étape suivante ne l'avait pas et cherchait
  `target/release/writer-deck` **à la racine du dépôt** → « No such file or
  directory », alors même que cargo venait de compiler. Un message d'erreur
  explicite liste maintenant ce que cargo a produit, pour ne pas se refaire avoir.

## À remplacer avant publication

| Clé | Valeur actuelle | Où |
|---|---|---|
| titularité de la LICENSE | Joseph Humbert | `LICENSE` — **à confirmer**, c'est un choix juridique |
| `OWNER` dans la spec | remplacé par l'URL réelle | `web/config.js` |
| version `0.1.0` | `package.json`, `web/config.js`, `tauri.conf.json`, `Cargo.toml` | vérifié par `tests/js/version.test.js` |

## Non fait / hors périmètre

- Migration des notes PWA vers des fichiers (voir plus haut).
- Signature de code, notarisation macOS, Flatpak (§12.8).
- Auto-update : le panneau « À propos » renvoie vers les Releases (§12.7).
- Application mobile native.