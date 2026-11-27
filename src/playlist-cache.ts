// 歌单详情缓存（借鉴 NeriPlayer 网易云歌单详情缓存）：远程歌单
// 详情（标题＋曲目）成功加载后存 localStorage，再次打开先显缓存
// 再后台刷新，刷新失败保留缓存。键含 source:歌单id，曲目去掉
// streamUrl（签名会过期），上限 20 个歌单按最近使用淘汰。
import type { Track } from './types';

const KEY = 'zx.playlistCache.v1';
const MAX_PLAYLISTS = 20;

export interface PlaylistCacheEntry {
    title: string;
    tracks: Track[];
    savedAt: number;
}

function stripTrack(track: Track): Track {
    const { streamUrl: _streamUrl, ...rest } = track;
    return rest;
}

function loadAll(): Record<string, PlaylistCacheEntry> {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const map: Record<string, PlaylistCacheEntry> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const entry = value as Partial<PlaylistCacheEntry> | null;
            if (
                entry &&
                typeof entry.title === 'string' &&
                Array.isArray(entry.tracks) &&
                typeof entry.savedAt === 'number'
            ) {
                map[key] = {
                    title: entry.title,
                    tracks: entry.tracks as Track[],
                    savedAt: entry.savedAt
                };
            }
        }
        return map;
    } catch {
        return {};
    }
}

export function loadPlaylistCache(cacheKey: string): PlaylistCacheEntry | null {
    return loadAll()[cacheKey] ?? null;
}

export function savePlaylistCache(cacheKey: string, title: string, tracks: Track[]): void {
    try {
        const map = loadAll();
        map[cacheKey] = {
            title,
            tracks: tracks.map(stripTrack),
            savedAt: Date.now()
        };
        const keys = Object.keys(map);
        if (keys.length > MAX_PLAYLISTS) {
            keys
                .sort((a, b) => (map[a]?.savedAt ?? 0) - (map[b]?.savedAt ?? 0))
                .slice(0, keys.length - MAX_PLAYLISTS)
                .forEach((key) => {
                    delete map[key];
                });
        }
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
        // 存储满了就跳过，不影响本次打开。
    }
}
