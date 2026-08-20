#!/usr/bin/env node
/**
 * Zero-dependency static file server for the exported site in out/.
 *
 * `next start` cannot serve an `output: "export"` build, so LAN hosting needs a
 * plain file server. Binds 0.0.0.0 so phones and tablets on the same Wi-Fi can
 * reach it; the games under out/g/ are just files, so they come along for free.
 *
 *   node scripts/serve.mjs [--port 3000] [--host 0.0.0.0] [--dir out]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SEP = path.sep;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT || 3000));
const HOST = arg('host', process.env.HOST || '0.0.0.0');
const DIR = path.resolve(ROOT, arg('dir', 'out'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Next's export writes /lobby as both lobby.html and lobby/index.html, and the
 * game bundles are plain index.html files — try each shape before giving up.
 */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = path.join(DIR, clean);
  // Refuse anything that escaped out/ via ../ segments.
  if (target !== DIR && !target.startsWith(DIR + path.sep)) return null;

  for (const candidate of [target, `${target}.html`, path.join(target, 'index.html')]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url || '/');

  if (!file) {
    const notFound = path.join(DIR, '404.html');
    if (isFile(notFound)) {
      res.writeHead(404, { 'Content-Type': MIME['.html'] });
      fs.createReadStream(notFound).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': MIME['.txt'] });
      res.end('404 Not Found');
    }
    return;
  }

  const ext = path.extname(file).toLowerCase();
  // Hashed bundles under _next/ and assets/ are immutable; HTML must revalidate
  // so a rebuild is picked up without a hard refresh on every device.
  const immutable = (file.includes(SEP + '_next' + SEP) || file.includes(SEP + 'assets' + SEP)) && ext !== '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });

  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

if (!fs.existsSync(DIR)) {
  console.error(`[serve] ${path.relative(ROOT, DIR)}/ not found — run: npm run build`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log(`[serve] serving ${path.relative(ROOT, DIR)}/ on ${HOST}:${PORT}`);
  console.log(`[serve]   local:   http://localhost:${PORT}`);
  for (const a of addrs) console.log(`[serve]   network: http://${a}:${PORT}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[serve] port ${PORT} is already in use`);
  else console.error(`[serve] ${e.message}`);
  process.exit(1);
});
