import { createServer } from 'node:http';

const requests = [];
const ports = [4173, 4174];

function handler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': request.headers.origin ?? '*',
      'access-control-allow-headers': 'content-type, x-cekat-visitor-id',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    }).end();
    return;
  }
  if (url.pathname === '/control/reset' && request.method === 'POST') {
    requests.length = 0;
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === '/control/requests') {
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': request.headers.origin ?? '*' })
      .end(JSON.stringify(requests));
    return;
  }
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><script type="module">import * as cekat from '/browser/index.js'; window.cekat = cekat;</script>`);
    return;
  }
  if (url.pathname.startsWith('/browser/')) {
    const file = new URL(`../../../dist/browser/${url.pathname.slice('/browser/'.length)}`, import.meta.url);
    import('node:fs/promises').then(({ readFile }) => readFile(file)).then((body) => {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
    }).catch(() => response.writeHead(404).end());
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push({ origin: `http://${request.headers.host}`, method: request.method, path: url.pathname, headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': request.headers.origin ?? '*',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    }).end(JSON.stringify({ ok: true, method: request.method, path: url.pathname }));
  });
}

for (const port of ports) createServer(handler).listen(port, '127.0.0.1');
