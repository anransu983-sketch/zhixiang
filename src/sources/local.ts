// 本地音乐音源：走原生 LocalMusic 插件扫 MediaStore。
// Track 类型里没有文件路径字段，路径单独存在本模块的缓存里，
// resolveStream 时再由路径换成 WebView 可播的地址。

import { Capacitor, registerPlugin } from '@capacitor/core';
import { neteaseSource } from './netease';
import type { AudioSource, SourceId, Track } from '../types';

interface LocalRawTrack {
    id: string;
    title: string;
    artist: string;
    album?: string;
    durationMs?: number;
    coverUri?: string;
    path: string;
}

interface LocalMusicPlugin {
    scan(): Promise<{ tracks: LocalRawTrack[] }>;
    coverArt(options: { albumId: number }): Promise<{ dataUrl: string }>;
    embeddedLyrics(options: {
        path: string;
    }): Promise<{ found: boolean; lyrics: string; source: string }>;
}

const LocalMusic = registerPlugin<LocalMusicPlugin>('LocalMusic');

class LocalMusicSource implements AudioSource {
    readonly id: SourceId = 'local';
    readonly label = '本地音乐';

    notice: string | null = null;

    private cached: Track[] | null = null;
    private paths = new Map<string, string>();
    private lastScanFailed = false;

    async search(query: string): Promise<Track[]> {
        const all = await this.loadAll();
        const keyword = query.trim().toLowerCase();
        if (!keyword) {
            return all;
        }
        return all.filter((track) => {
            const haystack = [track.title, track.artist, track.album ?? '']
                .join(' ')
                .toLowerCase();
            return haystack.includes(keyword);
        });
    }

    async resolveStream(track: Track): Promise<string> {
        if (track.streamUrl) {
            return track.streamUrl;
        }
        let path = this.paths.get(track.id);
        if (!path) {
            // 缓存里没有（例如 App 重启后直接点了旧列表），重扫一次再找。
            await this.loadAll(true);
            path = this.paths.get(track.id);
        }
        if (!path) {
            throw new Error('找不到这首歌的本地文件，请重新打开本地音乐再试');
        }
        return Capacitor.convertFileSrc(path);
    }

    // 内嵌歌词（0.1.103）：按扫描时记下的文件路径向原生要文件自带的词。
    // 路径不在缓存里（例如 App 重启后直接点了旧列表）时不重扫，
    // 回 null 让调用方落到联网补源；原生读失败同样回 null。
    async embeddedLyrics(track: Track): Promise<{ text: string; source: string } | null> {
        const path = this.paths.get(track.id);
        if (!path) {
            return null;
        }
        try {
            const result = await LocalMusic.embeddedLyrics({ path });
            if (result.found && typeof result.lyrics === 'string' && result.lyrics.trim()) {
                return { text: result.lyrics, source: result.source || 'embedded' };
            }
        } catch {
            // 原生读不到就当没有，落到联网补源。
        }
        return null;
    }

    private async loadAll(force = false): Promise<Track[]> {
        if (this.cached !== null && !force && !this.lastScanFailed) {
            return this.cached;
        }
        try {
            const result = await LocalMusic.scan();
            const tracks = (result.tracks ?? []).map((raw) => this.toTrack(raw));
            this.cached = tracks;
            this.lastScanFailed = false;
            this.notice = null;
            return tracks;
        } catch {
            // 不抛裸错：返回空列表，界面用 notice 给一句中文提示。
            this.lastScanFailed = true;
            if (Capacitor.getPlatform() !== 'android') {
                this.notice = '本地音乐只能在安卓 App 内使用，在浏览器里看不到本地歌曲。';
            } else {
                this.notice = '读不到本地歌曲：请在系统设置里给芷湘授予读取音频文件的权限，然后重新搜索。';
            }
            return [];
        }
    }

    private toTrack(raw: LocalRawTrack): Track {
        const id = `local:${raw.id}`;
        this.paths.set(id, raw.path);
        // 音质角标用：只取文件扩展名（大写），拿不到或不像扩展名时留空不猜。
        const dot = raw.path.lastIndexOf('.');
        const ext = dot > 0 ? raw.path.slice(dot + 1).toUpperCase() : '';
        return {
            id,
            title: raw.title || '未知曲名',
            artist: raw.artist || '未知歌手',
            album: raw.album,
            durationMs: raw.durationMs,
            coverUrl: raw.coverUri,
            source: 'local',
            format: /^[A-Z0-9]{2,5}$/.test(ext) ? ext : undefined
        };
    }
}

// 播放页封面用：按专辑 id 向原生要一张专辑图（data URL）。
// 只在播放页点开当前曲目时调一次，不批量扫库；失败返回 null，调用方隐藏封面。
export async function getLocalCoverDataUrl(albumId: number): Promise<string | null> {
    try {
        const result = await LocalMusic.coverArt({ albumId });
        return typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/')
            ? result.dataUrl
            : null;
    } catch {
        return null;
    }
}

// 0.1.85 本地封面网易云补源：MediaStore 专辑图拿不到时用。复用
// searchForLocal 的同一套匹配（标题歌手对得上、时长最接近），只取 coverUrl；
// 封面错一张无所谓，不设时长门。内存缓存只记命中，避免同一首歌反复搜索。
const neteaseCoverCache = new Map<string, string>();

export async function getLocalCoverFromNetease(track: Track): Promise<string | null> {
    const cached = neteaseCoverCache.get(track.id);
    if (cached) {
        return cached;
    }
    const title = track.title.trim();
    if (!title) {
        return null;
    }
    const artist =
        track.artist === '未知歌手' || track.artist === '<unknown>' ? '' : track.artist;
    const match = await neteaseSource.searchForLocal(
        title,
        artist,
        track.durationMs && track.durationMs > 0 ? track.durationMs : undefined
    );
    const coverUrl = match?.coverUrl;
    if (typeof coverUrl === 'string' && coverUrl.startsWith('https://')) {
        neteaseCoverCache.set(track.id, coverUrl);
        return coverUrl;
    }
    return null;
}

export const localSource = new LocalMusicSource();

export async function getLocalEmbeddedLyrics(
    track: Track
): Promise<{ text: string; source: string } | null> {
    return localSource.embeddedLyrics(track);
}

export function getLocalNotice(): string | null {
    return localSource.notice;
}
