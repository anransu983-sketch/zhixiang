// 歌词（第 8 块，全新写）：LRC 解析 + 网易云公开歌词接口 + YTM 字幕轨。
//
// 实探结论（2026-10-25 沙箱 curl，无登录、无 cookie）：
// - 网易云 GET https://music.163.com/api/song/lyric?id=<歌曲 id>&lv=-1&kv=-1&tv=-1
//   回 200 JSON，lrc.lyric 就是标准 LRC 文本（含 [00:40.66] 这类时间标签），
//   无歌词的曲返回空串或缺 lrc 字段。本模块只读 lrc.lyric，不读翻译与逐字。
// - YTM（2026-10-26 起接）：第一顺位是取链那步 player 返回里的
//   captions.playerCaptionsTracklistRenderer.captionTracks，取链时已由
//   ytm.ts 按 videoId 缓存，本模块不另发 player 请求。选轨偏好中文、
//   其次英文、其余随缘，同语种内优先非自动生成轨；拉 baseUrl&fmt=json3，
//   events 的 tStartMs＋segs 文本拼成歌词行。第二顺位是 LRCLIB 公开词库
//   （标题＋歌手＋时长一次查到；同步词按 LRC 解析，纯文本只展示不高亮）。
//   timedtext 本是视频字幕轨，很多歌曲根本没有这条轨——两顺位都没拿到时
//   仍回说明，不编歌词。歌词只记条数与来源，从不记正文。
// - 本地歌曲（0.1.49 起接）：走 LRCLIB /search，不走 /get——/search 才能
//   按时长 ±3 秒筛掉 DJ 剪辑版、按 instrumental 过滤纯音乐；
//   命中才回词，没命中仍回原提示，不编词。命中与干净 miss 缓存 7 天，
//   网络失败不缓存。歌词只记条数与来源，从不记正文。
//
// 歌词行只展示、不做点击跳转：本模块不提供 seek 口子，播放页也不给
// 歌词行绑任何点击处理。

import { httpGet } from './native/http';
import { withSessionCookie } from './sources/netease-session';
import { getYtmCaptions } from './sources/ytm';
import type { Track } from './types';

export interface LyricLine {
    timeMs: number;
    text: string;
}

export interface LyricResult {
    lines: LyricLine[];
    // 有歌词时为 null；无歌词时是一句中文说明，播放页原样展示。
    note: string | null;
}

const LYRIC_URL = 'https://music.163.com/api/song/lyric';

const HEADERS: Record<string, string> = {
    Referer: 'https://music.163.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
};

// 解析一行 LRC：
// - [mm:ss.xx] / [mm:ss.xxx] 时间标签，一个行可带多个标签（同文本多时间点）。
// - [ti:] / [ar:] / [al:] / [by:] / [offset:] 这类元数据标签不是时间，跳过。
// - 没有时间标签的行直接跳过，不猜时间。
export function parseLrc(text: string): LyricLine[] {
    const lines: LyricLine[] = [];
    const tagPattern = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const tags: number[] = [];
        let match: RegExpExecArray | null;
        tagPattern.lastIndex = 0;
        while ((match = tagPattern.exec(line)) !== null) {
            const minutes = Number(match[1]);
            const seconds = Number(match[2]);
            const fraction = match[3] ?? '';
            const millis = fraction
                ? Number(fraction.padEnd(3, '0').slice(0, 3))
                : 0;
            tags.push((minutes * 60 + seconds) * 1000 + millis);
        }
        if (tags.length === 0) {
            continue;
        }
        const lyricText = line.replace(tagPattern, '').trim();
        if (!lyricText) {
            continue;
        }
        for (const timeMs of tags) {
            lines.push({ timeMs, text: lyricText });
        }
    }
    lines.sort((a, b) => a.timeMs - b.timeMs);
    return lines;
}

// 按播放位置找当前行：最后一行 timeMs <= positionMs 的行；
// 还没到第一行时返回 -1（播放页此时不高亮任何行）。
export function findCurrentLineIndex(lines: LyricLine[], positionMs: number): number {
    let current = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
            break;
        }
        if (line.timeMs <= positionMs) {
            current = i;
        } else {
            break;
        }
    }
    return current;
}

// YTM 字幕轨选轨：中文优先、英文其次、同语种内优先非自动生成轨。
function pickYtmCaptionTrack(
    tracks: Array<{ baseUrl: string; languageCode: string; kind?: string }>
): { baseUrl: string; languageCode: string } | null {
    let best: { baseUrl: string; languageCode: string } | null = null;
    let bestScore = -1;
    for (const track of tracks) {
        const code = track.languageCode.toLowerCase();
        let score = 1;
        if (code.startsWith('zh')) {
            score = 3;
        } else if (code.startsWith('en')) {
            score = 2;
        }
        if (track.kind !== 'asr') {
            score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = { baseUrl: track.baseUrl, languageCode: track.languageCode };
        }
    }
    return best;
}

// json3 字幕转歌词行：只要带文本的 event，起播时间即行时间；
// 连续重复文本只留一行（自动字幕常有重复断句）。
function parseTimedtextJson3(text: string): LyricLine[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    const events = (parsed as { events?: unknown } | null)?.events;
    if (!Array.isArray(events)) {
        return [];
    }
    const lines: LyricLine[] = [];
    for (const raw of events as Array<Record<string, unknown>>) {
        if (typeof raw.tStartMs !== 'number' || !Array.isArray(raw.segs)) {
            continue;
        }
        const lineText = (raw.segs as Array<Record<string, unknown>>)
            .map((seg) => (typeof seg.utf8 === 'string' ? seg.utf8 : ''))
            .join('')
            .replace(/\n/g, ' ')
            .trim();
        if (!lineText) {
            continue;
        }
        if (lines.length > 0 && lines[lines.length - 1]?.text === lineText) {
            continue;
        }
        lines.push({ timeMs: raw.tStartMs, text: lineText });
    }
    lines.sort((a, b) => a.timeMs - b.timeMs);
    return lines;
}

// YTM 标题常带视频装饰（【動態歌詞】、副标题、Official Audio 等），
// 查词库前先去掉，否则标题对不上：只去装饰，不改歌名本身。
function cleanYtmTitle(title: string): string {
    return title
        .replace(/【[^】]*】/g, '')
        .replace(/『[^』]*』/g, '')
        .replace(/\s*\((Official Audio|Official Video|Lyric Video|Audio|Video)\)\s*$/i, '')
        .trim();
}

// LRCLIB（免费公开词库，无需登录）：标题＋歌手＋时长（有才带）一次查到。
// 同步词是标准 LRC，直接解析；只有纯文本时行时间记 Infinity——
// 播放页只展示不高亮，绝不编造时间轴。无匹配／失败回 null，调用方回原提示。
async function fetchLrclibLyrics(track: Track): Promise<LyricResult | null> {
    const params = new URLSearchParams({
        artist_name: track.artist,
        track_name: cleanYtmTitle(track.title)
    });
    if (track.durationMs && track.durationMs > 0) {
        params.set('duration', String(Math.round(track.durationMs / 1000)));
    }
    let response;
    try {
        response = await httpGet(`https://lrclib.net/api/get?${params.toString()}`);
    } catch {
        return null;
    }
    if (response.status !== 200) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        return null;
    }
    const data = parsed as { syncedLyrics?: unknown; plainLyrics?: unknown };
    if (typeof data.syncedLyrics === 'string' && data.syncedLyrics.trim()) {
        const lines = parseLrc(data.syncedLyrics);
        if (lines.length > 0) {
            console.log(`[Lyrics] LRCLIB 同步词 ${lines.length} 行`);
            return { lines, note: null };
        }
    }
    if (typeof data.plainLyrics === 'string' && data.plainLyrics.trim()) {
        const lines = data.plainLyrics
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((text) => ({ timeMs: Number.POSITIVE_INFINITY, text }));
        if (lines.length > 0) {
            console.log(`[Lyrics] LRCLIB 纯文本 ${lines.length} 行`);
            return { lines, note: null };
        }
    }
    return null;
}

async function fetchYtmLyrics(track: Track): Promise<LyricResult> {
    const prefix = 'ytm:';
    const noLyricNote = '该音源暂无歌词，只显示歌名与歌手。';
    if (!track.id.startsWith(prefix) || track.id.length === prefix.length) {
        return { lines: [], note: noLyricNote };
    }
    // 第一顺位：视频自带的字幕轨（最准，无需另查）。
    const videoId = track.id.slice(prefix.length);
    const tracks = getYtmCaptions(videoId);
    const picked = tracks && tracks.length > 0 ? pickYtmCaptionTrack(tracks) : null;
    if (picked) {
        try {
            const separator = picked.baseUrl.includes('?') ? '&' : '?';
            const response = await httpGet(`${picked.baseUrl}${separator}fmt=json3`);
            if (response.status === 200) {
                const lines = parseTimedtextJson3(response.body);
                if (lines.length > 0) {
                    console.log(`[Lyrics] YTM 字幕 ${picked.languageCode} ${lines.length} 行`);
                    return { lines, note: null };
                }
            }
        } catch {
            // 字幕拉取失败就往下走词库，不把一次失败当成没词。
        }
    }
    // 第二顺位：LRCLIB（标题＋歌手＋时长）。都没拿到才回原提示，不编词。
    const lrclib = await fetchLrclibLyrics(track);
    if (lrclib) {
        return lrclib;
    }
    return { lines: [], note: noLyricNote };
}

// 本地标题常带 DJ/抖音装饰（(DJ版)、_-_抖音…），查词库前先去掉，
// 只去装饰，不改歌名本身。
function cleanLocalTitle(title: string): string {
    return title
        .replace(/\s*[（(][^）)]*(DJ|抖音|Remix|REMIX)[^）)]*[）)]/g, '')
        .replace(/\s*[-_]+抖音.*$/u, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// 本地 LRCLIB 缓存：命中与干净 miss 都存，7 天过期，最多 200 条；
// 纯文本行的时间记 Infinity，JSON 存不下 Infinity，所以分 kind 存：
// synced 存 texts + times，plain 只存 texts，恢复时再拼 Infinity。
interface LocalLyricCacheEntry {
    at: number;
    kind: 'synced' | 'plain' | 'miss';
    texts?: string[];
    times?: number[];
}

const LOCAL_LYRIC_CACHE_KEY = 'zx_lrclib_local_v1';
const LOCAL_LYRIC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_LYRIC_CACHE_MAX = 200;

function loadLocalLyricCache(): Record<string, LocalLyricCacheEntry> {
    try {
        const raw = localStorage.getItem(LOCAL_LYRIC_CACHE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, LocalLyricCacheEntry>;
        }
    } catch {
        // 存档损坏时当空缓存。
    }
    return {};
}

function saveLocalLyricCache(cache: Record<string, LocalLyricCacheEntry>): void {
    try {
        const keys = Object.keys(cache);
        if (keys.length > LOCAL_LYRIC_CACHE_MAX) {
            // 按写入时间踢掉最旧的，只留 200 条。
            keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0));
            for (const key of keys.slice(0, keys.length - LOCAL_LYRIC_CACHE_MAX)) {
                delete cache[key];
            }
        }
        localStorage.setItem(LOCAL_LYRIC_CACHE_KEY, JSON.stringify(cache));
    } catch {
        // 写不进就当次有效。
    }
}

async function fetchLocalLyrics(track: Track): Promise<LyricResult | null> {
    const title = cleanLocalTitle(track.title);
    if (!title) {
        return null;
    }
    // 未知歌手：本地源默认填“未知歌手”，MediaStore 有时给 <unknown>，
    // 两个都当空歌手，只按标题查。
    const artist =
        track.artist === '未知歌手' || track.artist === '<unknown>' ? '' : track.artist;
    const durationSec =
        track.durationMs && track.durationMs > 0 ? Math.round(track.durationMs / 1000) : null;
    const key = `${artist}|${title}|${durationSec ?? ''}`;
    const cache = loadLocalLyricCache();
    const cached = cache[key];
    if (cached && Date.now() - cached.at < LOCAL_LYRIC_CACHE_TTL_MS) {
        if (cached.kind === 'miss') {
            return null;
        }
        const texts = cached.texts ?? [];
        if (texts.length === 0) {
            return null;
        }
        if (cached.kind === 'plain') {
            return {
                lines: texts.map((text) => ({ timeMs: Number.POSITIVE_INFINITY, text })),
                note: null
            };
        }
        const times = cached.times ?? [];
        const lines = texts
            .map((text, i) => ({ timeMs: times[i] ?? 0, text }))
            .filter((line) => line.text.length > 0);
        return lines.length > 0 ? { lines, note: null } : null;
    }
    const params = new URLSearchParams();
    if (artist) {
        params.set('track_name', title);
        params.set('artist_name', artist);
    } else {
        params.set('q', title);
    }
    let response;
    try {
        response = await httpGet(`https://lrclib.net/api/search?${params.toString()}`);
    } catch {
        // 网络失败不缓存，下次重查。
        return null;
    }
    if (response.status !== 200) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) {
        return null;
    }
    // 匹配：先滤纯音乐，再按时长 ±3 秒筛（DJ 剪辑版长度对不上，
    // 直接 miss 是对的——错时同步词比没词更糟）；无时长时取首个非纯音乐结果。
    let best: Record<string, unknown> | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const raw of parsed as Array<Record<string, unknown>>) {
        if (raw.instrumental === true) {
            continue;
        }
        const duration = typeof raw.duration === 'number' ? raw.duration : null;
        const diff =
            durationSec !== null && duration !== null ? Math.abs(duration - durationSec) : 0;
        if (durationSec !== null && duration !== null && diff > 3) {
            continue;
        }
        if (diff < bestDiff) {
            bestDiff = diff;
            best = raw;
        }
    }
    if (!best) {
        cache[key] = { at: Date.now(), kind: 'miss' };
        saveLocalLyricCache(cache);
        return null;
    }
    const synced = typeof best.syncedLyrics === 'string' ? best.syncedLyrics : '';
    if (synced.trim()) {
        const lines = parseLrc(synced);
        if (lines.length > 0) {
            console.log(`[Lyrics] 本地 LRCLIB 同步词 ${lines.length} 行`);
            cache[key] = {
                at: Date.now(),
                kind: 'synced',
                texts: lines.map((line) => line.text),
                times: lines.map((line) => line.timeMs)
            };
            saveLocalLyricCache(cache);
            return { lines, note: null };
        }
    }
    const plain = typeof best.plainLyrics === 'string' ? best.plainLyrics : '';
    if (plain.trim()) {
        const texts = plain
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        if (texts.length > 0) {
            console.log(`[Lyrics] 本地 LRCLIB 纯文本 ${texts.length} 行`);
            cache[key] = { at: Date.now(), kind: 'plain', texts };
            saveLocalLyricCache(cache);
            return {
                lines: texts.map((text) => ({ timeMs: Number.POSITIVE_INFINITY, text })),
                note: null
            };
        }
    }
    cache[key] = { at: Date.now(), kind: 'miss' };
    saveLocalLyricCache(cache);
    return null;
}

export async function fetchLyrics(track: Track): Promise<LyricResult> {
    if (track.source === 'local') {
        const local = await fetchLocalLyrics(track);
        if (local) {
            return local;
        }
        return { lines: [], note: '本地歌曲暂无歌词，只显示歌名与歌手。' };
    }
    if (track.source === 'ytm') {
        return fetchYtmLyrics(track);
    }
    const prefix = 'netease:';
    if (!track.id.startsWith(prefix) || track.id.length === prefix.length) {
        return { lines: [], note: '这首歌暂无歌词。' };
    }
    const songId = track.id.slice(prefix.length);
    try {
        const params = new URLSearchParams({
            id: songId,
            lv: '-1',
            kv: '-1',
            tv: '-1'
        });
        const response = await httpGet(`${LYRIC_URL}?${params.toString()}`, withSessionCookie(HEADERS));
        if (response.status !== 200) {
            return { lines: [], note: '歌词暂时拿不到，只显示歌名与歌手。' };
        }
        const parsed = JSON.parse(response.body) as {
            lrc?: { lyric?: unknown } | null;
        };
        const lyricText = parsed.lrc?.lyric;
        if (typeof lyricText !== 'string' || !lyricText.trim()) {
            return { lines: [], note: '这首歌暂无歌词。' };
        }
        const lines = parseLrc(lyricText);
        if (lines.length === 0) {
            return { lines: [], note: '这首歌暂无歌词。' };
        }
        return { lines, note: null };
    } catch {
        return { lines: [], note: '歌词暂时拿不到，只显示歌名与歌手。' };
    }
}
