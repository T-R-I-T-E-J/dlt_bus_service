/* devserve.mjs — same-origin static host + /api proxy, for local development.
 *
 * Why this exists: the *.dc.html screens load journey.js and dlt-client.js as
 * `<script type="module">`. Browsers refuse to fetch ES modules from a
 * `file://` origin (blocked as CORS from origin "null"), so double-clicking
 * a .dc.html file to open it directly loads none of the app's JS — no 3D
 * journey, no DLT.* API client, nothing. These files must be served over
 * http(s), not opened as local files.
 *
 * This also proxies /api/* to the backend on the same origin, so the
 * `dlt_session` cookie stays first-party and the backend needs no CORS
 * configuration (see backend/SECURITY_FINDINGS.md, M-2).
 *
 * Usage:
 *   node devserve.mjs [root] [port] [apiBase]
 *   node devserve.mjs .     8080  http://127.0.0.1:3000
 *
 * Then open http://localhost:8080/DLT%20Homepage.dc.html — with the backend
 * (`cd backend && npm run dev`) running on the apiBase port.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.argv[3] || 8080);
const API = process.argv[4] || 'http://127.0.0.1:3000';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(API + req.url, {
        method: req.method,
        headers: { ...req.headers, host: new URL(API).host },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        redirect: 'manual',
      });
      /* Object.fromEntries(upstream.headers) collapses repeated header names —
       * Set-Cookie above all — into one entry, silently dropping the session
       * cookie whenever a response sets more than one. getSetCookie() returns
       * every value; everything else is fine collapsed since it's one-per-name. */
      const headers = Object.fromEntries(upstream.headers);
      const cookies = upstream.headers.getSetCookie?.() ?? [];
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/DLT Homepage.dc.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); res.end('not found: ' + p); return; }
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  } catch (e) {
    res.writeHead(502); res.end('devserve error: ' + e.message);
  }
});
server.listen(PORT, () => console.log(`devserve: ${ROOT}\n  http://localhost:${PORT}/  -> static\n  /api    -> ${API}`));
