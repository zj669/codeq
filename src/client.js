import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./lock.js";
import { daemonPaths, ensurePrivateDir } from "./paths.js";
import { openSocket, socketIsLive } from "./socket.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const START_LOCK_TIMEOUT_MS = 30_000;
const STOP_WAIT_MS = 50;
const DAEMON_PING_TIMEOUT_MS = 5_000;
const LAUNCH_PING_TIMEOUT_MS = 500;
const QUERY_STALL_CHECK_MS = 30_000;

// Concurrent cold tool calls used to spawn one daemon each; they then raced to
// bind the socket and to migrate the same CodeGraph database ("database is
// locked"). One launch per process, everyone else waits for it.
let launching = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonPid(paths) {
  try {
    const pid = Number(readFileSync(paths.pid, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

// A socket that accepts a connection only proves a process owns the listen
// backlog — a wedged daemon accepts connections it never answers. Currency
// means the daemon replies to a ping and reports this package version.
async function pingDaemon(paths, timeoutMs = DAEMON_PING_TIMEOUT_MS) {
  let socket;
  try {
    socket = await openSocket(paths.socket);
  } catch {
    return false;
  }
  try {
    return await new Promise((resolve) => {
      let buffer = "";
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const message = JSON.parse(buffer.slice(0, newline));
          finish(
            message?.type === "result" && message.result?.version === version,
          );
        } catch {
          finish(false);
        }
      });
      socket.on("error", () => finish(false));
      socket.on("end", () => finish(false));
      socket.write(`${JSON.stringify({ command: "ping" })}\n`);
    });
  } finally {
    socket.destroy();
  }
}

function daemonIsCurrent(paths) {
  return pingDaemon(paths);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  // A zombie still answers kill(0) but runs no code and frees its socket.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
    if (state === "Z" || state === "X") return false;
  } catch {}
  return true;
}

// A hard-killed daemon leaves its pid file behind and the pid can be recycled
// to an unrelated process. Only signal a pid that still looks like ours.
function pidLooksLikeDaemon(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("daemon.js") || cmdline.includes("codeq");
  } catch (error) {
    if (error.code === "ENOENT") return false;
  }
  if (process.platform === "win32") return true;
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return args.includes("daemon.js") || args.includes("codeq");
  } catch {
    return true;
  }
}

async function stopDaemon(paths) {
  const pid = daemonPid(paths);
  if (pid && pidLooksLikeDaemon(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    for (let attempt = 0; attempt < 40 && pidAlive(pid); attempt += 1) {
      await sleep(STOP_WAIT_MS);
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      for (let attempt = 0; attempt < 20 && pidAlive(pid); attempt += 1) {
        await sleep(STOP_WAIT_MS);
      }
    }
  }
  if (!pid || !pidAlive(pid)) {
    await rm(paths.pid, { force: true }).catch(() => {});
  }
  if (!(await socketIsLive(paths.socket))) {
    await rm(paths.socket, { force: true }).catch(() => {});
  }
}

export async function connectDaemon(paths = daemonPaths()) {
  if (await daemonIsCurrent(paths)) {
    return openSocket(paths.socket);
  }

  if (!launching) {
    launching = ensureDaemon(paths).finally(() => {
      launching = null;
    });
  }
  await launching;
  return openSocket(paths.socket);
}

// One launch per process is not enough: several MCP servers and CLI invocations
// share one user-level daemon, so the autostart also has to be single across
// processes. Only the startup window is locked. A live socket from an older
// package is not current: path join and file-as-root live in the daemon, so an
// upgrade has to replace that process or 0.2.8's contract never takes effect.
// A pid file can also outlive its socket (partially-dead daemon), so whatever
// is not current gets stopped — once — before the fresh daemon binds.
async function ensureDaemon(paths) {
  const current = () => daemonIsCurrent(paths);
  const held = await acquireLock(paths.startLock, {
    timeoutMs: START_LOCK_TIMEOUT_MS,
    label: "daemon autostart",
    shortCircuit: current,
  });
  if (!held.release) return;
  try {
    if (await current()) return;
    await stopDaemon(paths);
    await launchDaemon(paths);
  } finally {
    held.release();
  }
}

async function launchDaemon(paths) {
  ensurePrivateDir(dirname(paths.log));
  const logFd = openSync(paths.log, "a");
  const script = fileURLToPath(new URL("./daemon.js", import.meta.url));
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    cwd: packageRoot,
  });
  child.unref();
  closeSync(logFd);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(50);
    if (await pingDaemon(paths, LAUNCH_PING_TIMEOUT_MS)) return;
  }
  throw new Error(`daemon did not start: see ${paths.log}`);
}

export async function queryDaemon(request, { onProgress, signal } = {}) {
  const paths = daemonPaths();
  const socket = await connectDaemon(paths);
  socket.setEncoding("utf8");
  let buffer = "";
  let settled = false;
  let watchdog;

  const completion = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      fn(value);
    };
    // A daemon that wedges mid-query never closes the socket, so the request
    // would wait forever. If it can no longer answer a ping, say so instead;
    // the next call restarts it.
    watchdog = setInterval(() => {
      void pingDaemon(paths).then((responsive) => {
        if (responsive) return;
        socket.destroy();
        finish(
          reject,
          new Error(
            "codeq daemon stopped responding; it will be restarted on the next call",
          ),
        );
      });
    }, QUERY_STALL_CHECK_MS);
    watchdog.unref();
    const onAbort = () => {
      socket.destroy();
      finish(reject, new Error("request cancelled"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === "progress") {
          onProgress?.(message);
        } else if (message.type === "error") {
          finish(reject, new Error(message.error));
        } else if (message.type === "result") {
          finish(resolve, message.result);
        }
      }
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("end", () => {
      if (!settled) {
        finish(
          reject,
          new Error("daemon returned an incomplete response"),
        );
      }
    });
    socket.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
    });
  });

  socket.write(`${JSON.stringify(request)}\n`);
  try {
    return await completion;
  } finally {
    if (!socket.destroyed) socket.end();
  }
}
