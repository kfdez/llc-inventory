# LLC Inventory v2 Scanner PWA

Installable mobile scanner for inventory lookup, sticker-price updates, cart
building, and physical audit scanning.

This PWA is copied into the v2 workspace as a separate Cloudflare Worker app. It
is not required for the Discord capture bot to run.

## Current Capabilities

- On-device QR decoding with `zxing-wasm`.
- PIN-gated Worker API with `APP_PIN`.
- Apps Script URL kept server-side as `APPS_SCRIPT_API_BASE_URL`.
- Lookup mode for inventory detail and sticker-price updates.
- Cart mode for quick scan totals.
- Audit mode for physical count sessions.
- Worker memory cache for inventory snapshots and recent lookups.
- Read-only Collectr resolution by Card ID, portfolio name, and catalog search.

## Apps Script Dependency

The current PWA expects these Apps Script paths:

- `inventory/lookup`
- `inventory/lookup-snapshot`
- `inventory/sticker-price`
- `inventory/sticker-targets`
- `audit/start`
- `audit/stop`
- `audit/scan`
- `audit/undo`

The optional Collectr resolver uses Worker secrets and routes Collectr reads
through the VPS proxy:

- `COLLECTR_ACCOUNT_ID`
- `COLLECTR_CURRENCY`
- `COLLECTR_PROXY_BASE_URL`
- `COLLECTR_PROXY_SECRET`

It resolves a scanned `Card ID` by reading the inventory row, matching
`Portfolio Name` against Collectr's live portfolio list, then using `Collectr
Product ID` when present or searching Collectr by set, product name, and card
number when missing. The current implementation is read-only. Use a DNS
hostname for `COLLECTR_PROXY_BASE_URL`; Cloudflare Workers return `403` when
fetching the VPS by raw IP.

Those are broader than the current v2 bot-only Apps Script. Before deploying
this PWA against the v2 spreadsheet, either add these endpoints to the v2 Apps
Script or point the Worker secret at an Apps Script deployment that already
supports them.

## Local Development

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run build
npm run dev
```

Fill `.dev.vars` with:

```text
APPS_SCRIPT_API_BASE_URL="https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
APP_PIN="choose-a-private-pin"
COLLECTR_ACCOUNT_ID="your-collectr-account-id"
COLLECTR_CURRENCY="CAD"
COLLECTR_PROXY_BASE_URL="https://your-vps-proxy-hostname.example/llc-inventory-v2-collectr/"
COLLECTR_PROXY_SECRET="shared-worker-to-vps-secret"
```

Camera access works on `localhost` during development and over HTTPS after
deployment.

## Deploy

```powershell
npx wrangler login
npx wrangler secret put APPS_SCRIPT_API_BASE_URL
npx wrangler secret put APP_PIN
npx wrangler secret put COLLECTR_ACCOUNT_ID
npx wrangler secret put COLLECTR_CURRENCY
npx wrangler secret put COLLECTR_PROXY_BASE_URL
npx wrangler secret put COLLECTR_PROXY_SECRET
npm run deploy
```

Use `npm run deploy:dry-run` to validate a deployment bundle without publishing.
