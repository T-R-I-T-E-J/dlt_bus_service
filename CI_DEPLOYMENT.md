# Build, verify and release DLT

The repository's default branch is `master`. Production uses `codex/vps-frontend-deployment`; there is no `main` branch. Keep production work on the deployment branch until it has been reviewed and tested.

## Continuous integration

Every push to `master` or `codex/vps-frontend-deployment`, and every pull request, runs **DLT CI**. The workflow installs the locked backend dependencies, runs frontend tests, typechecks the backend, applies migrations to a disposable PostgreSQL 17 database and runs the database/HTTP tests. It also prepares the frontend, validates release scripts and builds the production API image. It uses test payment credentials and in-memory email; no production credentials or VPS access are available to CI.

## Release on the VPS

Wait for **DLT CI → Tests and release build** to pass for the exact commit. Then run:

```bash
cd /opt/dlt-frontend &&
git pull --ff-only &&
bash deploy/vps/update-main.sh
```

This checks GitHub's result for the current commit before making changes. It saves the current API image, builds and preflights the new API, backs up the database, waits for API health and activates the frontend. Frontend checks include both domains, readiness, booking, robots and sitemap. A failed frontend activation restores its prior files and Nginx configuration; a failed full release restores the prior API image too. There is no unattended deployment on push. Building happens while the existing API runs; replacing the single API container may briefly interrupt requests, so choose a quiet moment outside active checkout.

For a verified change that only affects the frontend:

```bash
cd /opt/dlt-frontend &&
git pull --ff-only &&
bash deploy/vps/update-main-frontend.sh
```

Both release paths reject missing, running or failed CI for the exact commit and tracked local modifications. No SSH secret is stored in GitHub. The application database and payment credentials are retained. These scripts do not apply migrations; a future schema-changing release needs a separately reviewed migration plan. Database backups should also be copied off the VPS under the backup procedure.

## After a release

Check `/api/ready`, staff access, trip selection, a passenger's call link, and My Trips ticket selection. Do not create a real payment or board a real passenger just to test a deployment. A call link opens the phone dialler; DLT does not place the call automatically. Existing restrictions on boarding-only accounts remain in force.
