// 网易云扫码登录会话（全新写）：只存会话凭证，不存密码、不存账号密码。
//
// 机制（2026-10-25 改走 eapi App 扫码路；此前两条路均已证实不可用：
// 裸 /api/ 路 8821 拒扫码；weapi + 网页扫码 type=1 虽能取 key，但 key
// 约 20 秒就过期——14:02 / 14:27 / 14:39 / 14:44 / 14:52 五次实测
// 19–27 秒，切去网易云 App 再回来根本来不及；且 803 拿不到 MUSIC_U。
// 根因：那两条都是“浏览器游客”身份（浏览器 UA、无设备标识、无 App
// header），服务端按非官方客户端判风控。eapi + App 扫码 type=3 是
// 官方 App 自己的扫码路，沙箱已验通：取 key 200、首查 801、key 寿命正常）：
// - 取 key：eapi /api/login/qrcode/unikey（{type: 3}）→ {code: 200, unikey}。
// - 二维码内容：https://music.163.com/login?codekey=<key>，用户用网易云 App 扫。
//   二维码图片走 api.qrserver.com 渲染（<img> 加载不受 WebView CORS 限制）。
// - 轮询：eapi /api/login/qrcode/client/login（{key, type: 3}）
//   → code 800 已过期 / 801 等待扫码 / 802 已扫码待确认 / 803 成功。
//   803 的 body.cookie 就是会话凭证（字符串或数组，数组用 '; ' 拼）；
//   拿不到时才用响应 Set-Cookie 兜底（桥已回传 setCookies）。
// - eapi 不需要 cookie 罐与首页预取：请求本身带稳定设备标识与 App
//   header（见 netease-eapi.ts），服务端按设备认 key；轮询不带会话。
//   因此 qrJar 与首页种子已删。
// - 登录判定只认 MUSIC_U：游客会话只有 MUSIC_A/__csrf、没有 MUSIC_U，绝不能算登录。
// - 会话校验：GET /api/user/level（需登录端点），匿名回 code 301；200 为有效，
//   301 为过期。/api/login/status 与 /api/user/account 直连均回 404（只是中转
//   服务的包装路径），不用。退出只清本地会话，不调未经证实的服务端登出端点。

import { httpGet } from '../native/http';
import { eapiRequest, getEapiIdentityHash } from './netease-eapi';

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

// 出口 IP 回显（Claude 2026-10-25 实验）：取码时与每次检查时都经同一桥
// 抓一次 api.ip.sb/ip，只在 IP 变化时记一行（首个也记），用变化断定
// 同一 key 的两次请求是否走了不同出口。失败静默；一律不 await，
// 不拖慢取码与轮询。日志里是出口地址（VPN 节点或运营商共享地址），
// 只发到用户自己的 VPS，不进公开仓库。
let lastEchoIp = '';
function probeEgressIp(): void {
    void httpGet('https://api.ip.sb/ip')
        .then((response) => {
            if (response.status !== 200) {
                return;
            }
            const ip = response.body.trim();
            if (!ip || ip === lastEchoIp) {
                return;
            }
            lastEchoIp = ip;
            console.log(`[Netease] 出口 IP ${ip}`);
        })
        .catch(() => {
            // 回显失败不记日志、不干扰扫码。
        });
}

export async function fetchQrKey(): Promise<string> {
    // eapi App 扫码 type=3：请求本身带稳定设备标识（见 netease-eapi.ts），
    // 服务端按设备认 key。游客注册暖机已在 0.1.24 拿掉（实测拿不到会话
    // 也拿不到 NMTID，白白拖 2 秒还刷失败日志）；扫码根因改问 Claude。
    const response = await eapiRequest('/api/login/qrcode/unikey', { type: 3 });
    if (response.status !== 200) {
        throw new Error('拿不到登录二维码，请稍后重试');
    }
    let parsed: {
        code?: unknown;
        unikey?: unknown;
        uniKey?: unknown;
        data?: { unikey?: unknown; uniKey?: unknown } | null;
    };
    try {
        parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
        throw new Error('拿不到登录二维码，请稍后重试');
    }
    const key =
        (typeof parsed.unikey === 'string' && parsed.unikey) ||
        (typeof parsed.uniKey === 'string' && parsed.uniKey) ||
        (typeof parsed.data?.unikey === 'string' && parsed.data.unikey) ||
        (typeof parsed.data?.uniKey === 'string' && parsed.data.uniKey) ||
        '';
    if (!key) {
        throw new Error('拿不到登录二维码，请稍后重试');
    }
    // 诊断（Claude 2026-10-25）：每次取码都记 key 前 6 位与身份指纹——
    // 一会话里取码次数、以及取码与轮询是否同一身份，凭这几行就能断。
    console.log(`[Netease] 取码 ${key.slice(0, 6)} 身份=${getEapiIdentityHash()}`);
    probeEgressIp();
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

// 上一次检查的 key 前缀与身份指纹：变化才记一行（正常轮询 3 秒一次
// 全记会刷满控制台）；key 或身份一变就说明有第二个轮询器或头被换了。
let lastCheckKeyPrefix = '';
let lastCheckIdentityHash = '';

export async function checkQr(key: string): Promise<QrCheckResult> {
    probeEgressIp();
    const keyPrefix = key.slice(0, 6);
    const identityHash = getEapiIdentityHash();
    if (keyPrefix !== lastCheckKeyPrefix || identityHash !== lastCheckIdentityHash) {
        console.log(`[Netease] 检查码 ${keyPrefix} 身份=${identityHash}`);
        lastCheckKeyPrefix = keyPrefix;
        lastCheckIdentityHash = identityHash;
    }
    const response = await eapiRequest('/api/login/qrcode/client/login', { key, type: 3 });
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
