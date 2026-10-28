// B 站音源（0.1.104，v1：免登录搜索＋播放，不接登录体系与收藏夹同步）：
// B 站音乐就是视频音轨：WBI 签名搜视频 → pagelist 取 cid → playurl 取 DASH 音频。
// 全流程实测（2026-10-29 沙箱 curl＋本机 Python 复验 WBI 表与签名）：
// nav 未登录照样给 wbi_img（code=-101 预期内）；WBI 搜索 code=0 回 20 条；
// pagelist 单 P 一项；playurl fnval=4048 只回 DASH，audio 最高码率约 320kbps；
// Range 0-1023 回 206。实测到的坑都已处理：标题含 <em class="keyword"> 高亮
// 标签须剥掉；封面是协议相对 URL 须补 https:；搜索时长是 "M:SS" 字符串，
// pagelist 时长是秒数；音频直链带签名参数会过期，现取现用，不缓存；
// 实际 Content-Type 是 video/mp4，不要拿它做音频校验。
// 播放层：安卓远程流一律走本机代理（playback.ts），本模块只出直链；
// 歌词：v1 不接 B 站字幕轨，lyrics.ts 里复用本地那套联网补源。

import { httpGet } from '../native/http';
import { md5Hex } from './netease-eapi';
import type { AudioSource, Track } from '../types';

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const PAGELIST_URL = 'https://api.bilibili.com/x/player/pagelist';
const PLAYURL_URL = 'https://api.bilibili.com/x/player/playurl';

// B 站接口要浏览器 UA＋Referer，否则容易被风控拦；无 cookie、无登录态。
const BILI_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com'
};

// WBI mixin 置换表（公开算法，2026-10-29 本机 Python 持表实测搜索 code=0 验过）。
const MIXIN_TABLE: number[] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14,
    39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6,
    63, 57, 62, 11, 36, 20, 34, 44, 52
];

const MIXIN_TTL_MS = 24 * 60 * 60 * 1000;

let cachedMixin: { key: string; at: number } | null = null;

function fileNameOf(url: string): string {
    const base = url.split('/').pop() ?? '';
    return base.split('.')[0] ?? '';
}

async function getMixinKey(force = false): Promise<string> {
    if (!force && cachedMixin && Date.now() - cachedMixin.at < MIXIN_TTL_MS) {
        return cachedMixin.key;
    }
    let parsed: unknown;
    try {
        const res = await httpGet(NAV_URL, BILI_HEADERS);
        if (res.status !== 200) {
            throw new Error(`HTTP ${res.status}`);
        }
        parsed = JSON.parse(res.body) as unknown;
    } catch {
        throw new Error('B 站签名素材拿不到，请稍后重试');
    }
    const wbi = (parsed as { data?: { wbi_img?: { img_url?: unknown; sub_url?: unknown } } })
        .data?.wbi_img;
    const img = typeof wbi?.img_url === 'string' ? wbi.img_url : '';
    const sub = typeof wbi?.sub_url === 'string' ? wbi.sub_url : '';
    const src = fileNameOf(img) + fileNameOf(sub);
    if (src.length < 64) {
        throw new Error('B 站签名素材拿不到，请稍后重试');
    }
    const key = MIXIN_TABLE.map((i) => src.charAt(i)).join('').slice(0, 32);
    cachedMixin = { key, at: Date.now() };
    return key;
}

// WBI 签名：参数按 key 排序，值去掉 !'()* 后 URL 编码，拼 mixin key 取 MD5。
function signQuery(params: Record<string, string>, mixin: string): { qs: string; wRid: string } {
    const parts = Object.keys(params)
        .sort()
        .map((key) => {
            const value = (params[key] ?? '').replace(/[!'()*]/g, '');
            return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        });
    const qs = parts.join('&');
    return { qs, wRid: md5Hex(qs + mixin) };
}

interface BiliSearchResponse {
    code?: unknown;
    message?: unknown;
    data?: { result?: unknown };
}

async function searchWithMixin(keyword: string, mixin: string): Promise<BiliSearchResponse> {
    const wts = Math.floor(Date.now() / 1000).toString();
    const { qs, wRid } = signQuery({ keyword, search_type: 'video', wts }, mixin);
    let parsed: unknown;
    try {
        const res = await httpGet(`${SEARCH_URL}?${qs}&w_rid=${wRid}`, BILI_HEADERS);
        if (res.status !== 200) {
            throw new Error(`B 站搜索失败（HTTP ${res.status}）`);
        }
        parsed = JSON.parse(res.body) as unknown;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('B 站搜索失败')) {
            throw error;
        }
        throw new Error('B 站搜索网络异常，请稍后重试');
    }
    return parsed as BiliSearchResponse;
}

function stripEmTags(title: string): string {
    return title.replace(/<[^>]+>/g, '');
}

// 搜索时长是 "M:SS" 或 "H:MM:SS" 字符串，转毫秒；解析不出时留空不猜。
function parseBiliDuration(text: unknown): number | undefined {
    if (typeof text !== 'string' || !text) {
        return undefined;
    }
    const parts = text.split(':').map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
        return undefined;
    }
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return seconds > 0 ? seconds * 1000 : undefined;
}

function toHttps(url: unknown): string | undefined {
    if (typeof url !== 'string' || !url) {
        return undefined;
    }
    if (url.startsWith('//')) {
        return `https:${url}`;
    }
    return url.startsWith('http') ? url : undefined;
}

async function fetchJson(url: string, failure: string): Promise<unknown> {
    let parsed: unknown;
    try {
        const res = await httpGet(url, BILI_HEADERS);
        if (res.status !== 200) {
            throw new Error(`HTTP ${res.status}`);
        }
        parsed = JSON.parse(res.body) as unknown;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('HTTP ')) {
            throw new Error(`${failure}（${error.message}）`);
        }
        throw new Error('B 站网络异常，请稍后重试');
    }
    return parsed;
}

class BilibiliSource implements AudioSource {
    readonly id = 'bilibili' as const;
    readonly label = 'B站';

    async search(query: string): Promise<Track[]> {
        const keyword = query.trim();
        if (!keyword) {
            return [];
        }
        let parsed = await searchWithMixin(keyword, await getMixinKey());
        if (parsed.code !== 0) {
            // 签名素材过期是常见原因：清掉重取一次再试，还失败才报错。
            parsed = await searchWithMixin(keyword, await getMixinKey(true));
        }
        if (parsed.code !== 0) {
            const detail =
                typeof parsed.message === 'string' && parsed.message
                    ? parsed.message
                    : `code ${String(parsed.code)}`;
            throw new Error(`B 站搜索失败（${detail}）`);
        }
        const items = Array.isArray(parsed.data?.result) ? parsed.data.result : [];
        const tracks: Track[] = [];
        for (const raw of items as Array<Record<string, unknown>>) {
            const bvid = typeof raw.bvid === 'string' ? raw.bvid : '';
            const title = typeof raw.title === 'string' ? stripEmTags(raw.title) : '';
            if (!bvid || !title) {
                continue;
            }
            const artist = typeof raw.author === 'string' && raw.author ? raw.author : '未知歌手';
            tracks.push({
                id: `bilibili:${bvid}`,
                title,
                artist,
                durationMs: parseBiliDuration(raw.duration),
                coverUrl: toHttps(raw.pic),
                source: 'bilibili'
            });
        }
        return tracks;
    }

    async resolveStream(track: Track): Promise<string> {
        const bvid = track.id.startsWith('bilibili:')
            ? track.id.slice('bilibili:'.length)
            : track.id;
        if (!bvid) {
            throw new Error('B 站视频号不对，请重新搜索再试');
        }
        const pages = (await fetchJson(
            `${PAGELIST_URL}?bvid=${encodeURIComponent(bvid)}&jsonp=jsonp`,
            'B 站分 P 信息拿不到'
        )) as { code?: unknown; data?: unknown };
        if (pages.code !== 0 || !Array.isArray(pages.data) || pages.data.length === 0) {
            throw new Error('B 站视频没有分 P 信息');
        }
        const first = pages.data[0] as { cid?: unknown };
        const cid = typeof first.cid === 'number' ? first.cid : 0;
        if (cid <= 0) {
            throw new Error('B 站视频没有分 P 信息');
        }
        const play = (await fetchJson(
            `${PLAYURL_URL}?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=4048&fourk=1`,
            'B 站音频流拿不到'
        )) as { code?: unknown; data?: { dash?: { audio?: unknown } } };
        if (play.code !== 0) {
            throw new Error('B 站音频流拿不到，请稍后重试');
        }
        const audioList = Array.isArray(play.data?.dash?.audio) ? play.data.dash.audio : [];
        let best: { bandwidth: number; baseUrl: string } | null = null;
        for (const raw of audioList as Array<Record<string, unknown>>) {
            const bandwidth = typeof raw.bandwidth === 'number' ? raw.bandwidth : 0;
            const baseUrl =
                typeof raw.baseUrl === 'string'
                    ? raw.baseUrl
                    : typeof raw.base_url === 'string'
                      ? raw.base_url
                      : '';
            if (baseUrl && (best === null || bandwidth > best.bandwidth)) {
                best = { bandwidth, baseUrl };
            }
        }
        if (!best) {
            throw new Error('B 站音频流拿不到，请稍后重试');
        }
        // 直链带签名参数会过期，现取现用，不缓存。
        return best.baseUrl;
    }
}

export const bilibiliSource = new BilibiliSource();
