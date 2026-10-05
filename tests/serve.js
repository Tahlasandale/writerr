// Micro-serveur statique pour les tests : sert la racine du dépôt sans dépendance.
// PORT=0 (défaut) → un port libre est choisi automatiquement.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

function serve(port = 0) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    // L'app vit dans web/ : « / » redirige vers elle, sinon `npm run serve`
    // affiche une arborescence de fichiers sans moyen de deviner la bonne URL.
    if (rel === '/' || rel === '/index.html') {
      res.writeHead(302, { Location: '/web/index.html' });
      res.end();
      return;
    }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => {
    srv.listen(port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      app: `http://127.0.0.1:${srv.address().port}/web/index.html`,
      close: () => new Promise(r => srv.close(r)),
    }));
  });
}

module.exports = { serve };

if (require.main === module) {
  serve(Number(process.env.PORT) || 4173).then(s => {
    console.log(s.app);
    console.log('(Ctrl+C pour arrêter)');
  });
}