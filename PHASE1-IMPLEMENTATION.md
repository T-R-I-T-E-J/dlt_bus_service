# Phase 1 implementation

Approved 6 September 2026; operator confirmed ten rows A-D. Local work only.

1. Start an isolated disposable local PostgreSQL cluster; never use Railway/Neon credentials for tests.
2. Migration 022: database lifecycle guards, publish validation and configurable turnaround, guarded mutation functions, actual departure/completion timestamps.
3. Migration 023: controlled 40-seat vehicle configuration and dependency-free future inventory conversion; preserve historical maps and references.
4. Wire shared trip-policy checks into domain/API mutations; reuse existing idempotency table and digest/caller binding.
5. Truthful refund projections, financial report permission enforcement, safe CSV output.
6. Minimal Admin lifecycle actions, closeout warnings, confirmation and refund labels; no navigation/scanner redesign.
7. Fresh migration, typecheck, full isolated suite, targeted concurrency/preservation/permission/idempotency tests and local browser checks.

No production migration, data/configuration changes, deployment, LIVE payment calls, commit or push is authorized. AUTO_REFUNDS_ENABLED remains false. Existing pending refunds must not be rewritten.
