// 应用内日志：拦截 console 输出存一份环形缓冲，供首页底部的开发者区展示与复制。
// 日志存本机 localStorage，重启 App 后保留（用户要求：不要重启就没了）；
// 同时自动传到用户自己的英国 VPS 接收服务（0.1.23 起，不用再手动点上传）：
// 每条新日志后防抖 3 秒发一次全量原文，发送本身不记日志（否则会自触发循环），
// 成败都不写日志；口令由 CI secret 在构建时注入，不进公开仓库源码。
// 凭证类内容不打日志——各音源的失败提示只含状态与原因，不含 cookie 与 token。

import { APP_VERSION } from './version';
import { httpPost } from './native/http';

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
    time: string;
    level: LogLevel;
    // 模块取自消息开头的 [Tag]（如 [Netease]、[Player]），没有则为 app；
    // 供开发者控制台按模块过滤，对齐 Folia 开发者页的 MODULE 过滤。
    module: string;
    text: string;
}

const MAX_ENTRIES = 500;
const STORAGE_KEY = 'zx_dev_log_v1';

// 自动上传（用户自己的 VPS，手动按钮的同一地址与口令）：防抖 3 秒，
// 连续日志只发最后一次；发送静默，成败都不记日志，避免自触发循环。
const LOG_UPLOAD_URL = 'https://probe.suanran9527.com/zhixiang-logs/upload';
const LOG_UPLOAD_TOKEN = import.meta.env.VITE_ZHIXIANG_LOG_TOKEN as string | undefined;
let uploadTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleAutoUpload(): void {
    if (!LOG_UPLOAD_TOKEN) {
        return;
    }
    if (uploadTimer !== undefined) {
        clearTimeout(uploadTimer);
    }
    uploadTimer = setTimeout(() => {
        void sendLogsSilently();
    }, 3000);
}

async function sendLogsSilently(): Promise<void> {
    try {
        const text = getLogText();
        if (!text || !LOG_UPLOAD_TOKEN) {
            return;
        }
        await httpPost(
            LOG_UPLOAD_URL,
            JSON.stringify({ version: APP_VERSION, device: 'phone', entries: text }),
            {
                'Content-Type': 'application/json',
                'X-ZX-Token': LOG_UPLOAD_TOKEN
            }
        );
    } catch {
        // 静默：自动上传失败不记日志（记了又会触发下一次上传）。
    }
}

const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;

// 本机持久化：每条新日志都写回 localStorage，App 重启后先读回，
// 再接新日志；写不下（配额满）时砍半重试一次，再失败就只留内存。
function persist(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
        try {
            entries.splice(0, Math.floor(entries.length / 2));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } catch {
            // 存不下也不中断：本运行内内存日志仍可用。
        }
    }
}

function restore(): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return;
        }
        const parsed = JSON.parse(raw) as Partial<LogEntry>[] | null;
        if (!Array.isArray(parsed)) {
            return;
        }
        for (const item of parsed.slice(-MAX_ENTRIES)) {
            if (
                item &&
                typeof item.time === 'string' &&
                typeof item.level === 'string' &&
                typeof item.text === 'string'
            ) {
                entries.push({
                    time: item.time,
                    level: item.level as LogLevel,
                    module: typeof item.module === 'string' && item.module ? item.module : 'app',
                    text: item.text
                });
            }
        }
    } catch {
        // 旧存档损坏就丢弃，从空开始。
        entries.length = 0;
    }
}

function formatArg(arg: unknown): string {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
    }
    try {
        return JSON.stringify(arg) ?? String(arg);
    } catch {
        return String(arg);
    }
}

function push(level: LogLevel, args: unknown[]): void {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const text = args.map(formatArg).join(' ');
    const tag = /^\[([^\]]+)\]/.exec(text);
    const module = tag && tag[1] ? tag[1] : 'app';
    entries.push({ time, level, module, text });
    while (entries.length > MAX_ENTRIES) {
        entries.shift();
    }
    persist();
    for (const listener of listeners) {
        listener();
    }
    scheduleAutoUpload();
}

export function initLogger(): void {
    if (installed) {
        return;
    }
    installed = true;
    restore();
    const originals = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };
    console.log = (...args: unknown[]): void => {
        push('log', args);
        originals.log(...args);
    };
    console.info = (...args: unknown[]): void => {
        push('info', args);
        originals.info(...args);
    };
    console.warn = (...args: unknown[]): void => {
        push('warn', args);
        originals.warn(...args);
    };
    console.error = (...args: unknown[]): void => {
        push('error', args);
        originals.error(...args);
    };
    push('info', [`芷湘日志开始（${APP_VERSION}，已存本机，重启后保留）`]);
}

export function getLogEntries(): LogEntry[] {
    return entries.slice();
}

export function getLogModules(): string[] {
    const seen = new Set<string>();
    for (const entry of entries) {
        seen.add(entry.module);
    }
    return [...seen];
}

export function getLogText(): string {
    return entries.map((e) => `[${e.time}] ${e.level.toUpperCase()} ${e.text}`).join('\n');
}

export function clearLogs(): void {
    entries.length = 0;
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 清不掉也不中断：下次启动读回的仍是清空前的存档时再清一次。
    }
    for (const listener of listeners) {
        listener();
    }
}

export function subscribeLogs(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export async function copyPlainText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // 剪贴板 API 不可用时用老办法兜底。
        try {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(area);
            return ok;
        } catch {
            return false;
        }
    }
}

export async function copyLogText(): Promise<boolean> {
    return copyPlainText(getLogText() || '暂无日志');
}
