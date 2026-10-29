// B 站登录＋收藏夹同步（0.1.111）：扫码登录（B 站官方网页扫码路），
// 只存会话凭证，不存密码。收藏夹只读：文件夹列表＋每夹视频，播歌
// 复用 bilibili.ts 的免登录取链（播放本身不需要登录态）。
//
// 扫码路（2026-10-29 沙箱验过取码）：
// - 取码：GET passport.bilibili.com/x/passport-login/web/qrcode/generate
//   → code=0，data.url（完整扫码地址）＋ data.qrcode_key（32 字）。
//   二维码图片走 api.qrserver.com 渲染（<img> 加载不受 WebView CORS 限制，
//   网易云扫码同路）。
// - 轮询：GET .../web/qrcode/poll?qrcode_key=… → data.code：
//   86101 等待扫码／86090 已扫码待确认／86038 已过期／0 成功。
// - 成功时原生桥回传 Set-Cookie，取各条 name=value 拼成 Cookie；
//   SESSDATA 到手才算凭证齐全，再调 nav 拿 mid／昵称／头像存档。
// - 取码与轮询只靠 qrcode_key 关联，不依赖 cookie 罐。
// - 退出只清本地会话，不调未经证实的服务端登出端点（网易云同口径）。

import { httpGet } from '../native/http';
import type { Track } from '../types';

const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const FAV_FOLDERS_URL = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all';
const FAV_RESOURCES_URL = 'https://api.bilibili.com/x/v3/fav/resource/list';

const STORAGE_KEY = 'zx_bilibili_session_v1';

// B 站接口要浏览器 UA＋Referer，否则容易被风控拦（bilibili.ts 同款头）。
const BILI_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com'
};

export interface BiliSession {
    cookie: string;
    mid: number;
    nickname: string;
    avatarUrl: string;
    savedAt: number;
}

export function loadBiliSession(): BiliSession | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<BiliSession> | null;
        if (!parsed || typeof parsed.cookie !== 'string' || !parsed.cookie) {
            return null;
        }
        return {
            cookie: parsed.cookie,
            mid: typeof parsed.mid === 'number' ? parsed.mid : 0,
            nickname: typeof parsed.nickname === 'string' && parsed.nickname ? parsed.nickname : '已登录B站',
            avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : '',
            savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now()
        };
    } catch {
        return null;
    }
}

export function saveBiliSession(session: BiliSession): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
        // 存不下也不中断登录流程：本运行内仍可用，重启后需重新登录。
    }
}

export function clearBiliSession(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 清不掉也不抛错：调用方已按未登录渲染。
    }
}

export function biliQrImageUrl(url: string): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(url)}`;
}

export async function fetchBiliQrKey(): Promise<{ url: string; qrcodeKey: string }> {
    let parsed: unknown;
    try {
        const res = await httpGet(QR_GENERATE_URL, BILI_HEADERS);
        if (res.status !== 200) {
            throw new Error(`HTTP ${res.status}`);
        }
        parsed = JSON.parse(res.body) as unknown;
    } catch {
        throw new Error('B 站扫码取码失败，请稍后重试');
    }
    const data = (parsed as { code?: unknown; data?: Record<string, unknown> | null } | null)?.data;
    const url = data?.url;
    const qrcodeKey = data?.qrcode_key;
    if (typeof url !== 'string' || typeof qrcodeKey !== 'string') {
        throw new Error('B 站扫码取码失败，请稍后重试');
    }
    return { url, qrcodeKey };
}

export type BiliQrCheck =
    | { code: 86101 | 86090; message: string }
    | { code: 86038; message: string }
    | { code: 0; message: string; session: BiliSession | null };

function cookieFromSetCookies(setCookies: string[] | undefined): string {
    const parts: string[] = [];
    for (const line of setCookies ?? []) {
        const first = line.split(';')[0]?.trim();
        if (first && first.includes('=')) {
            parts.push(first);
        }
    }
    return parts.join('; ');
}

export async function checkBiliQr(qrcodeKey: string): Promise<BiliQrCheck> {
    let parsed: unknown;
    let setCookies: string[] | undefined;
    try {
        const res = await httpGet(
            `${QR_POLL_URL}?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
            BILI_HEADERS
        );
        if (res.status !== 200) {
            throw new Error(`HTTP ${res.status}`);
        }
        parsed = JSON.parse(res.body) as unknown;
        setCookies = res.setCookies;
    } catch {
        throw new Error('B 站扫码状态查不到，请稍后重试');
    }
    const root = parsed as { code?: unknown; data?: Record<string, unknown> | null } | null;
    const code = root?.data?.code ?? root?.code;
    if (code === 86101) {
        return { code: 86101, message: '等待扫码' };
    }
    if (code === 86090) {
        return { code: 86090, message: '已扫码，待手机上确认' };
    }
    if (code === 86038) {
        return { code: 86038, message: '二维码已过期，点刷新重取' };
    }
    if (code === 0) {
        const cookie = cookieFromSetCookies(setCookies);
        if (!cookie.includes('SESSDATA=')) {
            return { code: 0, message: '登录成功，但凭证没拿到，请重新扫码', session: null };
        }
        let navData: Record<string, unknown> | null = null;
        try {
            const nav = await httpGet(NAV_URL, { ...BILI_HEADERS, Cookie: cookie });
            if (nav.status === 200) {
                navData = (JSON.parse(nav.body) as { data?: Record<string, unknown> | null } | null)?.data ?? null;
            }
        } catch {
            navData = null;
        }
        const session: BiliSession = {
            cookie,
            mid: typeof navData?.mid === 'number' ? navData.mid : 0,
            nickname: typeof navData?.uname === 'string' ? navData.uname : '已登录B站',
            avatarUrl: typeof navData?.face === 'string' ? navData.face : '',
            savedAt: Date.now()
        };
        saveBiliSession(session);
        return { code: 0, message: '登录成功', session };
    }
    throw new Error('B 站扫码状态异常，请重试');
}

export type BiliValidity = 'none' | 'valid' | 'expired' | 'unknown';

export async function validateBiliSession(): Promise<BiliValidity> {
    const session = loadBiliSession();
    if (!session) {
        return 'none';
    }
    try {
        const res = await httpGet(NAV_URL, { ...BILI_HEADERS, Cookie: session.cookie });
        if (res.status !== 200) {
            return 'unknown';
        }
        const data = (JSON.parse(res.body) as { data?: Record<string, unknown> | null } | null)?.data;
        if (data?.isLogin === true) {
            return 'valid';
        }
        clearBiliSession();
        return 'expired';
    } catch {
        return 'unknown';
    }
}

export interface BiliFavFolder {
    id: number;
    title: string;
    mediaCount: number;
}

export async function fetchBiliFavFolders(): Promise<BiliFavFolder[]> {
    const session = loadBiliSession();
    if (!session) {
        throw new Error('请先登录B站');
    }
    const res = await httpGet(`${FAV_FOLDERS_URL}?up_mid=${session.mid}`, {
        ...BILI_HEADERS,
        Cookie: session.cookie
    });
    if (res.status !== 200) {
        throw new Error(`B 站收藏夹拿不到（HTTP ${res.status}）`);
    }
    const parsed = JSON.parse(res.body) as { code?: unknown; data?: unknown } | null;
    if (parsed?.code !== 0) {
        throw new Error('B 站收藏夹拿不到，请重新登录后再试');
    }
    const data = parsed.data as { list?: unknown } | unknown[] | null;
    const rawList = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : [];
    const folders: BiliFavFolder[] = [];
    for (const item of rawList as Record<string, unknown>[]) {
        if (typeof item.id !== 'number' || typeof item.title !== 'string') {
            continue;
        }
        folders.push({
            id: item.id,
            title: item.title,
            mediaCount: typeof item.media_count === 'number' ? item.media_count : 0
        });
    }
    return folders;
}

function toHttps(url: unknown): string | undefined {
    if (typeof url !== 'string' || !url) {
        return undefined;
    }
    if (url.startsWith('//')) {
        return `https:${url}`;
    }
    if (url.startsWith('http://')) {
        return url.replace('http://', 'https://');
    }
    return url;
}

export async function fetchBiliFavTracks(mediaId: number): Promise<Track[]> {
    const session = loadBiliSession();
    if (!session) {
        throw new Error('请先登录B站');
    }
    const headers = { ...BILI_HEADERS, Cookie: session.cookie };
    const tracks: Track[] = [];
    const seen = new Set<string>();
    for (let pn = 1; pn <= 3; pn++) {
        const res = await httpGet(
            `${FAV_RESOURCES_URL}?media_id=${mediaId}&pn=${pn}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`,
            headers
        );
        if (res.status !== 200) {
            throw new Error(`B 站收藏夹拿不到（HTTP ${res.status}）`);
        }
        const parsed = JSON.parse(res.body) as { code?: unknown; data?: { medias?: unknown } | null } | null;
        if (parsed?.code !== 0) {
            throw new Error('B 站收藏夹拿不到，请重新登录后再试');
        }
        const medias = parsed?.data?.medias;
        if (!Array.isArray(medias) || medias.length === 0) {
            break;
        }
        for (const raw of medias as Record<string, unknown>[]) {
            // 只认带 bvid 的视频项（文章等其它收藏形态没有 bvid，播不了）。
            if (typeof raw.bvid !== 'string' || !raw.bvid) {
                continue;
            }
            const id = `bilibili:${raw.bvid}`;
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            const upper = raw.upper as Record<string, unknown> | null;
            tracks.push({
                id,
                title: typeof raw.title === 'string' && raw.title ? raw.title : '未知曲名',
                artist: typeof upper?.name === 'string' && upper.name ? upper.name : '未知歌手',
                coverUrl: toHttps(raw.cover),
                durationMs: typeof raw.duration === 'number' ? raw.duration * 1000 : undefined,
                source: 'bilibili'
            });
        }
        if (medias.length < 20) {
            break;
        }
    }
    return tracks;
}
