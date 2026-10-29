// dsh-watchdog —— DS_RESTAR 的后台执行器
// 职责：插件源码变动、或收到重启请求时，同步文件并重启 DSH。
// 设计原则：它自己绝不重启自己，也不在 DSH 进程树里。

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG_PATH = path.join(ROOT, "config.json");

function readConfig() {
  // 仓库里只带 config.example.json；第一次运行时复制成本地 config.json。
  if (!fs.existsSync(CFG_PATH)) {
    const example = path.join(ROOT, "config.example.json");
    if (!fs.existsSync(example)) {
      throw new Error(`缺少配置：${CFG_PATH}（也没有 config.example.json）`);
    }
    fs.copyFileSync(example, CFG_PATH);
    console.log(`已从 config.example.json 生成 ${CFG_PATH}，请先改好再启动。`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
}

let cfg = readConfig();
const T = cfg.timing || {};
const debounceMs = Number(T.debounceMs ?? 1500);
const drainMs = Number(T.drainMs ?? 4000);
const minIntervalMs = Number(T.minIntervalMs ?? 30000);
const killTimeoutMs = Number(T.killTimeoutMs ?? 20000);
const bootTimeoutMs = Number(T.bootTimeoutMs ?? 90000);
// 杀完到再启动之间的空档：给系统释放文件句柄、端口、单实例锁的时间
const killGapMs = Number(T.killGapMs ?? 30000);

const DATA = path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });

const LOG = cfg.logFile || path.join(DATA, "watchdog.log");
const STATE = cfg.stateFile || path.join(DATA, "watchdog.json");
const REQUEST = cfg.requestFile || path.join(DATA, "restart.request");
const SCHEDULE = cfg.scheduleFile || path.join(DATA, "restart.schedule.json");
const LAST = path.join(DATA, "last-restart.json");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.appendFileSync(LOG, line + "\n", "utf8");
  } catch {
    /* 日志写不进去也不能影响主流程 */
  }
  console.log(line);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- 单实例 ----
function alreadyRunning() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (!st.pid) return false;
    process.kill(st.pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (alreadyRunning()) {
  log("已有实例在运行，退出");
  process.exit(0);
}
fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
process.on("exit", () => {
  try {
    if (JSON.parse(fs.readFileSync(STATE, "utf8")).pid === process.pid) fs.unlinkSync(STATE);
  } catch {
    /* ignore */
  }
});

// ---- 忽略规则 ----
const ignorePatterns = (cfg.ignore || []).map((p) => p.toLowerCase());
function ignored(filePath) {
  const p = String(filePath || "").toLowerCase();
  return ignorePatterns.some((pat) =>
    pat.includes("*") ? p.includes(pat.replace(/\*/g, "")) : p.includes(pat)
  );
}

// ---- 同步：源码 → profile ----
function sync() {
  for (const item of cfg.sync || []) {
    for (const rel of item.include || []) {
      const from = path.join(item.from, rel);
      const to = path.join(item.to, rel);
      if (!fs.existsSync(from)) continue;
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { recursive: true, force: true });
        log(`  sync ${rel}`);
      } catch (e) {
        log(`  sync 失败 ${rel}: ${e.message}`);
      }
    }
  }
}

// ---- 进程操作 ----
function killApp() {
  const image = cfg.app.imageName;
  log(`  taskkill /IM "${image}" /F`);
  try {
    execFileSync("taskkill", ["/IM", image, "/F"], { stdio: "ignore", timeout: 15000 });
  } catch {
    log("  （没有找到运行中的进程，跳过）");
  }
}

function isRunning(image) {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      encoding: "utf8",
      timeout: 10000,
    });
    return out.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

async function waitGone(image) {
  const deadline = Date.now() + killTimeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(image)) return true;
    await sleep(300);
  }
  return false;
}

/** 启动 DSH。
 *  走 explorer.exe 转一手：这样新进程挂在桌面 shell 下面，
 *  不会继承 DS_RESTAR（以及它背后 DSH）的 job object——
 *  上次「起来了又立刻没了」很可能就是 job 继承导致的。
 *  同时把 spawn 的结果写进 data/dsh-start.log，失败才有据可查。
 */
function startApp() {
  const { exe, args } = cfg.app;
  const out = path.join(DATA, "dsh-start.log");
  const stamp = new Date().toISOString();
  log(`  start "${exe}"`);
  try {
    fs.appendFileSync(out, `\n===== ${stamp} launch ${exe}\n`, "utf8");
  } catch {
    /* ignore */
  }

  // 1) 首选：explorer 转交（脱离 job / 继承桌面环境）
  try {
    const launcher = spawn("explorer.exe", [exe], { detached: true, stdio: "ignore", windowsHide: true });
    launcher.unref();
    log("  已通过 explorer.exe 转交启动");
    return null;
  } catch (e) {
    log(`  explorer 启动失败：${e.message}，改用直接 spawn`);
  }

  // 2) 兜底：直接 spawn，并保留 stdout/stderr
  let fd = "ignore";
  try {
    fd = fs.openSync(out, "a");
  } catch {
    fd = "ignore";
  }
  let child;
  try {
    child = spawn(exe, args || [], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: false,
    });
  } catch (e) {
    log(`  启动异常：${e.message}`);
    return null;
  }
  log(`  已拉起进程 pid=${child.pid ?? "未知"}`);
  const startedAt = Date.now();
  child.on("error", (e) => log(`  子进程错误：${e.message}`));
  child.on("exit", (code, signal) => {
    const lived = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`  子进程退出：code=${code} signal=${signal ?? "-"}，存活 ${lived}s`);
  });
  try {
    child.unref();
  } catch {
    /* ignore */
  }
  return child;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(1200, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function waitPort(port) {
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(600);
  }
  return false;
}

/** 启动后等「进程真的在」，比等某个固定端口靠谱（端口每次重启都会变）。 */
async function waitAlive(image, ms = 25000) {
  const deadline = Date.now() + ms;
  let seen = false;
  while (Date.now() < deadline) {
    if (isRunning(image)) {
      seen = true;
      // 再观察 3 秒，确认不是起来就崩
      await sleep(3000);
      return isRunning(image);
    }
    await sleep(500);
  }
  return seen;
}

// ---- 兜底：万一三次都没起来，让计划任务在 4 分钟后补一刀 ----
const FALLBACK_TASK = "DSH-Watchdog-Fallback";

function createFallback() {
  const { exe } = cfg.app;
  const cmdPath = path.join(DATA, "fallback-start.cmd");
  const body = [
    "@echo off",
    `tasklist /FI "IMAGENAME eq ${cfg.app.imageName}" | find /I "${cfg.app.imageName}" >nul`,
    "if not errorlevel 1 goto :end",
    `start "" "${exe}"`,
    ":end",
    `schtasks /delete /tn "${FALLBACK_TASK}" /f >nul 2>&1`,
  ].join("\r\n");
  try {
    fs.writeFileSync(cmdPath, body, "utf8");
    const when = new Date(Date.now() + 4 * 60 * 1000);
    const hm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    execFileSync(
      "schtasks",
      ["/create", "/tn", FALLBACK_TASK, "/tr", `"${cmdPath}"`, "/sc", "once", "/st", hm, "/f"],
      { stdio: "ignore", timeout: 15000 }
    );
    log(`  已挂兜底计划任务 ${FALLBACK_TASK}（${hm} 若还没起来就自己拉）`);
  } catch (e) {
    log(`  兜底计划任务创建失败：${e.message}`);
  }
}

function clearFallback() {
  try {
    execFileSync("schtasks", ["/delete", "/tn", FALLBACK_TASK, "/f"], { stdio: "ignore", timeout: 10000 });
    log(`  已撤掉兜底计划任务 ${FALLBACK_TASK}`);
  } catch {
    /* 没有就算了 */
  }
}

/** 启动后把主窗口提到前台：explorer 拉起的进程 Windows 不会自动给焦点，
 *  结果就是「进程在、窗口不出现」，用户以为没起来。 */
function activateApp() {
  const name = String(cfg.app.imageName).replace(/\.exe$/i, "").replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$w=$null",
    "for($i=0;$i -lt 20;$i++){",
    `  $w=Get-Process -Name '${name}' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    "  if($w){break}",
    "  Start-Sleep -Milliseconds 500",
    "}",
    "if($w){ $sh=New-Object -ComObject WScript.Shell; [void]$sh.AppActivate($w.Id) }",
  ].join("; ");
  try {
    execFileSync("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
      stdio: "ignore",
      timeout: 20000,
    });
    log("  已尝试把窗口提到前台");
  } catch {
    /* 提不到就算了，不影响启动 */
  }
}

// ---- 重启主流程 ----
let busy = false;
let lastRestart = 0;
let timer = null;

function schedule(reason, opts = {}) {
  if (!cfg.enabled) {
    log(`收到 ${reason}，但 enabled=false，忽略`);
    return;
  }
  if (busy) {
    log(`收到 ${reason}，正在重启中，忽略`);
    return;
  }
  if (!opts.force && Date.now() - lastRestart < minIntervalMs) {
    log(`收到 ${reason}，距上次重启不足 ${minIntervalMs}ms，忽略`);
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    restart(reason).catch((e) => log(`重启失败: ${e.message}`));
  }, debounceMs);
  log(`排队重启（${reason}），${debounceMs}ms 后执行`);
}

async function restart(reason) {
  busy = true;
  const t0 = Date.now();
  let ok = false;
  log(`=== 开始重启：${reason}`);
  try {
    sync();
    log(`  等待 ${drainMs}ms 让当前操作收尾`);
    await sleep(drainMs);
    createFallback();
    killApp();
    const gone = await waitGone(cfg.app.imageName);
    if (!gone) log("  进程未在超时内退出，仍然尝试启动");
    if (killGapMs > 0) {
      log(`  空档 ${killGapMs}ms 后再启动`);
      await sleep(killGapMs);
    }
    // 启动最多试 3 次：上次就是「起了一次、退出了」，没有重试直接判死
    let alive = false;
    for (let attempt = 1; attempt <= 3 && !alive; attempt++) {
      startApp();
      alive = await waitAlive(cfg.app.imageName, 20000);
      if (alive) {
        log(`  第 ${attempt} 次启动成功，进程已在运行`);
        break;
      }
      log(`  第 ${attempt} 次启动后进程不在（看 data/dsh-start.log）`);
      if (attempt < 3) {
        log("  10s 后重试");
        await sleep(10000);
      }
    }
    if (!alive) log("  **三次都没起来，需要手动启动**");
    if (alive) {
      clearFallback();
      activateApp();
    }
    const port = Number(cfg.app.port || 0);
    if (alive && port) {
      const ok = await waitPort(port);
      log(ok ? `  端口 ${port} 已就绪` : `  端口 ${port} 未就绪（可能换了端口，不影响）`);
    }
    const cost = Date.now() - t0;
    ok = alive;
    log(`=== 重启完成，用时 ${(cost / 1000).toFixed(1)}s（进程${alive ? "正常" : "未启动"}）`);
    try {
      fs.writeFileSync(
        LAST,
        JSON.stringify({ at: new Date().toISOString(), reason, durationMs: cost, port, alive }, null, 2)
      );
    } catch {
      /* 写不进去不影响重启本身 */
    }
  } finally {
    lastRestart = Date.now();
    busy = false;
  }

  // 重启成功就收工：DS_RESTAR 只在「有一次重启在办」的时候需要存在。
  // 下次 dsh_reboot 需要时，插件会重新把它拉起来。
  if (ok && cfg.exitAfterRestart) {
    log("重启已成功，DS_RESTAR 退出（下次需要重启时会自动再起）");
    try {
      fs.unlinkSync(SCHEDULE);
    } catch {
      /* 没有就算了 */
    }
    process.exit(0);
  }
}

// ---- 定时文件：{ at: 毫秒时间戳, reason } ----
let lastCountdownLog = 0;

function checkSchedule() {
  try {
    if (!fs.existsSync(SCHEDULE)) return;
    const s = JSON.parse(fs.readFileSync(SCHEDULE, "utf8"));
    const at = Number(s.at || 0);
    if (!at) {
      fs.unlinkSync(SCHEDULE);
      log("定时文件缺少 at，已删除");
      return;
    }
    const left = at - Date.now();
    if (left > 0) {
      // 每 10 秒打一次剩余时间，别刷屏
      if (Date.now() - lastCountdownLog > 10000) {
        lastCountdownLog = Date.now();
        log(`定时重启倒计时 ${Math.ceil(left / 1000)}s（${s.reason || "无说明"}）`);
      }
      return;
    }
    fs.unlinkSync(SCHEDULE);
    schedule(`定时重启：${s.reason || "（无说明）"}`, { force: true });
  } catch (e) {
    log(`读取定时文件失败: ${e.message}`);
    try {
      fs.unlinkSync(SCHEDULE);
    } catch {
      /* ignore */
    }
  }
}

// ---- 请求文件 ----
function checkRequest() {
  try {
    if (!fs.existsSync(REQUEST)) return;
    const raw = fs.readFileSync(REQUEST, "utf8").trim();
    fs.unlinkSync(REQUEST);
    schedule(`请求文件：${raw || "（无说明）"}`);
  } catch (e) {
    log(`读取请求文件失败: ${e.message}`);
  }
}

// ---- 监视 ----
const watchers = [];
for (const dir of cfg.watch || []) {
  if (!fs.existsSync(dir)) {
    log(`监视目录不存在，跳过：${dir}`);
    continue;
  }
  try {
    const w = fs.watch(dir, { recursive: true }, (_evt, file) => {
      if (ignored(file)) return;
      schedule(`文件变动 ${dir}\\${file ?? ""}`);
    });
    watchers.push(w);
    log(`监视：${dir}`);
  } catch (e) {
    log(`无法监视 ${dir}: ${e.message}`);
  }
}

fs.watchFile(REQUEST, { interval: 2000 }, checkRequest);
setInterval(checkRequest, 3000);
setInterval(checkSchedule, 1000);

log(`DS_RESTAR 启动 pid=${process.pid}，监视 ${watchers.length} 个目录，重启端口 ${cfg.app.port}，杀后空档 ${killGapMs}ms`);
if (fs.existsSync(SCHEDULE)) {
  try {
    const s = JSON.parse(fs.readFileSync(SCHEDULE, "utf8"));
    log(`发现待执行定时重启：${new Date(Number(s.at)).toLocaleString()}（${s.reason || "无说明"}）`);
  } catch {
    /* ignore */
  }
}

process.on("SIGINT", () => {
  log("收到 SIGINT，退出");
  process.exit(0);
});
