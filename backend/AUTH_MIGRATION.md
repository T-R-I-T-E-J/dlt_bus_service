# Authentication — browser behaviour → server endpoints

The map the frontend migration will be executed against. Read the middle column
as the contract: where it says *unchanged*, the screens keep working; where it
says *changes*, that is client work that has to be scheduled.

**Nothing here has been executed.** The endpoints are written, not running.

## 1. Method-by-method

| `window.DLT.auth` today | Server | Client contract |
|---|---|---|
| `signUp({name,email,password,phone,studentId})` → `{user, verifyToken}` | `POST /auth/signup` → `{user}` | **Changes.** `verifyToken` is gone — it was the F-06 disclosure. The account screen must stop displaying it and tell the student to check their email. |
| `signIn(email, password)` → `user` | `POST /auth/login` → `{user}`, sets `dlt_session` cookie | *Unchanged in shape.* Already `async`. The token moves into an HttpOnly cookie the page cannot read. |
| `signOut()` | `POST /auth/logout` | **Changes.** Was synchronous; becomes a promise. |
| `current()` → `user \| null`, **synchronous** | `GET /auth/me` → `{user}` | **Changes, and this is the big one.** Every screen calls `DLT.auth.current()` inside `renderVals()`. See §3. |
| `verifyEmail(token)` | `POST /auth/verify-email` | **Newly reachable.** F-15: the prototype had no route to this at all. |
| — | `POST /auth/resend-verification` | **New.** Needed because the code now expires in 48 hours. |
| `requestReset(email)` → `{sent:true}` | `POST /auth/forgot-password` → `{sent:true}` | *Unchanged.* Still never returns the code. |
| `resetPassword(token, password)` | `POST /auth/reset-password` | *Unchanged in shape.* Now also ends every session. |
| `changePassword(...)` | `POST /auth/change-password` | **Changes.** Responds `{ok, reauthenticate:true}` — the student must sign in again. |
| `admin.resetCodeFor(email)` | **deleted** | The support-desk stand-in existed only because there was no email. With real email it becomes a way for an admin to read a student's reset code — remove it, do not port it. |
| — | `POST /auth/logout-all` | **New.** Session revocation, which the prototype had no concept of. |
| `updateProfile`, `requestDeletion`, `myRequests` | Phase 6 (`/account/*`) | Not in this phase. |

## 2. What the server refuses that the browser could not

| Control | Where |
|---|---|
| argon2id, per-user salt, rehash on parameter change | `domain/auth.ts` |
| Reset and verification codes stored as SHA-256, single-use, expiring | `password_resets`, `email_verifications` |
| Codes delivered **only** by email — never in a response, a log or the audit trail | `requestPasswordReset` |
| Account enumeration closed: identical response and identical timing for unknown addresses | decoy hash + silent no-op |
| Brute force keyed on **email and IP**, window fixed from the first failure, surviving restart | `register_login_failure` |
| Sessions: opaque token, stored hashed, `HttpOnly; Secure; SameSite=Lax`, expiry + revocation | `sessions`, `active_sessions` |
| A password change or role change kills every live session | `revoke_user_sessions` |
| Role permissions read from the database per request | `role_permissions`, `has_permission` |
| Every input validated server-side regardless of client validation | `zod` at the boundary, rules in the domain |

## 3. The frontend work this creates

Three items, in order of size.

**3.1 `current()` becomes asynchronous — the largest task.**
`DLT.auth.current()` is called synchronously inside `renderVals()` on every
screen. Against a server it becomes a fetch. The fix is not to await it in
render; it is to resolve the session **once** on page load, hold the user in
component state, and have `renderVals()` read that state. Concretely:

```js
// dlt-client.js
let me = null, ready = false;
export async function boot() {
  me = (await api.get('/auth/me')).user;
  ready = true;
}
DLT.auth.current = () => me;        // stays synchronous for the screens
```

Each screen gains one loading state before `boot()` resolves. The screens'
`renderVals()` bodies do not otherwise change — this is the whole reason the
prototype was built against a single `window.DLT` object.

**3.2 The session cookie replaces `localStorage`.**
Nothing in the client reads or writes the session any more. `fetch` needs
`credentials: 'include'`, and the API must send `Access-Control-Allow-Credentials`
with an explicit origin (never `*`). Remove `SESSION_KEY` and every reference.

**3.3 Copy and screens that change.**
- Sign-up confirmation: "check your email" instead of showing a token.
- A verification screen at `/verify?code=…` — new, small.
- Account screen: show verified/unverified honestly, with a resend button (F-15).
- Password change: sign the student out and say so.
- Remove `demoHint` from the booking review screen.

## 4. Still not done in this phase

- **Email delivery is an interface, not an implementation.** `integrations/email`
  needs a real provider bound to it. Until then `outbox` is a test transport and
  no student receives anything.
- Rate limiting on `/auth/*` is per-process (`express-rate-limit`); behind more
  than one instance it needs a shared store. The database lockout is the real
  control and is already shared.
- No MFA, no device trust, no session listing UI. None are specified.
- `POST /auth/signup` does not sign the student in. If product wants sign-up to
  continue straight into booking, that is a decision to take, not a bug.
