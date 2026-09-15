/* DLT · test/polls.test.ts — schedule poll persistence, privacy and admin totals. */

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as polls from '../src/domain/polls.ts';
import { close } from '../src/db/index.ts';
import { resetTables } from './_reset.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);

let SUPER: string, OPS: string, STUDENT: string;
const superActor = () => ({ userId: SUPER, role: 'SUPER_ADMIN' });
const opsActor = () => ({ userId: OPS, role: 'OPS_ADMIN' });
const studentActor = () => ({ userId: STUDENT, role: 'STUDENT' });

async function seed() {
  await resetTables(pool, 'bus_time_poll_responses, users, student_profiles');
  const make = async (email: string, name: string, role: string, phone: string) =>
    (await q(`INSERT INTO users (email,name,role,phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, name, role, phone])).rows[0].id;
  SUPER = await make('poll-super@dlt.co.in', 'Poll Super', 'SUPER_ADMIN', '9000000001');
  OPS = await make('poll-ops@dlt.co.in', 'Poll Ops', 'OPS_ADMIN', '9000000002');
  STUDENT = await make('poll-student@woxsen.edu.in', 'Poll Student', 'STUDENT', '9000000003');
  await q(`INSERT INTO student_profiles (user_id,student_id) VALUES ($1,'25WU000001')`, [STUDENT]);
}

beforeEach(seed);
after(async () => { await pool.end(); await close(); });

describe('public bus-time poll', () => {
  test('an anonymous browser can vote and update the same response', async () => {
    const hash = polls.participantHash({ guestToken: 'a-secure-random-browser-token' });
    await polls.saveBusTimeVote(hash, null, {
      choices: ['10:00', '12:00'], name: 'Guest student', phone: '9876543210',
    });
    await polls.saveBusTimeVote(hash, null, {
      choices: ['11:00', 'OTHER'], otherTime: '7:30 pm', name: 'Guest student',
    });

    const mine = await polls.getBusTimePoll(hash);
    assert.deepEqual(mine.vote?.choices, ['11:00', 'OTHER']);
    assert.equal(mine.vote?.otherTime, '7:30 pm');
    assert.equal((await q('SELECT count(*)::int n FROM bus_time_poll_responses')).rows[0].n, 1);
  });

  test('the domain rejects invalid, duplicate and incomplete choices', async () => {
    const hash = polls.participantHash({ guestToken: 'another-secure-browser-token' });
    await assert.rejects(polls.saveBusTimeVote(hash, null, { choices: [] }), { code: 'VALIDATION' });
    await assert.rejects(polls.saveBusTimeVote(hash, null, { choices: ['10:00', '10:00'] }),
      { code: 'VALIDATION' });
    await assert.rejects(polls.saveBusTimeVote(hash, null, { choices: ['OTHER'] }),
      { code: 'VALIDATION' });
  });

  test('operations sees ranked live totals and account contact data', async () => {
    await polls.saveBusTimeVote(polls.participantHash({ userId: STUDENT }), STUDENT,
      { choices: ['10:00', '11:00'] });
    await polls.saveBusTimeVote(polls.participantHash({ guestToken: 'guest-response-token' }), null,
      { choices: ['10:00'], name: 'Guest', phone: '9888888888' });

    const result = await polls.busTimePollResults(opsActor());
    assert.equal(result.totalResponses, 2);
    assert.equal(result.leadingOption?.key, '10:00');
    assert.equal(result.leadingOption?.votes, 2);
    assert.equal(result.contactable, 2);
    assert.equal(result.responses.find((r: any) => r.email)?.studentId, '25WU000001');
  });

  test('students cannot read the aggregate or export', async () => {
    await assert.rejects(polls.busTimePollResults(studentActor()), { code: 'FORBIDDEN' });
    await assert.rejects(polls.exportBusTimePoll(studentActor()), { code: 'FORBIDDEN' });
  });

  test('the CSV export quotes contact fields and includes the Other suggestion', async () => {
    await polls.saveBusTimeVote(polls.participantHash({ guestToken: 'csv-response-token' }), null, {
      choices: ['OTHER'], otherTime: 'After 7, if possible', name: 'Rao, Tej', phone: '9777777777',
    });
    const out = await polls.exportBusTimePoll(superActor());
    assert.match(out.filename, /^dlt-bus-time-poll-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.match(out.csv, /Other: After 7, if possible/);
    assert.match(out.csv, /"Rao, Tej"/);
  });

  test('the CSV export neutralizes formulas and is not limited to the 500-row preview', async () => {
    await q(
      `INSERT INTO bus_time_poll_responses
         (poll_key, participant_hash, choices, name, phone, student_id)
       SELECT $1, lpad(n::text, 64, '0'), ARRAY['10:00'],
              CASE WHEN n = 501 THEN '=HYPERLINK("https://example.test")' ELSE 'Student ' || n END,
              CASE WHEN n = 500 THEN '+919999999999' ELSE '9000000000' END,
              '25WU' || lpad(n::text, 6, '0')
         FROM generate_series(1, 501) AS n`,
      [polls.BUS_TIME_POLL_KEY],
    );

    const preview = await polls.busTimePollResults(superActor());
    const out = await polls.exportBusTimePoll(superActor());
    assert.equal(preview.totalResponses, 501);
    assert.equal(preview.responses.length, 500);
    assert.equal(out.csv.split('\r\n').length, 502);
    assert.match(out.csv, /'\+919999999999/);
    assert.match(out.csv, /'(?==HYPERLINK)/);
  });
});
