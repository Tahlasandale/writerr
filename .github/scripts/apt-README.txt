Writer Deck — dépôt APT servi par GitHub Pages.

Ce dépôt apt est régénéré intégralement par .github/workflows/release.yml à
chaque tag v*, puis poussé en --force sur la branche gh-pages. Rien ici n'est
écrit à la main : le contenu est écrasé.

  /writerr-apt-key.asc                          clé publique de signature
  /dists/stable/InRelease                      Release clair-signé
  /dists/stable/Release                        Release en clair
  /dists/stable/main/binary-amd64/Packages     index des paquets
  /dists/stable/main/binary-amd64/Packages.xz  idem, compressé (apt 3.x le réclame)
  /pool/main/w/writer-deck/*.deb               paquets

Clé de signature GPG : 10433B2A24900E8F5A6FBA660CFFC7C5CB907F46
La clé privée correspondante vit dans le secret CI APT_GPG_PRIVATE_KEY et n'est
jamais versionnée. Elle est sans phrase de passe : le secret EST la clé.

Installation, mise à jour, et journal des décisions :
https://github.com/Tahlasandale/writerr
