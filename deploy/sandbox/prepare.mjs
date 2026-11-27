import { execFileSync } from 'node:child_process';
import { symlink, rename } from 'node:fs/promises';
const release = '/releases/review-' + Date.now();
execFileSync(process.execPath, ['/src/deploy/frontend/prepare.mjs', '--api-origin', 'http://127.0.0.1:3110', '--domain', 'sandbox.dltservices.tech', '--out', release], { stdio: 'inherit' });
const temporary = '/releases/.current-' + Date.now();
// The API mounts this volume at /srv/releases; keep the target relative.
await symlink(release.split('/').pop(), temporary);
await rename(temporary, '/releases/current');
console.log('Sandbox frontend prepared. No host Nginx configuration was installed.');
