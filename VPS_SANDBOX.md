# Private VPS sandbox

This review stack uses `/opt/dlt-sandbox`, `/etc/dlt-sandbox`, Compose project `dlt-sandbox-review`, its own `dlt_sandbox` database and volumes, and `dlt-sandbox-api:review` / `dlt-sandbox-tools:review` images. It does not install host Nginx configuration, change DNS, restart production containers, or read production environment files.

Only localhost ports 3110 (API) and 8186 (review website) are published. PostgreSQL has no published port. The stack network is internal, and the API is limited to 512 MiB and one CPU. Database credentials and the synthetic-account password are newly generated on the VPS. Do not copy production credentials or database dumps into this stack.

The production image and startup remain unchanged. The dedicated sandbox image refuses a production database name, an owner runtime role, live Razorpay keys and external email credentials. Payments and refunds are disabled; seeded SUCCESS payment rows are explicitly simulated fixtures. Background payment reconciliation jobs are not started. Email stays in an in-memory inbox, available only to the sandbox Super Admin at `/api/sandbox/inbox`.

## Setup, one step at a time

Confirm the current branch commit has passed DLT CI. The workflow also boots this isolated stack and checks its private web/API endpoints. On the VPS, use the separate checkout:

```bash
cd /opt/dlt-sandbox
git pull --ff-only
install -d -m 700 /etc/dlt-sandbox
docker run --rm \
  -v "$PWD:/src:ro" \
  -v /etc/dlt-sandbox:/config \
  node:24-alpine \
  node /src/deploy/sandbox/configure.mjs /config
```

Configuration generation refuses a nonempty directory. It prints no passwords. Continue only after that succeeds and CI passes for the checkout commit:

```bash
cd /opt/dlt-sandbox
bash deploy/vps/check-release.sh
docker compose -p dlt-sandbox-review -f deploy/sandbox/compose.yaml --profile tools build api migrate
docker compose -p dlt-sandbox-review -f deploy/sandbox/compose.yaml up -d --wait --wait-timeout 120 db
docker compose -p dlt-sandbox-review -f deploy/sandbox/compose.yaml run --rm migrate
docker compose -p dlt-sandbox-review -f deploy/sandbox/compose.yaml run --rm migrate node --experimental-strip-types scripts/sandbox-seed.mjs
docker compose -p dlt-sandbox-review -f deploy/sandbox/compose.yaml run --rm prepare
docker compose -p dlt-sandbox-review -f deploy/sandbox/compose.yaml up -d --wait --wait-timeout 120 api
curl -fsS http://127.0.0.1:3110/api/ready
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8186/review
```

Readiness must report `ok: true`, `auditAppendOnly: true`, and email `memory`. The review website must return 200. Seeding is transactional and refuses a nonempty unrelated database. Repeating it preserves existing sandbox data.

## Open the review

In a **new Terminal on the Mac**, keep this tunnel running:

```bash
ssh -N -L 8186:127.0.0.1:8186 root@187.127.177.22
```

Open `http://127.0.0.1:8186/review`. Use a normal sign-in with the synthetic accounts listed there. Their password is in `/etc/dlt-sandbox/access.txt` on the VPS; view it privately and do not paste it into chat. Sign out before switching roles. Secure cookies and camera access can be tested through the loopback address; testing on an actual phone will require an appropriate private HTTPS access path later, not publishing this unaudited sandbox directly.

Fixtures include two boarding departures tomorrow (1 pm and 5:30 pm IST) and two open departures the following day, with 44 places each. Each trip has two two-person bookings using the same passenger names/IDs. Boarding staff are assigned to the first boarding departure.

Check ticket switching and downloads, open-seating wording, mobile forms/navigation, manifest search and call-link destinations, staff role restrictions, wrong-departure refusal, and repeat-scan refusal. Use only synthetic tickets for boarding mutations. The test inbox is cleared when the API restarts. Provider payments and actual email delivery are not tested by this review stack.

## Stop or update

Stopping the review does not delete data:

```bash
cd /opt/dlt-sandbox
docker compose -p dlt-sandbox-review -f deploy/sandbox/compose.yaml stop
```

For a later reviewed code update, wait for exact-commit CI, rebuild only the sandbox images, rerun the frontend `prepare` service and recreate the sandbox API. Do not use production activation scripts here, do not reset volumes, and do not promote to production until the user has finished sandbox review.
