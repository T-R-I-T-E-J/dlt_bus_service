/* DLT · http/polls.routes.ts — public, no-sign-in schedule preference poll. */

import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as polls from '../domain/polls.ts';

export const POLL_COOKIE = 'dlt_poll';
const router = Router();
const voteThrottle = rateLimit({ windowMs: 60 * 60_000, limit: 12, standardHeaders: true });
const Choice = z.enum(polls.BUS_TIME_OPTIONS.map(([key]) => key) as [string, ...string[]]);
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullish();
const VoteBody = z.object({
  choices: z.array(Choice).min(1).max(3).refine((v) => new Set(v).size === v.length),
  otherTime: optionalText(60),
  name: optionalText(120),
  phone: optionalText(20),
  studentId: optionalText(32),
}).superRefine((value, ctx) => {
  if (value.choices.includes('OTHER') !== !!value.otherTime)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['otherTime'], message: 'Other time is required' });
});

function browserIdentity(req: Request, res: Response) {
  if (req.session) return { hash: polls.participantHash({ userId: req.session.userId }), userId: req.session.userId };
  let token = req.cookies?.[POLL_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
    token = randomBytes(24).toString('base64url');
    res.cookie(POLL_COOKIE, token, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      expires: new Date(Date.now() + 400 * 24 * 3600_000),
    });
  }
  return { hash: polls.participantHash({ guestToken: token }), userId: null };
}

router.get('/polls/bus-time', async (req, res, next) => {
  try {
    const identity = browserIdentity(req, res);
    res.json({ poll: await polls.getBusTimePoll(identity.hash) });
  } catch (e) { next(e); }
});

router.post('/polls/bus-time', voteThrottle, async (req, res, next) => {
  try {
    const identity = browserIdentity(req, res);
    const vote = await polls.saveBusTimeVote(identity.hash, identity.userId, VoteBody.parse(req.body));
    res.status(201).json({ vote });
  } catch (e) { next(e); }
});

export default router;
