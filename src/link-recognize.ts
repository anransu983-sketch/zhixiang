// 链接识别（借鉴 NeriPlayer 链接识别）：搜索框粘贴链接或整段
// 分享文案时，先提取第一个 URL 识别平台与目标，识别成功直接
// 打开对应曲目/歌单；识别不了回落普通搜索并在日志记原因。
import { httpGet } from './native/http';
import { fetchBilibiliVideoTrack } from './sources/bilibili';
import { fetchNeteasePlaylistTracks, fetchNeteaseSongTrack } from './sources/netease';
import { fetchYtmPlaylistTracks, fetchYtmVideoTrack } from './sources/ytm';
import type { Track } from './types';

export type LinkResult =
    | { kind: 'tracks'; tracks: Track[]; autoplay: boolean; label: string }
    | {
          kind: 'playlist';
          cacheKey: string;
          label: string;
          fetchFresh: () => Promise<Track[]>;
      }
    | { kind: 'error'; message: string };

const URL_PATTERN = /https?:\/\/[^\s"'<>）)】]+/i;
const BARE_PATTERN =
    /(?:music\.163\.com|y\.music\.163\.com|bilibili\.com|b23\.tv|music\.youtube\.com)\/[^\s"'<>）)】]+/i;

export function extractFirstUrl(text: string): string | null {
    const withScheme = text.match(URL_PATTERN);
    if (withScheme) {
        return withScheme[0];
    }
    const bare = text.match(BARE_PATTERN);
    return bare ? `https://${bare[0]}` : null;
}

type ParsedLink =
    | { type: 'netease-song'; id: number }
    | { type: 'netease-playlist'; id: number }
    | { type: 'bili'; bvid: string; page: number }
    | { type: 'bili-short'; url: string }
    | { type: 'ytm-video'; videoId: string }
    | { type: 'ytm-playlist'; listId: string };

function parseLink(url: string): ParsedLink | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const host = parsed.hostname.toLowerCase();
    const full = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (host === 'music.163.com' || host === 'y.music.163.com') {
        const playlist = full.match(/playlist\?id=(\d+)/) ?? full.match(/\/playlist\/(\d+)/);
        if (playlist) {
            return { type: 'netease-playlist', id: Number(playlist[1]) };
        }
        const song = full.match(/song\?id=(\d+)/) ?? full.match(/\/song\/(\d+)/);
        if (song) {
            return { type: 'netease-song', id: Number(song[1]) };
        }
        return null;
    }
    if (host === 'b23.tv') {
        return { type: 'bili-short', url };
    }
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
        const video = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
        if (video) {
            const pageRaw = Number(parsed.searchParams.get('p'));
            return {
                type: 'bili',
                bvid: video[1]!,
                page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1
            };
        }
        return null;
    }
    if (host === 'music.youtube.com') {
        if (parsed.pathname.startsWith('/playlist')) {
            const listId = parsed.searchParams.get('list');
            return listId ? { type: 'ytm-playlist', listId } : null;
        }
        if (parsed.pathname.startsWith('/watch')) {
            const videoId = parsed.searchParams.get('v');
            const listId = parsed.searchParams.get('list');
            if (videoId) {
                return { type: 'ytm-video', videoId };
            }
            return listId ? { type: 'ytm-playlist', listId } : null;
        }
        return null;
    }
    return null;
}

// b23 短链：桥不回最终 URL，跟随重定向后的页面正文里找 BV 号；
// 找不到就诚实失败，不瞎猜。
async function resolveBiliShort(url: string): Promise<{ bvid: string; page: number } | null> {
    try {
        const res = await httpGet(url);
        const match = res.body.match(/\/video\/(BV[0-9A-Za-z]{10})/) ??
            res.body.match(/"bvid"\s*:\s*"(BV[0-9A-Za-z]{10})"/);
        if (!match) {
            console.log('[Link] 识别失败：b23 短链页面里没找到 BV 号');
            return null;
        }
        const pageMatch = res.body.match(/[?&]p=(\d+)/);
        const pageRaw = pageMatch ? Number(pageMatch[1]) : 1;
        return { bvid: match[1]!, page: pageRaw > 1 ? pageRaw : 1 };
    } catch (error) {
        console.log(
            `[Link] 识别失败：b23 短链请求失败 ${error instanceof Error ? error.message : ''}`
        );
        return null;
    }
}

// 搜索提交时调：无链接或识别不了回 null（调用方走普通搜索）。
export async function tryRecognizeLink(query: string): Promise<LinkResult | null> {
    const url = extractFirstUrl(query);
    if (!url) {
        return null;
    }
    const parsed = parseLink(url);
    if (!parsed) {
        console.log(`[Link] 识别失败：不支持的链接 ${url.slice(0, 80)}`);
        return null;
    }
    switch (parsed.type) {
        case 'netease-song': {
            const track = await fetchNeteaseSongTrack(parsed.id);
            if (!track) {
                console.log(`[Link] 识别失败：网易云歌曲 ${parsed.id} 拿不到`);
                return null;
            }
            console.log(`[Link] 已识别网易云歌曲：${track.title}`);
            return { kind: 'tracks', tracks: [track], autoplay: true, label: '已识别链接' };
        }
        case 'netease-playlist': {
            console.log(`[Link] 已识别网易云歌单：${parsed.id}`);
            return {
                kind: 'playlist',
                cacheKey: `netease:${parsed.id}`,
                label: '已识别网易云歌单',
                fetchFresh: () => fetchNeteasePlaylistTracks(parsed.id)
            };
        }
        case 'bili-short': {
            const resolved = await resolveBiliShort(parsed.url);
            if (!resolved) {
                return null;
            }
            return biliResult(resolved.bvid, resolved.page);
        }
        case 'bili':
            return biliResult(parsed.bvid, parsed.page);
        case 'ytm-video': {
            const track = await fetchYtmVideoTrack(parsed.videoId);
            if (!track) {
                console.log(`[Link] 识别失败：YTM 歌曲 ${parsed.videoId} 拿不到`);
                return null;
            }
            console.log(`[Link] 已识别 YTM 歌曲：${track.title}`);
            return { kind: 'tracks', tracks: [track], autoplay: true, label: '已识别链接' };
        }
        case 'ytm-playlist': {
            console.log(`[Link] 已识别 YTM 歌单：${parsed.listId}`);
            return {
                kind: 'playlist',
                cacheKey: `ytm:${parsed.listId}`,
                label: '已识别 YTM 歌单',
                fetchFresh: async () => {
                    const tracks = await fetchYtmPlaylistTracks(parsed.listId);
                    if (tracks.length === 0) {
                        throw new Error('YTM 歌单暂时拿不到，请稍后重试');
                    }
                    return tracks;
                }
            };
        }
    }
}

async function biliResult(bvid: string, page: number): Promise<LinkResult | null> {
    const track = await fetchBilibiliVideoTrack(bvid, page);
    if (!track) {
        console.log(`[Link] 识别失败：B 站视频 ${bvid} 拿不到`);
        return null;
    }
    console.log(`[Link] 已识别 B 站视频：${track.title}`);
    return { kind: 'tracks', tracks: [track], autoplay: true, label: '已识别链接' };
}
