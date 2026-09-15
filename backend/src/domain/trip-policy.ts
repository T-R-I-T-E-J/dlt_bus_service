import type { PoolClient } from 'pg';
import { AppError } from './errors.ts';

export type TripAction = 'edit' | 'hold' | 'book' | 'settle' | 'release' | 'seats' | 'staff' | 'cancel' | 'board' | 'noshow' | 'refund';

export async function requireTripAction(c: PoolClient, tripId: string, action: TripAction) {
  try {
    return (await c.query('SELECT * FROM require_trip_action($1,$2)', [tripId, action])).rows[0];
  } catch (e: any) {
    if (e.code === '23514') throw new AppError('CONFLICT', e.message);
    if (e.code === 'P0002') throw new AppError('NOT_FOUND', 'Trip not found');
    throw e;
  }
}

export async function publishValidation(c: PoolClient, tripId: string) {
  const { rows: [r] } = await c.query('SELECT trip_publish_problems($1) AS problems', [tripId]);
  const problems: string[] = r.problems;
  return { valid: problems.length === 0, problems, checks: problems.length ? [] : ['Lifecycle, route, departure, vehicle, schedule and seat map validated.'] };
}
