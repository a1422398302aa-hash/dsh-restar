# dsh-watchdog

进程外DS_RESTAR：**插件源码一改，或你写一个请求文件，它就重启 DSH。**

它自己不在 DSH 的进程树里，也不自杀——`taskkill` 和 `start` 都由外部进程发起，所以不会出现「杀到一半把自己也带走」的情况。

## 为什么不用别的方案

| 方案 | 问题 |
| --- | --- |
| 插件里 `app.relaunch()` | 依赖插件能拿到 electron 模块，不确定 |
| 让插件自己 taskkill 父进程 | 进程树会一起死，重启没人拉起 |
| 动态 `import(url?t=...)` | 只换实现，新增工具/改依赖仍要真重启 |

## 工作方式

```
你改了 lib/index.js
        │
        ▼
fs.watch 触发（1.5s 去抖）
        │
        ├─ 同步：源码 → profiles/desktop/node_modules/dsh-comicbox
        ├─ 等 4s（让进行中的操作收尾）
        ├─ taskkill /IM "DeepSeek Harness.exe" /F
        ├─ 启动 "DeepSeek Harness.exe"
        └─ 轮询端口 60067 直到可连接（最多 90s）
```

也可以不靠文件变动，直接点一下：

```
bin\req.cmd "改完了 index.js"
```

它会在 `data/restart.request` 写一行，DS_RESTAR读到就执行，然后删掉。

## 快速开始

```bash
# 1. 生成配置
cp config.example.json config.json
#    然后改三处：app.exe、watch（要监视的插件目录）、sync（源码 → profile）

# 2. 启动DS_RESTAR
bin\start.cmd

# 3. 看状态
bin\status.cmd
```

`config.json` 是本机专用、已被 `.gitignore` 排除；仓库里只带 `config.example.json`。第一次运行时如果只找到 example，程序会复制一份出来并提示你先改。

## 命令

| 命令 | 作用 |
| --- | --- |
| `bin\start.cmd` | 启动DS_RESTAR（最小化窗口） |
| `bin\status.cmd` | 看是否在跑、有无排队请求、端口通不通、最近 12 行日志 |
| `bin\req.cmd "原因"` | 请求重启一次 |

脚本里用的是 DSH 自带的 node（`...\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`，v24.21.0），因为本机 PATH 上没有 node。

## 配置 `config.json`

```jsonc
{
  "app": { "exe": "...\\DeepSeek Harness.exe", "imageName": "DeepSeek Harness.exe", "port": 60067 },
  "timing": {
    "debounceMs": 1500,     // 文件连续变动时合并
    "drainMs": 4000,        // 杀进程前等多久，给当前操作收尾
    "minIntervalMs": 30000, // 两次重启最小间隔，防抖防循环
    "killTimeoutMs": 20000,
    "bootTimeoutMs": 90000
  },
  "watch": ["...\\dsh-comicbox\\lib", "...\\dsh-comicbox\\vendor\\scripts"],
  "sync": [{ "from": "...\\dsh-comicbox", "to": "...\\node_modules\\dsh-comicbox", "include": ["lib", "vendor/scripts", "..."] }],
  "enabled": true
}
```

- `enabled: false` 时只记日志、不动手，适合临时关掉。
- `sync` 是「改了源码但忘了拷进 profile」这个坑的解药：重启前先同步一遍。
- **不要监视 `node_modules`**：sync 会往里写，写了又触发，就成循环了。`ignore` 里已挡掉 `node_modules`。

## 边界

- 只负责「重启」，不判断 DSH 是不是正在跑一个长任务；`drainMs` 是固定等待，不是「等空闲」。要更稳可以把 `drainMs` 调大。
- 重启期间正在进行的回合会被打断。需要无损的话得走方案 C（热替换实现），那是另一件事。
- 端口写死在 `app.port`：DSH 每次重启端口会变，这里只用于「等它就绪」的探测。端口变了就更新这个值，或者设成 `0` 跳过探测。
- 日志在 `data/watchdog.log`，只追加不轮转；长时间跑记得清。

## 状态文件

- `data/watchdog.json` —— 当前守护进程的 pid（用于单实例判断，进程退出时自动删）
- `data/restart.request` —— 待处理的重启请求
- `data/watchdog.log` —— 时间线

## 生命周期（exitAfterRestart）

exitAfterRestart: true（默认）时，**重启成功DS_RESTAR就退出**，不常驻：

- 需要重启时才由 dsh-restar 插件把它拉起来（in\start.cmd 走 WMI，父进程是 WmiPrvSE.exe，不在 DSH 的 job 里，所以 DSH 被杀不会带走它）。
- 拉起来 → 干活 → 成功了 process.exit(0)，data/watchdog.json 自动删除；下次 dsh_reboot 再拉一次。
- 三次都失败则**不退出**，留着兜底计划任务在 4 分钟后补一刀。

代价：watch 那套「改文件自动重启」只在它活着时有效。想常驻就设 exitAfterRestart: false。