// Minimal static server for the anchor spike. Serves the audit harness plus the
// OSMD 2.2.1 UMD build from the frontend's installed node_modules.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = 'D:/123/audit-r1';
const OSMD = 'D:/123/rhythm-trainer-frontend/node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js';
const PORT = 8799;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.musicxml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  // The anchor-contract harness runs on the Vite dev server (5173) and posts its
  // result here; both are loopback-only audit tooling.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/result') {
      const requested = url.searchParams.get('file') ?? 'osmd-anchor-spike.json';
      const safeName = /^[a-z0-9._-]+$/i.test(requested) ? requested : 'osmd-anchor-spike.json';
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await mkdir('D:/123/audit-r1/spike/out', { recursive: true });
      await writeFile(`D:/123/audit-r1/spike/out/${safeName}`, Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"saved":true}');
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/spike/index.html';
    if (path === '/osmd.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      res.end(await readFile(OSMD));
      return;
    }
    const resolved = normalize(join(ROOT, path));
    if (!resolved.startsWith(normalize(ROOT))) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const body = await readFile(resolved);
    res.writeHead(200, { 'content-type': TYPES[extname(resolved)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(String(error?.message ?? error));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`anchor spike: http://127.0.0.1:${PORT}/`));
