// 应用内日志：拦截 console 输出存一份环形缓冲，供首页底部的开发者区展示与复制。
// 日志只存本机内存，不上传、不落盘；重启 App 即清空。凭证类内容不打日志——
// 各音源的失败提示只含状态与原因，不含 cookie 与 token。

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
    time: string;
    level: LogLevel;
    text: string;
}

const MAX_ENTRIES = 500;

const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;

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
    entries.push({ time, level, text: args.map(formatArg).join(' ') });
    while (entries.length > MAX_ENTRIES) {
        entries.shift();
    }
    for (const listener of listeners) {
        listener();
    }
}

export function initLogger(): void {
    if (installed) {
        return;
    }
    installed = true;
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
    push('info', ['芷湘日志开始（仅存本机，重启后清空）']);
}

export function getLogEntries(): LogEntry[] {
    return entries.slice();
}

export function getLogText(): string {
    return entries.map((e) => `[${e.time}] ${e.level.toUpperCase()} ${e.text}`).join('\n');
}

export function clearLogs(): void {
    entries.length = 0;
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

export async function copyLogText(): Promise<boolean> {
    const text = getLogText() || '暂无日志';
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
