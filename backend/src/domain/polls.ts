/* DLT · domain/polls.ts — public schedule preference collection and admin read. */

import { createHash } from 'node:crypto';
import { query } from '../db/index.ts';
import { AppError } from './errors.ts';
import { requirePermission } from './auth.ts';
import type { Actor } from './authz.ts';

export const BUS_TIME_POLL_KEY = 'woxsen-miyapur-departure-time-v1';
export const BUS_TIME_OPTIONS = [
  ['09:00', '9 AM'], ['10:00', '10 AM'], ['11:00', '11 AM'],
  ['12:00', '12 PM'], ['13:00', '1 PM'], ['14:00', '2 PM'],
  ['15:00', '3 PM'], ['16:00', '4 PM'], ['17:00', '5 PM'],
  ['18:00', '6 PM'], ['19:00', '7 PM'], ['OTHER', 'Other'],
] as const;

export type BusTimeChoice = typeof BUS_TIME_OPTIONS[number][0];
const CHOICES = new Set<string>(BUS_TIME_OPTIONS.map(([key]) => key));
const LABELS = new Map<string, string>(BUS_TIME_OPTIONS);

export interface BusTimeVoteInput {
  choices: string[];
  otherTime?: string | null;
  name?: string | null;
  phone?: string | null;
  studentId?: string | null;
}

const clean = (value: string | null | undefined) => {
  const out = String(value ?? '').trim();
  return out || null;
};

export function participantHash(identity: { userId?: string | null; guestToken?: string | null }): string {
  const source = identity.userId ? `user:${identity.userId}` : `guest:${identity.guestToken ?? ''}`;
  if (!identity.userId && !identity.guestToken)
    throw new AppError('VALIDATION', 'A browser identity is required');
  return createHash('sha256').update(source).digest('hex');
}

function validateVote(input: BusTimeVoteInput) {
  const choices = [...new Set(input.choices)];
  if (choices.length !== input.choices.length || choices.length < 1 || choices.length > 3
      || choices.some((choice) => !CHOICES.has(choice)))
    throw new AppError('VALIDATION', 'Choose between one and three available times');
  const otherTime = clean(input.otherTime);
  if (choices.includes('OTHER') !== !!otherTime)
    throw new AppError('VALIDATION', 'Tell us what time you prefer for Other');
  return {
    choices,
    otherTime,
    name: clean(input.name),
    phone: clean(input.phone),
    studentId: clean(input.studentId),
  };
}

const publicVote = (row: any) => row ? ({
  choices: row.choices,
  otherTime: row.other_time,
  name: row.name,
  phone: row.phone,
  studentId: row.student_id,
  updatedAt: row.updated_at,
}) : null;

export async function getBusTimePoll(hash: string) {
  const { rows: [vote] } = await query(
    `SELECT choices, other_time, name, phone, student_id, updated_at
       FROM bus_time_poll_responses
      WHERE poll_key = $1 AND participant_hash = $2`,
    [BUS_TIME_POLL_KEY, hash]);
  return {
    key: BUS_TIME_POLL_KEY,
    question: 'What time should the Woxsen to Miyapur bus leave?',
    maxChoices: 3,
    options: BUS_TIME_OPTIONS.map(([key, label]) => ({ key, label })),
    vote: publicVote(vote),
  };
}

export async function saveBusTimeVote(
  hash: string, userId: string | null, input: BusTimeVoteInput,
) {
  const vote = validateVote(input);
  const { rows: [saved] } = await query(
    `INSERT INTO bus_time_poll_responses
       (poll_key, participant_hash, user_id, choices, other_time, name, phone, student_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (poll_key, participant_hash) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       choices = EXCLUDED.choices,
       other_time = EXCLUDED.other_time,
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       student_id = EXCLUDED.student_id,
       updated_at = now()
     RETURNING choices, other_time, name, phone, student_id, updated_at`,
    [BUS_TIME_POLL_KEY, hash, userId, vote.choices, vote.otherTime,
     vote.name, vote.phone, vote.studentId]);
  return publicVote(saved);
}

async function pollResponses(limit?: number) {
  const values: unknown[] = [BUS_TIME_POLL_KEY];
  const limitSql = limit === undefined ? '' : 'LIMIT $2';
  if (limit !== undefined) values.push(limit);
  const { rows } = await query(
    `SELECT r.id, r.choices, r.other_time AS "otherTime",
            COALESCE(r.name, u.name) AS name,
            COALESCE(r.phone, u.phone) AS phone,
            COALESCE(r.student_id, sp.student_id) AS "studentId",
            u.email, r.updated_at AS "updatedAt"
       FROM bus_time_poll_responses r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN student_profiles sp ON sp.user_id = r.user_id
      WHERE r.poll_key = $1
      ORDER BY r.updated_at DESC
      ${limitSql}`,
    values,
  );
  return rows.map((row: any) => ({
    ...row,
    choiceLabels: row.choices.map((choice: string) =>
      choice === 'OTHER' && row.otherTime ? `Other: ${row.otherTime}` : (LABELS.get(choice) ?? choice)),
  }));
}

export async function busTimePollResults(actor: Actor) {
  await requirePermission(actor.role, 'poll.read');
  const [{ rows: counts }, { rows: [summary] }, responses] = await Promise.all([
    query(
      `SELECT choice, count(*)::int AS votes
         FROM bus_time_poll_responses r, unnest(r.choices) AS choice
        WHERE r.poll_key = $1
        GROUP BY choice`, [BUS_TIME_POLL_KEY]),
    query(
      `SELECT count(*)::int AS responses,
              count(*) FILTER (WHERE COALESCE(r.phone, u.phone, u.email) IS NOT NULL)::int AS contactable,
              max(r.updated_at) AS latest
         FROM bus_time_poll_responses r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.poll_key = $1`, [BUS_TIME_POLL_KEY]),
    pollResponses(500),
  ]);
  const byChoice = new Map(counts.map((row: any) => [row.choice, Number(row.votes)]));
  const totalResponses = Number(summary.responses ?? 0);
  const options = BUS_TIME_OPTIONS.map(([key, label]) => {
    const votes = byChoice.get(key) ?? 0;
    return { key, label, votes, percent: totalResponses ? Math.round(votes * 100 / totalResponses) : 0 };
  }).sort((a, b) => b.votes - a.votes || BUS_TIME_OPTIONS.findIndex(([key]) => key === a.key)
    - BUS_TIME_OPTIONS.findIndex(([key]) => key === b.key));
  return {
    key: BUS_TIME_POLL_KEY,
    question: 'What time should the Woxsen to Miyapur bus leave?',
    totalResponses,
    contactable: Number(summary.contactable ?? 0),
    latestAt: summary.latest,
    leadingOption: options.find((option) => option.votes > 0) ?? null,
    options,
    responses,
  };
}

const csvCell = (value: unknown) => {
  const raw = String(value ?? '');
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export async function exportBusTimePoll(actor: Actor) {
  await requirePermission(actor.role, 'poll.read');
  const responses = await pollResponses();
  const header = ['Preferred times', 'Name', 'Phone', 'Student ID', 'Email', 'Updated'];
  const lines = responses.map((row: any) => [
    row.choiceLabels.join(' | '), row.name, row.phone, row.studentId, row.email,
    row.updatedAt ? new Date(row.updatedAt).toISOString() : '',
  ].map(csvCell).join(','));
  return {
    filename: `dlt-bus-time-poll-${new Date().toISOString().slice(0, 10)}.csv`,
    csv: '\uFEFF' + [header.join(','), ...lines].join('\r\n'),
  };
}
