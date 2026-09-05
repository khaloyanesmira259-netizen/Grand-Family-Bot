# Deploy on JustRunMy.App

The standalone GitHub repository is ready for a Docker or Git deployment.

## Container settings

- Repository: `khaloyanesmira259-netizen/Grand-Family-Bot`
- Branch: `main`
- Build source: repository `Dockerfile`
- Container port: `8080`
- Start command when not using Docker: `pnpm run start`

## Environment variables

Add these in the JustRunMy environment/secrets panel:

- `DISCORD_BOT_TOKEN` — the Discord bot token, stored as a secret.
- `SQLITE_PATH=/data/families.sqlite` — database path on the persistent disk.
- `PORT=8080` — HTTP port for health checks and the host status endpoint.
- `NODE_ENV=production`

Never commit the token to GitHub or paste it into chat.

## Persistent storage

Mount a persistent disk at `/data`. Without this mount, the bot can still start, but SQLite data may be lost when the container is recreated.

## GitHub auto-deploy

1. Create a JustRunMy container and choose Git/GitHub deployment.
2. Authorize GitHub and select `Grand-Family-Bot`.
3. Select the `main` branch and enable deploy on push.
4. Add the variables above in the host secrets/environment panel.
5. Attach the persistent disk at `/data`.
6. Deploy once and confirm `GET /health` returns `{"status":"ok"}`.

The worker should then remain online through Gateway reconnects and process crashes; the in-process supervisor will restart the Discord worker when its heartbeat becomes stale.