/* DLT · src/types/express.d.ts
 *
 * Every route file reads `req.session`. Without this augmentation the backend
 * produces a TypeScript error on each of those reads — found by the consistency
 * audit, and the single most common compile failure in the HTTP layer.
 *
 * The shape mirrors what auth.resolveSession returns. Note what is NOT here: no
 * permissions array and no client-supplied fields. `role` is read from the
 * database on every request, and authorization always re-checks it against
 * role_permissions rather than trusting anything cached on the request.
 */

declare global {
  namespace Express {
    interface Request {
      session: {
        sessionId: string;
        userId: string;
        role: string;
        email: string;
        name: string;
        emailVerified: boolean;
      } | null;
    }
  }
}

export {};
