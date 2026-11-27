import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configureSandbox } from '../deploy/sandbox/configure.mjs';
import { assertSandbox } from '../backend/scripts/sandbox-guard.mjs';
const parseEnv = s => Object.fromEntries(s.trim().split('\n').map(s => { const i = s.indexOf('='); return [s.slice(0,i),s.slice(i+1)]; }));
async function config(t) {
  const base = await mkdtemp(join(tmpdir(), 'dlt-sandbox-config-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, 'config'); await configureSandbox(dir);
  return dir;
}
test('sandbox configuration is private, independent and cannot overwrite an existing setup', async t => {
  const dir = await config(t);
  const before = await readFile(join(dir,'runtime.env'),'utf8');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const name of ['database.env','runtime.env','migrate.env','access.txt']) assert.equal((await stat(join(dir,name))).mode & 0o777, 0o600);
  const env = parseEnv(before); assert.equal(assertSandbox(env).pathname,'/dlt_sandbox');
  const owner = parseEnv(await readFile(join(dir,'migrate.env'),'utf8'));
  assert.equal(assertSandbox(owner,{owner:true}).username,'postgres');
  assert.notEqual(new URL(env.DATABASE_URL).password,new URL(owner.DATABASE_URL).password);
  await assert.rejects(configureSandbox(dir), /not empty/);
  assert.equal(await readFile(join(dir,'runtime.env'),'utf8'),before);
  await assert.rejects(configureSandbox('/etc/dlt-vps'),/Production configuration/);
});
test('sandbox refuses production databases, elevated runtime roles and external credentials before connecting', async t => {
  const dir=await config(t);const env=parseEnv(await readFile(join(dir,'runtime.env'),'utf8'));
  for(const change of [{NODE_ENV:'production'},{DATABASE_URL:env.DATABASE_URL.replace('/dlt_sandbox','/dlt_prod')},
    {DATABASE_URL:env.DATABASE_URL.replace('dlt_app:','postgres:')},{DATABASE_URL:env.DATABASE_URL.replace('@db:', '@external.invalid:')},
    {RESEND_API_KEY:'must-not-be-used'},{EMAIL_SMTP_HOST:'external.invalid'},{RAZORPAY_KEY_ID:'rzp_live_not-allowed'},
    {SANDBOX_PAYMENTS:'enabled'},{ALLOW_AUDIT_PRIVILEGE:'i-understand-the-risk'}]) assert.throws(()=>assertSandbox({...env,...change}));
});
test('the Compose sandbox has its own images and volumes, private ports, and no production mounts', async t => {
  try {execFileSync('docker',['compose','version'],{stdio:'ignore'});}catch{return t.skip('Docker Compose CLI unavailable');}
  const dir=await config(t);
  const cfg=JSON.parse(execFileSync('docker',['compose','-p','dlt-sandbox-review','-f','deploy/sandbox/compose.yaml','--profile','tools','config','--format','json'],{cwd:new URL('..',import.meta.url),env:{...process.env,DLT_SANDBOX_CONFIG_DIR:dir},encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.equal(cfg.name,'dlt-sandbox-review');assert.equal(cfg.services.api.image,'dlt-sandbox-api:review');
  assert.equal(cfg.services.migrate.image,'dlt-sandbox-tools:review');assert.equal(cfg.services.db.ports,undefined);
  assert.equal(cfg.services.api.ports,undefined);
  assert.deepEqual(cfg.services.gateway.ports.map(p=>[p.host_ip,String(p.published)]),[['127.0.0.1','3110'],['127.0.0.1','8186']]);
  assert.equal(cfg.networks.backend.internal,true);
  for (const service of ['db','api','migrate']) assert.deepEqual(Object.keys(cfg.services[service].networks),['backend']);
  assert.equal(cfg.services.gateway.environment,undefined);
  assert.deepEqual(Object.keys(cfg.services.gateway.networks).sort(),['backend','default']);
  assert.equal(cfg.volumes['postgres-data'].name,'dlt-sandbox-review_postgres-data');
  assert.ok(cfg.services.api.volumes.every(v=>!String(v.source).includes('/etc/dlt-vps')&&!String(v.source).includes('dlt-vps-fresh')));
  assert.equal(cfg.services.api.environment.DATABASE_URL.endsWith('/dlt_sandbox'),true);
});
