# DLT account and booking security release

The security review found three availability and admission-control weaknesses in the code deployed at `fc2196b`: unverified accounts could bypass guest hold budgets; concurrent distinct-seat holds could exceed the basket or guest aggregate budgets; and public signup/reset requests could queue unbounded password-hashing work. These findings do not establish a database intrusion or compromise of a customer account.

## Changes

- A student must verify their email before acquiring authenticated holds, creating a booking, opening checkout, joining a waitlist or claiming an offer. Sign-in, verification/resend, reading existing tickets, and ordinary cancellation remain available. Anonymous selection continues under guest abuse limits. The server checks the database-derived session verification state on every new request.
- A transaction-scoped advisory lock serializes a trip's hold admission before any seat locks/counts. Existing row locks and settlement constraints continue to prevent duplicate allocation. This protects the empty-basket case and the guest aggregate budget across distinct guests/IPs.
- Signup and code-submission routes have configurable per-IP budgets, with defaults of 240 and 480 per minute to accommodate a shared campus network. All password KDF work shares a bounded queue: four active operations and up to 256 waiting by default. Invalid reset codes are rejected before hashing; a second locked lookup still enforces single-use consumption.
- Newly issued email and reset codes contain 64 random bits (16 hexadecimal characters). Existing issued codes are still accepted until their ordinary expiration or use. Passwords retain the existing Argon2id strength and session revocation rules.

The optional settings `SIGNUP_RATE_LIMIT_PER_MINUTE`, `AUTH_CODE_RATE_LIMIT_PER_MINUTE`, `PASSWORD_WORK_CONCURRENCY`, and `PASSWORD_WORK_QUEUE_MAX` are validated at startup. No environment edit, schema migration, data reset or credential replacement is needed for this release.

## Validation

All reproduction and regression data is synthetic and stored in disposable local PostgreSQL databases. The deployed code was reproduced locally allowing 12 simultaneous holds for one account (budget 5), 21 guest holds (budget 17), and sign-in without email ownership proof. The new regression tests enforce exact hold ceilings, verified booking admission, preservation of existing ticket access, KDF queue recovery, route throttling and no hashing for invalid reset tokens.

A local HTTP burst test passed 100/200 seat-map readers, 200 contenders for one seat (one winner), 200 duplicate booking clicks (one booking), 200 legitimate logins behind one campus IP (all successful), and 100 scans of one pass (one admission), without 5xx responses. This is local validation, not a VPS throughput guarantee or physical-phone camera certification.

An online npm production-dependency audit reported zero known advisories at review time. That does not certify vendored bundles or exclude unknown vulnerabilities.

## Production and host follow-up

After exact-commit CI succeeds, use the full guarded release script from `/opt/dlt-frontend` on `master`: `git pull --ff-only` followed by `bash deploy/vps/update-main.sh`. The single API container briefly restarts; the script preserves its previous image and backs up the database.

The operator's host output showed default-deny UFW with public listeners limited to SSH/HTTP/HTTPS, loopback-only API ports, no public PostgreSQL listener, and root-only DLT credentials/backups. SSH still allowed root password authentication. Keep the current SSH session open and prove a second public-key-only login before changing that policy. Host key access, effective database role/isolation, patch automation and a backup restore drill remain separate checks; this application patch does not alter them.

No live attack, load test, payment, passenger boarding, or customer-data correction was performed for the review. These controls reduce specific risks; they do not make a guarantee of immunity from attacks.
