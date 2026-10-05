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

## `stats()` a gagné un champ `bytes`

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

- **Décision** : la procédure est écrite dans le README (« Installer et tester »).
- **`v0.1.0` est publiée** (elle était en brouillon, donc invisible et en 404) :
  <https://github.com/Tahlasandale/writerr/releases/tag/v0.1.0> —
  `Writer.Deck_0.1.0_amd64.AppImage` (79 Mo) et `Writer.Deck_0.1.0_amd64.deb` (4,4 Mo).
  Le `.rpm` n'a pas été gardé : il était dans un brouillon séparé, créé par la
  matrice (voir « Une seule release par tag »). Il reviendra au prochain tag, désormais
  dans la même release.
- **Toujours en brouillon pour la suite** : `releaseDraft: true` reste dans le
  workflow. On ne publie que lorsque le binaire a été lancé au moins une fois —
  une 0.2.0 ne partira pas sur un code que personne n'a exécuté.

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

## MSRV : 1.85 pour la bibliothèque, 1.90 pour le binaire

- **Décision** : `rust-version = "1.85"` est conservé, avec un commentaire dans
  `Cargo.toml` expliquant que le feature `app` exige 1.90.
- **Pourquoi** : Cargo n'a pas de MSRV par feature. Déclarer 1.90 ferait **refuser**
  `cargo test` sur 1.85 — donc sur le `rustc` d'apt, que beaucoup de machines ont.
  On perdrait « le cœur se teste partout, sans GTK ni Rust récent », qui est
  précisément ce qui rend les 237 tests accessibles à n'importe qui.
  Vérifié des deux côtés : cœur vert sur **1.85.1** et sur **1.99.0**.
- **Le seuil est 1.90, pas 1.89** : cargo liste tous les crates en cause —
  `darling` 1.88, `time` 1.88, `uuid` 1.89, et **`tauri-utils` 2.10.1 → 1.90**.
  C'est le maximum qui fait foi, pas le dernier de la liste.
- **Verrouillé par** `tests/js/version.test.js` (le README doit annoncer les deux seuils).

## rustup n'était pas dans le PATH — et ça m'a fait valider sur le mauvais Rust

- **Décision** : `. "$HOME/.cargo/env"` ajouté à `~/.bashrc` **et** `~/.profile`
  (dépôt dotfiles), plus la marche à suivre dans le README.
- **Pourquoi** : `~/.cargo/env` existait mais n'était sourcé par aucun des deux
  fichiers. Conséquence : `which rustup` échouait et **toutes mes vérifications
  locales passaient par `/usr/bin/rustc` (apt, 1.85.1)**. Le blocage
  « `darling requires rustc 1.88` », que j'ai lu comme une contrainte insoluble,
  venait simplement du mauvais toolchain.
- **Leçon** : avant de conclure qu'une dépendance est incompatible, vérifier
  `rustc --version` **et** son origine (`command -v`). Deux toolchains
  cohabitaient sans bruit.
- `.profile` en plus de `.bashrc` : les sessions de connexion (Sway, `ssh`) ne
  lisent pas `.bashrc` et retomberaient sinon sur l'apt.

## Une seule release par tag : la matrice créait des doublons

- **Décision** : un job unique avec `--bundles appimage,deb,rpm`, plus de matrice.
- **Pourquoi** : trois jobs en parallèle appelaient tous `tauri-action` avec le
  **même** `tagName`. Chacun essayait de créer la release ; il en a résulté **deux
  brouillons pour `v0.1.0`** (id `403662510` rpm seul, id `403662496` AppImage+deb),
  et `gh release edit v0.1.0` devenait ambigu — il faut passer par l'API avec
  l'id. Nettoyé à la main pour `v0.1.0` ; la structure du workflow empêche
  désormais la récurrence.
- **Vérifié** : `/releases/latest` et le téléchargement anonyme du `.deb`
  répondent 200/206 depuis un shell non authentifié.

## `working-directory` ne s'applique pas aux étapes `run`

- **Décision** : on utilise `working-directory: src-tauri` sur les deux étapes, plus
  un message d'erreur qui liste ce que cargo a réellement produit.
- **Pourquoi** : le job `construire le binaire` en avait un (build OK), mais pas
  l'étape suivante, qui cherchait `target/release/writer-deck` **à la racine du
  dépôt** → « No such file or directory », alors même que cargo venait de compiler.
- **Piège** : `working-directory` ne s'applique PAS aux étapes `run`. C'est une
  distinction facile à manquer.
## Le `.deb` était ininstallable : `libgtk-3-0` n'existe plus

- **Décision** : on réécrit le fichier de contrôle **après** le bundling
  (`.github/scripts/fix-deb-deps.sh`), et on réuploade l'asset avec `--clobber`.
  Résultat : `Depends: libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0`.
- **Le symptôme** : `apt install ./Writer.Deck_0.1.0_amd64.deb` échoue sur
  « dépendances non satisfaites », alors que `libgtk-3-0t64 3.24.49` est installé
  sur la machine. Le paquet busca `libgtk-3-0`, que la transition t64 de Debian 13
  a renommé. Le binaire n'était donc installable sur **aucune** Debian 13 ni
  Ubuntu 24.04+, c'est-à-dire sur la majorité des cibles.
- **Pourquoi la config ne suffisait pas** : dans `tauri-cli-2.12.1`
  (`src/interface/rust.rs`), ligne 1364 puis 1422-1423 :
  ```rust
  let mut depends_deb = config.linux.deb.depends.unwrap_or_default();
  ...
  depends_deb.push("libwebkit2gtk-4.1-0".to_string());
  depends_deb.push("libgtk-3-0".to_string());
  ```
  Les deux `push` sont **inconditionnels** et il n'y a pas de déduplication : la
  config sert de base, et les deux noms historiques sont ajoutés par-dessus. Écrire
  `libgtk-3-0t64 | libgtk-3-0` dans `bundle.linux.deb.depends` n'aurait produit que
  `libgtk-3-0t64 | libgtk-3-0, libwebkit2gtk-4.1-0, libgtk-3-0` — où le
  `libgtk-3-0` final reste une dépendance **dure** : l'alternative ne couvre que
  la première entrée. Un champ `Depends` unique ne peut pas dire « GTK3, peu
  importe son nom » ; il faut une alternative Debian, donc un `|` — et donc un
  fichier réécrit après coup.
- **Pourquoi une alternative et pas `libgtk-3-0t64`** : le `.deb` ne peut pas
  cibler une seule génération. `libgtk-3-0t64` n'existe pas avant Debian 13 ;
  `libgtk-3-0` n'existe plus après. `a | b` couvre les deux.
- **Effet de bord heureux** : `dpkg-deb -b` compresse mieux que le bundler de
  Tauri, le `.deb` passe de **4 649 366 à 3 094 920 octets** (-33 %). Vérifié :
  binaire embarqué identique au bit près (sha256), les 7 fichiers du paquet sont
  les mêmes, et les `md5sums` déclarés passent.
- **Le script se vérifie lui-même** : si la reconstruction ne donne pas exactement
  le `Depends` attendu, il abandonne **sans** écraser l'original. Un `.deb` à la
  mauvaise dépendance est pire qu'un build rouge, parce que l'utilisateur verrait
  un échec d'apt incompréhensible.
- **Verrouillé par** `tests/js/packaging.test.js` (7 tests, qui *exécutent* le
  script sur un `.deb` fabriqué) et par une garde dans
  `publish-apt-repo.sh`, qui refuse de publier un paquet dont le `Depends` n'a pas
  été corrigé.

## Un dépôt APT pour mettre à jour sans réinstaller à la main

- **Décision** : un dépôt APT signé, servi par GitHub Pages, régénéré et
  ré-publié en `--force` sur `gh-pages` à chaque tag.
  `sudo apt install writer-deck`, puis `sudo apt update && sudo apt upgrade
  writer-deck`. C'est le seul canal qui donne une vraie mise à jour sans que
  l'utilisateur ait à télécharger quoi que ce soit.
- **Écarté** : AppImage seule (79 Mo par version, pas d'entrée de menu sans
  manipulation, et tauri ne produit pas de `.zsync` donc AppImageUpdate n'a rien à
  comparer) ; `.deb` par URL (propre à l'installation, mais la mise à jour
  redevenait un `wget` à la main) ; Flatpak (hors périmètre, et le bac à sable
  gêne l'accès à un dossier de notes libre).
- **Signature** : `InRelease` en **clair-signé** (`--clearsign`) plutôt que
  `Release` + `Release.gpg` — un seul fichier, donc pas de fenêtre de courses
  entre la signature et sa contrepartie. `apt` privilégie `InRelease` quand il
  existe. Clé **sans phrase de passe** : le secret CI *est* la clé, et ça évite un
  second secret à saisir.
- **Rotation** : si `APT_GPG_PRIVATE_KEY` fuite, il faut générer une nouvelle clé,
  publier la nouvelle clé publique, et les installations existantes devront
  ajouter la nouvelle — l'ancienne ne peut pas être révoquée de façon fiable pour
  un dépôt dont la clé est déjà déployée chez des tiers. D'où le choix
  « sans phrase de passe » : la clé est déjà dans un secret, une seconde barrière
  ne protège pas grand-chose, et elle coûte un second secret à gérer.
- **Oubli classique** : `apt-utils` (qui fournit `apt-ftparchive`) et `dpkg-dev`
  (`dpkg-scanpackages`) ne sont **pas** installés sur un runner Ubuntu. Le
  workflow les installe, et le script signale l'absence de chaque outil plutôt que
  de tomber sur « command not found » au milieu de la signature.

## Les trois pièges d'un dépôt apt, tous silencieux

Aucun des trois ne produit le moindre avertissement : apt récupère l'`InRelease`,
valide la signature, puis ne trouve rien. Les deux premiers ont été rencontrés
pendant la mise au point, le troisième par déduction avant d'être.

1. **Le préfixe `dists/` est obligatoire.** Écrire `site/stable/Release` : tout le
   reste est correct et apt dit « Le dépôt n'a pas de fichier Release ».
2. **Le `Release` ne doit pas se hacher lui-même.**
   `apt-ftparchive release dist > dist/Release` se mord la queue : le shell crée
   le fichier de sortie **avant** d'exécuter la commande, donc `apt-ftparchive`
   hache un `Release` vide et inscrit son propre nom dans sa liste de sommes. On
   écrit hors du répertoire puis on déplace. Une garde vérifie l'absence de
   l'auto-référence.
3. **`Packages.gz` seul ne suffit plus.** Un apt 3.x (Debian 13, Ubuntu 24.04+)
   n'en dérive **aucune** cible. On publie `Packages.xz` (que les apt modernes
   réclament) et `Packages` non compressé (pour les apt trop anciens pour xz) —
   et ni gz ni bz2, chaque variante en plus étant une somme de plus à garder
   cohérente dans le `Release`.
- **Vérifié hors CI**, contre un serveur HTTP local, avec apt 3.x : signature
  vérifiée, `apt-cache policy` annonce le candidat, la dépendance
  `libgtk-3-0t64 | libgtk-3-0` se résout, `apt-get -s install` ne signale
  **aucune** dépendance manquante, et `apt-get download` ramène un `.deb` au
  sha256 attendu. Test négatif : avec une autre clé, apt refuse en nommant notre
  empreinte. Tout cela est rejoué à chaque `npm test`, sur un `.deb` fabriqué
  avec une clé GPG jetable.
- **Méthode** : la première tentative de vérification a échoué **faussement**,
  avec le dépôt Debian officiel dans le même harnais, parce que le harnais
  relocalisait `Dir` en entier. Relocaliser seulement `Dir::Etc::sourcelist`,
  `Dir::Etc::sourceparts` et `Dir::State::lists` fonctionne. Un témoin qui ne
  réussit pas à échouer n'est pas un témoin.

## Le seuil de 15 Mio de la spec était déjà franchi

- **Décision** : seuil porté à **17 Mio** (17 825 792 octets), dans le job `smoke`
  du workflow de release.
- **Pourquoi** : le binaire release de `v0.1.0` fait **16 456 520 octets**
  (15,7 Mio). Le seuil d'origine (15 728 640) était donc déjà dépassé. Et il ne
  l'avait jamais signalé : sur `v0.1.0`, le job échouait plus tôt, sur le bug de
  `working-directory` (corrigé en `505e501`), avant même de mesurer. Il aurait
  échoué à la release suivante.
- **`strip = true` envisagé puis écarté** : il aurait probablement ramené le
  binaire sous 15 Mio, mais sans symboles une panique du binaire n'est plus
  exploitable. Un seuil un peu plus large vaut mieux qu'un binaire strippé.
- **Verrouillé par** un test qui vérifie que le seuil dépasse la taille mesurée —
  sinon le contrôle retomberait dans le piège qu'il est censé surveiller.

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