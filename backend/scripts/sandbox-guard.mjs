export function assertSandbox(env = process.env, { owner = false } = {}) {
  if (env.NODE_ENV !== 'test' || env.DLT_SANDBOX !== 'true') throw Error('Sandbox requires NODE_ENV=test and DLT_SANDBOX=true.');
  let url;
  try { url = new URL(env.DATABASE_URL || 'postgres://invalid/invalid'); }
  catch { throw Error('Sandbox database configuration is invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== '/dlt_sandbox'
    || !['db', '127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Sandbox requires its own local dlt_sandbox database.');
  if (!owner && url.username !== 'dlt_app') throw Error('Sandbox API requires the restricted dlt_app role.');
  if (env.EMAIL_TRANSPORT !== 'memory' || env.ALLOW_AUDIT_PRIVILEGE) throw Error('Sandbox must use memory email and the restricted audit role.');
  if (env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) throw Error('Live payment keys are not allowed in the sandbox.');
  if (['RESEND_API_KEY', 'EMAIL_SMTP_HOST', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASS'].some(k => env[k])) throw Error('Do not copy production email credentials into the sandbox.');
  if (!owner && (env.SANDBOX_PAYMENTS !== 'disabled' || env.RAZORPAY_KEY_ID !== 'rzp_test_sandbox_disabled'
    || env.RAZORPAY_KEY_SECRET !== 'disabled' || env.AUTO_REFUNDS_ENABLED !== 'false')) throw Error('This review sandbox requires disabled payments and refunds.');
  return url;
}
