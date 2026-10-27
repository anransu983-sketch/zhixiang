// 海报墙数据源聚合（第 6 块，全新写）：
// 首页顶部海报墙分三路，每路独立加载、独立空状态，任何一路失败都不拖垮整墙。
// - 本地专辑：复用第 2 块本地扫库结果（localSource.search('')），按专辑分组，
//   曲目最多的 3 张专辑上墙；封面取该专辑第一首有封面的曲目，没有则占位。
// - 网易云榜单：见 sources/netease.ts 的 fetchNeteaseChartPosters 实测注释。
// - YTM 热门专辑：见 sources/ytm.ts 的 fetchYtmChartPosters 实测注释。
// 本模块不发任何新接口请求，只做分组与分路组装；各路请求逻辑归各自音源文件。

import { localSource } from './sources/local';
import { fetchNeteaseChartPosters } from './sources/netease';
import { fetchYtmChartPosters } from './sources/ytm';
import type { Poster, Track } from './types';

export interface PosterSectionDefinition {
    key: string;
    label: string;
    load: () => Promise<Poster[]>;
    emptyNotice: string;
    failureNotice: string;
}

// 无封面占位：照搬 Folia BravaisTile.fallbackBackground 的思路——按 id 字符和取色相，
// 每张颜色不同，墙面不显空；但亮度与饱和按 Claude 视觉稿降过（38%→22%、55%），
// 不用 Folia 原值（58%→18%、68%/62%），免得墙面刺眼。CSS 里的统一紫渐变只作兜底。
// 同一哈希也供辉光/渐变用（--hue），省得各处重算。
export function posterHue(id: string): number {
    return [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
}

export function posterFallbackBackground(id: string): string {
    const hue = posterHue(id);
    return `linear-gradient(145deg, hsl(${hue} 55% 38%), hsl(${(hue + 52) % 360} 55% 22%))`;
}

// 海报加载失败时：调用方抛出的中文原因直接展示（已含 HTTP 状态等定位信息），
// 非中文异常（如解析错误）才回落到通用提示。
export function friendlyPosterError(definition: PosterSectionDefinition, error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/[\u4e00-\u9fff]/.test(message)) {
        return message;
    }
    return definition.failureNotice;
}

const LOCAL_ALBUM_LIMIT = 3;

// 海报数据共享缓存：海报墙与 3D 歌单架用同一批海报数据，
// 两处调用同一路的 load 时只发一次请求，成功结果共用。
// 失败不缓存（删掉失败的占位），之后再调用可以重新尝试。
const posterCache = new Map<string, Promise<Poster[]>>();

function withPosterCache(key: string, load: () => Promise<Poster[]>): () => Promise<Poster[]> {
    return () => {
        const cached = posterCache.get(key);
        if (cached) {
            return cached;
        }
        const promise = load();
        posterCache.set(key, promise);
        promise.catch(() => {
            if (posterCache.get(key) === promise) {
                posterCache.delete(key);
            }
        });
        return promise;
    };
}

export async function loadLocalAlbumPosters(): Promise<Poster[]> {
    const tracks = await localSource.search('');
    const groups = new Map<string, Track[]>();
    for (const track of tracks) {
        const album = track.album && track.album.trim() ? track.album : '未知专辑';
        const list = groups.get(album) ?? [];
        list.push(track);
        groups.set(album, list);
    }
    return [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, LOCAL_ALBUM_LIMIT)
        .map(([album, albumTracks]) => ({
            id: `local-album:${album}`,
            title: album,
            subtitle: albumTracks[0]?.artist,
            coverUrl: albumTracks.find((track) => track.coverUrl)?.coverUrl,
            source: 'local' as const,
            tracks: albumTracks
        }));
}

export const POSTER_SECTIONS: PosterSectionDefinition[] = [
    {
        key: 'local',
        label: '本地藏碟',
        load: withPosterCache('local', loadLocalAlbumPosters),
        emptyNotice: '本地还没有专辑，导入歌曲后这里会按专辑出现。',
        failureNotice: '本地藏碟暂时加载不出来，请确认已授予读取音频文件的权限后重试。'
    },
    {
        key: 'netease',
        label: '云端榜单',
        load: withPosterCache('netease', fetchNeteaseChartPosters),
        emptyNotice: '云端榜单暂时没有内容，请稍后重试。',
        failureNotice: '云端榜单暂时加载不出来，请稍后重试。'
    },
    {
        key: 'ytm',
        label: 'YTM 热碟',
        load: withPosterCache('ytm', fetchYtmChartPosters),
        emptyNotice: 'YTM 热碟暂时没有内容，请稍后重试。',
        failureNotice: 'YTM 热碟暂时加载不出来，请稍后重试。'
    }
];
