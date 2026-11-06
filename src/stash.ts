// 速记簿（0.1.132，参考范围外同类播放器的速记簿口径全新写）：
// 歌曲的暂存区。看到想收的歌先随手收进来，之后再按来源分组整组
// 播、整组加进歌单或整组加进队列，不必当场决定放哪个歌单。
//
// 存储口径与自建歌单（playlists.ts）一致：存整条 Track 记录，
// 流地址（streamUrl）绝不进库，播放时现取现用；去重用 playlists.ts
// 的 trackKey（同源同 id 才算同一首）。删除只删芷湘这里的记录，
// 歌本身不动。

import { trackKey } from './playlists';
import type { SourceId, Track } from './types';

export { trackKey };

const STORAGE_KEY = 'zx.stash.v1';

export const SOURCE_LABELS: Record<SourceId, string> = {
    local: '本地',
    netease: '网易云',
    ytm: 'YTM',
    bilibili: 'B站'
};

export function sourceLabel(source: SourceId): string {
    return SOURCE_LABELS[source] ?? source;
}

/** 来源分组的固定展示顺序。 */
export const SOURCE_ORDER: SourceId[] = ['local', 'netease', 'ytm', 'bilibili'];

function cleanTrack(raw: unknown): Track | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const item = raw as Record<string, unknown>;
    if (
        typeof item.id !== 'string' ||
        typeof item.title !== 'string' ||
        typeof item.artist !== 'string' ||
        typeof item.source !== 'string'
    ) {
        return null;
    }
    const track: Track = {
        id: item.id,
        title: item.title,
        artist: item.artist,
        source: item.source as Track['source']
    };
    if (typeof item.album === 'string') {
        track.album = item.album;
    }
    if (typeof item.durationMs === 'number') {
        track.durationMs = item.durationMs;
    }
    if (typeof item.coverUrl === 'string') {
        track.coverUrl = item.coverUrl;
    }
    if (typeof item.format === 'string') {
        track.format = item.format;
    }
    return track;
}

export function loadStash(): Track[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const tracks: Track[] = [];
        const seen = new Set<string>();
        for (const rawTrack of parsed) {
            const track = cleanTrack(rawTrack);
            if (!track) {
                continue;
            }
            const key = trackKey(track);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            tracks.push(track);
        }
        return tracks;
    } catch {
        return [];
    }
}

export function saveStash(tracks: Track[]): void {
    try {
        const cleaned = tracks
            .map((track) => cleanTrack({ ...track, streamUrl: undefined }))
            .filter((track): track is Track => track !== null);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    } catch {
        // 存储不可用时只影响下次打开的默认值，不中断当前操作。
    }
}

/** 返回 added（已加入）／exists（已在速记簿里）。 */
export function addToStash(track: Track): 'added' | 'exists' {
    const tracks = loadStash();
    const key = trackKey(track);
    if (tracks.some((item) => trackKey(item) === key)) {
        return 'exists';
    }
    const cleaned = cleanTrack({ ...track, streamUrl: undefined });
    if (!cleaned) {
        return 'exists';
    }
    tracks.push(cleaned);
    saveStash(tracks);
    return 'added';
}

export function removeFromStash(key: string): boolean {
    const tracks = loadStash();
    const next = tracks.filter((item) => trackKey(item) !== key);
    if (next.length === tracks.length) {
        return false;
    }
    saveStash(next);
    return true;
}

export function clearStash(): void {
    saveStash([]);
}

export function isInStash(track: Track): boolean {
    const key = trackKey(track);
    return loadStash().some((item) => trackKey(item) === key);
}

/** 按来源分组：只回有歌的组，组序按 SOURCE_ORDER，组内保持收录顺序。 */
export function groupStashBySource(tracks: Track[]): Array<{ source: SourceId; tracks: Track[] }> {
    const groups: Array<{ source: SourceId; tracks: Track[] }> = [];
    for (const source of SOURCE_ORDER) {
        const groupTracks = tracks.filter((track) => track.source === source);
        if (groupTracks.length > 0) {
            groups.push({ source, tracks: groupTracks });
        }
    }
    // 万一出现顺序表外的来源（旧存档），也别丢，附在末尾。
    for (const track of tracks) {
        if (!SOURCE_ORDER.includes(track.source)) {
            let group = groups.find((item) => item.source === track.source);
            if (!group) {
                group = { source: track.source, tracks: [] };
                groups.push(group);
            }
            group.tracks.push(track);
        }
    }
    return groups;
}
