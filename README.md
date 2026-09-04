# Grand Family Bot

Grand Family Bot is a long-running Node.js Discord worker with automatic Gateway reconnects, a watchdog, process recovery, and SQLite persistence.

## Run

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run start
```

Required environment variable:

- `DISCORD_BOT_TOKEN` — store this in the host's secret manager, never in GitHub or a file.

Optional environment variables:

- `PORT` — HTTP health and host dashboard port.
- `SQLITE_PATH` — path on persistent storage for `families.sqlite`; defaults to `./data/families.sqlite`.
- `LOG_LEVEL` — Pino log level.

Health checks are available at `/health` and `/api/healthz`. The supervisor dashboard is available at `/api/host` when `PORT` is set.

## Hosting requirements

Use a host that keeps a Node.js worker running continuously, supports Discord WebSocket connections, restarts a crashed process, and provides persistent storage for SQLite. Configure `SQLITE_PATH` to that persistent volume. Enable automatic deploys from the `main` branch only after the host has been configured with `DISCORD_BOT_TOKEN` as a secret.

The Discord application must have Message Content and Server Members intents enabled, and its bot role must be above the roles it manages.
