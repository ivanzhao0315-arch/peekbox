// A static server for web/ (the same files that go on DeWEB), for local work.   PORT=8820 node server/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT || 8820);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
// TAPE_BOX / TAPE_RPC / TAPE_CHAIN_ID in the environment override config.js for the pages served here (the dev stack sets them)
const OVERRIDES = ['TAPE_BOX', 'TAPE_RPC', 'TAPE_CHAIN_ID'].filter((k) => k in process.env);
const value = (k) => (k === 'TAPE_CHAIN_ID' ? Number(process.env[k]) : JSON.stringify(process.env[k]));
const configJs = () => fs.readFileSync(path.join(WEB, 'config.js'), 'utf8') + OVERRIDES.map((k) => `\nwindow.${k} = ${value(k)}; // set by the server's environment`).join('') + '\n';

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html'; } catch { res.writeHead(400); return res.end('bad path'); }
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  // the DeWEB gateway allows no outside or inline scripts: the same rule here, so a page that breaks there breaks here first
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': "script-src 'self'" });
  if (rel === 'config.js') return res.end(configJs());
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`瞄一箱 PeekBox on http://127.0.0.1:${PORT}/`));
