// YTM 登录会话（全新写）：凭据是 YouTube cookie，不是 OAuth —— YouTube 不给
// YTM 的 OAuth。登录页是原生单独 Activity 里的 WebView（见 YtmSignInActivity），
// 用户在里面真的登录一次 YouTube，主界面通过插件拿回整条 Cookie + 那个 WebView
// 的 UA；后续 InnerTube 请求必须同时带 Cookie 与同源 UA（YouTube 按 UA 决定给不
// 给某些接口），缺一不可。
//
// 登录判定只认 SAPISID。账号名没有可验证的直连端点（Folia 那边是 youtubei.js 的
// account.getInfo，芷湘没有对应实现），登录后只显示“已登录 YouTube Music”，
// 不编名字与头像。
//
// 会话没有可验证的直连校验端点：过期 cookie 发请求时 YouTube 一般按匿名处理，
// 不报错，因此不做过期清理、只在用户点退出时清；过期后重新登录即可。

import { Capacitor, registerPlugin } from '@capacitor/core';

const STORAGE_KEY = 'zx_ytm_session_v1';

export interface YtmSession {
    cookie: string;
    userAgent: string;
    savedAt: number;
}

export type YtmSignInResult =
    | { ok: true; session: YtmSession }
    | { ok: false; cancelled: boolean; message?: string };

interface YtmSignInPlugin {
    signIn(): Promise<{ ok?: unknown; cookie?: unknown; userAgent?: unknown }>;
}

const YtmSignIn = registerPlugin<YtmSignInPlugin>('YtmSignIn');

export function loadYtmSession(): YtmSession | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<YtmSession> | null;
        if (!parsed || typeof parsed.cookie !== 'string' || !hasSapisid(parsed.cookie)) {
            return null;
        }
        return {
            cookie: parsed.cookie,
            userAgent: typeof parsed.userAgent === 'string' ? parsed.userAgent : '',
            savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now()
        };
    } catch {
        return null;
    }
}

export function clearYtmSession(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 清不掉也不抛错：调用方已按未登录渲染。
    }
}

export function hasSapisid(cookie: string): boolean {
    return /(?:^|;\s*)SAPISID=[^;]+/.test(cookie);
}

// 原生登录 Activity 在不在：必须用 isPluginAvailable 查原生侧上报的清单，
// 不能用 typeof 方法名判断（registerPlugin 给回来的是代理，任何方法名问过去
// 都是 function，原生没实现时也会误判为可用）。
export function isYtmSignInAvailable(): boolean {
    return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('YtmSignIn');
}

export async function signInYtm(): Promise<YtmSignInResult> {
    if (!isYtmSignInAvailable()) {
        return { ok: false, cancelled: false, message: '当前设备不支持 YTM 登录' };
    }
    try {
        const result = await YtmSignIn.signIn();
        const cookie = typeof result?.cookie === 'string' ? result.cookie : '';
        if (!result || result.ok !== true || !cookie || !hasSapisid(cookie)) {
            // 取消、无凭证、无登录标记都按取消处理，不当成网络失败。
            return { ok: false, cancelled: true };
        }
        const session: YtmSession = {
            cookie,
            userAgent: typeof result.userAgent === 'string' ? result.userAgent : '',
            savedAt: Date.now()
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        } catch {
            // 存不下也不中断：本运行内仍可用，重启后需重新登录。
        }
        return { ok: true, session };
    } catch (error) {
        return {
            ok: false,
            cancelled: false,
            message: error instanceof Error ? error.message : 'YTM 登录失败'
        };
    }
}

// 有会话时补 Cookie 与同源 UA；无会话时原样返回，不动匿名请求。
export function withYtmSession(headers: Record<string, string>): Record<string, string> {
    const session = loadYtmSession();
    if (!session) {
        return headers;
    }
    const next: Record<string, string> = { ...headers, Cookie: session.cookie };
    if (session.userAgent) {
        next['User-Agent'] = session.userAgent;
    }
    return next;
}
