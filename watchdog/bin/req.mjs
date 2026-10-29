// 请求 watchdog 重启 DSH：写一个标记文件，守望进程看到后执行。
// 用法：node bin/req.mjs "改完了 index.js"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = fs.existsSync(path.join(ROOT, "config.json"))
  ? path.join(ROOT, "config.json")
  : path.join(ROOT, "config.example.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const file = cfg.requestFile || path.join(ROOT, "data", "restart.request");

fs.mkdirSync(path.dirname(file), { recursive: true });
const reason = process.argv.slice(2).join(" ") || "manual";
fs.writeFileSync(file, reason, "utf8");
console.log(`已写入重启请求：${file}`);
console.log(`原因：${reason}`);
console.log("watchdog 会在 debounce + drain 后重启 DSH；若它没在运行，这个文件不会被消费。");
