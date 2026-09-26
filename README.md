# DueMind MVP v4

Server-backed prototype for an AI-assisted invoice follow-up product.

## What changed from v3
- Real server-side signup/login with HttpOnly session cookies
- Passwords hashed with `scrypt`
- SQLite database persisted under `data/duemind.db`
- Server API for invoices, settings, templates, dashboard, replies and exports
- Approved follow-ups enter a server-side outbox
- Reply classification and promise-to-pay tracking happen on the server
- No browser localStorage is required for account data
- Uses only Node.js built-in modules; no `npm install` is needed on Node 22.5+

## What works
- Create account / log in / log out
- Add, edit and delete invoices
- Today dashboard with overdue and promise actions
- Server-generated follow-up drafts
- Friendly / professional / firm / final templates
- Record client replies and classify paid / promise / dispute / manual review
- Mark paid
- Settings and template persistence
- JSON account export
- Server outbox for approved follow-ups
- Reset demo data

## Still prototype / next integrations
- Outbox messages are **not actually sent by email yet**
- Reply classification is deterministic rules, not a hosted AI model yet
- No inbound email webhook
- No Stripe subscription billing
- No QuickBooks/Xero/Stripe invoice sync
- SQLite is fine for an MVP/single instance; production scale should move to managed Postgres

## Run
Requires Node.js 22.5+ because it uses the built-in `node:sqlite` module.

```bash
npm start
```

Open `http://localhost:3000`.

Optional environment variables:
- `PORT` (default 3000)
- `HOST` (default 0.0.0.0)
- `DUEMIND_DATA_DIR` (directory for SQLite data)
- `DUEMIND_DB_PATH` (exact SQLite file path)

## Deploy notes
For Render/Railway/Fly.io or a VPS, run `npm start` and attach a persistent disk/volume to the data directory. A deployment without persistent storage will lose SQLite data on rebuild/restart.

For a real SaaS launch, migrate the database to Postgres before significant public usage, add HTTPS/secure-cookie configuration, email delivery, rate limiting, password-reset flows, email verification, audit logging, privacy/retention controls, and billing.
