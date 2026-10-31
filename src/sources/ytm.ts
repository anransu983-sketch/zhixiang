// YTM 音源：走 YouTube InnerTube 接口，不做登录体系，不存任何私人密钥与 cookie。
// 请求一律走原生 HttpBridge，不用浏览器 fetch（WebView 跨域会被 CORS 拦）。
//
// 2026-10-25 沙箱 curl 实探结论（无登录、无 cookie；探到的行为记在这里，代码按它实现）：
// - 搜索 POST https://music.youtube.com/youtubei/v1/search?key=<公开客户端标识>
//   请求体 {context: {client: {clientName: 'WEB_REMIX', clientVersion: '1.20240111.01.00',
//   hl, gl}}, query}，回 200 JSON。注意 www.youtube.com 配 WEB 客户端搜同一关键词
//   只回一个“出了点问题”的占位块，拿不到结果，所以搜索必须走 music.youtube.com +
//   WEB_REMIX。结果在 contents.tabbedSearchResultsRenderer.tabs[].tabRenderer.content
//   .sectionListRenderer.contents[] 里，以 musicResponsiveListItemRenderer 出现；
//   本模块递归收集这类节点，只留带 playlistItemData.videoId 的可播项（歌手、专辑、
//   歌单行没有 videoId，直接跳过），按 videoId 去重，取前 20 条。
//   行结构：flexColumns[0] 是标题 runs；flexColumns[1] 是“类型 • 歌手 • 专辑/播放量”
//   这种 runs 串；thumbnail.musicThumbnailRenderer.thumbnail.thumbnails 是封面组。
//   搜索行不带时长（后几列只给播放量/观看量），所以 Track.durationMs 留空；
//   时长在取链响应的 videoDetails.lengthSeconds 里，第 5 块如需展示可从那里取。
// - 取链 POST https://www.youtube.com/youtubei/v1/player?key=<公开客户端标识>
//   请求体 {context: {client: {...}}, videoId, racyCheckOk: true, contentCheckOk: true}。
//   关键一点：player 请求的 client 里必须带 visitorData（取自最近一次搜索响应的
//   responseContext.visitorData）。沙箱实探：ANDROID 不带 visitorData 回
//   playabilityStatus LOGIN_REQUIRED（“Sign in to confirm you're not a bot”），
//   带上后回 OK 并给出 streamingData；IOS 同理。没有缓存的 visitorData 时仍按链
//   顺序尝试，不为此多发一次搜索请求。
// - 客户端回落顺序：VISIONOS → ANDROID → IOS → WEB_REMIX → WEB。
//   VISIONOS 放首位是 2026-10-24 真机验过的行为，本块按该顺序重新实现，不抄旧代码。
//   沙箱里 VISIONOS 1.0 无论带不带 visitorData 都回 404（Requested entity was not
//   found），ANDROID 20.10.38 与 IOS 20.10.38 带 visitorData 实测回 OK；WEB_REMIX 与
//   WEB 在沙箱里回 UNPLAYABLE，仍留作链尾兜底。哪一环在 S26 真机上真正出链，
//   须由真机验收确认，见本块报告。
// - 取链成功时 streamingData.adaptiveFormats 里有带直链 url 的纯音频项（实探 itag
//   139/140 mp4 与 249/251 opus，url 直给、无需解签名串）；本模块只取带直链 url 的
//   纯音频项，按 bitrate 取最高一条。带 signatureCipher 而无 url 的项直接跳过，
//   本块不做签名解算；某客户端拿不到可用流就落到下一客户端，全链失败才抛中文错。
// - key 说明：URL 上的 key 是 YouTube 各公开客户端共用的 InnerTube 客户端标识，
//   不是私人密钥、不是账号 cookie，不要把它当成需要保密的东西，也不要换成任何
//   私人凭证。取链地址带时效签名，拿到后应尽快播放，不要长期缓存。
//
// 重要约束（第 5 块播放引擎必须遵守，本块不实现播放逻辑）：
// googlevideo 自 2026-08 起拒绝无界 Range 请求（会 403），这是 2026-10-24 真机验过
// 的行为；已验证的应对是有界 Range（1MiB 窗口）。所以 resolveStream 只返回地址与
// 元数据（mimeType、contentLength），绝不要在本块里用 plain audio 直接播这条地址
// 来“验证出声”——无界 Range 会被 403 拦下，那不是地址本身不可用。有界 Range 加载
// 由第 5 块的播放引擎实现（MSE 分块加载或本地 Range 代理均可，第 5 块定）。

import { httpPost } from '../native/http';
import { extractYtmViaPage, loadYtmSession, sapisidHash, withYtmSession } from './ytm-session';
import type { AudioSource, Poster, SourceId, Track } from '../types';

const SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search';
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
// 公开客户端标识（见文件头 key 说明），非私人密钥。
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const SEARCH_LIMIT = 20;

const HEADERS: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8'
};

// 有会话时补 Cookie、同源 UA 与 SAPISIDHASH 签名（见 ytm-session.ts），
// 无会话时原样返回；URL、client 与参数一律不动。
function requestHeaders(): Record<string, string> {
    return withYtmSession(HEADERS);
}

interface InnertubeClient {
    name: string;
    version: string;
    deviceMake?: string;
    deviceModel?: string;
    osName?: string;
    osVersion?: string;
    // Folia 桥同款：每客户端专属 key、UA、数字客户端 id、安卓 SDK 版、
    // embed 嵌套地址（仅 TV_EMBEDDED）。播放链每腿都带全套上下文
    // （user/request/playbackContext）与 en/US，不再只给 VISIONOS。
    hl?: string;
    gl?: string;
    userAgent?: string;
    clientNameId?: number;
    apiKey?: string;
    androidSdkVersion?: number;
    embedUrl?: string;
}

const SEARCH_CLIENT: InnertubeClient = {
    name: 'WEB_REMIX',
    version: '1.20240111.01.00'
};

// 取链回落链：VISIONOS 首位（2026-10-24 真机验过的尝试顺序），依次回落。
// VISIONOS 规格照搬 Folia 桥（2026-10-26 第四轮结论）：1.0 恒 404，
// Folia 的 1.02＋101 头＋设备字段＋Safari UA 才能回 200；先整套照搬，
// 跑通后再单独消 hl/gl 做消融， bisect 前不拆。
// 取链回落链：照搬 Folia 桥的表（2026-10-26 第十四轮结论）——
// 每客户端专属 key、UA、数字 id、版本，全腿 en/US 全上下文；
// WEB 系不在播放链里（WEB 路要 poToken，桥里产不出来；搜索仍走 WEB_REMIX）。
// ANDROID_VR 是 legacy 兜底：其直链约 1MiB 取流上限，赢了要留意中途断流。
const PLAYER_CLIENTS: InnertubeClient[] = [
    {
        name: 'VISIONOS',
        version: '1.02',
        deviceMake: 'Apple',
        deviceModel: 'RealityDevice17,1',
        osName: 'visionOS',
        osVersion: '26.5.23O471',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
        clientNameId: 101,
        apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
    },
    {
        name: 'ANDROID_VR',
        version: '1.65.10',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        clientNameId: 28,
        apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
        androidSdkVersion: 32
    },
    {
        name: 'IOS',
        version: '20.11.6',
        deviceMake: 'Apple',
        deviceModel: 'iPhone10,4',
        osName: 'iOS',
        osVersion: '16.7.7.20H330',
        userAgent: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
        clientNameId: 5,
        apiKey: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc'
    },
    {
        name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        version: '2.0',
        userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
        clientNameId: 85,
        apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
        embedUrl: 'https://www.youtube.com/'
    },
    {
        name: 'ANDROID',
        version: '21.03.36',
        deviceModel: 'SM-S908E',
        osName: 'Android',
        osVersion: '16',
        userAgent: 'com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip',
        clientNameId: 3,
        apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
        androidSdkVersion: 36
    }
];

export interface YtmStream {
    url: string;
    mimeType: string;
    contentLength?: number;
    bitrate?: number;
    // 铸链时实际发出的 UA：有会话时是会话 UA，无会话时桥（OkHttp）默认发
    // okhttp/4.12.0。取流时代理必须复用它——googlevideo 按铸链时的请求形态
    // 认人，UA 不对只回空包、元素 instant Format error（Folia 0.7.22.8 同款教训）。
    userAgent?: string;
}

let lastYtmStream: YtmStream | null = null;

// 取链时顺带记下的字幕轨（供歌词用，不另发 player 请求）：
// player 返回的 captions.playerCaptionsTracklistRenderer.captionTracks，
// 每条只有 baseUrl（已带签名参数）＋ languageCode＋kind，不记正文。
export interface YtmCaptionTrack {
    baseUrl: string;
    languageCode: string;
    kind?: string;
}

// 按 videoId 缓存，歌词在起播后才拉，此时取链早已跑完；只留最近 20 首。
const captionCache = new Map<string, YtmCaptionTrack[]>();

export function getYtmCaptions(videoId: string): YtmCaptionTrack[] | null {
    return captionCache.get(videoId) ?? null;
}

function storeYtmCaptions(videoId: string, tracks: YtmCaptionTrack[]): void {
    captionCache.set(videoId, tracks);
    while (captionCache.size > 20) {
        const oldest = captionCache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        captionCache.delete(oldest);
    }
}

// 播放页角标用：最近一次 YTM 取链的元数据（client 选择结果）。
// 缓存直链时 mimeType 为空，角标隐藏，不猜。
export function getLastYtmStreamMeta(): YtmStream | null {
    return lastYtmStream;
}

interface RawRun {
    text?: unknown;
}

interface RawThumbnail {
    url?: unknown;
    width?: unknown;
}

interface RawListItem {
    playlistItemData?: { videoId?: unknown } | null;
    thumbnail?: {
        musicThumbnailRenderer?: {
            thumbnail?: { thumbnails?: unknown } | null;
        } | null;
    } | null;
    flexColumns?: unknown;
}

interface RawFormat {
    mimeType?: unknown;
    bitrate?: unknown;
    contentLength?: unknown;
    url?: unknown;
    signatureCipher?: unknown;
}

// 最近一次搜索响应给的 visitorData；取链时带上它才能绕过“请登录确认不是机器人”
// 的拦截（沙箱实探结论，见文件头）。没有它时也不阻塞取链，只是成功率会低。
let cachedVisitorData: string | null = null;

function clientContext(client: InnertubeClient, withVisitorData: boolean, gl = 'CN'): Record<string, unknown> {
    const context: Record<string, unknown> = {
        clientName: client.name,
        clientVersion: client.version,
        hl: client.hl ?? 'zh-CN',
        gl: client.gl ?? gl
    };
    if (client.deviceMake) {
        context.deviceMake = client.deviceMake;
    }
    if (client.deviceModel) {
        context.deviceModel = client.deviceModel;
    }
    if (client.osName) {
        context.osName = client.osName;
    }
    if (client.osVersion) {
        context.osVersion = client.osVersion;
    }
    if (cachedVisitorData && withVisitorData) {
        context.visitorData = cachedVisitorData;
    }
    return context;
}

function runText(run: RawRun): string {
    return typeof run.text === 'string' ? run.text : '';
}

function columnText(item: RawListItem, index: number): string {
    if (!Array.isArray(item.flexColumns) || item.flexColumns.length <= index) {
        return '';
    }
    const column = item.flexColumns[index] as {
        musicResponsiveListItemFlexColumnRenderer?: { text?: { runs?: unknown } } | null;
    };
    const runs = column.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
    if (!Array.isArray(runs)) {
        return '';
    }
    return (runs as RawRun[]).map(runText).join('');
}

function largestCover(item: RawListItem): string | undefined {
    const thumbnails = item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
    if (!Array.isArray(thumbnails)) {
        return undefined;
    }
    let bestUrl: string | undefined;
    let bestWidth = -1;
    for (const raw of thumbnails as RawThumbnail[]) {
        const width = typeof raw.width === 'number' ? raw.width : 0;
        if (typeof raw.url === 'string' && raw.url && width >= bestWidth) {
            bestUrl = raw.url;
            bestWidth = width;
        }
    }
    return bestUrl;
}

function collectListItems(node: unknown, out: RawListItem[]): void {
    if (Array.isArray(node)) {
        for (const child of node) {
            collectListItems(child, out);
        }
        return;
    }
    if (node === null || typeof node !== 'object') {
        return;
    }
    const record = node as Record<string, unknown>;
    const item = record.musicResponsiveListItemRenderer;
    if (item !== null && typeof item === 'object') {
        out.push(item as RawListItem);
    }
    for (const child of Object.values(record)) {
        collectListItems(child, out);
    }
}

function toTrack(item: RawListItem): Track | null {
    const videoId = item.playlistItemData?.videoId;
    if (typeof videoId !== 'string' || !videoId) {
        return null;
    }
    const title = columnText(item, 0) || '未知曲名';
    // 第二列形如“Song • 歌手”或“Video • 歌手 • 播放量”：首段是类型，次段是歌手；
    // 第三段若是播放量/观看量/订阅数一类计数则不是专辑，只有非计数文本才当专辑。
    const parts = columnText(item, 1)
        .split(' • ')
        .map((part) => part.trim())
        .filter((part) => part);
    const artist = parts[1] ?? '未知歌手';
    let album: string | undefined;
    const third = parts[2];
    if (third !== undefined && !/views|plays|subscribers|audience|followers/i.test(third)) {
        album = third;
    }
    return {
        id: `ytm:${videoId}`,
        title,
        artist,
        album,
        coverUrl: largestCover(item),
        source: 'ytm'
    };
}

// 诊断用：把非 JSON 响应体的前 200 字单行化展示。响应体里没有凭证，
// 只看 YouTube 到底回了什么页（验证页／同意页／空响应），不贴完整 body。
function bodySnippet(body: string): string {
    return body.replace(/\s+/g, ' ').trim().slice(0, 200) || '空响应';
}

class YtmSource implements AudioSource {
    readonly id: SourceId = 'ytm';
    readonly label = 'YTM';

    async search(query: string): Promise<Track[]> {
        const keyword = query.trim();
        if (!keyword) {
            // YTM 没有“全部歌曲”可列，空查询直接返回空列表，不发请求。
            return [];
        }
        const body = JSON.stringify({
            // YouTube 对 WEB_REMIX 搜索不接受 gl=CN（直接 400 INVALID_ARGUMENT，
            // 沙箱逐项缩减验证：只改 gl 为 US 即回 200；榜单与取链走 ANDROID/IOS
            // 且 gl=CN 本就通，不动它们）。
            context: { client: clientContext(SEARCH_CLIENT, false, 'US') },
            query: keyword
        });
        const response = await httpPost(`${SEARCH_URL}?key=${INNERTUBE_KEY}`, body, { ...HEADERS });
        if (response.status !== 200) {
            throw new Error(`YTM 搜索失败（HTTP ${response.status}）`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(response.body);
        } catch {
            const detail = `YTM 搜索失败（返回异常：${bodySnippet(response.body)}）`;
            console.error(detail);
            throw new Error(detail);
        }
        const visitorData = (parsed as { responseContext?: { visitorData?: unknown } } | null)
            ?.responseContext?.visitorData;
        if (typeof visitorData === 'string' && visitorData) {
            // 取链要靠它过机器人检查，搜到一次就缓存起来。
            cachedVisitorData = visitorData;
        }
        const rawItems: RawListItem[] = [];
        collectListItems(parsed, rawItems);
        const seen = new Set<string>();
        const tracks: Track[] = [];
        for (const raw of rawItems) {
            if (tracks.length >= SEARCH_LIMIT) {
                break;
            }
            const track = toTrack(raw);
            if (!track || seen.has(track.id)) {
                continue;
            }
            seen.add(track.id);
            tracks.push(track);
        }
        return tracks;
    }

    async resolveStream(track: Track): Promise<string> {
        return (await resolveYtmStream(track)).url;
    }
}

interface PlayerAttempt {
    stream: YtmStream | null;
    loginRequired: boolean;
    responded: boolean;
    responseVisitorData: string | null;
}

// 播放链专用的 client 上下文：Folia 桥同款——全腿 en/US、
// androidSdkVersion（>0 才带）、visitorData（有才带）。
function playerClientContext(client: InnertubeClient, visitorData: string | null): Record<string, unknown> {
    // 字段顺序与 Folia 桥一致（device/sdk 在前，hl/gl 在后，visitorData 最后）；
    // JSON 解析不看顺序，对齐只为消掉最后一个体层差别。
    const context: Record<string, unknown> = {
        clientName: client.name,
        clientVersion: client.version
    };
    if (client.deviceMake) {
        context.deviceMake = client.deviceMake;
    }
    if (client.deviceModel) {
        context.deviceModel = client.deviceModel;
    }
    if (client.osName) {
        context.osName = client.osName;
    }
    if (client.osVersion) {
        context.osVersion = client.osVersion;
    }
    if (client.androidSdkVersion) {
        context.androidSdkVersion = client.androidSdkVersion;
    }
    context.hl = 'en';
    context.gl = 'US';
    if (visitorData) {
        context.visitorData = visitorData;
    }
    return context;
}

// visitor_id 端点（Folia 桥同款 WEB 参数；WEB key 与共享 key 是同一把）。
// 匿名那份只存内存、冷启重取。取不到回 null，不拦路（缺了照样发 player
// 请求，只是更容易被挡）。播放取链 0.1.63 起不再带会话，登录那份已随
// 登录链一起删。
const VISITOR_URL = 'https://www.youtube.com/youtubei/v1/visitor_id';
const WEB_CLIENT_VERSION = '2.20260623.01.00';

async function fetchVisitorId(): Promise<string | null> {
    try {
        const body = JSON.stringify({
            context: {
                client: {
                    clientName: 'WEB',
                    clientVersion: WEB_CLIENT_VERSION,
                    hl: 'en',
                    gl: 'US'
                }
            }
        });
        const headers = { ...HEADERS };
        const response = await httpPost(`${VISITOR_URL}?prettyPrint=false&key=${INNERTUBE_KEY}`, body, headers);
        if (response.status !== 200) {
            return null;
        }
        const parsed = JSON.parse(response.body) as { responseContext?: { visitorData?: unknown } | null } | null;
        const visitorData = parsed?.responseContext?.visitorData;
        return typeof visitorData === 'string' && visitorData ? visitorData : null;
    } catch {
        return null;
    }
}

let anonymousVisitorData: string | null = null;

async function ensureAnonymousVisitorData(): Promise<string | null> {
    if (anonymousVisitorData) {
        return anonymousVisitorData;
    }
    const fresh = await fetchVisitorId();
    if (fresh) {
        anonymousVisitorData = fresh;
    }
    return fresh;
}

// 单次客户端取链尝试：返回流、或失败原因。LOGIN_REQUIRED 单独标记，
// 供调用方做分链与熔断；其余失败一律只记日志、不抛。
async function tryPlayerClient(
    client: InnertubeClient,
    videoId: string,
    baseHeaders: Record<string, string>,
    visitorData: string | null
): Promise<PlayerAttempt> {
    let response;
    try {
        // 每腿专属 UA 与数字客户端头（Folia 桥同款）：会话 UA 不再覆盖
        // 非 VISIONOS 客户端——旧逻辑里 ANDROID/IOS 发的是 WebView 会话 UA。
        const headers: Record<string, string> = { ...baseHeaders };
        if (client.userAgent) {
            headers['User-Agent'] = client.userAgent;
        }
        if (client.clientNameId !== undefined) {
            headers['X-YouTube-Client-Name'] = String(client.clientNameId);
            headers['X-YouTube-Client-Version'] = client.version;
        }
        const context: Record<string, unknown> = { client: playerClientContext(client, visitorData) };
        context['user'] = { lockedSafetyMode: false };
        context['request'] = { useSsl: true };
        if (client.embedUrl) {
            context['thirdParty'] = { embedUrl: client.embedUrl };
        }
        const bodyObject: Record<string, unknown> = {
            context,
            videoId,
            playbackContext: {
                contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1' }
            },
            racyCheckOk: true,
            contentCheckOk: true
        };
        const body = JSON.stringify(bodyObject);
        response = await httpPost(`${PLAYER_URL}&key=${client.apiKey ?? INNERTUBE_KEY}`, body, headers);
    } catch {
        // 单个客户端请求失败（断网、超时）不直接抛，落到下一客户端。
        console.log(`[Ytm] ${client.name} 不可用：请求失败`);
        return { stream: null, loginRequired: false, responded: false, responseVisitorData: null };
    }
    // 网络实情：只记协议/TLS/头名，不记任何值；门失败时也有响应，照样记。
    // 注意：Capacitor 传回来的头名不一定是数组（0.1.66 实测 join 直接抛错，
    // 整条取链在第一个客户端就炸了，门根本没测到），这里按实际类型兜底，
    // 诊断行绝不能再炸掉取链。
    const joinNames = (v: unknown): string => {
        if (Array.isArray(v)) return v.join(',');
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).join(',');
        return '';
    };
    console.log(`[Ytm] 网络实情：${client.name} 协议 ${response.networkProtocol ?? '?'} / TLS ${response.tlsVersion ?? '?'} ${response.tlsCipher ?? ''} / 发头 [${joinNames(response.requestHeaderNames)}] / 收头 [${joinNames(response.responseHeaderNames)}]`);
    if (response.status !== 200) {
        console.log(`[Ytm] ${client.name} 不可用：状态 ${response.status}`);
        return { stream: null, loginRequired: false, responded: true, responseVisitorData: null };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        console.log(`[Ytm] ${client.name} 不可用：解析失败`);
        return { stream: null, loginRequired: false, responded: true, responseVisitorData: null };
    }
    const root = parsed as {
        playabilityStatus?: { status?: unknown; reason?: unknown; subreason?: unknown } | null;
        streamingData?: { adaptiveFormats?: unknown } | null;
        captions?: {
            playerCaptionsTracklistRenderer?: { captionTracks?: unknown } | null;
        } | null;
        responseContext?: { visitorData?: unknown } | null;
    } | null;
    const responseVisitorData =
        typeof root?.responseContext?.visitorData === 'string' && root.responseContext.visitorData
            ? root.responseContext.visitorData
            : null;
    if (root?.playabilityStatus?.status !== 'OK') {
        // LOGIN_REQUIRED / UNPLAYABLE / ERROR 等都不是可用流，换下一客户端。
        // reason/subreason 是 YouTube 的通用提示文案（不含凭证），记下来区分
        // 机器人门还是别的 LOGIN_REQUIRED 成因。
        const status = String(root?.playabilityStatus?.status ?? '未知');
        const reason = typeof root?.playabilityStatus?.reason === 'string' ? root.playabilityStatus.reason : '';
        const subreason = typeof root?.playabilityStatus?.subreason === 'string' ? root.playabilityStatus.subreason : '';
        const psKeys = root?.playabilityStatus && typeof root.playabilityStatus === 'object' ? Object.keys(root.playabilityStatus).join(',') : '';
        console.log(`[Ytm] ${client.name} 不可用：playability=${status} reason=${reason} subreason=${subreason} 字段[${psKeys}]`);
        return { stream: null, loginRequired: status === 'LOGIN_REQUIRED', responded: true, responseVisitorData };
    }
    // 字幕轨与音频流同一次返回：只记条数与语种，不记地址与正文。
    const rawCaptions = root.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(rawCaptions)) {
        const tracks: YtmCaptionTrack[] = [];
        for (const raw of rawCaptions as Array<Record<string, unknown>>) {
            if (typeof raw.baseUrl === 'string' && raw.baseUrl &&
                typeof raw.languageCode === 'string' && raw.languageCode) {
                tracks.push({
                    baseUrl: raw.baseUrl,
                    languageCode: raw.languageCode,
                    kind: typeof raw.kind === 'string' ? raw.kind : undefined
                });
            }
        }
        storeYtmCaptions(videoId, tracks);
        if (tracks.length > 0) {
            console.log(`[Ytm] 字幕轨 ${tracks.length} 条：${tracks.map((t) => t.languageCode).join(',')}`);
        }
    }
    const formats = root.streamingData?.adaptiveFormats;
    if (!Array.isArray(formats)) {
        console.log(`[Ytm] ${client.name} 不可用：无 streamingData`);
        return { stream: null, loginRequired: false, responded: true, responseVisitorData };
    }
    let best: YtmStream | null = null;
    let bestBitrate = -1;
    for (const raw of formats as RawFormat[]) {
        // 只要纯音频 adaptiveFormats，且必须带直链 url；带 signatureCipher 而无
        // url 的项本块不解算，直接跳过。
        if (
            typeof raw.mimeType !== 'string' ||
            !raw.mimeType.startsWith('audio') ||
            typeof raw.url !== 'string' ||
            !raw.url
        ) {
            continue;
        }
        const bitrate = typeof raw.bitrate === 'number' ? raw.bitrate : 0;
        if (bitrate >= bestBitrate) {
            bestBitrate = bitrate;
            const contentLength =
                typeof raw.contentLength === 'string'
                    ? Number(raw.contentLength)
                    : typeof raw.contentLength === 'number'
                      ? raw.contentLength
                      : undefined;
            best = {
                url: raw.url,
                mimeType: raw.mimeType,
                bitrate,
                contentLength:
                    contentLength !== undefined && Number.isFinite(contentLength)
                        ? contentLength
                        : undefined,
                // 没显式 UA 时桥用 OkHttp 默认 UA 铸链，取流复用同一个串；
                // 客户端专属 UA（如 VISIONOS 的 Safari 串）优先于会话 UA。
                userAgent: client.userAgent ?? baseHeaders['User-Agent'] ?? 'okhttp/4.12.0'
            };
        }
    }
    if (best) {
        lastYtmStream = best;
        console.log(`[Ytm] 取链成功 ${client.name} ${best.mimeType} ${best.bitrate ?? 0}bps`);
        return { stream: best, loginRequired: false, responded: true, responseVisitorData };
    }
    console.log(`[Ytm] ${client.name} 不可用：无可用音频流`);
    return { stream: null, loginRequired: false, responded: true, responseVisitorData };
}

interface ChainResult {
    stream: YtmStream | null;
    sawLoginGate: boolean;
    sawResponse: boolean;
}

// 跑一遍回落链：每链熔断 2 次 LOGIN_REQUIRED（单首两链合计约 4 次取链）。
// 匿名答复带回的新 visitorData 比缓存的新：顺手换上（Folia 桥同款）。
async function runChain(
    videoId: string,
    baseHeaders: Record<string, string>,
    visitorData: string | null,
    isAnonymous: boolean
): Promise<ChainResult> {
    let sawLoginGate = false;
    let sawResponse = false;
    for (const client of PLAYER_CLIENTS) {
        const attempt = await tryPlayerClient(client, videoId, baseHeaders, visitorData);
        sawResponse = sawResponse || attempt.responded;
        if (isAnonymous && attempt.responseVisitorData) {
            anonymousVisitorData = attempt.responseVisitorData;
        }
        if (attempt.stream) {
            return { stream: attempt.stream, sawLoginGate, sawResponse };
        }
        if (attempt.loginRequired) {
            sawLoginGate = true;
            // 不再 2 连门就停链：Folia 是 5 腿全试，门可能是按客户端分的
            //（VISIONOS 新、ANDROID_VR 要 PO-token，这两腿先天难过），
            // 0.1.58 五腿全败是旧请求形态，新形态下 IOS/TV/ANDROID 从没试过；
            // 流量控制由门限流退避（gatedUntil）管，不靠停链。
        }
    }
    return { stream: null, sawLoginGate, sawResponse };
}

// 登录门错误标记：播放层据此立即停跳（不再连跳整单续门）。
// 不靠文案匹配——文案随时可改，标记跟错误走。
const YTM_GATE_MARK = 'ytmGate';

export function isYtmGateError(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error as Error & Record<string, unknown>)[YTM_GATE_MARK] === true
    );
}

function gateError(message: string): Error {
    const error = new Error(message);
    (error as Error & Record<string, unknown>)[YTM_GATE_MARK] = true;
    return error;
}

// 取链串行化（Folia 桥同款）：预取与播放可能同时问，一首一首答，
// 不再并发取链刷屏——并发是 0.1.62 日志里连点风暴的来源之一。
let resolveQueue: Promise<unknown> = Promise.resolve();

// 登录门限流：撞门即计 strike，退避 [10,20,40,60] 分钟；成功清零。
// 退避期内不再发请求（直接抛门错），不再拿新请求续门。
let gateStrikes = 0;
let gatedUntil = 0;
const GATE_BACKOFF_MINUTES = [10, 20, 40, 60];

// 0.1.125：手动点播清退避。退避原本防的是自动跳歌连烧整单，手动点播是
// 用户明确意图（典型场景：撞门→去梦盒换节点→回来点歌），不该被 10 分钟
// 退避吞掉——2026-10-31 真机日志里用户连点 5 次全是「限流保护中」未发
// 请求。playback.ts 只在用户手势入口 playQueue 里调本函数；自动推进与
// 跳歌循环不经过它，退避对自动路径照旧生效。撞门后退避会重新计起。
export function clearYtmGateBackoff(): void {
    if (gateStrikes > 0 || gatedUntil > Date.now()) {
        gateStrikes = 0;
        gatedUntil = 0;
        console.log('[Ytm] 手动点播，已清登录门退避，重新取链');
    }
}

// 门兜底节流：失败后 60 秒内不再开 WebView（成功不节流，见调用方）。
let lastGateProbeAt = 0;

// 撞门页面兜底（0.1.127；0.1.126 探针的判定落地）：真机探针实证——撞门时
// 真实 watch 页 playability=OK、streamingData 在，但格式全是
// signatureCipher（直链 0 条）、responseContext 无 visitorData。本兜底让
// 页面自己的播放器真起播，拦截它发往 googlevideo 的音频请求地址（页面
// 已解签的成品）直接拿来播；同时用 ytcfg 的 visitorData 试 B 路匿名
// 重试（0.1.126 里 B 因页面没给 visitorData 根本没试成、判定文案误报
// 「B 不通」，本版修正）。抽到的地址只记 host/itag/mime/长度，不打全文。
async function runGateProbe(videoId: string): Promise<YtmStream | null> {
    console.log('[YtmProbe] 撞门兜底开始：页面抽取（WebView 打开真实 watch 页并起播）');
    const page = await extractYtmViaPage(videoId);
    if (!page) {
        console.log('[YtmProbe] 页面兜底不可用（插件无回或非原生环境）');
        return null;
    }
    if (!page.ok) {
        console.log(`[YtmProbe] 页面侧未读到播放器响应：${page.err || '未知'}`);
        return null;
    }
    console.log(
        `[YtmProbe] 页面路径：playability=${page.status}${page.reason ? ' reason=' + page.reason : ''} streamingData=${page.hasStreaming ? '有' : '无'} 音频格式=${page.audioCount} 直链=${page.directCount} 页面visitorData=${page.visitorData ? '有（长度 ' + page.visitorData.length + '）' : '无'}`
    );
    if (page.audioUrl) {
        // 分段请求地址带 range/rn/sq，去掉才是整曲地址；其余参数（含
        // 签名与有效期）原样保留。
        let clean = page.audioUrl;
        let host = '';
        let itag = '';
        try {
            const u = new URL(page.audioUrl);
            host = u.host;
            itag = u.searchParams.get('itag') ?? '';
            u.searchParams.delete('range');
            u.searchParams.delete('rn');
            u.searchParams.delete('sq');
            clean = u.toString();
        } catch {
            // 地址解析不了就原样用（拦截所得本就是页面成品地址）。
        }
        console.log(
            `[YtmProbe] 页面抽取成功：host=${host} itag=${itag} mime=${page.audioMime || '未知'} 地址长度=${clean.length}，直接播放`
        );
        return { url: clean, mimeType: page.audioMime || 'audio/mp4' };
    }
    if (page.status !== 'OK') {
        console.log(`[YtmProbe] 判定：页面路径同样被挡（${page.status}），本轮兜底无路`);
        return null;
    }
    if (!page.visitorData) {
        console.log('[YtmProbe] 判定：页面通但未起播出地址（无拦截所得），且页面无 visitorData，B 路无从试起');
        return null;
    }
    const visionos = PLAYER_CLIENTS[0]!;
    const attempt = await tryPlayerClient(visionos, videoId, HEADERS, page.visitorData);
    if (attempt.stream) {
        console.log('[YtmProbe] 路径B（页面 visitorData 匿名重试 VISIONOS）：OK——卡点在请求上下文，已用 B 路直链直接播放');
        return attempt.stream;
    }
    console.log(
        `[YtmProbe] 路径B（页面 visitorData 匿名重试 VISIONOS）：${attempt.loginRequired ? 'LOGIN_REQUIRED' : '其他失败'}——页面通、B 不通、页面未起播出地址，本轮兜底失败`
    );
    return null;
}

export function resolveYtmStream(track: Track): Promise<YtmStream> {
    const run = resolveQueue.then(() => doResolveYtmStream(track));
    resolveQueue = run.catch(() => {});
    return run;
}

async function doResolveYtmStream(track: Track): Promise<YtmStream> {
    if (track.streamUrl) {
        // 已有直链时不再取链；mimeType 与 contentLength 只有取链响应才给得出。
        lastYtmStream = { url: track.streamUrl, mimeType: '' };
        return lastYtmStream;
    }
    const prefix = 'ytm:';
    if (!track.id.startsWith(prefix) || track.id.length === prefix.length) {
        throw new Error('这首歌不是 YTM 的曲目');
    }
    const videoId = track.id.slice(prefix.length);
    // 退避期内：不发请求，直接抛门错（播放层据此停跳）。
    if (Date.now() < gatedUntil) {
        console.log('[Ytm] 限流保护中，跳过本次取链（未发请求）');
        throw gateError('YTM 限流保护中，稍后再试');
    }
    console.log(`[Ytm] 取链 ${track.title}`);
    // 只剩匿名链：VISIONOS/ANDROID_VR 不认 web cookie 签名（Claude 第十五轮），
    // 登录链与匿名链实测同败，留着只会翻倍流量——0.1.63 起播放取链不再带会话。
    // 榜单仍走会话头（见 requestHeaders），登录本身不动。
    const anonVisitor = await ensureAnonymousVisitorData();
    if (!anonVisitor) {
        console.log('[Ytm] 匿名 visitorData 未取到，继续裸发');
    }
    const anon = await runChain(videoId, HEADERS, anonVisitor, true);
    if (anon.stream) {
        gateStrikes = 0;
        gatedUntil = 0;
        return anon.stream;
    }
    if (anon.sawLoginGate) {
        // 0.1.127 门兜底（0.1.126 探针判定落地）：撞门先跑页面抽取——
        // WebView 真实 watch 页起播、拦截页面自己的音频请求地址直接播；
        // 或用页面 visitorData 走 B 路重试。兜底失败后 60 秒内不再开
        // WebView（防整单连烧）；成功直接返回流、不计门 strike。兜底
        // 全程抛错不许影响撞门主流程。
        if (Date.now() - lastGateProbeAt > 60 * 1000) {
            lastGateProbeAt = Date.now();
            try {
                const probeStream = await runGateProbe(videoId);
                if (probeStream) {
                    gateStrikes = 0;
                    gatedUntil = 0;
                    return probeStream;
                }
            } catch {
                console.log('[YtmProbe] 页面兜底自身异常，忽略（不影响撞门处理）');
            }
        }
        gateStrikes += 1;
        const minutes = GATE_BACKOFF_MINUTES[Math.min(gateStrikes, GATE_BACKOFF_MINUTES.length) - 1]!;
        gatedUntil = Date.now() + minutes * 60 * 1000;
        console.log(`[Ytm] 撞登录门，限流保护 ${minutes} 分钟（连续 ${gateStrikes} 次）`);
        throw gateError('YTM 触发登录门（LOGIN_REQUIRED），请换网络或稍后再试');
    }
    console.log(`[Ytm] 全部客户端失败 ${track.title}`);
    if (!anon.sawResponse) {
        throw new Error('YTM 请求失败，请检查网络后重试');
    }
    throw new Error('这首歌在 YTM 上暂时播不了，请换一首试试');
}

export const ytmSource = new YtmSource();

// 海报墙用 YTM 榜单页热门专辑（第 6 块新增，全新写）：
// 实测（2026-10-25 沙箱 curl，无登录、无 cookie）：
// - 榜单页 POST https://music.youtube.com/youtubei/v1/browse，browseId
//   FEmusic_charts：WEB_REMIX 客户端回 400，ANDROID 20.10.38 回 200；
//   关键是 context.client 里不要带 visitorData 字段——带空字符串反而回 404，
//   不带字段直接回 200 且自带新的 visitorData。本函数按不带字段实现。
// - 该页回的轮播是新式 musicListItemCarouselModel（不是旧 renderer 树）：
//   本次实探只有「热门专辑」与「热门播客节目每周排行榜」两个轮播，没有
//   歌曲榜单轮播；所以本路取热门专辑轮播（其单项菜单里带 OLAK 开头的
//   watchPlaylistEndpoint.playlistId），播客轮播（PL 开头）直接跳过。
// - 专辑曲目 POST 同一 browse 端点，browseId 为 VL + 专辑 playlistId，
//   回 playlistVideoRenderer 数组（videoId、标题 runs、shortBylineText runs、
//   缩略图组），与搜索行的解析方式同源，可直接转 Track。
// 单张专辑取曲失败只跳过该张；榜单页本身失败则抛错，由调用方给中文提示。
const BROWSE_URL = 'https://music.youtube.com/youtubei/v1/browse';
const CHART_BROWSE_ID = 'FEmusic_charts';
const CHART_ALBUM_LIMIT = 3;
const CHART_ALBUM_TRACK_LIMIT = 20;

interface YtmCarouselItem {
    title?: unknown;
    subtitle?: unknown;
    thumbnail?: {
        image?: { sources?: unknown } | null;
    } | null;
}

interface YtmCarousel {
    header?: { title?: unknown } | null;
    items?: unknown;
}

interface YtmPlaylistVideo {
    videoId?: unknown;
    title?: { runs?: unknown } | null;
    shortBylineText?: { runs?: unknown } | null;
    thumbnail?: { thumbnails?: unknown } | null;
}

function collectCarousels(node: unknown, out: YtmCarousel[]): void {
    if (Array.isArray(node)) {
        for (const child of node) {
            collectCarousels(child, out);
        }
        return;
    }
    if (node === null || typeof node !== 'object') {
        return;
    }
    const record = node as Record<string, unknown>;
    const carousel = record.musicListItemCarouselModel;
    if (carousel !== null && typeof carousel === 'object') {
        out.push(carousel as YtmCarousel);
    }
    for (const child of Object.values(record)) {
        collectCarousels(child, out);
    }
}

function findAlbumPlaylistId(node: unknown): string | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findAlbumPlaylistId(child);
            if (found) {
                return found;
            }
        }
        return null;
    }
    if (node === null || typeof node !== 'object') {
        return null;
    }
    const record = node as Record<string, unknown>;
    const endpoint = record.watchPlaylistEndpoint as { playlistId?: unknown } | null;
    if (
        endpoint !== null &&
        typeof endpoint === 'object' &&
        typeof endpoint.playlistId === 'string' &&
        endpoint.playlistId.startsWith('OLAK')
    ) {
        return endpoint.playlistId;
    }
    for (const child of Object.values(record)) {
        const found = findAlbumPlaylistId(child);
        if (found) {
            return found;
        }
    }
    return null;
}

function largestThumbnailSource(sources: unknown): string | undefined {
    if (!Array.isArray(sources)) {
        return undefined;
    }
    let bestUrl: string | undefined;
    let bestWidth = -1;
    for (const raw of sources as RawThumbnail[]) {
        const width = typeof raw.width === 'number' ? raw.width : 0;
        if (typeof raw.url === 'string' && raw.url && width >= bestWidth) {
            bestUrl = raw.url;
            bestWidth = width;
        }
    }
    return bestUrl;
}

function collectPlaylistVideos(node: unknown, out: YtmPlaylistVideo[]): void {
    if (Array.isArray(node)) {
        for (const child of node) {
            collectPlaylistVideos(child, out);
        }
        return;
    }
    if (node === null || typeof node !== 'object') {
        return;
    }
    const record = node as Record<string, unknown>;
    const video = record.playlistVideoRenderer;
    if (video !== null && typeof video === 'object') {
        out.push(video as YtmPlaylistVideo);
    }
    for (const child of Object.values(record)) {
        collectPlaylistVideos(child, out);
    }
}

function playlistVideoToTrack(raw: YtmPlaylistVideo): Track | null {
    if (typeof raw.videoId !== 'string' || !raw.videoId) {
        return null;
    }
    const titleRuns = raw.title?.runs;
    const title = Array.isArray(titleRuns)
        ? (titleRuns as RawRun[]).map(runText).join('')
        : '';
    const artistRuns = raw.shortBylineText?.runs;
    const artist = Array.isArray(artistRuns)
        ? (artistRuns as RawRun[]).map(runText).filter((text) => text).join('、')
        : '';
    return {
        id: `ytm:${raw.videoId}`,
        title: title || '未知曲名',
        artist: artist || '未知歌手',
        coverUrl: largestThumbnailSource(raw.thumbnail?.thumbnails),
        source: 'ytm'
    };
}

// 0.1.110 WEB_REMIX 轮播卡片：WEB_REMIX 的 home/charts 响应里没有
// musicListItemCarouselModel / playlistVideoRenderer，轮播架是
// musicCarouselShelfRenderer，里面是 musicTwoRowItemRenderer 卡片
// （标题 runs、副标题 runs、musicThumbnailRenderer 封面、
// navigationEndpoint.browseEndpoint.browseId 是 VL… 歌单）。
// 卡片本身不是单曲，展开卡片取曲与榜单专辑同路。
interface YtmTwoRowCard {
    title: string;
    subtitle: string;
    coverUrl?: string;
    browseId: string;
}

function collectTwoRowCards(node: unknown, out: YtmTwoRowCard[]): void {
    if (Array.isArray(node)) {
        for (const child of node) {
            collectTwoRowCards(child, out);
        }
        return;
    }
    if (node === null || typeof node !== 'object') {
        return;
    }
    const record = node as Record<string, unknown>;
    const item = record.musicTwoRowItemRenderer as Record<string, unknown> | null;
    if (item !== null && typeof item === 'object') {
        const nav = item.navigationEndpoint as Record<string, unknown> | null;
        const browse = nav?.browseEndpoint as Record<string, unknown> | null;
        const browseId = browse?.browseId;
        if (typeof browseId === 'string' && browseId.startsWith('VL')) {
            const thumb = item.thumbnailRenderer as Record<string, unknown> | null;
            const musicThumb = thumb?.musicThumbnailRenderer as Record<string, unknown> | null;
            const thumbnail = musicThumb?.thumbnail as Record<string, unknown> | null;
            const title = item.title as Record<string, unknown> | null;
            const subtitle = item.subtitle as Record<string, unknown> | null;
            out.push({
                title: Array.isArray(title?.runs)
                    ? (title.runs as RawRun[]).map(runText).join('')
                    : '',
                subtitle: Array.isArray(subtitle?.runs)
                    ? (subtitle.runs as RawRun[]).map(runText).join('')
                    : '',
                coverUrl: largestThumbnailSource(thumbnail?.thumbnails),
                browseId
            });
        }
    }
    for (const child of Object.values(record)) {
        collectTwoRowCards(child, out);
    }
}

// 0.1.110 卡片展开：twoRow 卡片给的是歌单 browseId，展开后两种单曲
// 形态都要（playlistVideoRenderer 与 musicResponsiveListItemRenderer，
// VL 歌单在 ANDROID 与 WEB_REMIX 下各出一种）。
async function expandCardTracks(browseId: string, limit: number): Promise<Track[]> {
    const playlist = await browseYtm(browseId);
    const tracks: Track[] = [];
    const seen = new Set<string>();
    const push = (track: Track | null): void => {
        if (!track || seen.has(track.id) || tracks.length >= limit) {
            return;
        }
        seen.add(track.id);
        tracks.push(track);
    };
    const videos: YtmPlaylistVideo[] = [];
    collectPlaylistVideos(playlist, videos);
    for (const video of videos) {
        push(playlistVideoToTrack(video));
    }
    const items: RawListItem[] = [];
    collectListItems(playlist, items);
    for (const item of items) {
        push(toTrack(item));
    }
    return tracks;
}

async function browseYtm(browseId: string): Promise<unknown> {
    // 榜单页 browse 的铁律（见文件头沙箱实测）：
    // 1) context.client 里绝不带 visitorData 字段——带空串回 404，不带回 200。
    //    所以“先搜一次拿 visitorData 再 browse”对榜单无效；visitorData 只对
    //    取链（player）有用，那边已有搜索缓存兜底。
    // 2) 0.1.102 前回落只换移动端 client；但 2026-10-29 真机上移动端榜单
    //    全灭（热碟 ANDROID→IOS，IOS 回 500；探针里 ANDROID_MUSIC 7.55.52
    //    榜单对照臂回 404），而同机 WEB_REMIX gl=US 会话首页能通
    //    （今日星荐 20 首）。所以移动端全灭后加一臂 WEB_REMIX gl=US 会话
    //    （Origin/Referer 头，context 里仍不带 visitorData）；旧“WEB_REMIX
    //    榜单回 400”是 2026-10-25 无登录沙箱结论，不再作数。
    // 成功响应自带的 visitorData 顺手缓存，供后续取链用。
    const clients = PLAYER_CLIENTS.filter(
        (client) => client.name === 'ANDROID' || client.name === 'IOS'
    );
    interface BrowseAttempt {
        label: string;
        contextClient: Record<string, unknown>;
        headers: Record<string, string>;
    }
    const attempts: BrowseAttempt[] = [];
    for (const client of clients) {
        const contextClient: Record<string, unknown> = {
            clientName: client.name,
            clientVersion: client.version,
            hl: 'zh-CN',
            gl: 'CN'
        };
        if (client.deviceMake) {
            contextClient.deviceMake = client.deviceMake;
        }
        if (client.deviceModel) {
            contextClient.deviceModel = client.deviceModel;
        }
        if (client.osName) {
            contextClient.osName = client.osName;
        }
        if (client.osVersion) {
            contextClient.osVersion = client.osVersion;
        }
        attempts.push({ label: client.name, contextClient, headers: requestHeaders() });
    }
    attempts.push({
        label: 'WEB_REMIX',
        contextClient: {
            clientName: SEARCH_CLIENT.name,
            clientVersion: SEARCH_CLIENT.version,
            hl: 'zh-CN',
            gl: 'US'
        },
        headers: {
            ...requestHeaders(),
            Origin: 'https://music.youtube.com',
            Referer: 'https://music.youtube.com',
            'X-Origin': 'https://music.youtube.com'
        }
    });
    // 回落链上各臂失败的原因：定位用，不再只抛通用话术。
    const statuses: string[] = [];
    let lastNetwork = false;
    let lastTimeout = false;
    let lastParse = false;
    let lastTooLarge = false;
    let lastBody = '';
    for (const attempt of attempts) {
        const body = JSON.stringify({
            context: { client: attempt.contextClient },
            browseId
        });
        lastBody = '';
        try {
            const response = await httpPost(`${BROWSE_URL}?key=${INNERTUBE_KEY}`, body, attempt.headers);
            if (response.status !== 200) {
                statuses.push(`${attempt.label} ${response.status}`);
                continue;
            }
            lastBody = response.body;
            const parsed = JSON.parse(response.body) as unknown;
            const visitorData = (parsed as { responseContext?: { visitorData?: unknown } })
                .responseContext?.visitorData;
            if (typeof visitorData === 'string' && visitorData.length > 0) {
                cachedVisitorData = visitorData;
            }
            return parsed;
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (message.includes('超时')) {
                lastTimeout = true;
            } else if (message.includes('网络')) {
                lastNetwork = true;
            } else if (message.includes('响应体过大')) {
                // 桥主动中断的响应不要再冒充解析失败，否则诊断会误显示“空响应”。
                lastTooLarge = true;
            } else {
                lastParse = true;
            }
            continue;
        }
    }
    if (statuses.length > 0) {
        throw new Error(`YTM 榜单加载失败（${statuses.join('，')}）`);
    }
    if (lastTimeout) {
        throw new Error('YTM 榜单加载失败（请求超时）');
    }
    if (lastNetwork) {
        throw new Error('YTM 榜单加载失败（网络异常）');
    }
    if (lastTooLarge) {
        throw new Error('YTM 榜单加载失败（响应过大，超过上限）');
    }
    if (lastParse) {
        const detail = `YTM 榜单加载失败（返回异常：${bodySnippet(lastBody)}）`;
        console.error(detail);
        throw new Error(detail);
    }
    throw new Error('YTM 榜单加载失败，请稍后重试');
}

export async function fetchYtmChartPosters(): Promise<Poster[]> {
    const charts = await browseYtm(CHART_BROWSE_ID);
    const carousels: YtmCarousel[] = [];
    collectCarousels(charts, carousels);
    const posters: Poster[] = [];
    for (const carousel of carousels) {
        if (posters.length >= CHART_ALBUM_LIMIT) {
            break;
        }
        if (!Array.isArray(carousel.items)) {
            continue;
        }
        for (const raw of carousel.items as YtmCarouselItem[]) {
            if (posters.length >= CHART_ALBUM_LIMIT) {
                break;
            }
            const playlistId = findAlbumPlaylistId(raw);
            if (!playlistId) {
                // 没有 OLAK 专辑歌单（如播客轮播项）直接跳过。
                continue;
            }
            try {
                const playlist = await browseYtm(`VL${playlistId}`);
                const videos: YtmPlaylistVideo[] = [];
                collectPlaylistVideos(playlist, videos);
                const tracks: Track[] = [];
                for (const video of videos) {
                    if (tracks.length >= CHART_ALBUM_TRACK_LIMIT) {
                        break;
                    }
                    const track = playlistVideoToTrack(video);
                    if (track) {
                        tracks.push(track);
                    }
                }
                if (tracks.length === 0) {
                    continue;
                }
                const title = typeof raw.title === 'string' && raw.title ? raw.title : 'YTM 热门专辑';
                const subtitle = typeof raw.subtitle === 'string' ? raw.subtitle : undefined;
                posters.push({
                    id: `ytm-chart:${playlistId}`,
                    title,
                    subtitle: subtitle || undefined,
                    coverUrl:
                        largestThumbnailSource(raw.thumbnail?.image?.sources) ??
                        tracks.find((track) => track.coverUrl)?.coverUrl,
                    source: 'ytm',
                    tracks
                });
            } catch {
                // 单张专辑失败跳过，不拖垮整路。
                continue;
            }
        }
    }
    if (posters.length === 0) {
        // 0.1.110 WEB_REMIX 榜单没有 musicListItemCarouselModel，轮播架是
        // twoRow 卡片：展开前几张卡片取曲当海报，空卡片跳过。
        const cards: YtmTwoRowCard[] = [];
        collectTwoRowCards(charts, cards);
        const seenCards = new Set<string>();
        for (const card of cards) {
            if (posters.length >= CHART_ALBUM_LIMIT) {
                break;
            }
            if (seenCards.has(card.browseId)) {
                continue;
            }
            seenCards.add(card.browseId);
            try {
                const tracks = await expandCardTracks(card.browseId, CHART_ALBUM_TRACK_LIMIT);
                if (tracks.length === 0) {
                    continue;
                }
                posters.push({
                    id: `ytm-chart:${card.browseId}`,
                    title: card.title || 'YTM 热门专辑',
                    subtitle: card.subtitle || undefined,
                    coverUrl: card.coverUrl ?? tracks.find((track) => track.coverUrl)?.coverUrl,
                    source: 'ytm',
                    tracks
                });
            } catch {
                continue;
            }
        }
    }
    return posters;
}

// 0.1.81 YTM 每日推荐（今日星荐）：登录态下 browse 首页 FEmusic_home，
// 取个性化 feed 里的单曲项。首页结构未在沙箱实探过，故解析走通用口径：
// playlistVideoRenderer（榜单同源）+ musicResponsiveListItemRenderer
// （playlistItemData.videoId + flexColumns 标题/歌手 + 缩略图组）两路并行
// 收集、按 videoId 去重、上限 30 首；首页拿不到任何单曲即抛错，
// 调用方只显示中文提示，不拿榜单专辑冒充每日推荐。
// 0.1.82 YTM 首页探针：FEmusic_home 在 ANDROID/IOS 会话下同回 400，
// 而榜单 FEmusic_charts 同函数同会话头能通——先分臂测，不改每日取数。
// 臂只变一个量：client / 会话头 / 地区 / visitorData；每臂只记状态与
// 是否含单曲项，不记任何会话值；全部臂跑完才算完成，单臂异常不中断。
// 0.1.84 YTM 首页探针 v3（Claude 第三轮排序，0.1.83 的 7 臂全败、400/404 分化）：
// 每臂只记状态、体长、有无单曲项；非 200 时再记 error 信封（code/status/
// message 前 200 字/reason），解析失败则脱敏截断，绝不记请求头与会话值。
// 四臂：WEB_REMIX 旧版 gl=US、ANDROID_MUSIC 7.21.50、WEB_REMIX 当日版 gl=US、榜单对照 7.55.52。
// 每日取数逻辑不动，探针出 200 再定。
function logProbeError(body: string): string {
    try {
        const parsed = JSON.parse(body) as {
            error?: {
                code?: unknown;
                status?: unknown;
                message?: unknown;
                errors?: Array<{ reason?: unknown }>;
            };
        };
        const err = parsed.error;
        if (err && typeof err === 'object') {
            const message = typeof err.message === 'string' ? err.message.slice(0, 200) : '';
            const reason = Array.isArray(err.errors) && typeof err.errors[0]?.reason === 'string'
                ? (err.errors[0] as { reason: string }).reason
                : '';
            return `error=${String(err.code ?? '')}/${String(err.status ?? '')} msg=${message} reason=${reason}`;
        }
    } catch {
        // 解析失败时走脱敏截断，不贴原始体。
    }
    const stripped = body
        .replace(/"?\s*(Cookie|SAPISID|Authorization|visitorData)\s*"?\s*[:=]\s*[^,}\s"]+/gi, '$1=[已脱敏]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    return `raw=${stripped || '空响应'}`;
}

export async function probeYtmHome(): Promise<void> {
    const android = PLAYER_CLIENTS.find((client) => client.name === 'ANDROID');
    // 探针 v3（Claude 第三轮排序）：7.55.52 只留给第 4 臂榜单对照（定 404 是拒版本还是仅拒 home），
    // home 臂改测 ytmusicapi_dart asMobile 用的 7.21.50；sdk 版沿用公开 androidMusic 定义的 34。
    const androidMusic7552: InnertubeClient = {
        name: 'ANDROID_MUSIC',
        version: '7.55.52',
        userAgent: 'com.google.android.apps.youtube.music/7.55.52 (Linux; U; Android 14) gzip',
        clientNameId: 21,
        androidSdkVersion: 34
    };
    const androidMusic72150: InnertubeClient = {
        name: 'ANDROID_MUSIC',
        version: '7.21.50',
        userAgent: 'com.google.android.apps.youtube.music/7.21.50 (Linux; U; Android 14) gzip',
        clientNameId: 21,
        androidSdkVersion: 34
    };
    // 当日版 WEB_REMIX：只换版号，其余同 SEARCH_CLIENT（无专属 UA，走会话 UA）。
    const webRemixToday: InnertubeClient = { ...SEARCH_CLIENT, version: '1.20261028.01.00' };
    type ProbeArm = {
        label: string;
        client: InnertubeClient;
        session: boolean;
        hl: string;
        gl: string;
        visitor: boolean;
        browseId: string;
        apiKey?: string;
        extraHeaders?: Record<string, string>;
        musicOrigin?: boolean;
        clientHeaders?: boolean;
    };
    const webRemixExtra: Record<string, string> = {
        Origin: 'https://music.youtube.com',
        Referer: 'https://music.youtube.com',
        'X-Origin': 'https://music.youtube.com'
    };
    if (cachedVisitorData) {
        webRemixExtra['X-Goog-Visitor-Id'] = cachedVisitorData;
    } else {
        console.log('[Ytm] 首页探针 v3：WEB_REMIX 臂无缓存 visitorData，X-Goog-Visitor-Id 省略');
    }
    const arms: ProbeArm[] = [];
    // 第 1 臂：WEB_REMIX 旧版 + gl=US（v2 修头臂唯一变量是 gl；hl 保持 zh-CN，同搜索修复口径）。
    arms.push({ label: 'WEB_REMIX·旧版·gl=US·会话', client: SEARCH_CLIENT, session: true, hl: 'zh-CN', gl: 'US', visitor: true, browseId: 'FEmusic_home', extraHeaders: webRemixExtra });
    // 第 2 臂：ANDROID_MUSIC 7.21.50 跑 home（同 v2 第 2 臂形状，只换版本）。
    if (android) {
        arms.push({ label: 'ANDROID_MUSIC 7.21.50·会话·CN', client: androidMusic72150, session: true, hl: 'zh-CN', gl: 'CN', visitor: false, browseId: 'FEmusic_home', clientHeaders: true });
    }
    // 第 3 臂：WEB_REMIX 当日版 + gl=US（同第 1 臂，只换版号；主要在第 1 臂 400 时有信息量）。
    arms.push({ label: 'WEB_REMIX·当日版·gl=US·会话', client: webRemixToday, session: true, hl: 'zh-CN', gl: 'US', visitor: true, browseId: 'FEmusic_home', extraHeaders: webRemixExtra });
    // 第 4 臂：榜单对照 + ANDROID_MUSIC 7.55.52（定 404 是全 browse 拒版本还是仅拒 home）。
    arms.push({ label: '对照·FEmusic_charts·ANDROID_MUSIC 7.55.52·会话·CN', client: androidMusic7552, session: true, hl: 'zh-CN', gl: 'CN', visitor: false, browseId: 'FEmusic_charts', clientHeaders: true });
    console.log(`[Ytm] 首页探针 v3：开始（共 ${arms.length} 臂）`);
    for (const arm of arms) {
        const contextClient: Record<string, unknown> = {
            clientName: arm.client.name,
            clientVersion: arm.client.version,
            hl: arm.hl,
            gl: arm.gl
        };
        if (arm.client.deviceMake) {
            contextClient.deviceMake = arm.client.deviceMake;
        }
        if (arm.client.deviceModel) {
            contextClient.deviceModel = arm.client.deviceModel;
        }
        if (arm.client.osName) {
            contextClient.osName = arm.client.osName;
        }
        if (arm.client.osVersion) {
            contextClient.osVersion = arm.client.osVersion;
        }
        if (arm.client.clientNameId) {
            contextClient.clientNameId = arm.client.clientNameId;
        }
        if (arm.client.androidSdkVersion) {
            contextClient.androidSdkVersion = arm.client.androidSdkVersion;
        }
        if (arm.visitor && cachedVisitorData) {
            contextClient.visitorData = cachedVisitorData;
        }
        let headers: Record<string, string> = arm.session ? requestHeaders() : HEADERS;
        if (arm.extraHeaders) {
            headers = { ...headers, ...arm.extraHeaders };
        }
        if (arm.musicOrigin) {
            const session = loadYtmSession();
            const musicHash = session ? sapisidHash(session.cookie, 'https://music.youtube.com') : null;
            if (musicHash) {
                headers = { ...headers, Authorization: musicHash, 'X-Origin': 'https://music.youtube.com' };
            } else {
                console.log(`[Ytm] 首页探针 v3 ${arm.label}：无会话，music-origin 签名省略`);
            }
        }
        if (arm.clientHeaders) {
            if (arm.client.clientNameId) {
                headers = { ...headers, 'X-YouTube-Client-Name': String(arm.client.clientNameId) };
            }
            headers = { ...headers, 'X-YouTube-Client-Version': arm.client.version };
            if (arm.client.userAgent) {
                headers = { ...headers, 'User-Agent': arm.client.userAgent };
            }
        }
        const body = JSON.stringify({
            context: { client: contextClient },
            browseId: arm.browseId
        });
        try {
            const response = await httpPost(
                `${BROWSE_URL}?key=${arm.apiKey ?? INNERTUBE_KEY}`,
                body,
                headers
            );
            // 0.1.110：WEB_REMIX 首页只有 twoRow 卡片，也算有内容（可展开取曲）。
            const hasItems = response.body.includes('musicResponsiveListItemRenderer')
                || response.body.includes('playlistVideoRenderer')
                || response.body.includes('musicTwoRowItemRenderer');
            // 对照臂以 status 200 为通过，单曲项标志只作参考（榜单响应结构不同）。
            const extra = response.status !== 200 ? ` ${logProbeError(response.body)}` : '';
            console.log(`[Ytm] 首页探针 v3 ${arm.label}：status=${response.status} len=${response.body.length} 单曲项=${hasItems ? '有' : '无'}${extra}`);
        } catch (error) {
            console.log(`[Ytm] 首页探针 v3 ${arm.label}：异常 ${error instanceof Error ? error.message : '未知原因'}`);
        }
    }
    console.log('[Ytm] 首页探针 v3：完成');
}

// 0.1.85 今日星荐取数：不再走 browseYtm() 的 ANDROID/IOS 回落（移动端家族
// 拒 home 参数，探针 v2/v3 已实证），改走探针 v3 第 1 臂原样：WEB_REMIX 旧版
// + gl=US（hl 保持 zh-CN，会话头 + 修头，缓存 visitorData 才带）。
// 榜单等其他 browse 路径不动，仍走 browseYtm()。
async function browseYtmHome(): Promise<unknown> {
    const contextClient: Record<string, unknown> = {
        clientName: SEARCH_CLIENT.name,
        clientVersion: SEARCH_CLIENT.version,
        hl: 'zh-CN',
        gl: 'US'
    };
    if (cachedVisitorData) {
        contextClient.visitorData = cachedVisitorData;
    }
    const headers: Record<string, string> = {
        ...requestHeaders(),
        Origin: 'https://music.youtube.com',
        Referer: 'https://music.youtube.com',
        'X-Origin': 'https://music.youtube.com'
    };
    if (cachedVisitorData) {
        headers['X-Goog-Visitor-Id'] = cachedVisitorData;
    }
    const body = JSON.stringify({
        context: { client: contextClient },
        browseId: 'FEmusic_home'
    });
    let response;
    try {
        response = await httpPost(`${BROWSE_URL}?key=${INNERTUBE_KEY}`, body, headers);
    } catch {
        throw new Error('YTM 榜单加载失败（网络异常）');
    }
    if (response.status !== 200) {
        throw new Error(`YTM 榜单加载失败（HTTP ${response.status}）`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body) as unknown;
    } catch {
        throw new Error('YTM 榜单加载失败（返回异常）');
    }
    const visitorData = (parsed as { responseContext?: { visitorData?: unknown } })
        .responseContext?.visitorData;
    if (typeof visitorData === 'string' && visitorData.length > 0) {
        cachedVisitorData = visitorData;
    }
    return parsed;
}

export async function fetchYtmDailyTracks(): Promise<Track[]> {
    // 0.1.82：browseYtm 的报错文案是榜单共用的“YTM 榜单加载失败”，
    // 每日推荐这里翻成“YTM 今日星荐加载失败”，不再让每日失败顶着榜单名。
    let home: unknown;
    try {
        home = await browseYtmHome();
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('YTM 榜单加载失败')) {
            throw new Error(error.message.replace('YTM 榜单加载失败', 'YTM 今日星荐加载失败'));
        }
        throw error;
    }
    const tracks: Track[] = [];
    const seen = new Set<string>();
    const pushTrack = (track: Track | null): void => {
        if (!track || seen.has(track.id)) {
            return;
        }
        seen.add(track.id);
        tracks.push(track);
    };
    const videos: YtmPlaylistVideo[] = [];
    collectPlaylistVideos(home, videos);
    for (const video of videos) {
        pushTrack(playlistVideoToTrack(video));
    }
    const collectListItems = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (const child of node) {
                collectListItems(child);
            }
            return;
        }
        if (node === null || typeof node !== 'object') {
            return;
        }
        const record = node as Record<string, unknown>;
        const item = record.musicResponsiveListItemRenderer as RawListItem | null;
        if (item !== null && typeof item === 'object') {
            const videoId =
                typeof item.playlistItemData?.videoId === 'string'
                    ? item.playlistItemData.videoId
                    : null;
            if (videoId) {
                const title = columnText(item, 0);
                const artist = columnText(item, 1);
                pushTrack({
                    id: `ytm:${videoId}`,
                    title: title || '未知曲名',
                    artist: artist || '未知歌手',
                    coverUrl: largestThumbnailSource(
                        item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
                    ),
                    source: 'ytm'
                });
            }
        }
        for (const child of Object.values(record)) {
            collectListItems(child);
        }
    };
    collectListItems(home);
    if (tracks.length === 0) {
        // 0.1.110 WEB_REMIX 首页没有单曲项，只有 twoRow 歌单卡片：
        // 展开前几张卡片取曲，仍为空才算真的拿不到。
        const cards: YtmTwoRowCard[] = [];
        collectTwoRowCards(home, cards);
        const seenCards = new Set<string>();
        for (const card of cards) {
            if (tracks.length >= 30) {
                break;
            }
            if (seenCards.has(card.browseId)) {
                continue;
            }
            seenCards.add(card.browseId);
            try {
                const expanded = await expandCardTracks(card.browseId, 30);
                for (const track of expanded) {
                    pushTrack(track);
                }
            } catch {
                continue;
            }
        }
    }
    if (tracks.length === 0) {
        console.log('[Ytm] 每日推荐首页无单曲，browse 回了空 feed');
        throw new Error('YTM 每日推荐暂时拿不到，请登录后再试');
    }
    return tracks.slice(0, 30);
}
