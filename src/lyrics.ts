// 歌词（第 8 块，全新写）：LRC 解析 + 网易云公开歌词接口。
//
// 实探结论（2026-10-25 沙箱 curl，无登录、无 cookie）：
// - 网易云 GET https://music.163.com/api/song/lyric?id=<歌曲 id>&lv=-1&kv=-1&tv=-1
//   回 200 JSON，lrc.lyric 就是标准 LRC 文本（含 [00:40.66] 这类时间标签），
//   无歌词的曲返回空串或缺 lrc 字段。本模块只读 lrc.lyric，不读翻译与逐字。
// - YTM 简探：沙箱里不带 visitorData 的 player 请求回 LOGIN_REQUIRED，
//   拿不到 captionTracks，timedtext 链路在沙箱里无法证实；且 timedtext
//   本是视频字幕轨，并非音乐同步歌词，很多歌曲根本没有这条轨。
//   所以 YTM 不硬接 timedtext，播放页只显示歌名与歌手，不编歌词。
// - 本地歌曲没有歌词源，同样只显示歌名与歌手。
//
// 歌词行只展示、不做点击跳转：本模块不提供 seek 口子，播放页也不给
// 歌词行绑任何点击处理。

import { httpGet } from './native/http';
import { withSessionCookie } from './sources/netease-session';
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

export async function fetchLyrics(track: Track): Promise<LyricResult> {
    if (track.source === 'local') {
        return { lines: [], note: '本地歌曲暂无歌词，只显示歌名与歌手。' };
    }
    if (track.source === 'ytm') {
        return { lines: [], note: '该音源暂无歌词，只显示歌名与歌手。' };
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
