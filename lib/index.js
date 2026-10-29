// dsh-reboot —— 让 DSH 自己安排重启。
// 时序（用户定的）：触发 → 等 60s → 杀进程 → 空档 30s → 再启动。
// 真正的杀/启动由进程外的 dsh-watchdog 执行；这里只负责「下单」和「查单」。
// 纪律：只用命名导出，别加 `export default`。

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, cpSync } from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-reboot';
export const inject = ['tools'];

export const Config = Schema.object({
    watchdogRoot: Schema.string().default(join(homedir(), '.dsh', 'dsh-restar'))
        .description('DS_RESTAR 运行目录（它负责真正执行 kill/start）。默认 %USERPROFILE%\\.dsh\\dsh-restar，首次使用时自动铺开。'),
    defaultDelaySec: Schema.natural().min(0).max(3600).default(60)
        .description('默认倒计时秒数：从下单到杀进程。'),
    defaultGapSec: Schema.natural().min(0).max(600).default(30)
        .description('杀完之后等多久再启动（展示用；实际值在 watchdog 的 timing.killGapMs）。'),
});

const TEXT_OUT = {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
    render: (_args, v) => [{ type: 'text', text: v.text }],
};

function hhmmss(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtLeft(ms) {
    if (ms <= 0) return '0s';
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function apply(ctx, config) {
    const log = ctx.logger('reboot');
    const root = config.watchdogRoot;
    const P = {
        dir: root,
        schedule: join(root, 'data', 'restart.schedule.json'),
        state: join(root, 'data', 'watchdog.json'),
        last: join(root, 'data', 'last-restart.json'),
        logFile: join(root, 'data', 'watchdog.log'),
        startCmd: join(root, 'bin', 'start.cmd'),
    };

    function readJson(file) {
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        }
        catch {
            return null;
        }
    }

    function watchdogPid() {
        const st = readJson(P.state);
        if (!st?.pid) return 0;
        try {
            process.kill(st.pid, 0);
            return st.pid;
        }
        catch {
            return 0;
        }
    }

    /**
     * 首次使用：把随包附带的 watchdog/ 铺到 root，并写一份指向当前应用的 config.json。
     * 这样「装完插件就能用」，用户不必手动 clone 另一个仓库。
     */
    function bootstrapRoot() {
        const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'watchdog');
        if (!existsSync(src)) return;
        mkdirSync(root, { recursive: true });
        cpSync(src, root, {
            recursive: true,
            filter: (from) => !from.includes(`${sep}data`) && !from.endsWith(`${sep}data`),
        });
        const cfgPath = join(root, 'config.json');
        if (!existsSync(cfgPath)) {
            const cfg = {
                app: { exe: process.execPath, imageName: basename(process.execPath), port: 0, args: [] },
                timing: {
                    debounceMs: 1500,
                    drainMs: 4000,
                    minIntervalMs: 30000,
                    killTimeoutMs: 20000,
                    bootTimeoutMs: 30000,
                    killGapMs: Math.max(0, config.defaultGapSec) * 1000,
                },
                watch: [],
                ignore: ['node_modules', 'data', '.git', '*.log', '*.tmp'],
                sync: [],
                autoRestartOnChange: false,
                exitAfterRestart: true,
                enabled: true,
            };
            writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        }
        log.info(`已铺开 DS_RESTAR 运行目录：${root}`);
    }

    /** DS_RESTAR 没在跑就从外部拉起来（独立进程，不在 DSH 进程树里）。 */
    function ensureWatchdog() {
        const pid = watchdogPid();
        if (pid) return pid;
        if (!existsSync(P.startCmd)) bootstrapRoot();
        if (!existsSync(P.startCmd)) throw new Error(`找不到 ${P.startCmd}，没法启动 DS_RESTAR 进程`);
        log.info('DS_RESTAR 未运行，拉起');
        const child = spawn('cmd.exe', ['/c', P.startCmd], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
        return 0;
    }

    function writeSchedule(at, reason) {
        mkdirSync(dirname(P.schedule), { recursive: true });
        const tmp = `${P.schedule}.tmp`;
        writeFileSync(tmp, JSON.stringify({ at, reason, requestedAt: Date.now() }, null, 2), 'utf8');
        // 原子替换，避免 watchdog 读到半个文件
        try {
            writeFileSync(P.schedule, readFileSync(tmp, 'utf8'), 'utf8');
            unlinkSync(tmp);
        }
        catch {
            writeFileSync(P.schedule, JSON.stringify({ at, reason, requestedAt: Date.now() }, null, 2), 'utf8');
        }
    }

    ctx.tools.register(defineTool({
        name: 'dsh_restart',
        description: '安排一次 DSH 重启：倒计时结束后结束进程，空档若干秒后再启动。返回时间线。用于「改完插件需要重载」的场景。',
        parameters: {
            delaySec: { type: 'integer', description: '从下单到杀进程的秒数，默认 60。给 0 表示立刻。' },
            reason: { type: 'string', description: '写进日志的原因，例如「同步 comicbox 修复」。' },
        },
        output: TEXT_OUT,
        isConcurrencySafe: () => true,
        async execute(args) {
            const delay = Math.max(0, Math.min(3600, args.delaySec ?? config.defaultDelaySec));
            const gapSec = Math.max(0, config.defaultGapSec);
            const reason = String(args.reason ?? '').trim() || '来自 dsh_restart';
            const at = Date.now() + delay * 1000;

            ensureWatchdog();
            writeSchedule(at, reason);

            const lines = [
                `已排定重启：**${hhmmss(at)}** 结束 DSH 进程。`,
                '',
                `- 现在 → ${hhmmss(at)}：正常可用，你照常发消息，我不受影响`,
                `- ${hhmmss(at)}：进程被结束（对话会断在这里）`,
                `- ${hhmmss(at + gapSec * 1000)}：重新启动`,
                `- 大约 ${hhmmss(at + gapSec * 1000 + 8000)}：端口就绪、插件加载完`,
                '',
                `原因：${reason}`,
                '',
                '屏幕底部会出现一张倒计时卡片，最后 10 秒变红；窗口消失的那段会显示「重启中…」。',
                '卡片右边有个红色「取消」按钮，点一下就撤销；或者让我调 `dsh_restart_cancel`。倒计时里我这边不需要做别的事。',
            ];
            if (delay === 0) {
                lines.unshift('（delaySec=0：会在下一条消息之后很快执行，可能来不及道别。）', '');
            }
            return { text: lines.join('\n') };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'dsh_restart_status',
        description: '看重启安排：还有多久、DS_RESTAR 在不在、上次重启花了多久。',
        parameters: {},
        output: TEXT_OUT,
        isConcurrencySafe: () => true,
        async execute() {
            const pid = watchdogPid();
            const sch = readJson(P.schedule);
            const last = readJson(P.last);
            const out = [];

            out.push(pid ? `DS_RESTAR：运行中（pid ${pid}）` : 'DS_RESTAR：**没在运行**（下次 dsh_restart 会自动拉起）');

            if (sch?.at) {
                const left = sch.at - Date.now();
                out.push(left > 0
                    ? `待执行重启：${hhmmss(sch.at)}（还有 ${fmtLeft(left)}），原因：${sch.reason || '无'}`
                    : `有一单已到点但还没执行（${hhmmss(sch.at)}），DS_RESTAR 可能卡住了`);
            }
            else {
                out.push('待执行重启：无');
            }

            if (last?.at) {
                out.push(`上次重启：${new Date(last.at).toLocaleString('zh-CN', { hour12: false })}，耗时 ${(last.durationMs / 1000).toFixed(1)}s，原因：${last.reason || '无'}`);
            }

            try {
                const tail = readFileSync(P.logFile, 'utf8').trimEnd().split(/\r?\n/).slice(-6);
                out.push('', '最近日志：', '```', ...tail, '```');
            }
            catch {
                out.push('', '（还没有日志）');
            }
            return { text: out.join('\n') };
        },
    }));

    // 撤销：删排期 + 结束 DS_RESTAR 进程 + 撤掉兜底计划任务。
    // 工具和卡片上的按钮都走这里，保证两条路行为一致。
    function cancelRestart() {
        let sch = null;
        if (existsSync(P.schedule)) {
            sch = readJson(P.schedule);
            try {
                unlinkSync(P.schedule);
            }
            catch { /* 文件被抢占就算了，进程一死倒计时也会停 */ }
        }
        const pid = watchdogPid();
        if (pid) {
            try {
                process.kill(pid);
            }
            catch { /* 已经退了 */ }
        }
        try {
            spawn('schtasks', ['/Delete', '/TN', 'DSH-Watchdog-Fallback', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            }).on('error', () => {});
        }
        catch { /* 没这个任务也无所谓 */ }
        return { sch, pid };
    }

    ctx.tools.register(defineTool({
        name: 'dsh_restart_cancel',
        description: '撤销还没到点的重启安排。已经杀掉的进程救不回来。',
        parameters: {},
        output: TEXT_OUT,
        isConcurrencySafe: () => true,
        async execute() {
            if (!existsSync(P.schedule)) return { text: '没有待执行的重启，不用撤销。' };
            const { sch } = cancelRestart();
            const when = sch?.at ? hhmmss(sch.at) : '未知时间';
            return { text: `已撤销（原定 ${when}）。DSH 继续运行，DS_RESTAR 进程也已结束。` };
        },
    }));

    // 卡片（lib/client.js）读 state，按钮打 cancel。
    ctx.inject(['webServer'], (wctx) => {
        wctx.effect(() => wctx.webServer.register({
            kind: 'prefix',
            path: '/x-dsh-reboot',
            handler: async (req, res) => {
                const url = String(req.url || '');

                if (url.startsWith('/x-dsh-reboot/cancel')) {
                    if (req.method !== 'POST') {
                        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
                        return;
                    }
                    const { sch, pid } = cancelRestart();
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ ok: true, at: sch?.at ?? null, killedPid: pid ?? null }));
                    log.info(`卡片上撤销了重启（原定 ${sch?.at ? hhmmss(sch.at) : '无'}）`);
                    return;
                }

                if (!url.startsWith('/x-dsh-reboot/state')) {
                    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end('not found');
                    return;
                }
                const sch = readJson(P.schedule);
                const at = sch?.at ?? null;
                let watchdog = null;
                try {
                    watchdog = watchdogPid();
                }
                catch {
                    watchdog = null;
                }
                const body = {
                    at,
                    leftMs: at ? Math.max(0, at - Date.now()) : 0,
                    requestedAt: sch?.requestedAt ?? null,
                    reason: sch?.reason ?? '',
                    gapSec: config.defaultGapSec,
                    watchdog,
                };
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify(body));
            },
        }));
    });

    log.info(`dsh-reboot 就绪，watchdog 根目录 ${root}`);
}
