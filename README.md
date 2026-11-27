# DLT bus service

Student shuttle booking, payments, boarding and operations.

Deploy a **fresh frontend, backend and PostgreSQL database on the VPS** using
[VPS_FRESH.md](VPS_FRESH.md), from branch `codex/vps-frontend-deployment`.
Existing Neon/Railway data is not imported or deleted. The current fare and
new-trip default are ₹320. DLT's authorization, payment, seat-locking and audit
rules remain enforced by the backend/database.

For frontend-only staging, see [VPS_FRONTEND.md](VPS_FRONTEND.md). For local
frontend development, see [RUNNING_LOCALLY.md](RUNNING_LOCALLY.md).
