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

## Développement

L'application tient dans `index.html` : balisage, CSS et JS inline, sans bundler ni dépendance.
Pour éviter toute régression, une suite de tests headless pilote un vrai Chromium via `puppeteer-core` :

```bash
npm install     # dépendance de dev uniquement (puppeteer-core)
npm test        # démarre son propre serveur statique puis lance les tests
```

Le test cherche un Chromium déjà installé sur la machine (`CHROME_PATH` pour forcer un chemin).
Le même `npm test` tourne à chaque push via GitHub Actions.

## Licence

Usage personnel. © Joseph Humbert.