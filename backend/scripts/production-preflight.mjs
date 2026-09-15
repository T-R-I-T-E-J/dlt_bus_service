#!/usr/bin/env node
/* DLT production preflight.
 *
 * Run on the production host after environment variables are set and after
 * migrations are applied, but before opening traffic.
 */

const REQUIRED_MIGRATIONS = 23;

const failures = [];
const warnings = [];

const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);
const has = (name) => Boolean(process.env[name] && process.env[name].trim());

function roleFromConnectionString(value) {
  try {
    return new URL(value).username || '(no username)';
  } catch {
    return '(could not parse username)';
  }
}

if (process.env.NODE_ENV !== 'production')
  fail('NODE_ENV must be production.');

if (!has('DATABASE_URL')) {
  fail('DATABASE_URL is required.');
} else {
  const role = roleFromConnectionString(process.env.DATABASE_URL);
  if (/^(postgres|root|admin|owner)$/i.test(role))
    fail(`DATABASE_URL appears to use an owner/superuser role (${role}); use the restricted runtime role, ideally dlt_app.`);
}

if (process.env.ALLOW_AUDIT_PRIVILEGE)
  fail('ALLOW_AUDIT_PRIVILEGE must be absent in production.');

if (process.env.EMAIL_TRANSPORT === 'memory')
  fail('EMAIL_TRANSPORT=memory is development-only and must be absent in production.');

if (has('RESEND_API_KEY')) {
  if (!has('EMAIL_FROM'))
    fail('EMAIL_FROM is required when RESEND_API_KEY is set.');
} else if (!(has('EMAIL_SMTP_HOST') && has('EMAIL_SMTP_USER') && has('EMAIL_SMTP_PASS'))) {
  fail('Configure production email with RESEND_API_KEY + EMAIL_FROM, or EMAIL_SMTP_HOST/EMAIL_SMTP_USER/EMAIL_SMTP_PASS.');
}

for (const name of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
  if (!has(name)) fail(`${name} is required.`);
}

if (has('RAZORPAY_KEY_ID') && !process.env.RAZORPAY_KEY_ID.startsWith('rzp_live_'))
  warn('RAZORPAY_KEY_ID does not start with rzp_live_; confirm this is intentional before accepting real payments.');

if (process.env.AUTO_REFUNDS_ENABLED !== 'false')
  warn('AUTO_REFUNDS_ENABLED is not false; automatic provider refund dispatch may run.');

if (!failures.length) {
  const { assertReady, close } = await import('../src/db/index.ts');
  try {
    const ready = await assertReady();
    if (ready.migrations < REQUIRED_MIGRATIONS)
      fail(`Database has ${ready.migrations} migrations; expected at least ${REQUIRED_MIGRATIONS}.`);
    if (!ready.auditAppendOnly)
      fail('Database audit log is not append-only for the runtime role.');
    console.log(`[preflight] database ok: postgres ${ready.version}, ${ready.migrations} migrations, audit append-only ${ready.auditAppendOnly}`);
  } catch (error) {
    fail(`Database readiness failed: ${error.message}`);
  } finally {
    await close();
  }
}

for (const message of warnings)
  console.warn(`[preflight] warning: ${message}`);

if (failures.length) {
  console.error('[preflight] FAILED');
  for (const message of failures)
    console.error(` - ${message}`);
  process.exit(1);
}

console.log('[preflight] PASSED: production environment and database readiness checks are green.');
