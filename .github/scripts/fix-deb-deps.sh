#!/usr/bin/env bash
# Réécrit le champ Depends: d'un .deb produit par Tauri.
#
# Pourquoi ce script existe
# ------------------------
# La configuration `bundle.deb.depends` de tauri.conf.json ne suffit PAS, et c'est
# contournable seulement en lisant la source du CLI. Dans
# tauri-cli-2.12.1/src/interface/rust.rs :
#
#   ligne 1364 : let mut depends_deb = config.linux.deb.depends.unwrap_or_default();
#   ligne 1422 : depends_deb.push("libwebkit2gtk-4.1-0".to_string());
#   ligne 1423 : depends_deb.push("libgtk-3-0".to_string());
#
# Les deux `push` sont INCONDITIONNELS : la valeur de la config sert de base, et
# Tauri ajoute les deux noms historiques par-dessus. Un `libgtk-3-0t64 | libgtk-3-0`
# écrit dans la config se retrouve donc suivi d'un `libgtk-3-0` dur en fin de
# ligne — insatisfaisable sur Debian 13 / Ubuntu 24.04+,
# où GTK3 a été renommé `libgtk-3-0t64` (transition t64).
#
# Aucun nom unique ne convient : il faut une ALTERNATIVE Debian (`a | b`), or un
# champ Depends unique ne peut pas dire « GTK3, peu importe son nom ». On réécrit
# donc le fichier de contrôle après le bundling.
#
# Usage : fix-deb-deps.sh <chemin/paquet.deb> [<Depends attendu>]

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $(basename "$0") <paquet.deb> [depends-attendu]" >&2
  exit 2
fi

DEB=$1
EXPECTED=${2:-"libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0"}

if [ ! -f "$DEB" ]; then
  echo "erreur: paquet introuvable: $DEB" >&2
  exit 1
fi

# dpkg-deb n'accepte pas un chemin sans extension .deb
case $DEB in
  *.deb) ;;
  *) echo "erreur: pas un .deb: $DEB" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
pkg="$work/pkg"

# -R extrait l'arbre de contrôle (DEBIAN/control) et l'arbre de données.
dpkg-deb -R "$DEB" "$pkg"

control="$pkg/DEBIAN/control"
if [ ! -f "$control" ]; then
  echo "erreur: DEBIAN/control absent après extraction" >&2
  exit 1
fi

# Réécriture : une seule ligne Depends:, celle qu'on veut. Le nom du paquet, la
# version, le maintainer, les md5sums et les données restent intacts.
python3 - "$control" "$EXPECTED" <<'PY'
import sys

path, expected = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as fh:
    lines = fh.read().splitlines()

out, replaced = [], False
for line in lines:
    if line.lower().startswith('depends:'):
        out.append('Depends: ' + expected)
        replaced = True
    else:
        out.append(line)

if not replaced:
    raise SystemExit(
        'aucun champ Depends: dans le fichier de controle — le paquet a-t-il '
        'été construit par une version de Tauri qui le remplit toujours ?'
    )

with open(path, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(out) + '\n')
PY

# Reconstruction. --root-owner-group force 0/0 sur tout l'arbre, indispensable
# car l'extraction n'a pas d'information d'ownership fiable.
out_deb="$work/fixed.deb"
dpkg-deb --build --root-owner-group "$pkg" "$out_deb"

# On ne remplace l'original que si le résultat est conforme.
actual=$(dpkg-deb -f "$out_deb" Depends)
if [ "$actual" != "$EXPECTED" ]; then
  echo "erreur: Depends inattendu après reconstruction" >&2
  echo "  attendu: $EXPECTED" >&2
  echo "  obtenu : $actual" >&2
  exit 1
fi

mv -f "$out_deb" "$DEB"

echo "Depends corrigé: $actual"
echo "  paquet: $(dpkg-deb -f "$DEB" Package) $(dpkg-deb -f "$DEB" Version) ($(dpkg-deb -f "$DEB" Architecture))"
echo "  taille : $(stat -c%s "$DEB") octets"
