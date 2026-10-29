# DS_RESTAR

给 DeepSeek Harness 用的「自助重启」小部件。

排一个倒计时，时间到了由**进程外**的看守程序结束 DSH、等一会儿、再把它拉起来。整个过程你只需要说一句「重启」，或者点一下卡片上的按钮。

```
倒计时 → 结束进程 → 空档 30s → 重新启动 → 窗口回到前台 → 看守进程自行退出
```

## 为什么不是「直接调用 app.relaunch()」

插件跑在 DSH 的进程里，它没法干净地杀掉自己再起来。所以这里拆成两半：

| 角色 | 位置 | 职责 |
|---|---|---|
| `dsh-reboot`（本插件） | DSH 进程内 | 下单（写排期文件）、查单、提供工具和前端卡片 |
| DS_RESTAR 看守进程 | 独立 node 进程 | 真正执行 kill / 等待 / start，并验证新进程是否活着 |

看守进程由 WMI 拉起，父进程是 `WmiPrvSE.exe`，**不在 DSH 的 job object 里**——否则 `taskkill /F` 会把看守一起带走（这是第一版踩过的坑）。

## 安装

```bash
dsh plugin add <本仓库地址或本地路径>
```

首次执行重启时，插件会把自带的 `watchdog/` 目录铺到 `%USERPROFILE%\.dsh\dsh-restar`，并生成一份指向当前 DSH 的 `config.json`。不需要另外克隆仓库。

要求：Windows（用到了 `taskkill` / `schtasks` / `explorer.exe` 的行为），Node 20+。

## 用法

对助手说：

- 「重启一下」→ `dsh_restart`，默认 60 秒后执行
- 「90 秒后重启，我要保存东西」→ `delaySec: 90`
- 「别重启了」→ `dsh_restart_cancel`，或直接点卡片上的红色按钮

工具：

| 工具 | 作用 |
|---|---|
| `dsh_restart(delaySec?, reason?)` | 排一次重启，返回时间线 |
| `dsh_restart_status()` | 还有多久、看守进程在不在、上次花了多久、最近日志 |
| `dsh_restart_cancel()` | 撤销：删排期 + 结束看守进程 + 撤掉兜底任务 |

## 屏幕上的卡片

有排期时，输入框上方会出现一张卡片：

- `DS_RESTAR 即将重启` + 大号 `mm:ss`
- 进度条按「排期时刻 → 触发时刻」推进
- 最后 10 秒整体转红
- 底行是看守进程状态，右侧一个红色 **取消重启** 按钮
- 没有排期时完全不存在（`display:none`），也不拦截点击（`pointer-events:none`，只有按钮例外）

## 配置

插件配置（`dsh` 的插件设置里）：

| 键 | 默认 | 说明 |
|---|---|---|
| `watchdogRoot` | `%USERPROFILE%\.dsh\dsh-restar` | 看守程序运行目录 |
| `defaultDelaySec` | 60 | 默认倒计时 |
| `defaultGapSec` | 30 | 杀完到重启的空档（展示用，实际值在 `config.json` 的 `timing.killGapMs`） |

看守程序的 `config.json` 里还有：

```jsonc
{
  "app":   { "exe": "…\\DeepSeek Harness.exe", "imageName": "DeepSeek Harness.exe", "port": 0 },
  "timing":{ "debounceMs": 1500, "drainMs": 4000, "killGapMs": 30000, "bootTimeoutMs": 30000 },
  "watch": [],          // 这些目录有改动时自动重启（需 autoRestartOnChange: true）
  "sync":  [],          // 重启前把源码目录同步进 profile 的 node_modules
  "exitAfterRestart": true
}
```

`port` 保持 0：DSH 的端口每次重启都会变，拿端口当存活判据永远会失败（第二版踩过的坑）。存活只看进程。

## 安全边界

- 只在本机操作，只结束 `imageName` 匹配的进程，不碰别的程序。
- 排期文件是唯一事实来源；撤销就是删掉它。
- 看守进程在重启成功后会自己退出，不留常驻后台。
- 失败时**不退出**，保留兜底计划任务（`DS-Watchdog-Fallback`），5 分钟后尝试补拉一次。

## 目录

```
lib/index.js     宿主半：工具 + /x-dsh-reboot/{state,cancel} 路由
lib/client.js    浏览器半：倒计时卡片
watchdog/        看守程序（独立运行，也可单独使用）
```

## License

MIT
