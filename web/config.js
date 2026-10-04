/* Writer Deck — configuration.
   Source unique de la version et des liens GitHub (utilisés par le panneau « À propos »).
   La cohérence de `version` avec package.json / tauri.conf.json / Cargo.toml est
   vérifiée par tests/js/version.test.js. */
var WD_CONFIG = {
  repo: 'https://github.com/Tahlasandale/writerr',
  version: '0.1.0',
};
if (typeof window !== 'undefined') window.WD_CONFIG = WD_CONFIG;
if (typeof module !== 'undefined') module.exports = WD_CONFIG;