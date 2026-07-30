# LLC Inventory v2

This is a separate refactor workspace for the inventory automation system. The
current production implementation in `llc-inventory/` is intentionally not
modified by this project.

## Direction

The first v2 target is VPS-only but cloud-ready:

- Node service on the VPS
- SQLite for durable local jobs/state
- explicit queue and state-machine boundaries
- adapters for Discord, Apps Script, and image analysis
- storage interfaces that can later be backed by Cloudflare D1/Queues

The initial scaffold is dry-run by default. It does not register production
commands, create Discord threads, or write to Apps Script unless configured.

## Initial Modules

- `src/storage/` - local SQLite job/state store
- `src/capture/` - capture start/stop state machine and orchestration
- `src/appsScript/` - Apps Script API adapter
- `src/discord/` - Discord adapter skeleton
- `src/config/` - environment loading and validation
- `pwa/` - copied Cloudflare Worker scanner PWA for lookup, pricing, cart, and audit workflows

## Commands

```powershell
npm install
Copy-Item .env.example .env
npm run db:init
npm test
npm run demo:capture
npm run demo:analyze -- ".\test-assets\test-qr-single.png"
npm start
```

`demo:capture` runs a local dry-run start and stop through the same queue and
state-machine path used by the future Discord commands.

`demo:analyze` runs the v2 image analysis service against one image. By default
it uses full-image QR decoding only. To enable the YOLO sticker-label detector,
configure:

```text
LABEL_DETECTION_ENABLED=true
LABEL_DETECTOR_PROJECT_DIR=./label-detector
LABEL_DETECTOR_PYTHON=./label-detector/.venv/Scripts/python.exe
LABEL_DETECTOR_DEVICE=cpu
```

The detector is optional. If it is disabled, or if it fails, v2 can still fall
back to full-image QR decoding.

## PWA

The copied scanner PWA lives in `pwa/` and builds as a separate Cloudflare Worker
app. It currently requires inventory and audit Apps Script endpoints that are
broader than the bot-only v2 Apps Script.

## Migration Rule

V2 should earn production traffic one workflow at a time. The first workflow is
Discord sales capture start/stop and status. Image processing, review mode,
audit, Collectr, and the PWA should remain out of scope until that path is
stable.
