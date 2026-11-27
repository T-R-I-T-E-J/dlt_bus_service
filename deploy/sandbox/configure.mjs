import { mkdir, readdir, writeFile, chmod, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function configureSandbox(path) {
  const dir = resolve(path);
  if (dir === '/etc/dlt-vps' || dir.startsWith('/etc/dlt-vps/')) throw Error('Production configuration is not a sandbox directory.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const actual = await realpath(dir);
  if (actual === '/etc/dlt-vps' || actual.startsWith('/etc/dlt-vps/')) throw Error('Production configuration is not a sandbox directory.');
  if ((await readdir(dir)).length) throw Error('Sandbox configuration directory is not empty; nothing was overwritten.');
  await chmod(dir, 0o700);
  const owner = randomBytes(32).toString('hex');
  const app = randomBytes(32).toString('hex');
  const password = randomBytes(24).toString('base64url');
  const common = 'NODE_ENV=test\nDLT_SANDBOX=true\nEMAIL_TRANSPORT=memory\nAUTO_REFUNDS_ENABLED=false\n';
  const files = {
    'database.env': `POSTGRES_USER=postgres\nPOSTGRES_DB=dlt_sandbox\nPOSTGRES_PASSWORD=${owner}\nDLT_APP_PASSWORD=${app}\n`,
    'migrate.env': `${common}DATABASE_URL=postgres://postgres:${owner}@db:5432/dlt_sandbox\nSANDBOX_REVIEW_PASSWORD=${password}\n`,
    'runtime.env': `${common}DATABASE_URL=postgres://dlt_app:${app}@db:5432/dlt_sandbox\nSANDBOX_PAYMENTS=disabled\nRAZORPAY_KEY_ID=rzp_test_sandbox_disabled\nRAZORPAY_KEY_SECRET=disabled\nRAZORPAY_WEBHOOK_SECRET=${randomBytes(32).toString('hex')}\nLOGIN_RATE_LIMIT_PER_MINUTE=240\n`,
    'access.txt': `DLT sandbox only. No production accounts or keys.\nOpen through the SSH tunnel: http://127.0.0.1:8186/review\nStudent: student@dlt-sandbox.invalid\nOperations: ops@dlt-sandbox.invalid\nBoarding: boarding@dlt-sandbox.invalid\nReview password for these synthetic accounts: ${password}\n`,
    'sandbox.json': JSON.stringify({ project: 'dlt-sandbox-review', database: 'dlt_sandbox', payments: 'disabled' }) + '\n',
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, { mode: 0o600, flag: 'wx' });
  return Object.keys(files);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await configureSandbox(process.argv[2] || '/etc/dlt-sandbox');
  console.log(`Created ${files.length} protected sandbox configuration files. No credentials were printed.`);
}
