// Trouve un Chromium/Chrome déjà installé. CHROME_PATH force un chemin précis.
const fs = require('fs');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

const found = CANDIDATES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });

if (!found) {
  console.error('Aucun navigateur trouvé. Installez Chromium/Chrome, ou définissez CHROME_PATH.');
  console.error('Emplacements cherchés :\n  ' + CANDIDATES.join('\n  '));
  process.exit(1);
}

module.exports = { executablePath: found };