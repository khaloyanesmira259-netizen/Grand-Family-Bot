import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { logger } from "../lib/logger";

export type HostState = "starting" | "online" | "restarting" | "offline";

export interface HostStatus {
  state: HostState;
  workerPid: number | null;
  workerStartedAt: string | null;
  uptimeSeconds: number;
  restartCount: number;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  heartbeatReady: boolean;
  watchdogTimeoutSeconds: number;
  lastExitAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  nextRestartAt: string | null;
}

const MAX_LOG_LINES = 250;
const MAX_RESTART_DELAY_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;

export class BotHostController {
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private workerTerminationRequested = false;
  private workerStartedAt: number | null = null;
  private lastHeartbeatAt: number | null = null;
  private heartbeatReady = false;
  private lastExitAt: string | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private nextRestartAt: string | null = null;
  private state: HostState = "offline";
  private restartCount = 0;
  private readonly logs: string[] = [];

  public constructor(private readonly workerEntry: string) {}

  public start(): void {
    if (this.stopping || this.child || this.restartTimer) return;
    this.watchdogTimer = setInterval(() => this.checkWorkerHealth(), WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
    this.spawnWorker();
  }

  public getStatus(): HostStatus {
    const uptimeSeconds =
      this.workerStartedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - this.workerStartedAt) / 1000));
    const heartbeatAgeSeconds =
      this.lastHeartbeatAt === null
        ? null
        : Math.max(0, Math.floor((Date.now() - this.lastHeartbeatAt) / 1000));
    return {
      state: this.state,
      workerPid: this.child?.pid ?? null,
      workerStartedAt: this.workerStartedAt ? new Date(this.workerStartedAt).toISOString() : null,
      uptimeSeconds,
      restartCount: this.restartCount,
      lastHeartbeatAt: this.lastHeartbeatAt ? new Date(this.lastHeartbeatAt).toISOString() : null,
      heartbeatAgeSeconds,
      heartbeatReady: this.heartbeatReady,
      watchdogTimeoutSeconds: WORKER_HEARTBEAT_TIMEOUT_MS / 1_000,
      lastExitAt: this.lastExitAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      nextRestartAt: this.nextRestartAt,
    };
  }

  public getLogs(): string[] {
    return [...this.logs];
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.nextRestartAt = null;
    const child = this.child;
    if (!child) {
      this.state = "offline";
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = null;
    this.state = "offline";
  }

  private spawnWorker(): void {
    if (this.stopping) return;
    this.state = "restarting";
    this.nextRestartAt = null;
    this.workerStartedAt = Date.now();
    this.lastHeartbeatAt = null;
    this.heartbeatReady = false;
    this.workerTerminationRequested = false;
    this.appendLog(
      `[host] Запуск Discord worker${this.restartCount > 0 ? ` (перезапуск #${this.restartCount})` : ""}.`,
    );

    const workerEnv: NodeJS.ProcessEnv = { ...process.env, BOT_HOST_WORKER: "1" };
    delete workerEnv["PORT"];
    const child = spawn(process.execPath, [this.workerEntry], {
      cwd: process.cwd(),
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    if (child.stdout) this.attachOutput(child.stdout);
    if (child.stderr) this.attachOutput(child.stderr);
    child.on("message", (message: unknown) => this.handleWorkerMessage(message));

    child.once("error", (error) => {
      this.appendLog(`[host] Ошибка запуска worker: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.lastExitAt = new Date().toISOString();
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      this.appendLog(
        `[host] Discord worker завершён (код: ${code ?? "—"}, сигнал: ${signal ?? "—"}).`,
      );
      if (!this.stopping) this.scheduleRestart();
      else this.state = "offline";
    });
  }

  private attachOutput(stream: Readable): void {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) this.handleWorkerLog(line);
    });
    stream.on("end", () => {
      if (pending) this.handleWorkerLog(pending);
    });
  }

  private handleWorkerMessage(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const payload = message as { type?: unknown; ready?: unknown };
    if (payload.type !== "heartbeat") return;
    this.lastHeartbeatAt = Date.now();
    this.heartbeatReady = payload.ready === true;
    if (this.heartbeatReady) {
      this.state = "online";
    } else if (this.state === "online") {
      this.state = "restarting";
    }
  }

  private handleWorkerLog(line: string): void {
    if (!line.trim()) return;
    const cleanLine = line.replace(/\u001b\[[0-9;]*m/gu, "");
    this.appendLog(cleanLine);
    if (cleanLine.includes("Discord client ready") || cleanLine.includes("Discord Gateway reconnected")) {
      this.state = "online";
    }
  }

  private checkWorkerHealth(): void {
    if (this.stopping || !this.child || this.workerTerminationRequested || this.workerStartedAt === null) return;
    const now = Date.now();
    const lastSignal = this.lastHeartbeatAt ?? this.workerStartedAt;
    if (now - lastSignal < WORKER_HEARTBEAT_TIMEOUT_MS) return;
    this.workerTerminationRequested = true;
    const reason =
      this.lastHeartbeatAt === null
        ? `worker не прислал heartbeat за ${WORKER_HEARTBEAT_TIMEOUT_MS / 1_000} с.`
        : `heartbeat worker устарел более чем на ${WORKER_HEARTBEAT_TIMEOUT_MS / 1_000} с.`;
    this.appendLog(`[host] Watchdog: ${reason} Перезапуск worker.`);
    const child = this.child;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child === child && child.exitCode === null) child.kill("SIGKILL");
    }, 5_000).unref();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.state = "offline";
    this.restartCount += 1;
    const delay = Math.min(
      MAX_RESTART_DELAY_MS,
      1_000 * 2 ** Math.min(this.restartCount - 1, 6),
    );
    this.nextRestartAt = new Date(Date.now() + delay).toISOString();
    this.appendLog(`[host] Автоперезапуск запланирован через ${Math.ceil(delay / 1_000)} с.`);
    this.state = "restarting";
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnWorker();
    }, delay);
    this.restartTimer.unref();
  }

  private appendLog(line: string): void {
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    logger.info({ hostLog: line }, "Bot host event");
  }
}