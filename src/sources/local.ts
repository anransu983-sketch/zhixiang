// 本地音乐音源：走原生 LocalMusic 插件扫 MediaStore。
// Track 类型里没有文件路径字段，路径单独存在本模块的缓存里，
// resolveStream 时再由路径换成 WebView 可播的地址。

import { Capacitor, registerPlugin } from '@capacitor/core';
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
        return {
            id,
            title: raw.title || '未知曲名',
            artist: raw.artist || '未知歌手',
            album: raw.album,
            durationMs: raw.durationMs,
            coverUrl: raw.coverUri,
            source: 'local'
        };
    }
}

export const localSource = new LocalMusicSource();

export function getLocalNotice(): string | null {
    return localSource.notice;
}
