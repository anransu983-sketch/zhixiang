// 网易云听歌排行（本周／全部）：
// 口径核实结论——Folia 的 listeningRank.ts 只是通用壳（集合命名、
// week/all 两档、按账号隔离、分页切片），里面没有网易云适配，
// 网上也未核到 Folia 的网易云排行适配文件；故不照搬 Folia，
// 直接用网易云公开的听歌记录端点：
//   GET https://music.163.com/api/v1/play/record?uid=<uid>&type=1（周）
//   GET https://music.163.com/api/v1/play/record?uid=<uid>&type=0（全部）
// 返回 {code: 200, weekData/allData: [{playCount, score, song: {...}}]}，
// song 形状与搜索结果相近（id/name/ar/al/dt）。需登录会话
// （复用 netease-session.ts 的 Cookie 与 userId）。
// 响应形态做防御解析：code 非 200、无排行数组、uid 取不到时一律
// 抛中文错由调用方展示，不编假数据、不猜 uid。

import { httpGet } from '../native/http';
import { loadSession, withSessionCookie } from './netease-session';
import type { Track } from '../types';

const RECORD_URL = 'https://music.163.com/api/v1/play/record';
const USER_LEVEL_URL = 'https://music.163.com/api/user/level';

const HEADERS: Record<string, string> = {
    Referer: 'https://music.163.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
};

export type NeteaseRankRange = 'week' | 'all';

export interface NeteaseRankEntry {
    track: Track;
    playCount: number;
}

function httpsCover(url: string | undefined): string | undefined {
    return url ? url.replace(/^http:/, 'https:') : undefined;
}

// uid 来源：803 登录时存下的 userId；老会话没存时再调一次
// /api/user/level 从返回里取（只取返回里真实有的字段，取不到
// 就明确报错请重新登录，不猜、不编）。
async function resolveUid(): Promise<number> {
    const session = loadSession();
    if (!session) {
        throw new Error('还没登录网易云，请先去「我的」页听歌钥匙扫码登录');
    }
    if (typeof session.userId === 'number' && session.userId > 0) {
        return session.userId;
    }
    try {
        const response = await httpGet(USER_LEVEL_URL, {
            ...HEADERS,
            Cookie: session.cookie
        });
        if (response.status === 200) {
            const parsed = JSON.parse(response.body) as {
                data?: { userId?: unknown; profile?: { userId?: unknown } };
                profile?: { userId?: unknown };
            };
            const uid =
                parsed.data?.userId ?? parsed.data?.profile?.userId ?? parsed.profile?.userId;
            if (typeof uid === 'number' && uid > 0) {
                return uid;
            }
        }
    } catch {
        // 取 uid 失败不吞错：下面按无 uid 报错，调用方原样展示。
    }
    throw new Error('登录会话里没有用户 id，请退出网易云后重新扫码登录一次');
}

interface NeteaseRankRawSong {
    id?: unknown;
    name?: unknown;
    ar?: unknown;
    al?: unknown;
    dt?: unknown;
}

function rawSongToTrack(raw: NeteaseRankRawSong): Track | null {
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
    if (!Number.isFinite(id) || id <= 0) {
        return null;
    }
    const artists = Array.isArray(raw.ar)
        ? (raw.ar as { name?: unknown }[])
            .map((artist) => (typeof artist.name === 'string' ? artist.name : ''))
            .filter((name) => name)
        : [];
    const album = raw.al as { name?: unknown; picUrl?: unknown } | null;
    const duration = typeof raw.dt === 'number' ? raw.dt : undefined;
    return {
        id: `netease:${id}`,
        title: typeof raw.name === 'string' && raw.name ? raw.name : '未知曲名',
        artist: artists.length > 0 ? artists.join('、') : '未知歌手',
        album: typeof album?.name === 'string' && album.name ? album.name : undefined,
        durationMs: duration !== undefined && duration > 0 ? duration : undefined,
        coverUrl: httpsCover(
            typeof album?.picUrl === 'string' && album.picUrl ? album.picUrl : undefined
        ),
        source: 'netease'
    };
}

export async function fetchNeteaseListeningRank(
    range: NeteaseRankRange
): Promise<NeteaseRankEntry[]> {
    const uid = await resolveUid();
    const type = range === 'week' ? '1' : '0';
    const response = await httpGet(
        `${RECORD_URL}?uid=${uid}&type=${type}`,
        withSessionCookie(HEADERS)
    );
    if (response.status !== 200) {
        throw new Error(`网易云听歌排行暂时拿不到（HTTP ${response.status}），请稍后重试`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        throw new Error('网易云听歌排行暂时拿不到（返回不是 JSON），请稍后重试');
    }
    const body = parsed as {
        code?: unknown;
        weekData?: unknown;
        allData?: unknown;
        data?: { weekData?: unknown; allData?: unknown } | null;
    };
    if (Number(body.code) !== 200) {
        throw new Error('网易云听歌排行暂时拿不到，请登录后再试');
    }
    const rawList = range === 'week' ? body.weekData ?? body.data?.weekData : body.allData ?? body.data?.allData;
    if (!Array.isArray(rawList)) {
        throw new Error('网易云没有返回排行数据，可能是账号还没有听歌记录');
    }
    const entries: NeteaseRankEntry[] = [];
    for (const raw of rawList as { playCount?: unknown; song?: unknown }[]) {
        if (typeof raw !== 'object' || raw === null) {
            continue;
        }
        const track = rawSongToTrack((raw.song ?? {}) as NeteaseRankRawSong);
        if (!track) {
            continue;
        }
        const playCount = typeof raw.playCount === 'number' ? raw.playCount : Number(raw.playCount);
        entries.push({ track, playCount: Number.isFinite(playCount) && playCount > 0 ? Math.floor(playCount) : 0 });
    }
    return entries;
}
