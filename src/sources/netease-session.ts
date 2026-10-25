// 网易云扫码登录会话（全新写）：只存会话凭证，不存密码、不存账号密码。
//
// 机制（2026-10-25 改走 Folia 桥式 weapi 路；此前裸 /api/ 路已证实不可用：
// 8821 拒扫码、key 约 22 秒就过期——14:02 与 14:27 两次实测均为生成后 22 秒
// 回 800，切去网易云 App 扫码再回来根本来不及；803 还拿不到 MUSIC_U）：
// - 取 key：POST /weapi/login/qrcode/unikey（weapi 加密，{type: '1', csrf_token}）
//   → {code: 200, unikey}（沙箱实测通，加密方案已验）。
// - 二维码内容：https://music.163.com/login?codekey=<key>，用户用网易云 App 扫。
//   二维码图片走 api.qrserver.com 渲染（<img> 加载不受 WebView CORS 限制）。
// - 轮询：POST /weapi/login/qrcode/client/login（weapi 加密，{key, type: '1'}）
//   → code 800 已过期 / 801 等待扫码 / 802 已扫码待确认 / 803 成功。
//   803 的 body.cookie 就是会话凭证（字符串或数组，数组用 '; ' 拼）；
//   拿不到时才用响应 Set-Cookie 兜底（桥已回传 setCookies）。
// 会话承接：取 key 与轮询必须带同一套 cookie——先逛首页拿 MUSIC_A/__csrf，
//   再取 key，轮询全程带罐子里的 cookie、每轮用新 Set-Cookie 更新罐子；
//   csrf_token 取罐子里的 __csrf，没有为空。
// - 登录判定只认 MUSIC_U：游客会话只有 MUSIC_A/__csrf、没有 MUSIC_U，绝不能算登录。
// - 会话校验：GET /api/user/level（需登录端点），匿名回 code 301；200 为有效，
//   301 为过期。/api/login/status 与 /api/user/account 直连均回 404（只是中转
//   服务的包装路径），不用。退出只清本地会话，不调未经证实的服务端登出端点。

import { httpGet, httpPost, type HttpResponse } from '../native/http';
import { weapiEncrypt } from './netease-crypto';

const WEAPI_BASE = 'https://music.163.com/weapi';
const USER_LEVEL_URL = 'https://music.163.com/api/user/level';
const HOMEPAGE_URL = 'https://music.163.com/';

// 二维码流程专用的 cookie 罐：首页 → 取 key → 轮询全程共用，扫码确认时
// 服务端按这套会话找 key 的归属；与已登录会话（MUSIC_U）无关，别混用。
const qrJar = new Map<string, string>();

function qrJarUpdate(setCookies: string[] | undefined): void {
    if (!setCookies) {
        return;
    }
    for (const entry of setCookies) {
        const pair = entry.split(';', 1)[0]?.trim();
        if (!pair) {
            continue;
        }
        const name = pair.split('=', 1)[0]?.trim();
        if (name) {
            qrJar.set(name, pair);
        }
    }
}

function qrJarHeader(): string {
    return [...qrJar.values()].join('; ');
}

function qrHeaders(): Record<string, string> {
    const cookie = qrJarHeader();
    return cookie ? { ...HEADERS, Cookie: cookie } : HEADERS;
}

// 罐子里的 __csrf，没有为空（weapi 要求带 csrf_token，未登录时可为空串）。
function qrCsrfToken(): string {
    const entry = qrJar.get('__csrf');
    if (!entry) {
        return '';
    }
    return entry.split('=', 2)[1] ?? '';
}

// weapi 请求：参数加密后拼成表单体 POST，Cookie 带罐子里的会话。
async function weapiQr(path: string, data: Record<string, unknown>): Promise<HttpResponse> {
    const encrypted = await weapiEncrypt({ ...data, csrf_token: qrCsrfToken() });
    const body = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;
    return httpPost(`${WEAPI_BASE}${path}`, body, {
        ...qrHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded'
    });
}
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
    | { code: 8821; message: string }
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
    // 先逛首页拿游客会话（MUSIC_A/__csrf），再取 key：两步的 Set-Cookie
    // 都进罐子，轮询与扫码确认全程带同一套会话。首页失败不中断（取 key
    // 本身也会下发会话 cookie），只影响会话完整度。
    qrJar.clear();
    try {
        const home = await httpGet(HOMEPAGE_URL, HEADERS);
        qrJarUpdate(home.setCookies);
    } catch {
        // 忽略：取 key 那步仍会下发会话。
    }
    const response = await weapiQr('/login/qrcode/unikey', { type: '1' });
    if (response.status !== 200) {
        throw new Error('拿不到登录二维码，请稍后重试');
    }
    qrJarUpdate(response.setCookies);
    let parsed: { code?: unknown; unikey?: unknown };
    try {
        parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
        throw new Error('拿不到登录二维码，请稍后重试');
    }
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
    const response = await weapiQr('/login/qrcode/client/login', { key, type: '1' });
    if (response.status !== 200) {
        throw new Error(`扫码状态查询失败（HTTP ${response.status}）`);
    }
    qrJarUpdate(response.setCookies);
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
    // 8821 不再抛错：它是“这个码被拒绝”的终态，调用方停掉本码轮询、
    // 给用户换新码再扫；继续轮询同一码只会一直 8821。
    if (code === 8821) {
        return { code: 8821, message: message || '请切换其他登录方式或升级新版本再试' };
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
        // 803 已确认却拿不到 MUSIC_U：只记凭证“形状”定位，不记任何凭证值——
        // body.cookie 有无与类型、data.cookie 有无、Set-Cookie 里出现的
        // cookie 名、响应体里是否含 MUSIC_U 子串。用户在开发者区 COPY 发回
        // 即可定位是服务端没发、还是桥没回传、还是解析漏了字段。
        const cookieNames = (value: unknown): string => {
            if (typeof value === 'string') {
                return value
                    .split(';')
                    .map((part) => part.split('=', 1)[0]?.trim())
                    .filter(Boolean)
                    .join(',');
            }
            if (Array.isArray(value)) {
                return value
                    .filter((item) => typeof item === 'string')
                    .map((item) => (item as string).split(';', 1)[0]?.split('=', 1)[0]?.trim())
                    .filter(Boolean)
                    .join(',');
            }
            return '';
        };
        const setCookieNames = (response.setCookies ?? [])
            .map((entry) => entry.split(';', 1)[0]?.split('=', 1)[0]?.trim())
            .filter(Boolean)
            .join(',');
        console.error(
            `[Netease] 803 凭证缺失：body.cookie=${typeof parsed.cookie}(${cookieNames(parsed.cookie) || '空'})，` +
                `data.cookie=${parsed.data ? typeof parsed.data.cookie : '无data'}(${cookieNames(parsed.data?.cookie) || '空'})，` +
                `setCookies名=[${setCookieNames || '空'}]，body含MUSIC_U=${response.body.includes('MUSIC_U') ? '是' : '否'}`
        );
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
