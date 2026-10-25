// 网易云扫码登录会话（全新写）：只存会话凭证，不存密码、不存账号密码。
//
// 机制（2026-10-25 沙箱实探，端点均为 music.163.com 直连，不走中转服务）：
// - 取 key：GET /api/login/qrcode/unikey?type=1 → {code: 200, unikey}（实测通）。
// - 二维码内容：https://music.163.com/login?codekey=<key>，用户用网易云 App 扫。
//   二维码图片走 api.qrserver.com 渲染（网易云自家的 qrimg 端点直连回 404，
//   只有中转服务才有；<img> 加载不受 WebView CORS 限制）。
// - 轮询：GET /api/login/qrcode/client/login?key=<key>&type=1 → code 800 已过期 /
//   801 等待扫码 / 802 已扫码待确认 / 803 成功（801 实测通；803 只能真机扫码验）。
//   803 的 body.cookie 就是会话凭证（字符串或数组，数组用 '; ' 拼）；
//   拿不到时才用响应 Set-Cookie 兜底（桥已回传 setCookies）。
// - 登录判定只认 MUSIC_U：游客会话只有 MUSIC_A/__csrf、没有 MUSIC_U，绝不能算登录。
// - 会话校验：GET /api/user/level（需登录端点），匿名回 code 301；200 为有效，
//   301 为过期。/api/login/status 与 /api/user/account 直连均回 404（只是中转
//   服务的包装路径），不用。退出只清本地会话，不调未经证实的服务端登出端点。

import { httpGet } from '../native/http';

const UNIKEY_URL = 'https://music.163.com/api/login/qrcode/unikey';
const QR_CHECK_URL = 'https://music.163.com/api/login/qrcode/client/login';
const USER_LEVEL_URL = 'https://music.163.com/api/user/level';
const STORAGE_KEY = 'zx_netease_session_v1';

const HEADERS: Record<string, string> = {
    Referer: 'https://music.163.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
};

export interface NeteaseSession {
    cookie: string;
    nickname: string;
    avatarUrl: string;
    userId?: number;
    savedAt: number;
}

export type SessionValidity = 'none' | 'valid' | 'expired' | 'unknown';

export type QrCheckResult =
    | { code: 800 | 801 | 802; message: string }
    | { code: 803; message: string; session: NeteaseSession | null };

export function loadSession(): NeteaseSession | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<NeteaseSession> | null;
        if (!parsed || typeof parsed.cookie !== 'string' || !hasMusicU(parsed.cookie)) {
            return null;
        }
        return {
            cookie: parsed.cookie,
            nickname: typeof parsed.nickname === 'string' && parsed.nickname ? parsed.nickname : '已登录网易云',
            avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : '',
            userId: typeof parsed.userId === 'number' ? parsed.userId : undefined,
            savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now()
        };
    } catch {
        return null;
    }
}

export function saveSession(session: NeteaseSession): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
        // 存不下也不中断登录流程：本运行内仍可用，重启后需重新登录。
    }
}

export function clearSession(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 清不掉也不抛错：调用方已按未登录渲染。
    }
}

// 登录态只认 MUSIC_U：游客 cookie 没有它，绝不能算登录。
export function hasMusicU(cookie: string): boolean {
    return /(?:^|;\s*)MUSIC_U=[^;]+/.test(cookie);
}

// 有会话时给请求头补 Cookie；无会话时原样返回，不改调用方的其它头。
export function withSessionCookie(headers: Record<string, string>): Record<string, string> {
    const session = loadSession();
    if (!session) {
        return headers;
    }
    return { ...headers, Cookie: session.cookie };
}

export function qrContentUrl(key: string): string {
    return `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
}

export function qrImageUrl(key: string): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(qrContentUrl(key))}`;
}

export async function fetchQrKey(): Promise<string> {
    const response = await httpGet(`${UNIKEY_URL}?type=1`, HEADERS);
    if (response.status !== 200) {
        throw new Error('拿不到登录二维码，请稍后重试');
    }
    const parsed = JSON.parse(response.body) as { code?: unknown; unikey?: unknown };
    const key = typeof parsed.unikey === 'string' ? parsed.unikey : '';
    if (!key) {
        throw new Error('拿不到登录二维码，请稍后重试');
    }
    return key;
}

function cookieFromSetCookies(setCookies: string[] | undefined): string {
    if (!setCookies || setCookies.length === 0) {
        return '';
    }
    const pairs: string[] = [];
    for (const entry of setCookies) {
        const pair = entry.split(';', 1)[0]?.trim();
        if (pair) {
            pairs.push(pair);
        }
    }
    // 同名只留最后一个（两次响应里可能各有一份）。
    const seen = new Map<string, string>();
    for (const pair of pairs) {
        const name = pair.split('=', 1)[0]?.trim();
        if (name) {
            seen.set(name, pair);
        }
    }
    return [...seen.values()].join('; ');
}

export async function checkQr(key: string): Promise<QrCheckResult> {
    const response = await httpGet(`${QR_CHECK_URL}?key=${encodeURIComponent(key)}&type=1`, HEADERS);
    if (response.status !== 200) {
        throw new Error(`扫码状态查询失败（HTTP ${response.status}）`);
    }
    let parsed: {
        code?: unknown;
        message?: unknown;
        cookie?: unknown;
        profile?: { nickname?: unknown; avatarUrl?: unknown; userId?: unknown } | null;
        data?: { cookie?: unknown; profile?: { nickname?: unknown; avatarUrl?: unknown; userId?: unknown } | null } | null;
    };
    try {
        parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
        throw new Error('扫码状态返回异常');
    }
    const code = Number(parsed.code);
    const message = typeof parsed.message === 'string' && parsed.message ? parsed.message : '';
    if (code === 800) {
        return { code: 800, message: message || '二维码已过期' };
    }
    if (code === 801) {
        return { code: 801, message: message || '等待扫码' };
    }
    if (code === 802) {
        return { code: 802, message: message || '已扫码，请在手机上确认' };
    }
    if (code !== 803) {
        // 服务端原话 message 一起带上：8821 这类非标准码的含义可能就写在里面。
        const detail = `扫码状态查询失败（code ${code}${message ? `：${message}` : ''}）`;
        console.error(detail);
        throw new Error(detail);
    }
    // 803：先取 body 里的凭证，拿不到再用 Set-Cookie 兜底；都没有则不算登录成功。
    let cookie = '';
    if (typeof parsed.cookie === 'string') {
        cookie = parsed.cookie.trim();
    } else if (Array.isArray(parsed.cookie)) {
        cookie = (parsed.cookie as unknown[]).filter((item) => typeof item === 'string' && item).join('; ');
    }
    if (!cookie && parsed.data && typeof parsed.data.cookie === 'string') {
        cookie = parsed.data.cookie.trim();
    }
    if (!cookie) {
        cookie = cookieFromSetCookies(response.setCookies);
    }
    if (!cookie || !hasMusicU(cookie)) {
        return { code: 803, message: '登录凭证不完整，请重新扫码', session: null };
    }
    const profile = parsed.profile ?? parsed.data?.profile ?? null;
    const session: NeteaseSession = {
        cookie,
        nickname:
            typeof profile?.nickname === 'string' && profile.nickname ? profile.nickname : '已登录网易云',
        avatarUrl: typeof profile?.avatarUrl === 'string' ? profile.avatarUrl : '',
        userId: typeof profile?.userId === 'number' ? profile.userId : undefined,
        savedAt: Date.now()
    };
    return { code: 803, message: message || '授权登录成功', session };
}

// 校验已存会话：200 有效；301 过期（当场清掉）；网络异常不断言，保留会话。
export async function validateStoredSession(): Promise<SessionValidity> {
    const session = loadSession();
    if (!session) {
        return 'none';
    }
    try {
        const response = await httpGet(USER_LEVEL_URL, { ...HEADERS, Cookie: session.cookie });
        if (response.status !== 200) {
            return 'unknown';
        }
        const parsed = JSON.parse(response.body) as { code?: unknown };
        if (Number(parsed.code) === 200) {
            return 'valid';
        }
        if (Number(parsed.code) === 301) {
            clearSession();
            return 'expired';
        }
        return 'unknown';
    } catch {
        return 'unknown';
    }
}
