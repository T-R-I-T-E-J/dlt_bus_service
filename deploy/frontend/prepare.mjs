#!/usr/bin/env node
// Build a frontend-only release. This never connects to or changes the database.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const options = { domain: 'dltservices.tech', alias: '', 'api-origin': '', out: '' };
const preview = args.includes('--preview');
for (let i = 0; i < args.length;) {
  if (args[i] === '--preview') { i += 1; continue; }
  const key = args[i].replace(/^--/, '');
  if (!args[i].startsWith('--') || !Object.hasOwn(options, key) || !args[i + 1])
    throw new Error('Usage: node deploy/frontend/prepare.mjs (--preview | --api-origin https://your-api.example.com) --out /tmp/dlt-release [--domain dltservices.tech] [--alias www.dltservices.tech]');
  options[key] = args[i + 1];
  i += 2;
}
const validDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
for (const name of [options.domain, options.alias].filter(Boolean)) {
  if (!validDomain.test(name)) throw new Error(`Invalid domain: ${name}`);
}
if (preview && options['api-origin'])
  throw new Error('--preview disables the API; do not combine it with --api-origin.');
if (!preview && !options['api-origin'])
  throw new Error('--api-origin is required; supply the new Railway backend public HTTPS origin.');
const api = preview ? null : new URL(options['api-origin']);
const localApi = api && api.protocol === 'http:' && api.hostname === '127.0.0.1' && Boolean(api.port);
if (api && ((!localApi && (api.protocol !== 'https:' || !validDomain.test(api.hostname))) || api.username || api.password || api.pathname !== '/' || api.search || api.hash))
  throw new Error('--api-origin must be http://127.0.0.1:PORT or a public HTTPS origin, without credentials, path or query.');
if (!options.out) throw new Error('--out is required; use a new directory for each release.');
const out = resolve(options.out);
// mkdir without recursive refuses to overwrite an existing release.
await mkdir(out);
const publicDir = join(out, 'public');
await mkdir(publicDir);
const pages = ['Homepage', 'Booking', 'Dashboard', 'Account', 'Admin', 'Policies']
  .map(name => `DLT ${name}.dc.html`);
const files = [...pages, '404.html', 'dlt-client.js', 'dlt-qr.js', 'journey.js',
  'jsqr.vendor.js', 'support.js', 'dlt-mobile.css', 'favicon.svg', 'robots.txt', 'sitemap.xml'];
for (const file of files) {
  let contents = await readFile(join(repo, file), 'utf8');
  if (/\.(html|xml|txt)$/.test(file)) {
    // Vercel injects these endpoints; they do not exist on the VPS.
    contents = contents.replace(/<script\b[^>]*src=["']\/_vercel\/[^"']+["'][^>]*>\s*<\/script>\s*/g, '');
    contents = contents.replace(/https:\/\/(?:www\.)?(?:dltservices\.tech|webtesters\.site|dlt\.example\.com)/g,
      `https://${options.domain}`);
  }
  await writeFile(join(publicDir, file), contents);
}
for (const folder of ['assets', 'vendor'])
  await cp(join(repo, folder), join(publicDir, folder), { recursive: true, dereference: false });

const names = [options.domain, options.alias].filter(Boolean).join(' ');
if (preview) {
  await writeFile(join(out, 'nginx-preview.conf'), `# Static preview only. No backend or database connection.
server {
    listen 80;
    listen [::]:80;
    server_name ${names};
    root /var/www/dlt/current;
    index "DLT Homepage.dc.html";
    server_tokens off;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header X-Robots-Tag "noindex, noarchive" always;
    add_header Cache-Control "no-store" always;
    location ^~ /api/ {
        default_type application/json;
        return 503 '{"ok":false,"error":"Frontend preview; API is not connected."}';
    }
    location = /api { return 308 /api/$is_args$args; }
    location = /booking { rewrite ^ "/DLT Booking.dc.html" last; }
    location = /policies { rewrite ^ "/DLT Policies.dc.html" last; }
    location = /account { rewrite ^ "/DLT Account.dc.html" last; }
    location = /my-trips { rewrite ^ "/DLT Dashboard.dc.html" last; }
    location = /admin { rewrite ^ "/DLT Admin.dc.html" last; }
    location = /book { return 301 /booking$is_args$args; }
    location = /terms { return 301 /policies$is_args$args; }
    location = /privacy { return 301 /policies$is_args$args; }
    location ~ /\\. { return 404; }
    location / { try_files $uri $uri/ =404; }
    error_page 404 /404.html;
}
`);
} else {
const tlsUpstream = localApi ? '' : `        proxy_ssl_server_name on;
        proxy_ssl_name ${api.hostname};
        proxy_ssl_verify on;
        proxy_ssl_verify_depth 3;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
`;
const acme = `    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        try_files $uri =404;
    }`;
await writeFile(join(out, 'nginx-bootstrap.conf'), `# Use only while obtaining the first TLS certificate.
server {
    listen 80;
    listen [::]:80;
    server_name ${names};
${acme}
    location / { return 503; }
}
`);
await writeFile(join(out, 'nginx-dlt.conf'), `# Frontend on VPS; proxy to the configured API backend.
server {
    listen 80;
    listen [::]:80;
    server_name ${names};
${acme}
    location / { return 301 https://${options.domain}$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${names};
    ssl_certificate /etc/letsencrypt/live/${options.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${options.domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    root /var/www/dlt/current;
    index "DLT Homepage.dc.html";
    server_tokens off;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header Cache-Control "no-cache" always;

    # Preserve /api and query strings. The VPS API uses a loopback-only port.
    location ^~ /api/ {
        proxy_pass ${api.origin};
        proxy_http_version 1.1;
        proxy_set_header Host ${localApi ? '$host' : api.host};
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
${tlsUpstream}        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
        client_max_body_size 256k;
        # API responses, sessions, payments and webhooks must not be cached.
        proxy_cache off;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
        add_header X-Robots-Tag "noindex" always;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }
    location = /api { return 308 /api/$is_args$args; }
    location = /booking { rewrite ^ "/DLT Booking.dc.html" last; }
    location = /policies { rewrite ^ "/DLT Policies.dc.html" last; }
    location = /account { rewrite ^ "/DLT Account.dc.html" last; }
    location = /my-trips { rewrite ^ "/DLT Dashboard.dc.html" last; }
    location = /admin { rewrite ^ "/DLT Admin.dc.html" last; }
    location = /book { return 301 /booking$is_args$args; }
    location = /terms { return 301 /policies$is_args$args; }
    location = /privacy { return 301 /policies$is_args$args; }
    location ~ /\\. { return 404; }
    location ~* ^/(backend|deploy|test|uploads)(/|$) { return 404; }
    location ~* \\.(md|sql|env|dump)$ { return 404; }
    location / { try_files $uri $uri/ =404; }
    error_page 404 /404.html;
}
`);
}
console.log(`Frontend release prepared at ${out}`);
console.log(preview ? 'Static preview only: API is disabled.' : `API origin: ${api.origin}`);
console.log('No backend environment, migrations or data were changed.');
