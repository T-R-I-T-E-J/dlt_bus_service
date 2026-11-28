import { AppError } from './errors.ts';

/** Bound both active KDF work and its waiting room. A campus login burst may
 * wait, but anonymous traffic cannot create an unlimited native-work queue. */
export function createPasswordWorkLimiter(concurrency: number, queueMax: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
    || !Number.isInteger(queueMax) || queueMax < 0 || queueMax > 1024)
    throw new Error('Password work limits require concurrency 1–8 and queue size 0–1024.');
  let running = 0;
  const waiting: Array<() => void> = [];
  return function run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        running += 1;
        const finish = () => { running -= 1; waiting.shift()?.(); };
        Promise.resolve().then(work).then(
          value => { finish(); resolve(value); },
          error => { finish(); reject(error); },
        );
      };
      if (running < concurrency) start();
      else if (waiting.length < queueMax) waiting.push(start);
      else reject(new AppError('RATE_LIMITED', 'Sign-in is busy. Please wait a moment and try again.'));
    });
  };
}

export const withPasswordWork = createPasswordWorkLimiter(
  Number(process.env.PASSWORD_WORK_CONCURRENCY ?? 4),
  Number(process.env.PASSWORD_WORK_QUEUE_MAX ?? 256),
);
