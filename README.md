# Writer Deck

> Écrire concentré, sans distraction. Aucun bundler, aucune dépendance, zéro requête réseau au runtime — tout reste sur votre appareil.

**Writer Deck** est une application d'écriture Markdown minimaliste, pensée d'abord pour le mobile.
L'interface s'efface pendant que vous écrivez, la syntaxe se rend au fil de la frappe, et rien ne
part sur un serveur : vos documents vivent dans votre navigateur ou dans un dossier de `.md`
sur votre disque.

- 🌐 **Site** : <https://writerr-pi.vercel.app>
- 📦 **Version web** : [`web/index.html`](web/index.html) — ouvrez-le, c'est tout. Aucune installation, aucun build.
- 🖥️ **Version bureau** : vos notes sont de vrais fichiers `.md` — voir [Installer et tester](#installer-et-tester).

**Documentation** : les décisions techniques et les écarts assumés sont dans
[`DECISIONS.md`](DECISIONS.md) · la spec d'origine est dans [`docs/design-doc.md`](docs/design-doc.md)
(*attention : elle décrit l'état **prévu**, pas l'état réel — voir `DECISIONS.md`*).

---

## Installer et tester

### Version web (PWA) — la plus simple

Rien à installer. Choisissez :

- <https://writerr-pi.vercel.app> (déployée à chaque push sur `main`)
- ou en local : `npm install && npm run serve` → <http://127.0.0.1:4173>
- ou directement : ouvrir [`web/index.html`](web/index.html) dans un navigateur

> ⚠️ Ouvrir le fichier en `file://` fonctionne, mais certains navigateurs
> restreignent IndexedDB sur les origines `file://`. Le serveur local est plus sûr.

Sur mobile, « ⋮ → Ajouter à l'écran d'accueil » installe l'application.

### Version bureau — binaire déjà compilé

Les binaires sont publiés par GitHub Actions à chaque tag `v*`
(AppImage, `.deb`, `.rpm`) : <https://github.com/Tahlasandale/writerr/releases/tag/v0.1.0>

Depuis `v0.1.0` : **AppImage** (79 Mo, autonome) et **`.deb`** (4,4 Mo). Le `.rpm`
manque sur ce tag — il était dans un brouillon séparé, conséquence d'un bug du
workflow de release corrigé depuis ; il revient au prochain tag.

```bash
# .deb (Debian/Ubuntu) — WebKitGTK vient du système, 4,4 Mo
wget https://github.com/Tahlasandale/writerr/releases/download/v0.1.0/Writer.Deck_0.1.0_amd64.deb
sudo apt install ./Writer.Deck_0.1.0_amd64.deb
```

```bash
# ou AppImage : aucune installation, mais WebKitGTK embarqué, 79 Mo
wget https://github.com/Tahlasandale/writerr/releases/download/v0.1.0/Writer.Deck_0.1.0_amd64.AppImage
chmod +x Writer.Deck_0.1.0_amd64.AppImage && ./Writer.Deck_0.1.0_amd64.AppImage
```

> ⚠️ **Statut de `v0.1.0` : binaire compilé et publié, mais jamais exécuté.**
> Aucune recette graphique n'a été faite (il faut une session X11). Le premier
> lancement est à considérer comme une phase de test — les points à vérifier sont
> listés dans [`DECISIONS.md`](DECISIONS.md).

### Version bureau — compiler chez soi

**Rust** : deux seuils selon ce que tu compiles.

| Ce que tu compiles | Rust requis | Pourquoi |
|---|---|---|
| la bibliothèque seule (`cargo test`, `cargo clippy`) | **≥ 1.85** | aucun crate Tauri n'est résolu |
| le binaire (`--features app`) | **≥ 1.90** | `tauri-utils` l'exige |

Si `which rustup` ne répond rien, rustup n'est pas dans le `PATH` :

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
grep -q 'cargo/env' ~/.bashrc || echo '. "$HOME/.cargo/env"' >> ~/.bashrc
grep -q 'cargo/env' ~/.profile || echo '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"' >> ~/.profile
```

**Prérequis Linux** (GTK/WebKit) :

```bash
sudo apt install -y libwebkit2gtk-4.1-dev build-essential libxdo-dev \
                    libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Puis :

```bash
cd src-tauri
cargo build --features app --release --bin writer-deck
./target/release/writer-deck
```

Le frontend est **incorporé dans le binaire** : pas de serveur, pas de fichier à copier.
Sans `--features app`, `cargo build` ne compile que la bibliothèque Rust et n'exige aucune
lib GTK — c'est ce qui permet de lancer `cargo test` sur n'importe quelle machine.

## Fonctionnalités

| | |
|---|---|
| **Rendu au fil de la frappe** | `# ## ###`, listes, cases à cocher, citations, `---` : les marqueurs disparaissent, le style reste |
| **Gras / italique** | `**gras**` et `*italique*` rendus à la volée, sans commande |
| **Commandes `/`** | 12 commandes (titres, listes, case à cocher, citation, séparateur, gras, italique, date) avec filtrage progressif |
| **Plan (ToC)** | panneau latéral cliquable, avec le nombre de mots de chaque section |
| **Multi-documents** | barre latérale, tri par dernière modification, suppression en deux temps |
| **Import / export** | `.md` `.txt` `.json` à l'import ; `.md` `.html` `.txt` `.json` à l'export, plus copie Markdown / texte brut |
| **Thème** | clair, sombre, ou suivi automatique du système |
| **Masquage de l'interface** | les barres s'effacent après 3 s, 6 s, 12 s, ou jamais |
| **Plein écran** | sur le bouton `⛶` |
| **PWA** | installable sur l'écran d'accueil, fonctionne hors-ligne |

## Utilisation

Ouvrez [`web/index.html`](web/index.html) dans un navigateur, ou rendez-vous sur
<https://writerr-pi.vercel.app>. Voir [Installer et tester](#installer-et-tester).

Sur mobile, « ⋮ → Ajouter à l'écran d'accueil » installe l'application comme un vrai app.

**Trois tiroirs** dans la barre du haut :

| Bouton | Tiroir |
|---|---|
| `≡` | **Documents** : nouveau document, recherche, tri, import/export, À propos |
| `☰` (droite) | **Plan** : sommaire des titres, avec le nombre de mots de chaque section |
| via `≡` → *À propos & téléchargements* | version, liens GitHub / releases, installation PWA, raccourcis |

Le tiroir se ferme en cliquant sur le voile ou avec `Échap`.

## Raccourcis

| Action | Comment |
|---|---|
| Ouvrir les commandes | `/` (le menu s'ouvre aussi avec le bouton `/`) |
| Choisir une commande | `↑` `↓` puis `Entrée` (ou `Tab`) |
| Fermer le menu | `Échap` — le texte tapé est conservé |
| Nouvelle ligne | `Entrée` — prolonge la liste, la numérotation ou la citation ; sur une ligne vide, on en sort |
| Indenter / désindenter | `Tab` / `⇧Tab` (listes uniquement) |
| Cocher une tâche | clic sur `☐` / `☑` |

## Stockage des données

Tout est **local**, rien n'est envoyé sur un réseau :

- **IndexedDB**, base `writer-deck`, magasin `docs` — un enregistrement par document ;
- **repli `localStorage`** si IndexedDB est indisponible (navigation privée stricte, vieux navigateur) ;
- le document courant et le délai de masquage sont dans `localStorage` (`mwd:cur`, `mwd:idle`).

> ⚠️ Les données sont liées au navigateur et à son origine (`https://writerr-pi.vercel.app` ou `file://`).
> Vider les données du site les supprime. Pensez à exporter en `.md` pour une sauvegarde durable.

## Déploiement

Site purement statique : déposez le **contenu de `web/`** (`index.html`, les 5 `.js`,
les polices, `manifest.json`, les icônes) chez n'importe quel hébergement statique
(Vercel, GitHub Pages, Netlify…). Il n'y a **ni build ni dépendance** : c'est envoyé tel quel.

Chez Vercel, le dépôt est configuré par [`vercel.json`](vercel.json)
(`outputDirectory: web`) — rien à faire dans le tableau de bord.

## Version bureau (Tauri)

Le même frontend, avec les documents **réellement écrits en `.md` dans un dossier
de votre choix** : arborescence, tri, recherche, surveillance du disque et corbeille
système. Écrivez dans l'application, ou éditez les fichiers avec n'importe quel
autre éditeur — les deux se voient.

| | PWA (web) | Bureau |
|---|---|---|
| Stockage | IndexedDB, repli `localStorage` | fichiers `.md` / `.txt` dans un dossier |
| Organisation | liste plate | arborescence de dossiers |
| Titre | libre | nom du fichier |
| Modification externe | — | rechargement automatique, ou bandeau « Modifié ailleurs » |
| Suppression | définitive | corbeille du système |
| Tri, recherche, À propos | ✅ | ✅ |

**État : le code compile et la CI est verte, mais l'application n'a pas encore été
exécutée en conditions réelles** (il faut une session graphique et les libs GTK).
La checklist de recette manuelle est listée dans `DECISIONS.md` — c'est le seul
reste à faire.

Le cœur Rust (noms de fichiers sûrs, chemins confinés à la racine, écriture atomique,
corbeille, configuration, watcher) est testé **sans** GTK/WebKit. Seul le binaire final
exige ces libs ; la CI le compile séparément.

## Développement

```bash
npm install     # dépendances de dev uniquement (puppeteer-core, fake-indexeddb)
npm test        # tests unitaires (node:test) + bout en bout (Chromium)
npm run lint    # vérification syntaxique du JS
npm run serve   # sert l'app sur http://127.0.0.1:4173
```

Rust :

```bash
cd src-tauri
cargo test                              # cœur complet, aucune lib GTK requise
cargo build --features app              # binaire Tauri (nécessite webkit2gtk)
```

Les tests e2e trouvent un Chromium déjà installé sur la machine ; `CHROME_PATH` force
un chemin précis. Pour ne rejouer qu'un groupe de tests :

```bash
node tests/writerr.test.js V     # intégrité du balisage
node tests/writerr.test.js T     # tri, recherche, À propos, dossier
node tests/writerr.test.js U     # desktop simulé
```

### Ce que couvrent les tests

| Suite | Ce qu'elle vérifie |
|---|---|
| `tests/js/characterization.test.js` | le comportement **historique** des fonctions pures — un refactor qui change le rendu échoue ici |
| `tests/js/sort.test.js` | tri naturel (`note2` < `note10`), dossiers avant fichiers, réconciliation |
| `tests/js/search.test.js` | AND logique, préfixes de mot, pondération du titre, snippets, performance |
| `tests/js/storage.contract.test.js` | le contrat `Storage`, exécuté sur chaque adaptateur |
| `tests/js/version.test.js` | cohérence de version et invariants de configuration entre les 4 manifestes |
| `tests/writerr.test.js` | l'éditeur dans un vrai Chromium : frappe, `/`, cases à cocher, tiroirs, import/export, desktop simulé |
| `src-tauri/tests/` | chemins confinés à la racine, écriture atomique, corbeille, watcher |

## Licence

MIT. © Joseph Humbert.