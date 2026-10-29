// 自建歌单（0.1.109）：用户自己建的歌单，跨源都能放。
//
// 与私藏不同：私藏只存本地 MediaStore id；歌单存整条 Track 记录
// （标题／歌手／封面／来源／id），点歌单即按原顺序播。播放时取链
// 现取现用，流地址（streamUrl）绝不进库，过期地址不会被存下来。
// 删除歌单、从歌单里删歌，都只删芷湘这里的记录，歌本身不动。

import type { Track } from './types';

export interface Playlist {
    id: string;
    name: string;
    createdAt: number;
    tracks: Track[];
}

const STORAGE_KEY = 'zx.playlists.v1';

/** 跨源去重键：同源同 id 才算同一首（网易云 id 与本地 id 可能撞号）。 */
export function trackKey(track: Track): string {
    return `${track.source}:${track.id}`;
}

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
        source: item.source as Track['source'],
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

export function loadPlaylists(): Playlist[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const lists: Playlist[] = [];
        for (const item of parsed) {
            if (typeof item !== 'object' || item === null) {
                continue;
            }
            const entry = item as Record<string, unknown>;
            if (typeof entry.id !== 'string' || typeof entry.name !== 'string') {
                continue;
            }
            const tracks: Track[] = [];
            if (Array.isArray(entry.tracks)) {
                for (const rawTrack of entry.tracks) {
                    const track = cleanTrack(rawTrack);
                    if (track) {
                        tracks.push(track);
                    }
                }
            }
            lists.push({
                id: entry.id,
                name: entry.name,
                createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
                tracks,
            });
        }
        return lists;
    } catch {
        return [];
    }
}

export function savePlaylists(lists: Playlist[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(lists));
    } catch {
        // 存储不可用时只影响下次打开的默认值，不中断当前操作。
    }
}

export function createPlaylist(name: string): Playlist {
    const lists = loadPlaylists();
    const playlist: Playlist = {
        id: `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        createdAt: Date.now(),
        tracks: [],
    };
    lists.push(playlist);
    savePlaylists(lists);
    return playlist;
}

export function renamePlaylist(id: string, name: string): boolean {
    const lists = loadPlaylists();
    const target = lists.find((item) => item.id === id);
    if (!target) {
        return false;
    }
    target.name = name;
    savePlaylists(lists);
    return true;
}

export function deletePlaylist(id: string): void {
    savePlaylists(loadPlaylists().filter((item) => item.id !== id));
}

/** 返回 added（已加入）／exists（已在里面）／missing（歌单不存在）。 */
export function addTrackToPlaylist(id: string, track: Track): 'added' | 'exists' | 'missing' {
    const lists = loadPlaylists();
    const target = lists.find((item) => item.id === id);
    if (!target) {
        return 'missing';
    }
    const key = trackKey(track);
    if (target.tracks.some((item) => trackKey(item) === key)) {
        return 'exists';
    }
    target.tracks.push({ ...track, streamUrl: undefined });
    savePlaylists(lists);
    return 'added';
}

export function removeTrackFromPlaylist(id: string, key: string): boolean {
    const lists = loadPlaylists();
    const target = lists.find((item) => item.id === id);
    if (!target) {
        return false;
    }
    const before = target.tracks.length;
    target.tracks = target.tracks.filter((item) => trackKey(item) !== key);
    if (target.tracks.length === before) {
        return false;
    }
    savePlaylists(lists);
    return true;
}
