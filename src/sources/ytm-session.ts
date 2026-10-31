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
    probeWatchPage(options: { videoId: string }): Promise<{ raw?: unknown }>;
    extractViaPage(options: { videoId: string }): Promise<{ raw?: unknown; audioUrl?: unknown; audioMime?: unknown; tally?: unknown; stateRaw?: unknown }>;
}

const YtmSignIn = registerPlugin<YtmSignInPlugin>('YtmSignIn');

// 登录门探针的页面侧结果（0.1.126）：原生 WebView 打开真实 watch 页读到的
// ytInitialPlayerResponse 摘要。visitorData 只回内存给探针重试用，绝不打日志
// （日志只记有无与长度）。
export interface YtmWatchPageProbe {
    ok: boolean;
    status: string;
    reason: string;
    hasStreaming: boolean;
    audioCount: number;
    directCount: number;
    visitorData: string | null;
    err: string;
}

// 页面抽取结果（0.1.127）：探针摘要之外，多了页面播放器自己发出的音频
// 请求地址（拦截所得、已解签）。audioUrl 含出口 IP 与签名，只在内存里
// 流转，调用方日志只许记 host/itag/mime/长度，绝不打全文。
export interface YtmPageExtract extends YtmWatchPageProbe {
    audioUrl: string | null;
    audioMime: string;
    // 页面请求总览（host/路径首段×次数）与 video 元素末次状态：0.1.128 起
    // 回传，专为定位「页面没起播出地址」卡在哪一步。
    tally: string;
    stateRaw: string;
}

export async function extractYtmViaPage(videoId: string): Promise<YtmPageExtract | null> {
    if (!Capacitor.isNativePlatform()) {
        return null;
    }
    try {
        const ret = await YtmSignIn.extractViaPage({ videoId });
        if (!ret || typeof ret.raw !== 'string' || !ret.raw) {
            return null;
        }
        let inner: unknown = JSON.parse(ret.raw);
        if (typeof inner === 'string') {
            inner = JSON.parse(inner);
        }
        const o = inner as Record<string, unknown> | null;
        if (!o) {
            return null;
        }
        return {
            ok: o.ok === true,
            status: typeof o.status === 'string' ? o.status : '',
            reason: typeof o.reason === 'string' ? o.reason : '',
            hasStreaming: o.hasStreaming === true,
            audioCount: typeof o.audioCount === 'number' ? o.audioCount : 0,
            directCount: typeof o.directCount === 'number' ? o.directCount : 0,
            visitorData:
                typeof o.visitorData === 'string' && o.visitorData ? o.visitorData : null,
            err: typeof o.err === 'string' ? o.err : '',
            audioUrl: typeof ret.audioUrl === 'string' && ret.audioUrl ? ret.audioUrl : null,
            audioMime: typeof ret.audioMime === 'string' ? ret.audioMime : '',
            tally: typeof ret.tally === 'string' ? ret.tally : '',
            stateRaw: typeof ret.stateRaw === 'string' ? ret.stateRaw : ''
        };
    } catch {
        return null;
    }
}

// 非原生环境或插件不可用时回 null（探针是诊断，缺了不许影响取链主流程）。
export async function probeYtmWatchPage(videoId: string): Promise<YtmWatchPageProbe | null> {
    if (!Capacitor.isNativePlatform()) {
        return null;
    }
    try {
        const ret = await YtmSignIn.probeWatchPage({ videoId });
        if (!ret || typeof ret.raw !== 'string' || !ret.raw) {
            return null;
        }
        let inner: unknown = JSON.parse(ret.raw);
        if (typeof inner === 'string') {
            inner = JSON.parse(inner);
        }
        const o = inner as Record<string, unknown> | null;
        if (!o) {
            return null;
        }
        return {
            ok: o.ok === true,
            status: typeof o.status === 'string' ? o.status : '',
            reason: typeof o.reason === 'string' ? o.reason : '',
            hasStreaming: o.hasStreaming === true,
            audioCount: typeof o.audioCount === 'number' ? o.audioCount : 0,
            directCount: typeof o.directCount === 'number' ? o.directCount : 0,
            visitorData:
                typeof o.visitorData === 'string' && o.visitorData ? o.visitorData : null,
            err: typeof o.err === 'string' ? o.err : ''
        };
    } catch {
        return null;
    }
}

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

// ---- SHA-1（FIPS 180-1，输入按 UTF-8 编码，输出小写十六进制） ----
// 与 netease-eapi.ts 的 md5Hex 同一写法；只给下面的 sapisidHash 用。

function sha1Hex(text: string): string {
    const bytes = new TextEncoder().encode(text);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    // SHA-1 用大端 64 位长度。
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(padded.length - 4, bitLength & 0xffffffff, false);
    const rotateLeft = (value: number, bits: number): number =>
        ((value << bits) | (value >>> (32 - bits))) >>> 0;
    const add = (...values: number[]): number => {
        let sum = 0;
        for (const value of values) {
            sum = (sum + (value >>> 0)) >>> 0;
        }
        return sum >>> 0;
    };
    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    for (let offset = 0; offset < padded.length; offset += 64) {
        const words: number[] = [];
        for (let i = 0; i < 16; i += 1) {
            words.push(view.getUint32(offset + i * 4, false));
        }
        for (let i = 16; i < 80; i += 1) {
            // 下标恒在范围内（i < 80，前项均已算出）：noUncheckedIndexedAccess 下用 ! 断言。
            words.push(rotateLeft(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1));
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        for (let i = 0; i < 80; i += 1) {
            let f: number;
            let k: number;
            if (i < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999;
            } else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1;
            } else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdc;
            } else {
                f = b ^ c ^ d;
                k = 0xca62c1d6;
            }
            const temp = add(rotateLeft(a, 5), f, e, k, words[i]!);
            e = d;
            d = c;
            c = rotateLeft(b, 30);
            b = a;
            a = temp;
        }
        h0 = add(h0, a);
        h1 = add(h1, b);
        h2 = add(h2, c);
        h3 = add(h3, d);
        h4 = add(h4, e);
    }
    return [h0, h1, h2, h3, h4].map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

// SAPISIDHASH（Folia 桥同款算法）：`SAPISIDHASH <unix秒>_<sha1("<unix秒> <SAPISID> https://www.youtube.com")>`。
// cookie 里没有 SAPISID（或它的 __Secure- 形态）就回 null，请求只带 Cookie。
// 签名现算现用，不记日志、不落盘。
export function sapisidHash(cookie: string, origin = 'https://www.youtube.com'): string | null {
    // 优先 plain SAPISID（SAPISIDHASH 规范的本名），再 fallback
    // __Secure-3PAPISID：旧逻辑取首个，顺序依赖，两值不同时可能取错。
    let sapisid: string | null = null;
    let fallback: string | null = null;
    for (const pair of cookie.split(';')) {
        const split = pair.indexOf('=');
        if (split <= 0) {
            continue;
        }
        const name = pair.slice(0, split).trim();
        if (name === 'SAPISID' && sapisid === null) {
            sapisid = pair.slice(split + 1).trim();
        } else if (name === '__Secure-3PAPISID' && fallback === null) {
            fallback = pair.slice(split + 1).trim();
        }
    }
    const value = sapisid ?? fallback;
    if (!value) {
        return null;
    }
    const seconds = Math.floor(Date.now() / 1000);
    return `SAPISIDHASH ${seconds}_${sha1Hex(`${seconds} ${value} ${origin}`)}`;
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
    // Folia 桥同款登录态三件套：Cookie 之外再带 SAPISIDHASH 签名与
    // X-Goog-AuthUser。门收紧时（IP 信誉低）只带 Cookie 的请求会被
    // LOGIN_REQUIRED 拦下，带全套签名的才过——2026-10-26 晚 Folia
    // 能播、芷湘不能播，差的就是这两项。
    const authorization = sapisidHash(session.cookie);
    if (authorization) {
        next['Authorization'] = authorization;
        next['X-Goog-AuthUser'] = '0';
    }
    return next;
}
