// 歌词（第 8 块，全新写）：LRC 解析 + 网易云公开歌词接口 + YTM 字幕轨。
//
// 实探结论（2026-10-25 沙箱 curl，无登录、无 cookie）：
// - 网易云 GET https://music.163.com/api/song/lyric?id=<歌曲 id>&lv=-1&kv=-1&tv=-1
//   回 200 JSON，lrc.lyric 就是标准 LRC 文本（含 [00:40.66] 这类时间标签），
//   无歌词的曲返回空串或缺 lrc 字段。本模块只读 lrc.lyric，不读翻译与逐字。
// - YTM（2026-10-26 起接）：取链那步的 player 返回里带
//   captions.playerCaptionsTracklistRenderer.captionTracks，取链时已由
//   ytm.ts 按 videoId 缓存，本模块不另发 player 请求。选轨偏好中文、
//   其次英文、其余随缘，同语种内优先非自动生成轨；拉 baseUrl&fmt=json3，
//   events 的 tStartMs＋segs 文本拼成歌词行。timedtext 本是视频字幕轨，
//   并非音乐同步歌词，很多歌曲根本没有这条轨——无轨、无行、拉取失败时
//   仍回说明，不编歌词。
// - 本地歌曲没有歌词源，同样只显示歌名与歌手。
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

async function fetchYtmLyrics(track: Track): Promise<LyricResult> {
    const prefix = 'ytm:';
    const noLyricNote = '该音源暂无歌词，只显示歌名与歌手。';
    if (!track.id.startsWith(prefix) || track.id.length === prefix.length) {
        return { lines: [], note: noLyricNote };
    }
    const videoId = track.id.slice(prefix.length);
    const tracks = getYtmCaptions(videoId);
    if (!tracks || tracks.length === 0) {
        return { lines: [], note: noLyricNote };
    }
    const picked = pickYtmCaptionTrack(tracks);
    if (!picked) {
        return { lines: [], note: noLyricNote };
    }
    try {
        const separator = picked.baseUrl.includes('?') ? '&' : '?';
        const response = await httpGet(`${picked.baseUrl}${separator}fmt=json3`);
        if (response.status !== 200) {
            return { lines: [], note: '歌词暂时拿不到，只显示歌名与歌手。' };
        }
        const lines = parseTimedtextJson3(response.body);
        if (lines.length === 0) {
            return { lines: [], note: '这首歌暂无歌词。' };
        }
        console.log(`[Lyrics] YTM 字幕 ${picked.languageCode} ${lines.length} 行`);
        return { lines, note: null };
    } catch {
        return { lines: [], note: '歌词暂时拿不到，只显示歌名与歌手。' };
    }
}

export async function fetchLyrics(track: Track): Promise<LyricResult> {
    if (track.source === 'local') {
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
