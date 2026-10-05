# AGENTS.md

Instructions pour un agent qui travaille dans ce dépôt. Elles complètent
`README.md` (installation et usage) et `DECISIONS.md` (pourquoi). Ce fichier ne
contient que ce qu'on ne peut pas déduire du code : **les portes à passer, les
pièges déjà payés, et les conventions qui ne sont écrites nulle part ailleurs.**

## 1. Le dépôt

Writer Deck est un éditeur Markdown en deux formes qui partagent le même
frontend :

- une **PWA** servie statiquement (`web/`), sans bundler et **sans aucune
  dépendance runtime** — les 5 `.js` sont chargés tels quels ;
- une **application de bureau Tauri** (`src-tauri/`) qui lit et écrit de vrais
  fichiers `.md` dans un dossier choisi par l'utilisateur.

Invariant : **le runtime est mono-fichier, sans build.** Ce qui est dans
`package.json` en `dependencies` n'existe pas ; `puppeteer-core` et
`fake-indexeddb` sont des `devDependencies` de test uniquement. N'ajoute pas de
dépendance runtime, et n'introduis pas de bundler.

## 2. Les portes

Rien ne part avec une porte rouge. Voici la liste complète, toutes exécutables
depuis la racine sauf mention contraire.

```bash
npm test                  # JS unitaire (node:test) + bout en bout (Chromium)
npm run lint              # vérification syntaxique du JS
npm run serve             # PWA locale sur http://127.0.0.1:4173

cd src-tauri
cargo test                # cœur Rust complet
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo build --features app --release --bin writer-deck   # le binaire Tauri
```

Rejouer un seul groupe de tests bout en bout (les groupes sont nommés A1…V5) :

```bash
node tests/writerr.test.js V      # intégrité du balisage et tiroirs
node tests/writerr.test.js U      # bureau simulé
```

**Le cœur Rust se teste sans GTK ni WebKit**, c'est un choix d'architecture :
`tauri`, `tauri-build` et la GTK sont derrière le feature `app`, et
`tauri-build` n'est lié que sous `#[cfg(feature = "app")]`. Ne délie jamais
`tauri-build` inconditionnellement — tu casserais `cargo test` sur toute machine
qui n'a pas les libs GTK, c'est-à-dire la majorité des postes de dev.

## 3. Deux toolchains Rust, une seule dans le `PATH`

Sur une machine où Debian fournit `rustc` par apt **et** où rustup est
installé, `~/.cargo/bin` peut être absent du `PATH` — et tous tes tests
passent alors en silence par le rustc d'apt, beaucoup plus ancien.

**Vérifie `command -v rustc` et `rustc --version` avant de conclure qu'un crate
est incompatible avec ta version.** Ce contrôle a coûté une session entière
ici : un blocage `darling requires rustc 1.88` lu comme une contrainte
insoluble n'était que le mauvais binaire qui répondait.

Les deux seuils, volontairement différents :

| Ce que tu compiles | Rust requis |
|---|---|
| la bibliothèque seule (`cargo test`, `cargo clippy`) | ≥ 1.85 |
| le binaire (`--features app`) | ≥ 1.90 (exigé par `tauri-utils`) |

`rust-version = "1.85"` est le plancher de la **bibliothèque** et le reste :
Cargo n'a pas de MSRV par feature, et le déclarer à 1.90 ferait *refuser*
`cargo test` sur 1.85.

## 4. Cycle de travail

1. **Caractérisation avant refactor.** Un test décrit le comportement
   *historique*, pas le comportement souhaité. Quand une attente est fausse,
   corrige l'attente **vers** le réel, jamais le réel vers l'attente — et
   note le changement dans `DECISIONS.md`.
2. **Rejoue en local avant de pousser la CI.** Une CI coûte dix minutes ; un
   test local coûte dix secondes. Tout ce qui est vérifiable hors CI doit
   l'être, y compris les scripts shell et l'empaquetage.
3. **Commits atomiques** : `type(scope): sujet français`. Un commit = une
   raison de changer. Si tu peux écrire deux messages sans « et », fais deux
   commits.
4. **Ne réécris pas un tag poussé.** Si une release est ratée, coupe la
   version suivante. Ici, `v0.1.1` porte un run de release rouge et a été
   conservé tel quel plutôt que re-taggé.
5. **`git add -A` est interdit.** Il a glissé la clé APT publique dans un
   commit sans rapport avec elle. Ajoute fichier par fichier, et vérifie
   `git status --short` avant de commiter.
6. **Ce que tu n'as pas touché n'est pas à toi.** Le `TODO.md` du dépôt
   appartient à l'utilisateur.

## 5. Discipline d'investigation

C'est la partie du fichier qui rapporte le plus.

- **Lis la source de la dépendance avant de conclure.** Presque tous les
  blocages rencontrés dans ce dépôt venaient d'une source lue au lieu d'un
  message d'erreur lu. Exemple : `tauri.conf.json` ne pouvait *pas* réparer la
  dépendance GTK3 du `.deb`, parce que `tauri-cli/src/interface/rust.rs:1364`
  part des `depends` de la config et que les lignes 1422-1423 y ajoutent
  **inconditionnellement** `libgtk-3-0` par-dessus. Le message d'erreur
  disait « dépendance insatisfaisable » ; la source disait pourquoi.
- **Un témoin doit pouvoir échouer.** En vérifiant un dépôt apt, mon harnais de
  test local échouait. J'en ai conclu « mon dépôt est cassé » — alors que le
  témoin, le **vrai** dépôt Debian dans le même harnais, échouait aussi.
  Sans lui, le diagnostic était inversé. Si ton expérience de test ne peut pas
  réussir à échouer, elle ne prouve rien.
- **Ne présente jamais comme vérifié ce qui ne l'a pas été.** L'écart le plus
  coûteux de ce dépôt est un bug CSS *déjà déployé* dont on parlait au présent.
  Quand tu n'as pas exécuté quelque chose, écris-le.
- **Corrige explicitement ce que tu as affirmé avant.** Si tu te trompes en
  cours de route, dis-le en une ligne, dans le fil — pas en le glissant dans
  un fichier de décisions pour qu'on ne voie plus l'erreur.
- **Un script qui transforme doit se vérifier avant d'écraser l'original.** Si
  la reconstruction ne donne pas exactement le résultat attendu, abandonner.
  Un fichier de sortie à la mauvaise valeur est pire qu'un build rouge :
  l'utilisateur verra une erreur incompréhensible plus tard.
- **Journaux :** toute décision est écrite dans `DECISIONS.md` **au moment où
  elle est prise**, pas reconstruite après coup. Le `README.md` documente le résultat,
  jamais l'historique.

## 6. Les pièges déjà payés

- **`LC_ALL=C` sur toute assertion qui lit la sortie d'une commande.** Sur une
  locale française, `md5sum -c` répond « Réussi » et non « OK ». Le test passe
  en local et échoue en CI, ou l'inverse.
- **`pkill -f "un motif"` matche sa propre ligne de commande** et tue le shell
  qui l'a lancé. Utilise un motif qui ne se trouve pas dans la commande
  elle-même.
- **Un `>` redirigeant vers un fichier du répertoire inspecté pollue l'inspection.** `apt-ftparchive release dist > dist/Release` : le shell crée
  le fichier *avant* d'exécuter la commande, donc l'outil hache un `Release`
  vide et inscrit son propre nom dans ses sommes de contrôle.
- **apt échoue silencieusement.** Trois pièges rencontrés en une session, aucun
  ne produit le moindre avertissement : apt récupère l'`InRelease`, valide la
  signature, puis ne trouve rien.
  - le préfixe `dists/` est obligatoire dans l'arborescence ;
  - le `Release` ne doit pas se lister lui-même ;
  - un dépôt qui ne publie que `Packages.gz` ne sert **rien** sur apt 3.x.
    Publie `Packages.xz` et `Packages` non compressé.
- **Un runner GitHub n'a pas** `apt-utils` (qui fournit `apt-ftparchive`) ni
  `dpkg-dev` (`dpkg-scanpackages`). Le workflow les installe ; un script qui en
  dépend doit signaler l'absence de chaque outil plutôt que de planter tard.
- **Aucun littéral de version dans un test.** Un test qui compare la version à
  `"0.1.2"` casse à chaque version. C'est arrivé deux fois de suite : deux
  tests Rust, puis le test e2e `T11`, qui ont fait échouer une release pour
  de mauvaises raisons. Lis `web/config.js` côté JS, `package.json` via
  `include_str!` côté Rust.
- **Un commentaire en français peut recevoir des caractères asiatiques par
  accident.** Ça s'est produit trois fois ici, et une fois dans un fichier déjà
  commité. Le scan de `tests/js/agents.test.js` le refuse désormais dans `web/`,
  `tests/`, `docs/` et `.github/` — **pas** dans `src-tauri/`, où les CJK sont
  volontaires (tests de noms de fichiers Unicode).

## 7. Ce qui n'est pas vérifié

- **Le binaire n'a fait l'objet d'aucune recette graphique complète.** Il se
  lance, mais les points à valider sont listés dans `DECISIONS.md`
  (« Recette manuelle »). Ne parle pas du bureau comme d'une chose acquise.
- **Les releases `v0.1.1` et `v0.1.2` sont en brouillon.** Seul `v0.1.0` est
  publié, et son `.deb` est **ininstallable** sur Debian 13 : il déclare
  `libgtk-3-0`, que la transition t64 a renommé. Le correctif est dans le code
  depuis `0.1.1`.
- **Le pool du dépôt apt est écrasé à chaque version.** L'URL d'un `.deb` d'une
  version antérieure renvoie 404. C'est voulu — apt ne réinstalle pas une
  version plus vieille, et le code est embarqué dans le binaire.
- **Il n'y a pas de service worker, volontairement.** L'historique du dépôt
  montre deux retraits de SW (« broken render »). Un cache-first sert une
  version périmée après chaque déploiement. Le `manifest.json` suffit à
  l'installation PWA.

## 8. Écarts assumés par rapport à `docs/design-doc.md`

**La spec décrit l'état *prévu*, pas l'état *réel*.** Ne réécris pas le code
pour coller à la spec : consigne l'écart dans `DECISIONS.md` (sections
« Langue », « Pas de service worker », « Déploiement : Vercel uniquement », …),
ou corrige la spec **avec l'accord de l'utilisateur**.

Amendements en vigueur :

| Section | Écart |
|---|---|
| §2, §6.11 | pas de service worker |
| §5.8 | seuil de performance adouci (l'échelle demandée dépasse ce qu'un `Map` tient) |
| §9 | `pages.yml` retiré, Vercel uniquement |
| §10 | seuil de taille du binaire porté à 17 Mio (le binaire réel fait 15,7 Mio) |
| §12.9 | interface et documentation en français, code et identifiants en anglais |

`docs/design-doc.md` porte un bandeau d'avertissement en tête. Ne le supprime
pas et ne réécris pas la spec sans accord.
