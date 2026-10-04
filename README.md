# Writer Deck

> Écrire concentré, sans distraction. Un seul fichier HTML, aucune dépendance, tout reste sur votre appareil.

**Writer Deck** est une application d'écriture Markdown minimaliste, pensée d'abord pour le mobile.
L'interface s'efface pendant que vous écrivez, la syntaxe se rend au fil de la frappe, et rien ne
part sur un serveur : vos documents vivent dans votre navigateur.

- 🌐 **Site** : <https://writerr-pi.vercel.app>
- 📦 **Installation** : un seul fichier, [`index.html`](index.html) — ouvrez-le, c'est tout.

---

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

Ouvrez [`index.html`](index.html) dans un navigateur, ou rendez-vous sur <https://writerr-pi.vercel.app>.

Sur mobile, « ⋮ → Ajouter à l'écran d'accueil » installe l'application comme un vrai app.

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

Site purement statique : déposez `index.html`, `manifest.json` et les deux icônes chez n'importe quel
hébergement de fichiers statiques (Vercel, GitHub Pages, Netlify…). Il n'y a **ni build ni dépendance**,
le HTML est envoyé tel quel.

## Version bureau (Tauri, en cours)

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

Le cœur Rust (noms de fichiers sûrs, chemins confinés à la racine, écriture atomique,
corbeille, configuration, watcher) est testé **sans** GTK/WebKit. Seul le binaire final
exige ces libs ; la CI le compile séparément.

## Développement

```bash
npm install     # dépendances de dev uniquement (puppeteer-core, fake-indexeddb)
npm test        # tests unitaires (node:test) + bout en bout (Chromium)
npm run lint    # vérification syntaxique du JS
npm run serve   # sert le dépôt sur http://127.0.0.1:4173
```

Rust :

```bash
cd src-tauri
cargo test                              # cœur complet, aucune lib GTK requise
cargo build --features app              # binaire Tauri (nécessite webkit2gtk)
```

Les tests e2e trouvent un Chromium déjà installé sur la machine ; `CHROME_PATH` force
un chemin précis. Le même `npm test` tourne à chaque push.

## Licence

MIT. © Joseph Humbert.