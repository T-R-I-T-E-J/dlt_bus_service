/* DLT · domain/audit.ts — the audit trail.
 *
 * Admin Spec §9–§10: operational records are NEVER DELETED. The prototype
 * truncated to 600 entries, with a comment admitting a real store would not —
 * on a busy day of scans and status changes the oldest evidence rolled off
 * first. There is deliberately no cap, no retention trigger and no cleanup job
 * here, and migration 001 revokes DELETE and UPDATE on the table.
 *
 * Archive by partition if the table grows. Never by DELETE.
 *
 * WRITTEN, NOT EXECUTED.
 */

import type { PoolClient } from 'pg';
import { query } from '../db/index.ts';
import { AppError } from './errors.ts';

/* `userId` is accepted as an alias for `actorId`: admin.ts passes the canonical
 * Actor ({ userId, role, ip }) straight through, while payments.ts and
 * boarding.ts pass { actorId }. Both name the acting user's id. */
export interface AuditActor { actorId?: string; userId?: string; ip?: string }

/** Writes one entry. Takes the client so it commits with the mutation it
 *  describes: an action and its audit record are one transaction, and a
 *  rollback loses both rather than leaving a record of something that did not
 *  happen. */
export async function audit(
  c: PoolClient, actor: AuditActor, action: string,
  entityType: string, entityId: string | null,
  before: string | null, after: string | null, reason: string | null
): Promise<void> {
  /* actor_name and actor_role are DENORMALISED on purpose. A renamed or
   * demoted admin must not retroactively change what the log says about what
   * they did at the time. */
  await c.query(
    `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type,
                             entity_id, before_value, after_value, reason, ip)
     SELECT $1,
            COALESCE(u.name, 'system'), u.role,
            $2, $3, $4, $5, $6, $7, $8
       FROM (SELECT 1) _
       LEFT JOIN users u ON u.id = $1`,
    [actor.actorId ?? actor.userId ?? null, action, entityType, entityId,
     truncate(before), truncate(after), reason ?? null, actor.ip ?? null]);
}

/* Values are for human reading, not for reconstructing rows. Bounded so a large
 * payload cannot bloat the log — but never so short that the reason is lost. */
const truncate = (v: string | null | undefined) =>
  v == null ? null : String(v).slice(0, 2000);

export interface AuditQuery {
  entityType?: string; entityId?: string; actorId?: string;
  action?: string; from?: string; to?: string; limit?: number; cursor?: string;
}

/** Read the log. Keyset pagination on the bigserial id, so a busy log does not
 *  drift under an operator's feet mid-scroll. */
export async function readAudit(f: AuditQuery) {
  const limit = Math.min(Math.max(Number(f.limit ?? 100), 1), 500);
  const { rows } = await query(
    `SELECT id, actor_id AS "actorId", actor_name AS "actorName", actor_role AS "actorRole",
            action, entity_type AS "entityType", entity_id AS "entityId",
            before_value AS "before", after_value AS "after", reason, occurred_at AS "occurredAt"
       FROM audit_logs
      WHERE ($1::text IS NULL OR entity_type = $1)
        AND ($2::text IS NULL OR entity_id = $2)
        AND ($3::uuid IS NULL OR actor_id = $3)
        AND ($4::text IS NULL OR action LIKE $4 || '%')
        AND ($5::timestamptz IS NULL OR occurred_at >= $5)
        AND ($6::timestamptz IS NULL OR occurred_at <= $6)
        AND ($7::bigint IS NULL OR id < $7)
      ORDER BY id DESC
      LIMIT $8`,
    [f.entityType ?? null, f.entityId ?? null, f.actorId ?? null, f.action ?? null,
     f.from ?? null, f.to ?? null, f.cursor ?? null, limit]);
  return { entries: rows, nextCursor: rows.length === limit ? String(rows.at(-1)!.id) : null };
}

/** Guards against a caller trying to prune the log through the ordinary API.
 *  The database REVOKE is the real protection; this makes the intent explicit
 *  if anyone ever adds such an endpoint by habit. */
export function refuseAuditDeletion(): never {
  throw new AppError('FORBIDDEN',
    'Audit records are never deleted. Archive by partition if retention is needed.');
}
