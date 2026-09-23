const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function createStaticServer() {
  const root = path.resolve(__dirname, '..');
  const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'};
  return http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, {'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache'});
    fs.createReadStream(file).pipe(response);
  });
}

async function startStaticServer(port = 0) {
  const server = createStaticServer();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {server, url: `http://127.0.0.1:${server.address().port}/`};
}

module.exports = {startStaticServer};

if (require.main === module) {
  startStaticServer(Number(process.argv[2]) || 8766).then(({url}) => process.stdout.write(`${url}\n`)).catch(error => {console.error(error); process.exitCode = 1;});
}
