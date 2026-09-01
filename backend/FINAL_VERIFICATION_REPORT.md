# DLT — FINAL VERIFICATION REPORT

**Date:** 1 September 2026
**Stage:** real backend verification
**Outcome: STEP 1 COMPLETE. STEPS 2–9 BLOCKED — not attempted, not simulated.**

---

## The honest headline

You asked me to run the backend. **I cannot.** This environment has no
PostgreSQL server, no Node runtime, no package installer and no network egress.
There is no `npm`, no `psql`, no `createdb`.

So this report contains **no test results, no migration output and no typecheck
output**, because producing any would mean inventing them. What it does contain
is the one thing I *could* do — Step 1, a real pre-flight audit — and it found
**two defects that would have stopped `npm test` on its very first line**, plus
one that would have failed the typecheck immediately. Those are fixed.

| Status | Meaning here |
|---|---|
| **EXECUTED** | ran, output observed |
| **VERIFIED** | ran and behaved correctly |
| **BLOCKED** | cannot run in this environment |
| **WRITTEN** | source exists, unexecuted |

**Nothing in this project is EXECUTED. Nothing is VERIFIED.**

---

## 1. Migration result — **BLOCKED**

Not run. No PostgreSQL. `npm run migrate` has never been invoked.

Static state: **9 migrations**, `001` → `009`, forward-only, each wrapped in its
own transaction, each recording itself in `schema_migrations`. Definition
ordering was verified statically earlier (all 33 SQL functions define before
use). `assertReady()` requires 9 and the count matches.

**Predicted first failures, in likelihood order** — worth having in hand:

1. **`CREATE EXTENSION citext`** (001) needs superuser or a pre-installed
   extension. On a managed Postgres this is the most likely first error.
2. **`CREATE ROLE dlt_app`** (009) needs `CREATEROLE`. The `DO` block skips
   creation if the role exists, so pre-provisioning it avoids this.
3. **`ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS`** (007, `seat_row_order`)
   — the `regexp_replace(...)::int` expression must be immutable; if Postgres
   rejects it, make it a plain column plus a trigger.
4. **`erasableSyntaxOnly`**/enum interactions — not migrations, see §2.
5. `ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey` (009)
   assumes the constraint's default name. If 001 produced a different name this
   fails; `\d idempotency_keys` first.

---

## 2. Typecheck result — **BLOCKED**

Not run. No Node, no `tsc`.

**Pre-flight found one certain failure and fixed it:** `tsconfig.json` set
`erasableSyntaxOnly`, which TypeScript only added in **5.8**, while
`package.json` pinned `typescript: ^5.7.2`. `npm run typecheck` would have failed
on the unknown option before checking a single file. Pin raised to `^5.8.2`.

**Still expect real type errors on first run.** `pg` returns `any` rows, so every
`rows[0].foo` is currently unchecked — mismatches are invisible to static
reading. Likely spots: the `scan_verdict` composite mapping in `boarding.ts`, zod
`.nullish()` unions against parameter types, and `express-rate-limit`'s option
shape.

---

## 3. Test result — **BLOCKED**

Not run. **~268 assertions across 8 files, 0 executed.**

**Pre-flight found the defect that would have stopped the suite immediately, and
this is the important finding of this turn:**

> **Every relative import used a `.js` extension — 71 specifiers across 26 files
> — but `--experimental-strip-types` runs the `.ts` file *itself* and does NOT
> rewrite `.js` → `.ts`.** Node would have thrown `ERR_MODULE_NOT_FOUND` on the
> first import of the first test file. Not one of the 268 assertions could have
> run.

`.js` specifiers are correct for *compiled* output and wrong for direct
type-stripped execution. I had written them out of habit while choosing the
opposite runtime. Fixed: all 71 rewritten to `.ts`, and
`allowImportingTsExtensions: true` added so `tsc` accepts them.

**Also fixed:** `domain/boarding.ts` and `domain/admin.ts` each defined their own
local `Actor` interface while `authz.ts` exported the canonical one. Structurally
compatible today, so it would have compiled — but a drifted actor type is exactly
how an authorization argument gets quietly dropped, which is the class of bug the
last three turns were about. Both now re-export the single definition.
`admin.ts` also needed the import for its own 22 uses; without it the
re-export-only version would not have compiled.

**Final import audit: 80 relative imports, all resolve. 0 leftover `.js`
specifiers. 0 duplicate `Actor` definitions.**

---

## 4. Concurrency result — **BLOCKED**

Not run. The five two-session procedures in `test/concurrency.md` need two
simultaneous `psql` connections.

This is the part I most want executed and least able to fake. The assertion that
matters is not "the loser errored" — a check-then-act race produces that by luck
— it is that **the loser *blocks*** while the winner's transaction is open. Only
a real `FOR UPDATE` row lock does that, and only two real sessions can show it.

---

## 5. Database security result — **BLOCKED**

Not run. `dlt_app` has never been provisioned; `auditAppendOnly` has never been
observed.

Written and awaiting execution: three layers — owner-binding triggers on
DELETE/UPDATE/TRUNCATE, the `dlt_app` least-privilege grant, and the
`assertReady()` boot refusal. Step 6 of your plan is exactly right: this must be
tested as `dlt_app`, not as the migration owner, and with
`ALLOW_AUDIT_PRIVILEGE` **removed**.

---

## 6–12. Component results — all **BLOCKED**

| Component | Status | Note |
|---|---|---|
| **Auth** | BLOCKED | 33 tests written. argon2 is a native module — `npm ci` must compile it; expect this to be the first install friction. |
| **Trips / seats** | BLOCKED | 33 concurrency tests written. |
| **Booking** | BLOCKED | 43 tests written. |
| **Razorpay** | BLOCKED | No credentials, no network. **Zero contact with Razorpay has ever occurred.** The signature scheme is documented, not observed. |
| **Boarding** | BLOCKED | 44 tests written. |
| **Admin** | BLOCKED | 66 tests written. |
| **Email** | BLOCKED | No provider bound. Today no student could verify an address or reset a password. |
| **Security regressions** | BLOCKED | 48 tests written, each designed to fail against pre-fix code. |

---

## 13. Failures found

Three, all in Step 1, all execution-blocking:

| # | Failure | Severity |
|---|---|---|
| **PF-1** | 71 relative imports used `.js` under a runtime that requires `.ts`. **The entire suite would have failed to load.** | blocker |
| **PF-2** | `erasableSyntaxOnly` requires TS 5.8; `^5.7.2` was pinned. Typecheck fails on an unknown option. | blocker |
| **PF-3** | Duplicate local `Actor` definitions in `boarding.ts` and `admin.ts` alongside the canonical one in `authz.ts`. | correctness / drift risk |

---

## 14. Fixes made

Plumbing only. No architecture, no business rules, no new functionality.

1. **PF-1** — 71 specifiers rewritten `.js` → `.ts` across 26 files;
   `allowImportingTsExtensions: true` added to `tsconfig.json`. Verified: 80
   relative imports, all resolve.
2. **PF-2** — `typescript` pinned to `^5.8.2`.
3. **PF-3** — `boarding.ts` and `admin.ts` re-export `Actor` from `authz.ts`;
   `admin.ts` imports it for its own uses.
4. A wrong relative path in a `seed-dev.mjs` comment corrected.

---

## 15. Remaining blockers

| Blocker | Blocks |
|---|---|
| **No PostgreSQL 15+** | steps 2, 4, 5, 6, 7 — the single gating dependency |
| **No Node 22.6+, no npm** | steps 3, 4, 7 |
| **No network egress** | `npm ci`, Razorpay, email |
| **No Razorpay credentials** | step 8 entirely |
| **No email provider** | step 9 entirely |
| **`dlt_app` not provisioned** | step 6 |
| **No public HTTPS endpoint** | webhook signature verification |

None of these can be resolved from inside this environment. They are not tasks
remaining for me; they are the machine the work now needs.

---

## 16. VERIFIED vs UNVERIFIED

| | Components |
|---|---|
| **VERIFIED** | **none** |
| **EXECUTED** | **none** |
| **BLOCKED** | migrations · typecheck · all 268 tests · concurrency · DB security · auth · trips/seats · booking · payments · Razorpay · boarding · admin · email |
| **WRITTEN** | 9 migrations · 10 domain modules · 5 route modules · 2 integrations · runtime plumbing · 268 assertions · 6 reports |

The only thing this turn genuinely advanced is that the code can now *attempt* to
run. Before Step 1 it could not have loaded a single test file.

---

## Exact next step

Nothing further is achievable here. On a machine with Postgres 15+ and Node 22.6+:

    cd backend
    createdb dlt_dev
    export DATABASE_URL=postgres://localhost/dlt_dev
    export NODE_ENV=test
    export ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk   # local only; the suite runs as owner

    npm ci                   # argon2 compiles natively — first likely friction
    npm run migrate          # expect the §1 predicted failures
    npm run typecheck        # first compile ever; expect pg-row type errors
    npm test                 # ~268 assertions; expect failures, they are information

Then paste the output back and I will work through the failures — each one
classified as implementation defect, test defect, migration issue or environment
issue, as you specified, without weakening a test to make the suite green.

After the suite is green: `test/concurrency.md` by hand, then provision
`dlt_app` and drop `ALLOW_AUDIT_PRIVILEGE`, then email, then Razorpay Test mode
(**confirm the capture setting first**).

**Nothing is VERIFIED. Stopping here.**
