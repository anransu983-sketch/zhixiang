// 网易云音源：只走无需登录的公开接口，不做登录体系。
// 请求一律走原生 HttpBridge，不用浏览器 fetch（WebView 跨域会被 CORS 拦）。
//
// 实测探到的端点与返回结构（2026-10-25 沙箱 curl 实测，无登录、无 cookie）：
// - 搜索 GET https://music.163.com/api/cloudsearch/pc?s=<关键词>&type=1&limit=20&offset=0
//   返回 200 JSON：{result: {songs: [{id, name, ar: [{name}], al: {name, picUrl},
//   dt（时长毫秒）, fee, privilege: {...}}]}}；ar 为空时歌手记未知歌手。
// - 取链 GET https://music.163.com/api/song/enhance/player/url?ids=[<歌曲 id>]&br=128000
//   返回 200 JSON：{code: 200, data: [{id, code, url}]}。
//   免费曲：data[0].code 为 200，url 是 m701/m801.music.126.net 的 mp3 地址；
//   需会员或无版权的曲：data[0].code 为 404，url 为 null，resolveStream 抛中文错。
// - 以下两路实测不可用，本模块不用：
//   取链 v1 GET（/api/song/enhance/player/url/v1）回 {msg: '参数错误', code: 400}；
//   /api/search/get/web 回加密串，无法直接解析。
// 注意：取链地址带时效签名，拿到后应尽快播放，不要长期缓存。

import { httpGet } from '../native/http';
import type { AudioSource, SourceId, Track } from '../types';

const SEARCH_URL = 'https://music.163.com/api/cloudsearch/pc';
const STREAM_URL = 'https://music.163.com/api/song/enhance/player/url';
const SEARCH_LIMIT = 20;
const STREAM_BITRATE = 128000;

const HEADERS: Record<string, string> = {
    Referer: 'https://music.163.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
};

interface NeteaseRawSong {
    id?: unknown;
    name?: unknown;
    ar?: unknown;
    al?: unknown;
    dt?: unknown;
}

interface NeteaseRawStream {
    id?: unknown;
    code?: unknown;
    url?: unknown;
}

class NeteaseSource implements AudioSource {
    readonly id: SourceId = 'netease';
    readonly label = '网易云';

    async search(query: string): Promise<Track[]> {
        const keyword = query.trim();
        if (!keyword) {
            // 网易云没有“全部歌曲”可列，空查询直接返回空列表，不发请求。
            return [];
        }
        const params = new URLSearchParams({
            s: keyword,
            type: '1',
            limit: String(SEARCH_LIMIT),
            offset: '0'
        });
        const response = await httpGet(`${SEARCH_URL}?${params.toString()}`, HEADERS);
        if (response.status !== 200) {
            throw new Error('网易云搜索失败，请稍后重试');
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(response.body);
        } catch {
            throw new Error('网易云搜索失败，请稍后重试');
        }
        const songs = (parsed as { result?: { songs?: unknown } } | null)?.result?.songs;
        if (!Array.isArray(songs)) {
            throw new Error('网易云搜索失败，请稍后重试');
        }
        return songs.map((raw) => this.toTrack(raw as NeteaseRawSong));
    }

    async resolveStream(track: Track): Promise<string> {
        if (track.streamUrl) {
            return track.streamUrl;
        }
        const songId = this.parseSongId(track.id);
        const params = new URLSearchParams({
            ids: `[${songId}]`,
            br: String(STREAM_BITRATE)
        });
        const response = await httpGet(`${STREAM_URL}?${params.toString()}`, HEADERS);
        if (response.status !== 200) {
            throw new Error('拿不到这首歌的播放地址，请稍后重试');
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(response.body);
        } catch {
            throw new Error('拿不到这首歌的播放地址，请稍后重试');
        }
        const items = (parsed as { data?: unknown } | null)?.data;
        const first = Array.isArray(items) ? (items[0] as NeteaseRawStream | undefined) : undefined;
        const url = typeof first?.url === 'string' && first.url ? first.url : null;
        if (first?.code !== 200 || !url) {
            throw new Error('这首歌在网易云上暂时播不了，可能是需要会员或没有版权，请换一首试试');
        }
        return url;
    }

    private parseSongId(trackId: string): string {
        const prefix = 'netease:';
        if (!trackId.startsWith(prefix) || trackId.length === prefix.length) {
            throw new Error('这首歌不是网易云的曲目');
        }
        return trackId.slice(prefix.length);
    }

    private toTrack(raw: NeteaseRawSong): Track {
        const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
        const artists = Array.isArray(raw.ar)
            ? (raw.ar as { name?: unknown }[])
                .map((artist) => (typeof artist.name === 'string' ? artist.name : ''))
                .filter((name) => name)
            : [];
        const album = (raw.al as { name?: unknown } | null)?.name;
        const cover = (raw.al as { picUrl?: unknown } | null)?.picUrl;
        const duration = typeof raw.dt === 'number' ? raw.dt : undefined;
        return {
            id: `netease:${Number.isFinite(id) ? id : 0}`,
            title: typeof raw.name === 'string' && raw.name ? raw.name : '未知曲名',
            artist: artists.length > 0 ? artists.join('、') : '未知歌手',
            album: typeof album === 'string' && album ? album : undefined,
            durationMs: duration !== undefined && duration > 0 ? duration : undefined,
            coverUrl: typeof cover === 'string' && cover ? cover : undefined,
            source: 'netease'
        };
    }
}

export const neteaseSource = new NeteaseSource();
