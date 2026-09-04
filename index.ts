import app from "./app";
import { createDiscordBot } from "./bot";
import { BotDatabase } from "./bot/database";
import { BotHostController } from "./host/controller";
import { createHostRouter } from "./host/dashboard";
import { logger } from "./lib/logger";
import { fileURLToPath } from "node:url";

const isHostWorker = process.env["BOT_HOST_WORKER"] === "1";
let db: BotDatabase | null = null;
let discordBot: ReturnType<typeof createDiscordBot> | null = null;
let hostController: BotHostController | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
const rawPort = process.env["PORT"];

function sendIpcMessage(message: Record<string, unknown>): void {
  const ipcProcess = process as NodeJS.Process & {
    connected?: boolean;
    send?: (message: Record<string, unknown>) => void;
  };
  if (typeof ipcProcess.send !== "function" || ipcProcess.connected === false) return;
  try {
    ipcProcess.send(message);
  } catch {
    // The parent may be shutting down at the same time as a heartbeat tick.
  }
}

if (isHostWorker) {
  db = new BotDatabase();
  discordBot = createDiscordBot(db);
  sendIpcMessage({ type: "heartbeat", ready: discordBot.isReady() });
  heartbeatTimer = setInterval(() => {
    sendIpcMessage({ type: "heartbeat", ready: discordBot?.isReady() === true });
  }, 10_000);
  heartbeatTimer.unref();
} else {
  hostController = new BotHostController(fileURLToPath(import.meta.url));
  app.use("/api/host", createHostRouter(hostController));
  heartbeatTimer = setInterval(() => {
    sendIpcMessage({ type: "host-heartbeat", state: hostController?.getStatus().state ?? "starting" });
  }, 5_000);
  heartbeatTimer.unref();

  if (rawPort) {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid PORT value: "${rawPort}"`);
    }

      app.listen(port, "0.0.0.0", () => {
      logger.info({ port }, "Bot host dashboard listening");
      hostController?.start();
    });
  } else {
    logger.info("PORT is not set; starting bot host without the HTTP dashboard");
    hostController.start();
  }
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutdown requested");
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (hostController) {
    await hostController.stop();
  }
  discordBot?.destroy();
  db?.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  process.exitCode = 1;
});
process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception; exiting for supervisor restart");
  process.exit(1);
});
