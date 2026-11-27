import { assertSandbox } from './sandbox-guard.mjs';
assertSandbox();
const [{ default: express }, { readFile, access }, { resolve, join }, { createApp }, { assertReady, close }, { closeCache }, { requireAuth, authErrorHandler }, { outbox }, { AppError }] = await Promise.all([
  import('express'), import('node:fs/promises'), import('node:path'), import('../src/app.ts'), import('../src/db/index.ts'),
  import('../src/domain/cache.ts'), import('../src/http/auth.routes.ts'), import('../src/integrations/email/index.ts'), import('../src/domain/errors.ts'),
]);
const ready = await assertReady();
if (!ready.auditAppendOnly) throw Error('Sandbox API must use an append-only audit role.');
const root = resolve(process.env.SANDBOX_PUBLIC_DIR || '/srv/releases/current/public');
await access(join(root, 'DLT Homepage.dc.html'));
const { app, provider } = createApp();
const disabled = async () => { throw new AppError('CONFLICT', 'Sandbox review: payments are disabled. No charge was made.'); };
provider.createOrder = disabled;
provider.fetchOrder = disabled;
provider.createRefund = disabled;
// This route exists only in the guarded sandbox image, never the production app.
app.get('/api/sandbox/inbox', requireAuth, (req, res) => {
  if (req.session.role !== 'SUPER_ADMIN') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Sandbox operations account required.' } });
  res.json({ environment: 'sandbox', sentExternally: false, messages: outbox });
});
app.use(authErrorHandler);
const web = express();
web.disable('x-powered-by');
web.use((_req, res, next) => {
  res.set('X-DLT-Environment', 'sandbox'); res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('Cache-Control', 'no-store'); next();
});
web.use((req, res, next) => req.path === '/api' || req.path.startsWith('/api/') ? app(req, res, next) : next());
web.get('/review', (_req, res) => res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>DLT sandbox review</title><main style="max-width:650px;margin:40px auto;padding:20px;font:17px/1.65 system-ui"><h1>DLT sandbox review</h1><p>Synthetic accounts and bookings. Real payments, external emails and background reconciliation are disabled.</p><p>Sign in using a sandbox account and the password from the VPS access file.</p><ul><li>Student: student@dlt-sandbox.invalid</li><li>Operations: ops@dlt-sandbox.invalid</li><li>Boarding staff: boarding@dlt-sandbox.invalid</li></ul><p><a href="/account">Sign in</a> · <a href="/booking">Book a trip</a> · <a href="/my-trips">Tickets</a> · <a href="/admin">Operations</a></p><p><a href="/api/sandbox/inbox">Test email inbox</a> requires the operations account. No real email is sent.</p></main>`));
const aliases = { '/': 'Homepage', '/booking': 'Booking', '/my-trips': 'Dashboard', '/account': 'Account', '/admin': 'Admin', '/policies': 'Policies' };
web.get('*', async (req, res, next) => {
  const name = aliases[req.path] ? `DLT ${aliases[req.path]}.dc.html` : /^\/DLT (Homepage|Booking|Dashboard|Account|Admin|Policies)\.dc\.html$/.test(req.path) ? req.path.slice(1) : null;
  if (!name) return next();
  try {
    const html = await readFile(join(root, name), 'utf8');
    res.type('html').send(html.replace(/<body([^>]*)>/i, '<body$1><div style="padding:10px 16px;background:#FFF0CE;color:#493500;font:600 13px/1.4 system-ui;position:relative;z-index:60">DLT SANDBOX · Test data only · Payments and emails disabled</div>'));
  } catch (e) { next(e); }
});
web.use(express.static(root, { index: false, dotfiles: 'deny', fallthrough: true }));
web.use((_req, res) => res.sendStatus(404));
web.use((_err, _req, res, _next) => res.status(500).send('Sandbox frontend unavailable.'));
const bind = process.env.SANDBOX_BIND || '127.0.0.1';
const api = app.listen(Number(process.env.SANDBOX_API_PORT || 3000), bind);
const frontend = web.listen(Number(process.env.SANDBOX_WEB_PORT || 8080), bind);
console.log('[sandbox] Ready with restricted audit role; payments and external email disabled.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  Promise.all([new Promise(r => api.close(r)), new Promise(r => frontend.close(r))])
    .then(() => Promise.all([close(), closeCache()])).then(() => process.exit(0));
});
