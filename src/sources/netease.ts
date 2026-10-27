// 网易云音源：公开接口直连；登录后搜索／取链／榜单／歌词自动带上会话 Cookie
//（见 netease-session.ts 的扫码登录），未登录时一切如旧。
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
import { withSessionCookie } from './netease-session';
import type { AudioSource, Poster, SourceId, Track } from '../types';

const SEARCH_URL = 'https://music.163.com/api/cloudsearch/pc';
const STREAM_URL = 'https://music.163.com/api/song/enhance/player/url';
const SEARCH_LIMIT = 20;
const STREAM_BITRATE = 128000;

// 有会话时补 Cookie、无会话时原样返回；URL 与参数一律不动。
function requestHeaders(): Record<string, string> {
    return withSessionCookie(HEADERS);
}

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
        const response = await httpGet(`${SEARCH_URL}?${params.toString()}`, requestHeaders());
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
        const response = await httpGet(`${STREAM_URL}?${params.toString()}`, requestHeaders());
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
        // 0.1.72 诊断：只记取链码、地址 host 与协议、长度与查询参数名，
        // 不记完整地址与签名，供分流是取链本身还是代理取上游的问题。
        try {
            if (url) {
                const parsedUrl = new URL(url);
                const paramNames = [...new URLSearchParams(parsedUrl.search).keys()].join(',');
                console.log(
                    `[Netease] 取链码=${first?.code} host=${parsedUrl.hostname} 协议=${parsedUrl.protocol} 长度=${url.length} 参数=[${paramNames}]`
                );
            } else {
                console.log(`[Netease] 取链码=${first?.code} 无地址`);
            }
        } catch {
            console.log(`[Netease] 取链码=${first?.code} 地址解析失败`);
        }
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

// 海报墙用网易云榜单（第 6 块新增，全新写）：
// 实测（2026-10-25 沙箱 curl，无登录、无 cookie）：
// - GET https://music.163.com/api/toplist 回 200，list 里有官方榜单的 id 与封面；
//   下面 3 个 id 就是从该返回里取的公开榜单，不是编的。
// - GET https://music.163.com/api/playlist/detail?id=<榜单 id> 回 200，
//   result.tracks 是完整歌曲数组（字段与搜索不同：artists 而非 ar、duration
//   而非 dt），result.name 是榜单名、result.coverImgUrl 是榜单封面。
// 单个榜单失败只跳过该榜，不影响其余榜；全部失败时返回空数组，由调用方
// 给一句中文提示，不抛错到整墙。
const CHART_PLAYLIST_IDS = [19723756, 3779629, 3778678];
const CHART_TRACK_LIMIT = 20;

interface NeteaseChartSong {
    id?: unknown;
    name?: unknown;
    artists?: unknown;
    album?: unknown;
    duration?: unknown;
}

function chartSongToTrack(raw: NeteaseChartSong): Track {
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
    const artists = Array.isArray(raw.artists)
        ? (raw.artists as { name?: unknown }[])
            .map((artist) => (typeof artist.name === 'string' ? artist.name : ''))
            .filter((name) => name)
        : [];
    const album = raw.album as { name?: unknown; picUrl?: unknown } | null;
    const duration = typeof raw.duration === 'number' ? raw.duration : undefined;
    return {
        id: `netease:${Number.isFinite(id) ? id : 0}`,
        title: typeof raw.name === 'string' && raw.name ? raw.name : '未知曲名',
        artist: artists.length > 0 ? artists.join('、') : '未知歌手',
        album: typeof album?.name === 'string' && album.name ? album.name : undefined,
        durationMs: duration !== undefined && duration > 0 ? duration : undefined,
        coverUrl: typeof album?.picUrl === 'string' && album.picUrl ? album.picUrl : undefined,
        source: 'netease'
    };
}

export async function fetchNeteaseChartPosters(): Promise<Poster[]> {
    const posters: Poster[] = [];
    for (const playlistId of CHART_PLAYLIST_IDS) {
        try {
            const response = await httpGet(
                `https://music.163.com/api/playlist/detail?id=${playlistId}`,
                requestHeaders()
            );
            if (response.status !== 200) {
                continue;
            }
            const parsed = JSON.parse(response.body) as {
                result?: {
                    name?: unknown;
                    coverImgUrl?: unknown;
                    tracks?: unknown;
                } | null;
            };
            const result = parsed.result;
            const songs = result?.tracks;
            if (!Array.isArray(songs) || songs.length === 0) {
                continue;
            }
            const tracks = (songs as NeteaseChartSong[])
                .slice(0, CHART_TRACK_LIMIT)
                .map(chartSongToTrack);
            posters.push({
                id: `netease-chart:${playlistId}`,
                title:
                    typeof result?.name === 'string' && result.name
                        ? result.name
                        : '网易云榜单',
                coverUrl:
                    typeof result?.coverImgUrl === 'string' && result.coverImgUrl
                        ? result.coverImgUrl
                        : undefined,
                source: 'netease',
                tracks
            });
        } catch {
            // 单榜失败跳过，不让一个榜拖垮整路。
            continue;
        }
    }
    return posters;
}
