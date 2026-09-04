import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./dist/index.mjs", import.meta.url));
const HEARTBEAT_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const RESTART_DELAY_MS = 1_000;

let stopping = false;
let child = null;
let restartTimer = null;
let watchdogTimer = null;
let lastHeartbeatAt = 0;
let launchStartedAt = 0;
let restartCount = 0;

function append(message) {
  process.stderr.write(`[launcher] ${message}\n`);
}

function stopChild(signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    if (pid) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
  setTimeout(() => {
    if (child && child.exitCode === null) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 5_000).unref();
}

function launch() {
  if (stopping) return;
  launchStartedAt = Date.now();
  lastHeartbeatAt = launchStartedAt;
  append(`Запуск host process${restartCount ? ` (перезапуск #${restartCount})` : ""}.`);
  child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: { ...process.env, BOT_HOST_PARENT: "1" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    detached: true,
  });

  child.on("message", (message) => {
    if (message && typeof message === "object" && message.type === "host-heartbeat") {
      lastHeartbeatAt = Date.now();
    }
  });
  child.once("error", (error) => append(`Ошибка host process: ${error.message}`));
  child.once("exit", (code, signal) => {
    if (stopping) return;
    append(`Host process завершён (код: ${code ?? "—"}, сигнал: ${signal ?? "—"}).`);
    restartCount += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, RESTART_DELAY_MS);
    restartTimer.unref();
  });
}

watchdogTimer = setInterval(() => {
  if (!child || stopping) return;
  if (Date.now() - lastHeartbeatAt <= HEARTBEAT_TIMEOUT_MS) return;
  append(`Watchdog: host process не отвечает ${HEARTBEAT_TIMEOUT_MS / 1_000} с. Принудительный перезапуск.`);
  stopChild("SIGTERM");
  lastHeartbeatAt = Date.now();
}, WATCHDOG_INTERVAL_MS);
watchdogTimer.unref();

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  append(`Остановка по ${signal}.`);
  stopChild(signal);
  setTimeout(() => process.exit(0), 6_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  append(`Критическая ошибка launcher: ${error.stack || error.message}`);
  stopChild("SIGTERM");
  process.exit(1);
});

launch();