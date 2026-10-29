// 查看 watchdog 状态：是否在跑、有没有排队中的请求、最近几条日志。

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = fs.existsSync(path.join(ROOT, "config.json"))
  ? path.join(ROOT, "config.json")
  : path.join(ROOT, "config.example.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const DATA = path.join(ROOT, "data");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const statePath = cfg.stateFile || path.join(DATA, "watchdog.json");
let state = null;
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  /* 没有状态文件 */
}

if (!state) {
  console.log("watchdog：未运行（没有状态文件）");
} else if (!alive(state.pid)) {
  console.log(`watchdog：未运行（残留状态 pid=${state.pid}，进程已不存在）`);
} else {
  console.log(`watchdog：运行中 pid=${state.pid}，启动于 ${state.startedAt}`);
}

const reqFile = cfg.requestFile || path.join(DATA, "restart.request");
console.log(fs.existsSync(reqFile) ? `待处理请求：${fs.readFileSync(reqFile, "utf8")}` : "待处理请求：无");

const app = cfg.app;
const port = Number(app.port || 0);
if (port) {
  const ok = await new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
  console.log(`DSH 端口 ${port}：${ok ? "可连接" : "不可连接"}`);
}

const logPath = cfg.logFile || path.join(DATA, "watchdog.log");
try {
  const lines = fs.readFileSync(logPath, "utf8").trimEnd().split(/\r?\n/);
  console.log("\n最近日志：");
  console.log(lines.slice(-12).join("\n"));
} catch {
  console.log("\n还没有日志。");
}
