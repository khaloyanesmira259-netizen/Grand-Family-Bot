# Grand Family Bot

Production-ready Discord bot for deployment from GitHub to an external 24/7 host.

## Runtime

- Node.js 22
- `npm start` launches the supervisor
- the supervisor restarts the Discord worker after a crash or stale heartbeat
- SQLite is stored at `SQLITE_PATH` (default: `./data/families.sqlite`)
- `GET /health` returns a lightweight host health response
- when `PORT` is provided, the built-in supervisor dashboard is available at `/`

## Required environment variable

```text
DISCORD_BOT_TOKEN=your-discord-bot-token
```

The token is read only from `DISCORD_BOT_TOKEN`. It is not included in this repository, the image, or the database.

## Commands

```bash
npm install
npm run typecheck
npm run build
npm start
```

Keep the host's data directory or persistent volume mounted at the path containing `SQLITE_PATH`; otherwise SQLite data will be lost when the container is replaced.