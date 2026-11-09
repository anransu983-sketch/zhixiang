// B 站音源（0.1.104，v1：免登录搜索＋播放，不接登录体系与收藏夹同步）：
// B 站音乐就是视频音轨：WBI 签名搜视频 → pagelist 取 cid → playurl 取 DASH 音频。
// 全流程实测（2026-10-29 沙箱 curl＋本机 Python 复验 WBI 表与签名）：
// nav 未登录照样给 wbi_img（code=-101 预期内）；WBI 搜索 code=0 回 20 条；
// pagelist 单 P 一项；playurl fnval=4048 只回 DASH，audio 最高码率约 320kbps；
// Range 0-1023 回 206。实测到的坑都已处理：标题含 <em class="keyword"> 高亮
// 标签须剥掉；封面是协议相对 URL 须补 https:；搜索时长是 "M:SS" 字符串，
// pagelist 时长是秒数；音频直链带签名参数会过期，只在内存里短缓存
// 10 分钟供拆歌连播共用（见 resolveStream 旁的 streamUrlCache）；
// 实际 Content-Type 是 video/mp4，不要拿它做音频校验。
// 播放层：安卓远程流一律走本机代理（playback.ts），本模块只出直链；
// 歌词：v1 不接 B 站字幕轨，lyrics.ts 里复用本地那套联网补源。

import { httpGet } from '../native/http';
import { md5Hex } from './netease-eapi';
import type { AudioSource, Track } from '../types';
import type { LyricLine } from '../lyrics';

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const PAGELIST_URL = 'https://api.bilibili.com/x/player/pagelist';
const PLAYURL_URL = 'https://api.bilibili.com/x/player/playurl';
const PLAYER_V2_URL = 'https://api.bilibili.com/x/player/wbi/v2';

// B 站接口要浏览器 UA＋Referer，否则容易被风控拦；无 cookie、无登录态。
// 0.1.124：这串 UA 同时是播放铸链 UA（playback.ts 交给本机代理复用）——
// B 站音频 CDN（upos）现在双查 Referer＋UA 平台：Referer 缺失或 UA 是
// 安卓（WebView／Android Chrome 均同罪）都回 403＋548 字节错误页，桌面
// Chrome UA＋Referer 才回 206（2026-10-31 沙箱两首歌多组合实测钉死）。
export const BILIBILI_MINT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BILI_HEADERS: Record<string, string> = {
    'User-Agent': BILIBILI_MINT_UA,
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
    if (url.startsWith('http://')) {
        // 榜单封面是 http:// 直链：WebView 页是 https 源，http 图会被混杂内容拦，
        // B 站 CDN 本就支持 https，直接升级（搜索封面是 // 相对，本来就走 https）。
        return `https:${url.slice('http:'.length)}`;
    }
    return url.startsWith('https://') ? url : undefined;
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

// 分 P cid：取链与字幕共用，v1 只用第一 P。
async function getCid(bvid: string): Promise<number> {
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
    return cid;
}

// B 站 CC 字幕轨当歌词（0.1.105，思路借鉴 NeriPlayer 的 B 站字幕歌词）：
// wbi/v2 拿字幕轨列表，优先中文轨，否则第一条；拉字幕 JSON 的 body
//（from 秒＋content）拼成歌词行。实测提醒：2026-10-29 连查 9 个视频
//（含周杰伦官方 MV）字幕轨全是空的——音乐视频多无轨，所以本函数无轨
// 时回 null，调用方回落联网补源，不硬编。字幕 JSON 本身未实测到真轨，
// 字段按 B 站公开字幕格式（body[].from/to/content）解析、异常项跳过，
// 真机以带字幕轨的视频验为准。
export async function getBilibiliSubtitleLines(track: Track): Promise<LyricLine[] | null> {
    const bvid = track.id.startsWith('bilibili:')
        ? track.id.slice('bilibili:'.length)
        : track.id;
    if (!bvid) {
        return null;
    }
    let cid: number;
    try {
        cid = await getCid(bvid);
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        const wts = Math.floor(Date.now() / 1000).toString();
        const { qs, wRid } = signQuery({ bvid, cid: String(cid), wts }, await getMixinKey());
        const res = await httpGet(`${PLAYER_V2_URL}?${qs}&w_rid=${wRid}`, BILI_HEADERS);
        if (res.status !== 200) {
            return null;
        }
        parsed = JSON.parse(res.body) as unknown;
    } catch {
        return null;
    }
    const subs = (parsed as { data?: { subtitle?: { subtitles?: unknown } } })
        .data?.subtitle?.subtitles;
    if (!Array.isArray(subs) || subs.length === 0) {
        return null;
    }
    const tracks = subs as Array<Record<string, unknown>>;
    const picked =
        tracks.find(
            (item) => typeof item.lan === 'string' && item.lan.toLowerCase().includes('zh')
        ) ?? tracks[0];
    if (!picked) {
        return null;
    }
    const url = toHttps(picked.subtitle_url);
    if (!url) {
        return null;
    }
    let body: unknown;
    try {
        const res = await httpGet(url, BILI_HEADERS);
        if (res.status !== 200) {
            return null;
        }
        body = JSON.parse(res.body) as unknown;
    } catch {
        return null;
    }
    const items = (body as { body?: unknown }).body;
    if (!Array.isArray(items)) {
        return null;
    }
    const lines: LyricLine[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
        const from = typeof raw.from === 'number' ? raw.from : NaN;
        const content = typeof raw.content === 'string' ? raw.content.trim() : '';
        if (!Number.isFinite(from) || !content) {
            continue;
        }
        lines.push({ timeMs: Math.round(from * 1000), text: content });
    }
    return lines.length > 0 ? lines : null;
}

// 搜索实现抽出来：榜单里原创/翻唱两区 ranking/v2 回 -400（分区 rid 不吃），
// 回落走搜索（BiliTune 同款回落路子；tid 参数实测对结果无影响，不加）。
async function searchBilibiliVideos(keyword: string): Promise<Track[]> {
    const trimmed = keyword.trim();
    if (!trimmed) {
        return [];
    }
    let parsed = await searchWithMixin(trimmed, await getMixinKey());
    if (parsed.code !== 0) {
        // 签名素材过期是常见原因：清掉重取一次再试，还失败才报错。
        parsed = await searchWithMixin(trimmed, await getMixinKey(true));
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

const RANKING_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2';

// 榜单分区（0.1.105 发现页，rid 取自 BiliTune 源码的 zone 表，与截图四栏一致）：
// 全站音乐榜 1003、音乐区总榜 3 是 ranking/v2 直出；原创 28、翻唱 31
// 在 ranking/v2 上回 -400，走搜索回落（关键词即栏名）。
export interface BiliChartZone {
    key: string;
    label: string;
    rid: number | null;
    searchKeyword: string | null;
}

export const BILI_CHART_ZONES: BiliChartZone[] = [
    { key: 'all', label: '全站音乐榜', rid: 1003, searchKeyword: null },
    { key: 'region', label: '音乐区总榜', rid: 3, searchKeyword: null },
    { key: 'original', label: '原创音乐', rid: null, searchKeyword: '原创音乐' },
    { key: 'cover', label: '翻唱', rid: null, searchKeyword: '翻唱' }
];

export async function fetchBilibiliChart(zone: BiliChartZone): Promise<Track[]> {
    if (zone.searchKeyword) {
        return searchBilibiliVideos(zone.searchKeyword);
    }
    if (zone.rid === null) {
        return [];
    }
    const parsed = (await fetchJson(
        `${RANKING_URL}?rid=${zone.rid}&type=all`,
        'B 站榜单加载失败'
    )) as { code?: unknown; message?: unknown; data?: { list?: unknown } };
    if (parsed.code !== 0) {
        const detail =
            typeof parsed.message === 'string' && parsed.message
                ? parsed.message
                : `code ${String(parsed.code)}`;
        throw new Error(`B 站榜单加载失败（${detail}）`);
    }
    const items = Array.isArray(parsed.data?.list) ? parsed.data.list : [];
    const tracks: Track[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
        const bvid = typeof raw.bvid === 'string' ? raw.bvid : '';
        const title = typeof raw.title === 'string' ? stripEmTags(raw.title) : '';
        if (!bvid || !title) {
            continue;
        }
        const owner = raw.owner as { name?: unknown } | undefined;
        const artist =
            owner && typeof owner.name === 'string' && owner.name ? owner.name : '未知歌手';
        tracks.push({
            id: `bilibili:${bvid}`,
            title,
            artist,
            durationMs:
                typeof raw.duration === 'number' && raw.duration > 0
                    ? raw.duration * 1000
                    : undefined,
            coverUrl: toHttps(raw.pic),
            source: 'bilibili'
        });
    }
    return tracks;
}

// ---- 歌单视频与简介拆歌 ----
// B 站有一类「歌单视频」：单个长视频装十几首歌，简介里按行写时间戳
// 歌单（如 BV1pyp761E5e，39:45，简介带 0:00 Everyday 起全套）。
// 本节做：搜这类长视频、双源拿分段（简介时间戳＋官方章节，合并规则
// 见 mergeBiliSegmentSources）、把简介解析成分段表。

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';
// 章节源走 player/v2 非 WBI 版（与上面字幕用的 wbi/v2 不是一个端点）。
const PLAYER_V2_WEB_URL = 'https://api.bilibili.com/x/player/v2';
const PLAYLIST_SEARCH_KEYWORDS = ['Playlist 歌单', '歌单'];
const PLAYLIST_MIN_DURATION_MS = 10 * 60 * 1000;
const PLAYLIST_LIMIT = 30;

// 歌单视频列表：两个关键词各搜一次，合并按 bvid 去重，只留 10 分钟
// 以上的长视频（短视频装不下歌单），保搜索原序，上限 30 条。
export async function fetchBilibiliPlaylistVideos(): Promise<Track[]> {
    const seen = new Set<string>();
    const merged: Track[] = [];
    for (const keyword of PLAYLIST_SEARCH_KEYWORDS) {
        const tracks = await searchBilibiliVideos(keyword);
        for (const track of tracks) {
            if (seen.has(track.id)) {
                continue;
            }
            seen.add(track.id);
            if ((track.durationMs ?? 0) < PLAYLIST_MIN_DURATION_MS) {
                continue;
            }
            merged.push(track);
            if (merged.length >= PLAYLIST_LIMIT) {
                return merged;
            }
        }
    }
    return merged;
}

// ---- buvid 指纹 ----
// view 接口裸打会被风控拦（412）：缺 buvid 指纹 cookie。先打官方
// finger/spi 拿 b_3/b_4、拼成 buvid3/buvid4 带上才放行（2026-11-09
// 沙箱实测：机房 IP 裸打 412、带 buvid 后 200/code 0、简介原文到手；
// 沙箱是机房 IP、风控比手机住宅网络更狠，沙箱能通手机基本能通）。
// 指纹只在内存里缓存一份；失败不缓存，下次调用重试；并发去重仿
// mixin 缓存的在途写法。拿不到回 null，调用方照旧裸打降级。
let cachedBuvid: string | null = null;
let buvidInFlight: Promise<string | null> | null = null;

async function getBuvidCookie(): Promise<string | null> {
    if (cachedBuvid) {
        return cachedBuvid;
    }
    if (buvidInFlight) {
        return buvidInFlight;
    }
    buvidInFlight = (async (): Promise<string | null> => {
        try {
            const res = await httpGet(SPI_URL, BILI_HEADERS);
            if (res.status !== 200) {
                console.log(`[Bili] buvid 指纹拿不到（HTTP ${res.status}）`);
                return null;
            }
            const parsed = JSON.parse(res.body) as {
                code?: unknown;
                data?: { b_3?: unknown; b_4?: unknown };
            };
            const b3 = typeof parsed.data?.b_3 === 'string' ? parsed.data.b_3 : '';
            const b4 = typeof parsed.data?.b_4 === 'string' ? parsed.data.b_4 : '';
            if (parsed.code !== 0 || !b3 || !b4) {
                console.log(`[Bili] buvid 指纹拿不到（code ${String(parsed.code)}）`);
                return null;
            }
            cachedBuvid = `buvid3=${b3}; buvid4=${b4}`;
            return cachedBuvid;
        } catch {
            console.log('[Bili] buvid 指纹拿不到（网络异常）');
            return null;
        } finally {
            buvidInFlight = null;
        }
    })();
    return buvidInFlight;
}

// 视频简介原文：拆歌的原料之一。view 要带 buvid 指纹才放行（见上）；
// 已登录时调用方把 bilibili-session 的会话 cookie 传进来，与指纹
// 合并成一条 Cookie 头（拆两个头会互相覆盖）。bilibili.ts 不直接引
// bilibili-session（那边反向引了本文件，会成循环），故走入参。
// 拿不到一律回 null 让详情页降级（还有章节源兜底）——拆歌是增值，
// 绝不因它抛错、更不能让详情页打不开；失败原因记一行 [Bili] 日志
//（只记状态/code，不记简介原文）。
export async function fetchBilibiliVideoDesc(
    bvid: string,
    sessionCookie?: string
): Promise<string | null> {
    const buvid = await getBuvidCookie();
    const cookieParts = [buvid, sessionCookie].filter(
        (part): part is string => typeof part === 'string' && part.length > 0
    );
    const headers =
        cookieParts.length > 0
            ? { ...BILI_HEADERS, Cookie: cookieParts.join('; ') }
            : BILI_HEADERS;
    let res: Awaited<ReturnType<typeof httpGet>>;
    try {
        res = await httpGet(`${VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, headers);
    } catch {
        console.log(`[Bili] 简介拿不到 ${bvid}（网络异常）`);
        return null;
    }
    if (res.status !== 200) {
        console.log(`[Bili] 简介拿不到 ${bvid}（HTTP ${res.status}）`);
        return null;
    }
    let parsed: { code?: unknown; data?: { desc?: unknown } };
    try {
        parsed = JSON.parse(res.body) as { code?: unknown; data?: { desc?: unknown } };
    } catch {
        console.log(`[Bili] 简介拿不到 ${bvid}（响应解析失败）`);
        return null;
    }
    if (parsed.code !== 0) {
        console.log(`[Bili] 简介拿不到 ${bvid}（code ${String(parsed.code)}）`);
        return null;
    }
    if (typeof parsed.data?.desc !== 'string') {
        console.log(`[Bili] 简介拿不到 ${bvid}（响应无 desc 字段）`);
        return null;
    }
    return parsed.data.desc;
}

// 视频总时长（秒）：拆歌算最后一段的终点用，取 pagelist 第一 P 的
// duration（单 P 歌单视频即全长）。拿不到回 null，调用方用搜索结果
// 自带的 durationMs 兜底。
export async function fetchBilibiliVideoDurationSec(bvid: string): Promise<number | null> {
    try {
        const pages = (await fetchJson(
            `${PAGELIST_URL}?bvid=${encodeURIComponent(bvid)}&jsonp=jsonp`,
            'B 站分 P 信息拿不到'
        )) as { code?: unknown; data?: unknown };
        if (pages.code !== 0 || !Array.isArray(pages.data) || pages.data.length === 0) {
            return null;
        }
        const duration = (pages.data[0] as { duration?: unknown }).duration;
        return typeof duration === 'number' && duration > 0 ? duration : null;
    } catch {
        return null;
    }
}

export interface BiliDescSegment {
    startSec: number;
    title: string;
}

// 行首时间戳：m:ss 或 h:mm:ss（先三段后两段由正则回溯处理），
// 时间戳与标题之间可有空格或一个分隔符（- — | · 等）。
const SEGMENT_LINE_PATTERN =
    /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})\s*(?:[-—–|·:：、]\s*)?(.+)$/;

const SEGMENT_MIN_COUNT = 3;
const SEGMENT_FIRST_MAX_START_SEC = 15;
const SEGMENT_MIN_GAP_SEC = 20;

// 把简介里的时间戳歌单解析成分段表。口径是宁缺毋滥：解析不可信就
// 整体回空数组，详情页降级整条播。逐条规则：
// - 逐行只认行首时间戳；标题 trim 后须含文字（纯数字/纯标点丢弃）；
// - 总时长已知（>0）时，起点已越过总时长的行丢弃，尾段校验才启用；
// - 第一条起点须 ≤15 秒（歌单从视频开头起算，偏了说明不是歌单）；
// - 起点不严格递增、或与上一条间隔 <20 秒的，丢后一条（多半是重复
//   标注或章节误写）；丢完不足 3 条整体作废；
// - 最后一条到总时长的尾段 <20 秒时丢最后一条（短尾巴多半是片尾），
//   丢完不足 3 条同样整体作废。
// 验过样例：BV1pyp761E5e 简介 12 行（0:00 Everyday、3:48 I Really
// Want to Stay at Your House、7:53 Wind、10:57 Self Love x Last Year、
// 13:36 7 Years、15:25 What Do You Mean?、18:47 Hours、20:45 it's 6pm
// but I miss u already.、24:03 Young、27:46 Sorry、31:35 Little
// Stranger、35:58 every-little-part），总长 2385 秒，恰好出 12 条。
export function parseBiliDescSegments(desc: string, totalDurationSec: number): BiliDescSegment[] {
    const total =
        Number.isFinite(totalDurationSec) && totalDurationSec > 0
            ? Math.floor(totalDurationSec)
            : 0;
    const candidates: BiliDescSegment[] = [];
    for (const line of desc.split(/\r?\n/)) {
        const match = SEGMENT_LINE_PATTERN.exec(line);
        if (!match) {
            continue;
        }
        const hours = match[1] ? Number(match[1]) : 0;
        const startSec = hours * 3600 + Number(match[2]) * 60 + Number(match[3]);
        const title = (match[4] ?? '').trim();
        if (!title || !/\p{L}/u.test(title)) {
            continue;
        }
        if (total > 0 && startSec >= total) {
            continue;
        }
        candidates.push({ startSec, title });
    }
    if (candidates.length < SEGMENT_MIN_COUNT) {
        return [];
    }
    if (candidates[0]!.startSec > SEGMENT_FIRST_MAX_START_SEC) {
        return [];
    }
    const segments: BiliDescSegment[] = [];
    for (const candidate of candidates) {
        const last = segments[segments.length - 1];
        // 不递增（差 ≤0）与间隔过小同处理：丢后一条。
        if (last && candidate.startSec - last.startSec < SEGMENT_MIN_GAP_SEC) {
            continue;
        }
        segments.push(candidate);
    }
    if (total > 0) {
        while (
            segments.length > 0 &&
            total - segments[segments.length - 1]!.startSec < SEGMENT_MIN_GAP_SEC
        ) {
            segments.pop();
        }
    }
    return segments.length >= SEGMENT_MIN_COUNT ? segments : [];
}

export interface BiliChapterSegment {
    startSec: number;
    endSec: number;
    title: string;
}

// 官方章节：拆歌的第二数据源（结构化，比简介时间戳稳）。player/v2
// 的 data.view_points 里 type===2 的条目就是 UP 主标的章节
// {from,to,content}，自带段尾（2026-11-09 沙箱实测 BV1pyp761E5e
// 回 10 条）。两源互补：章节稳但 UP 主可能把多首打包成一条（该例
// 最后一条「剩下三首宝藏！！！」1666→2384 包了简介里的最后三首），
// 简介则常有全量歌单。取舍在 mergeBiliSegmentSources。
// 任何失败/不足 3 条回空数组，不抛错。
export async function fetchBilibiliChapters(bvid: string): Promise<BiliChapterSegment[]> {
    try {
        const cid = await getCid(bvid);
        const parsed = (await fetchJson(
            `${PLAYER_V2_WEB_URL}?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
            'B 站章节拿不到'
        )) as { code?: unknown; data?: { view_points?: unknown } };
        if (parsed.code !== 0) {
            return [];
        }
        const points = Array.isArray(parsed.data?.view_points) ? parsed.data.view_points : [];
        const chapters: BiliChapterSegment[] = [];
        for (const raw of points as Array<Record<string, unknown>>) {
            if (raw.type !== 2) {
                continue;
            }
            const from = typeof raw.from === 'number' ? raw.from : NaN;
            const to = typeof raw.to === 'number' ? raw.to : NaN;
            const title = typeof raw.content === 'string' ? raw.content.trim() : '';
            if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !title) {
                continue;
            }
            chapters.push({ startSec: from, endSec: to, title });
        }
        chapters.sort((a, b) => a.startSec - b.startSec);
        return chapters.length >= SEGMENT_MIN_COUNT ? chapters : [];
    } catch {
        return [];
    }
}

// 详情页统一的分段表示：endSec 有值优先用（章节自带），没有时调用方
// 按「下一条 start／总时长」推（简介源）。
export interface BiliSegment {
    startSec: number;
    endSec?: number;
    title: string;
}

// 双源合并（纯函数）：两边都达标时谁条数多用谁——简介赢才用简介；
// 条数持平或章节更多用章节（自带段尾更准）；只剩一边用那一边；
// 两边都空回空数组。入参各自已保证 ≥3 条或为空（解析器/章节函数
// 内部口径），这里不重复过滤。
export function mergeBiliSegmentSources(
    descSegs: BiliDescSegment[],
    chapters: BiliChapterSegment[]
): BiliSegment[] {
    if (chapters.length > 0 && descSegs.length <= chapters.length) {
        return chapters;
    }
    if (descSegs.length > 0) {
        return descSegs;
    }
    return chapters;
}

// 取链内存缓存：直链带签名参数会过期，只短缓存 10 分钟——同一视频
// 的各分段连播、以及整条重播都不再每首重走 pagelist+playurl；
// 失败不入缓存，下次照旧现取现用。只放本模块，不动播放层的取链路。
const STREAM_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const streamUrlCache = new Map<string, { url: string; fetchedAt: number }>();

class BilibiliSource implements AudioSource {
    readonly id = 'bilibili' as const;
    readonly label = 'B站';

    async search(query: string): Promise<Track[]> {
        return searchBilibiliVideos(query);
    }

    async resolveStream(track: Track): Promise<string> {
        // 分段曲 id 形如 bilibili:<bvid>@<startSec>：取 @ 之前的真 bvid。
        const rawId = track.id.startsWith('bilibili:')
            ? track.id.slice('bilibili:'.length)
            : track.id;
        const bvid = rawId.split('@')[0] ?? '';
        if (!bvid) {
            throw new Error('B 站视频号不对，请重新搜索再试');
        }
        const cached = streamUrlCache.get(bvid);
        if (cached && Date.now() - cached.fetchedAt < STREAM_URL_CACHE_TTL_MS) {
            return cached.url;
        }
        const cid = await getCid(bvid);
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
        // 只缓存成功的取链结果（短 TTL，见 streamUrlCache 注释）。
        streamUrlCache.set(bvid, { url: best.baseUrl, fetchedAt: Date.now() });
        return best.baseUrl;
    }
}

export const bilibiliSource = new BilibiliSource();
