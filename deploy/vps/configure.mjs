#!/usr/bin/env node
import { mkdir, readdir, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';

const dir = resolve(process.argv[2] || '/etc/dlt-vps');
await mkdir(dir, { recursive: true, mode: 0o700 });
if ((await readdir(dir)).length)
  throw new Error('Configuration directory is not empty; refusing to replace existing credentials.');
await chmod(dir, 0o700);
const ownerPassword = randomBytes(32).toString('hex');
const appPassword = randomBytes(32).toString('hex');
const files = {
  'database.env': `POSTGRES_USER=postgres\nPOSTGRES_DB=dlt_prod\nPOSTGRES_PASSWORD=${ownerPassword}\nDLT_APP_PASSWORD=${appPassword}\n`,
  'migrate.env': `NODE_ENV=production\nDATABASE_URL=postgres://postgres:${ownerPassword}@db:5432/dlt_prod\n`,
  'runtime.env': `# Literal KEY=value lines; do not add export or wrapping quotes.\nNODE_ENV=production\nDATABASE_URL=postgres://dlt_app:${appPassword}@db:5432/dlt_prod\n# Allow a 200-student campus-NAT burst; database brute-force rules stay active.\nLOGIN_RATE_LIMIT_PER_MINUTE=240\n\n# Fill these on the VPS before starting the API. Never commit them.\nRESEND_API_KEY=\nEMAIL_FROM=\nEMAIL_FROM_NAME=DLT\nRAZORPAY_KEY_ID=\nRAZORPAY_KEY_SECRET=\nRAZORPAY_WEBHOOK_SECRET=\nAUTO_REFUNDS_ENABLED=false\n`,
};
for (const [name, content] of Object.entries(files))
  await writeFile(join(dir, name), content, { mode: 0o600, flag: 'wx' });
console.log(`Created protected DLT configuration in ${dir}. No credentials were printed.`);
console.log('Fill email and Razorpay settings in runtime.env before starting the API.');
