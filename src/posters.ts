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

const LOCAL_ALBUM_LIMIT = 3;

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
        label: '本地专辑',
        load: loadLocalAlbumPosters,
        emptyNotice: '本地还没有专辑，导入歌曲后这里会按专辑出现。',
        failureNotice: '本地专辑暂时加载不出来，请确认已授予读取音频文件的权限后重试。'
    },
    {
        key: 'netease',
        label: '网易云榜单',
        load: fetchNeteaseChartPosters,
        emptyNotice: '网易云榜单暂时没有内容，请稍后重试。',
        failureNotice: '网易云榜单暂时加载不出来，请稍后重试。'
    },
    {
        key: 'ytm',
        label: 'YTM 热门专辑',
        load: fetchYtmChartPosters,
        emptyNotice: 'YTM 热门专辑暂时没有内容，请稍后重试。',
        failureNotice: 'YTM 热门专辑暂时加载不出来，请稍后重试。'
    }
];
