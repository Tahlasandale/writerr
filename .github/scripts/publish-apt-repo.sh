#!/usr/bin/env bash
# Construit le dépôt APT de Writer Deck et le publie sur la branche gh-pages,
# servie par GitHub Pages. Résultat : `sudo apt install writer-deck`, puis
# `sudo apt update && sudo apt upgrade writer-deck` à chaque nouveau tag.
#
# Arborescence publiée (apt n'a pas besoin de listing, il suit des URL) :
#
#   /writerr-apt-key.asc                          clé publique
#   /dists/stable/InRelease                      Release clair-signé
#   /dists/stable/main/binary-amd64/Packages.gz   index
#   /pool/main/w/writer-deck/writer-deck_*.deb   paquets
#
# InRelease est en clair-signé (--clearsign) plutôt que Release + Release.gpg :
# un seul fichier, donc pas de fenêtre de courses entre la signature et sa
# contrepartie. apt préfère InRelease quand il existe.
#
# Variables d'environnement attendues :
#   APT_GPG_PRIVATE_KEY  clé privée ASCII-armored (secret CI, sans phrase de passe)
#   TAG ou GITHUB_REF_NAME   version publiée, ex. v0.1.1
#   REPO                 Tahlasandale/writerr
#   BASE_URL             https://tahlasandale.github.io/writerr

set -euo pipefail

TAG=${TAG:-${GITHUB_REF_NAME:-}}
REPO=${REPO:-Tahlasandale/writerr}
BASE_URL=${BASE_URL:-https://tahlasandale.github.io/writerr}
KEY_ID=writerr-apt-key.asc
SUITE=stable
COMPONENT=main
ARCH=amd64

if [ -z "$TAG" ]; then
  echo "erreur: TAG (ou GITHUB_REF_NAME) est vide" >&2
  exit 1
fi
if [ -z "${APT_GPG_PRIVATE_KEY:-}" ]; then
  echo "erreur: APT_GPG_PRIVATE_KEY absent — le dépôt ne peut pas être signé." >&2
  echo "  Créer le secret : gh secret set APT_GPG_PRIVATE_KEY < ~/writerr-apt-private.asc" >&2
  exit 1
fi

# Outils requis. Sur un runner GitHub, `apt-utils` (qui fournit apt-ftparchive)
# n'est pas installé d'origine : le workflow l'ajoute, mais on le signale ici
# plutôt que de tomber sur « command not found » au milieu de la signature.
for outil in dpkg-deb dpkg-scanpackages apt-ftparchive xz gzip gpg git; do
  if ! command -v "$outil" >/dev/null 2>&1; then
    case $outil in
      apt-ftparchive) quoi="apt-utils" ;;
      dpkg-scanpackages) quoi="dpkg-dev" ;;
      *) quoi=$outil ;;
    esac
    echo "erreur: '$outil' absent (paquet Debian: $quoi)" >&2
    exit 1
  fi
done

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
site="$root/site"
# apt cherche TOUJOURS le préfixe dists/ devant la suite. Écrire
# `site/stable/Release` produit un dépôt invisible alors que tout le reste est
# correct : l'erreur d'apt est « n'a pas de fichier Release », sans autre piste.
dist="$site/dists/$SUITE"
mkdir -p "$dist/$COMPONENT/binary-$ARCH" "$site/pool/main/w/writer-deck"

# --- 1. le paquet -----------------------------------------------------------
# On récupère l'asset de la release : à ce stade il a DÉJÀ été corrigé par
# fix-deb-deps.sh (l'étape précédente de release.yml). Ce script ne touche pas au
# contenu des paquets.
#
# APT_DEB_DIR permet de verifier le script hors CI (on pointe un dossier de .deb
# déjà corrigés) sans dependre de GitHub. En CI, la variable est absente.
if [ -n "${APT_DEB_DIR:-}" ]; then
  echo "source des paquets : APT_DEB_DIR=$APT_DEB_DIR (hors CI)"
  mapfile -t debs < <(find "$APT_DEB_DIR" -name '*.deb' | sort)
else
  work="$root/gh"
  gh release download "$TAG" -R "$REPO" -D "$work" --pattern '*.deb' >/dev/null
  mapfile -t debs < <(find "$work" -name '*.deb' | sort)
fi
if [ ${#debs[@]} -eq 0 ]; then
  echo "erreur: aucun .deb trouvé (TAG=$TAG)" >&2
  exit 1
fi
echo "paquets trouvés : ${debs[*]##*/}"

# On garde le nom de fichier tel quel. apt résout le téléchargement via le champ
# `Filename:` du fichier Packages, pas via le nom sur le disque, donc un nom
# inhabituel (Writer.Deck_0.1.1_amd64.deb) fonctionnerait — mais on renomme quand
# même vers la convention Debian, qui rend le dépôt lisible à l'œil et lisible en
# local si quelqu'un le clone.
for deb in "${debs[@]}"; do
  pkg=$(dpkg-deb -f "$deb" Package)
  ver=$(dpkg-deb -f "$deb" Version)
  arch=$(dpkg-deb -f "$deb" Architecture)
  dest="$site/pool/$COMPONENT/w/$pkg/${pkg}_${ver}_${arch}.deb"
  cp "$deb" "$dest"
  echo "  $pkg $ver $arch -> pool/$COMPONENT/w/$pkg/${pkg}_${ver}_${arch}.deb"
  depends=$(dpkg-deb -f "$deb" Depends)
  case $depends in
    *libgtk-3-0t64*) ;;
    *) echo "erreur: $pkg $ver a encore la mauvaise dépendance GTK3: $depends" >&2
       echo "  l'étape fix-deb-deps.sh a-t-elle tourné ?" >&2
       exit 1 ;;
  esac
done

# --- 2. l'index -------------------------------------------------------------
# `Filename:` doit être relatif à la racine du site, et dpkg-scanpackages écrit
# le chemin tel qu'on le lui donne : on génère depuis la racine du site.
(cd "$site" && dpkg-scanpackages --arch "$ARCH" --multiversion "pool/$COMPONENT" /dev/null) \
  > "$dist/$COMPONENT/binary-$ARCH/Packages"

# Deux variantes, et pas plus :
#
#  * `Packages.xz` — c'est celle qu'apt 3.x (Debian 13, Ubuntu 24.04+) réclame.
#    Un dépôt qui ne publie QUE `Packages.gz` est accepté sans le moindre avertis-
#    ment et puis ne fournit aucun paquet : apt récupère l'InRelease, n'en dérive
#    aucune cible, et `apt install` répond « Unable to locate package ». Constaté,
#    d'où ce choix.
#  * `Packages` non compressé — pour les apt très anciens qui ne savent pas lire
#    xz. Le format uncompressé est lu par tous les apt depuis toujours.
#
# Ni bz2 ni gz : un apt moderne ne les demandera pas, et chaque variante
# supplémentaire est une entrée de plus dans le Release à garder cohérente.
xz -9 -T0 -c "$dist/$COMPONENT/binary-$ARCH/Packages" \
  > "$dist/$COMPONENT/binary-$ARCH/Packages.xz"
xz -9 -T0 --check=crc32 -c "$dist/$COMPONENT/binary-$ARCH/Packages.xz" >/dev/null \
  || { echo "erreur: le Packages.xz produit est corrompu" >&2; exit 1; }

# --- 3. Release + signature -------------------------------------------------
cp "$KEY_ID" "$site/$KEY_ID"

# apt-ftparchive release scanne le répertoire et hache tout ce qu'il y trouve.
# Écrire sa sortie par `> "$dist/Release"` se mord la queue : le shell crée le
# fichier de sortie AVANT d'exécuter la commande, donc apt-ftparchive hacherait
# un Release vide et s'inscrirait lui-même dans sa propre liste de sommes. On
# écrit donc hors du répertoire, puis on déplace.
apt-ftparchive \
  -o "APT::FTPArchive::Release::Suite=$SUITE" \
  -o "APT::FTPArchive::Release::Codename=$SUITE" \
  -o "APT::FTPArchive::Release::Components=$COMPONENT" \
  -o "APT::FTPArchive::Release::Architectures=$ARCH" \
  -o "APT::FTPArchive::Release::Label=Writer Deck" \
  release "$dist" > "$root/Release"
mv "$root/Release" "$dist/Release"

# Auto-contrôle : un Release qui se liste lui-même est le symptôme exact de
# l'erreur ci-dessus, et le résultat est un dépôt qu'apt refuse en silence.
if grep -qE '^ [0-9a-f]+ +[0-9]+ Release$' "$dist/Release"; then
  echo "erreur: le Release se hache lui-même — l'ordre de génération est faux" >&2
  exit 1
fi

cat "$dist/Release"

# Clé privée importée dans un GNUPGHOME jetable : on ne touche pas à la clé du
# runner, et rien ne reste après le script.
export GNUPGHOME="$root/gnupg"
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
printf '%s\n' "$APT_GPG_PRIVATE_KEY" | gpg --batch --quiet --import
fpr=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/{print $10; exit}')
if [ -z "$fpr" ]; then
  echo "erreur: aucune clé privée importée" >&2
  exit 1
fi
echo "signature avec $fpr"

gpg --batch --yes --pinentry-mode loopback --passphrase '' \
    --local-user "$fpr" --digest-algo SHA256 \
    --clearsign --output "$dist/InRelease" "$dist/Release"

# On se vérifie soi-même avant de publier : une InRelease que apt refuse est pire
# qu'une absence de dépôt, parce que l'utilisateur verrait une erreur d'apt
# inexpliquée au lieu d'un « package not found ».
#
# L'ordre compte : la vérification doit tourner AVANT de retirer GNUPGHOME, sinon
# gpg valide contre le keyring ambiant du runner — où la clé n'est pas — et le
# contrôle échoue systématiquement. En CI il n'y a aucun keyring du tout.
gpg --batch --verify "$dist/InRelease" >/dev/null 2>&1 \
  || { echo "erreur: l'InRelease produite ne se vérifie pas" >&2; exit 1; }
echo "InRelease auto-vérifiée"

# `gpg --import` démarre un agent qui SURVIT au script. Dans un GNUPGHOME
# jetable il ne pourra jamais être réutilisé : sans ce kill, chaque exécution
# fuit un daemon, et la machine finit par manquer de sockets — ce qui casse
# ensuite des tests sans rapport, ici ceux du watcher Rust avec un EMFILE
# incompréhensible. Observé : 54 agents survivants après une trentaine de
# passages, et 3 tests Rust en échec sur « Too many open files ».
if command -v gpgconf >/dev/null 2>&1; then
  gpgconf --homedir "$GNUPGHOME" --kill all >/dev/null 2>&1 || true
fi
unset GNUPGHOME

# --- 4. publication ---------------------------------------------------------
# gh-pages est écrasée en entier à chaque version : le dépôt ne garde pas
# d'historique de paquets, apt ne le demande pas, et cela évite d'accumuler des
# anciennes versions qui ne se réinstalleraient plus (le code du paquet est
# embarqué dans le binaire).
# La page d'accueil est versionnée dans le dépôt : publish-apt-repo.sh écrase
# gh-pages en entier, la page doit donc venir d'un fichier suivi, sinon le site
# se retrouverait sans index après la première release.
racine=$(git -C "$GITHUB_WORKSPACE" rev-parse --show-toplevel)
for page in apt-index.html apt-README.txt; do
  if [ ! -f "$racine/.github/scripts/$page" ]; then
    echo "erreur: $page introuvable dans .github/scripts" >&2
    exit 1
  fi
done
cp "$racine/.github/scripts/apt-index.html" "$site/index.html"
cp "$racine/.github/scripts/apt-README.txt" "$site/README.txt"

cd "$site"
git init -q -b gh-pages .
git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' add -A
git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -q -m "apt: $TAG — dépôt signé republié"

# APT_DRY_RUN : construit et signe tout, saute la publication. Utilisé par les
# tests, qui vérifient l'arborescence et la signature sans toucher à gh-pages.
if [ -n "${APT_DRY_RUN:-}" ]; then
  trap - EXIT   # on conserve le site : c'est lui que le test inspecte
  echo
  echo "[dry-run] dépôt construit et signé, publication sautée"
  echo "[dry-run] site : $site"
  exit 0
fi

git push -q --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" \
    HEAD:refs/heads/gh-pages

echo
echo "dépôt APT publié : $BASE_URL"
echo "  $TAG  ->  $BASE_URL/dists/$SUITE/InRelease"
