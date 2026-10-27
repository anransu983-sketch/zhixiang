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
//   但 v1 eapi POST（同路径，eapi 加密，level=exhigh, encodeType=flac）
//   在 2026-10-27 S26 探针实证可用，给无 authSecret 的 m701 地址且全 206，
//   故 0.1.77 起取链 v1 优先、老接口回落。
// 注意：取链地址带时效签名，拿到后应尽快播放，不要长期缓存。

import { httpGet } from '../native/http';
import { eapiRequest } from './netease-eapi';
import { withSessionCookie } from './netease-session';
import type { AudioSource, Poster, SourceId, Track } from '../types';

const SEARCH_URL = 'https://music.163.com/api/cloudsearch/pc';
const STREAM_URL = 'https://music.163.com/api/song/enhance/player/url';
const SEARCH_LIMIT = 20;
const STREAM_BITRATE = 128000;

// 0.1.79 封面修复：网易云接口给的 picUrl/coverImgUrl 一律是 http，
// WebView 的 <img> 会被 Android 明文策略拦（与 0.1.72 取流被拦同款），
// YTM 封面是 https 所以一直正常。Folia 同款：封面全量升 https。
// 取链升 https 已在 0.1.73 做过，这里只补封面。
function toHttpsCover(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }
    return url.replace(/^http:/, 'https:');
}

// 有会话时补 Cookie、无会话时原样返回；URL 与参数一律不动。
function requestHeaders(): Record<string, string> {
    return withSessionCookie(HEADERS);
}

// 铸链时实际发出的 UA：探针第 2/3 臂用它，判断 CDN 是否按铸链 UA 认人。
export const NETEASE_MINT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const HEADERS: Record<string, string> = {
    Referer: 'https://music.163.com/',
    'User-Agent': NETEASE_MINT_UA
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
    fee?: unknown;
    level?: unknown;
    br?: unknown;
    size?: unknown;
    type?: unknown;
    time?: unknown;
    expi?: unknown;
    freeTrialInfo?: unknown;
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
            // Folia 同款：网易云给 http 明文地址，代理 OkHttp 会被网络
            // 安全策略拦（0.1.72 实证 CLEARTEXT not permitted），一律升 https。
            return track.streamUrl.replace(/^http:/, 'https:');
        }
        const songId = this.parseSongId(track.id);
        // 0.1.77 修复：v1 优先（2026-10-27 22:22 S26 探针实证）。
        // 老接口给带 authSecret 的 m704/m804 地址，7 臂全 403；
        // eapi v1 给无 authSecret 的 m701 地址，7 臂全 206。
        // v1 无地址/试听/异常时回落老接口，不丢无签名曲的旧路。
        // 0.1.78 Claude 评审后补强：记两级码、fee、level/br/size/type、
        // time 对 dt、expi、试听，v1 只给 10 秒（探针实测 v1 约 3 秒内），
        // 超时即回落老接口，不等 eapi 自身 25 秒。
        try {
            const v1Race = await Promise.race([
                eapiRequest('/api/song/enhance/player/url/v1', {
                    ids: `[${songId}]`,
                    level: 'exhigh',
                    encodeType: 'flac'
                }),
                new Promise<never>((_, reject) => {
                    window.setTimeout(() => reject(new Error('v1 取链 10 秒超时')), 10000);
                })
            ]);
            const parsedV1 = JSON.parse(v1Race.body) as {
                code?: unknown;
                data?: NeteaseRawStream[];
            };
            const v1First = Array.isArray(parsedV1.data) ? parsedV1.data[0] : undefined;
            const v1Url = typeof v1First?.url === 'string' && v1First.url ? v1First.url : null;
            const v1DataCode = v1First?.code;
            const v1Trial = !!v1First?.freeTrialInfo ||
                (typeof v1First?.time === 'number' && typeof track.durationMs === 'number' &&
                    track.durationMs > 0 && v1First.time < 0.8 * track.durationMs);
            const v1Blocked = v1DataCode === 404 || v1DataCode === 403;
            if (v1Url && !v1Trial && !v1Blocked) {
                const httpsUrl = v1Url.replace(/^http:/, 'https:');
                try {
                    const parsedUrl = new URL(httpsUrl);
                    const paramNames = [...new URLSearchParams(parsedUrl.search).keys()].join(',');
                    console.log(
                        `[Netease] 取链路径=v1 顶码=${parsedV1.code} 数据码=${v1DataCode} fee=${v1First?.fee} level=${v1First?.level} br=${v1First?.br} size=${v1First?.size} type=${v1First?.type} time=${v1First?.time} dt=${track.durationMs} expi=${v1First?.expi} 试听=无 host=${parsedUrl.hostname} 协议=${parsedUrl.protocol} 长度=${httpsUrl.length} 参数=[${paramNames}]`
                    );
                } catch {
                    console.log(`[Netease] 取链路径=v1 顶码=${parsedV1.code} 数据码=${v1DataCode} 地址解析失败`);
                }
                return httpsUrl;
            }
            console.log(
                `[Netease] 取链v1不用回落老接口，顶码=${parsedV1.code} 数据码=${v1DataCode} fee=${v1First?.fee} level=${v1First?.level} br=${v1First?.br} size=${v1First?.size} type=${v1First?.type} time=${v1First?.time} dt=${track.durationMs} expi=${v1First?.expi} 试听=${v1Trial ? '有' : '无'} 有地址=${v1Url ? '是' : '否'}`
            );
        } catch (error) {
            console.log(
                `[Netease] 取链v1失败回落老接口：${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`
            );
        }
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
        let url = typeof first?.url === 'string' && first.url ? first.url : null;
        // 0.1.73 修复：网易云取链给 http，代理 OkHttp 明文被网络安全
        // 策略拦（0.1.72 实证），Folia 同款升 https，签名参数不动。
        if (url) {
            url = url.replace(/^http:/, 'https:');
        }
        // 0.1.78：老接口也记顶码、fee、br/size/type/time、authSecret 有无。
        // authSecret 只记不拦：芷湘里取链抛错同样计入连续 3 跳，拦了省不掉
        // 跳数，只省一次代理往返；且带签名老接口在更多曲目上仍待验证。
        try {
            if (url) {
                const parsedUrl = new URL(url);
                const paramNames = [...new URLSearchParams(parsedUrl.search).keys()].join(',');
                const hasAuthSecret = paramNames.split(',').includes('authSecret');
                console.log(
                    `[Netease] 取链路径=老接口 顶码=${(parsed as { code?: unknown } | null)?.code} 数据码=${first?.code} fee=${first?.fee} br=${first?.br} size=${first?.size} type=${first?.type} time=${first?.time} dt=${track.durationMs} expi=${first?.expi} authSecret=${hasAuthSecret ? '有' : '无'} host=${parsedUrl.hostname} 协议=${parsedUrl.protocol} 长度=${url.length} 参数=[${paramNames}]`
                );
            } else {
                console.log(`[Netease] 取链路径=老接口 顶码=${(parsed as { code?: unknown } | null)?.code} 数据码=${first?.code} 无地址`);
            }
        } catch {
            console.log(`[Netease] 取链路径=老接口 数据码=${first?.code} 地址解析失败`);
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
            coverUrl: toHttpsCover(typeof cover === 'string' && cover ? cover : undefined),
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
        coverUrl: toHttpsCover(typeof album?.picUrl === 'string' && album.picUrl ? album.picUrl : undefined),
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
                coverUrl: toHttpsCover(
                    typeof result?.coverImgUrl === 'string' && result.coverImgUrl
                        ? result.coverImgUrl
                        : undefined
                ),
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

// 0.1.79 每日推荐：需登录会话（与扫码登录同一 Cookie）。
// 先走 eapi v3（Folia 后端同款路径），返回的 dailySongs 字段与榜单曲
// 形状相近（artists/album/duration），同时兼容搜索形状（ar/al/dt）
// 与 NeteaseCloudMusicApi 后端的 data.dailySongs/data.songs 两种包法。
// eapi 失败时回落公开 GET /api/recommend/songs；两路都拿不到即抛错，
// 调用方只显示中文提示，不让整页挂掉。
export async function fetchNeteaseDailySongs(): Promise<Track[]> {
    const toTrack = (raw: Record<string, unknown>): Track => {
        const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
        const artists = Array.isArray(raw.artists)
            ? (raw.artists as { name?: unknown }[])
                .map((artist) => (typeof artist.name === 'string' ? artist.name : ''))
                .filter((name) => name)
            : Array.isArray(raw.ar)
              ? (raw.ar as { name?: unknown }[])
                .map((artist) => (typeof artist.name === 'string' ? artist.name : ''))
                .filter((name) => name)
              : [];
        const albumRaw = (raw.album ?? raw.al) as { name?: unknown; picUrl?: unknown } | null;
        const durationRaw = raw.duration ?? raw.dt;
        const duration = typeof durationRaw === 'number' ? durationRaw : undefined;
        return {
            id: `netease:${Number.isFinite(id) ? id : 0}`,
            title: typeof raw.name === 'string' && raw.name ? raw.name : '未知曲名',
            artist: artists.length > 0 ? artists.join('、') : '未知歌手',
            album: typeof albumRaw?.name === 'string' && albumRaw.name ? albumRaw.name : undefined,
            durationMs: duration !== undefined && duration > 0 ? duration : undefined,
            coverUrl: toHttpsCover(
                typeof albumRaw?.picUrl === 'string' && albumRaw.picUrl ? albumRaw.picUrl : undefined
            ),
            source: 'netease'
        };
    };
    const pickSongs = (parsed: Record<string, unknown>): unknown[] => {
        const data = parsed.data as Record<string, unknown> | null;
        const candidates = [
            data?.dailySongs,
            data?.songs,
            parsed.recommendData,
            parsed.songs
        ];
        for (const candidate of candidates) {
            if (Array.isArray(candidate) && candidate.length > 0) {
                return candidate;
            }
        }
        const recommendData = parsed.recommendData as Record<string, unknown> | null;
        if (Array.isArray(recommendData?.dailySongs)) {
            return recommendData.dailySongs as unknown[];
        }
        return [];
    };
    let lastError: unknown = null;
    try {
        const v3 = await eapiRequest('/api/v3/discovery/recommend/songs', {});
        const parsedV3 = JSON.parse(v3.body) as Record<string, unknown>;
        const songs = pickSongs(parsedV3);
        if (songs.length > 0) {
            return (songs as Record<string, unknown>[]).map(toTrack);
        }
        lastError = new Error(`v3 每日推荐无歌，码=${parsedV3.code}`);
    } catch (error) {
        lastError = error;
    }
    const response = await httpGet('https://music.163.com/api/recommend/songs', requestHeaders());
    if (response.status !== 200) {
        throw new Error('每日推荐暂时拿不到，请登录后再试');
    }
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    const songs = pickSongs(parsed);
    if (songs.length === 0) {
        console.log(`[Netease] 每日推荐两路均无歌，v3 错=${lastError instanceof Error ? lastError.message : String(lastError)}，GET 码=${parsed.code}`);
        throw new Error('每日推荐暂时拿不到，请登录后再试');
    }
    return (songs as Record<string, unknown>[]).map(toTrack);
}
