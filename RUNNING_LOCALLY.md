# Running the frontend locally

The `*.dc.html` screens (Homepage, Booking, Dashboard, Account, Admin) load
`journey.js` and `dlt-client.js` as `<script type="module">`. Browsers block
ES module fetches from a `file://` origin, so **opening a `.dc.html` file
directly (double-click, drag into a browser tab) will not work** — every
module script fails with a CORS error, and everything that depends on one
silently doesn't run: no 3D Woxsen → Miyapur journey (`journey.js` defines
the `<dlt-journey>` custom element the Homepage's `<x-import>` resolves),
no `DLT.*` API client, no live data anywhere.

These screens must be served over `http://` or `https://`. There is no
build step — it's flat static files — so any static file server works, but
this repo ships one (`devserve.mjs`) that also proxies `/api/*` to the
backend on the same origin, which keeps the `dlt_session` cookie first-party
and needs no CORS configuration on the backend (see
`backend/SECURITY_FINDINGS.md`, M-2).

## Start it

```sh
# 1. backend, in one terminal
cd backend
npm run dev              # http://127.0.0.1:3000

# 2. static host + proxy, in another terminal, from the repo root
node devserve.mjs . 8080 http://127.0.0.1:3000

# 3. open
http://localhost:8080/DLT%20Homepage.dc.html
```

`devserve.mjs` takes three optional positional args: `root` (default: cwd),
`port` (default: `8080`), `apiBase` (default: `http://127.0.0.1:3000`).
