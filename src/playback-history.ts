// 音乐足迹：播放历史记录与月度聚合（0.1.54）。
//
// 之前没有任何播放记录（dev 日志不是可查的历史），足迹只能从装上
// 0.1.54 起记，之前的数据补不回来——足迹页空态会把这句写明。
//
// 记录方式：只订阅 onTrackChange（与系统播放卡同款入口，起歌/暂停/
// 恢复/停止/播完都会 emit），不改 playback.ts。逻辑状态一变就结算：
// - 切歌/暂停/停止/播完：把上一段的收听时长（Date.now 差值）落成一条
//   session；切歌时旧段结算完立刻给新歌开段。
// - 后台继续播时不结算：时间照常累进，下一状态变化时一次结算，
//   所以后台时长不会丢；只有 App 被杀时当前开段会丢（可接受）。
// 口径（足迹页脚注同样写明）：
// - 时长：所有 session 的 listenedMs 之和，1 秒内的误触不记。
// - 次数：listenedMs >= 30 秒的 session 计一次收听；试听不计次。
// - 归属：按 session 开始时间的本地年月日归档，跨夜只算开始那天。
// - 唱片墙：去重后的曲目，最新听过的排前面。

import { getCurrentState, onTrackChange } from './playback';
import type { SourceId } from './types';

export interface PlaySession {
    trackId: string;
    title: string;
    artist: string;
    source: SourceId;
    coverUrl?: string;
    startedAt: number;
    listenedMs: number;
}

export const SOURCE_NAMES: Record<SourceId, string> = {
    local: '本地',
    netease: '网易云',
    ytm: 'YTM',
};

const KEY = 'zx_play_history_v1';
const MAX_SESSIONS = 5000;
const MIN_SESSION_MS = 1000;
export const COUNT_THRESHOLD_MS = 30_000;

let sessionsCache: PlaySession[] | null = null;
let current: {
    trackId: string;
    title: string;
    artist: string;
    source: SourceId;
    coverUrl?: string;
    startedAt: number;
} | null = null;
let started = false;

export function initPlaybackHistory(): void {
    if (started) {
        return;
    }
    started = true;
    onTrackChange(() => {
        syncFromState();
    });
}

function loadSessions(): PlaySession[] {
    if (sessionsCache !== null) {
        return sessionsCache;
    }
    let list: PlaySession[] = [];
    try {
        const raw = localStorage.getItem(KEY);
        const parsed: unknown = raw === null ? [] : JSON.parse(raw);
        if (Array.isArray(parsed)) {
            list = parsed.filter((item): item is PlaySession => {
                if (typeof item !== 'object' || item === null) {
                    return false;
                }
                const candidate = item as Partial<PlaySession>;
                return typeof candidate.trackId === 'string'
                    && typeof candidate.title === 'string'
                    && typeof candidate.artist === 'string'
                    && typeof candidate.startedAt === 'number'
                    && typeof candidate.listenedMs === 'number';
            });
        }
    } catch {
        list = [];
    }
    sessionsCache = list;
    return list;
}

function saveSessions(list: PlaySession[]): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
        // 存满/不可写时静默：足迹缺几天不影响播放。
    }
}

function syncFromState(): void {
    const state = getCurrentState();
    const track = state.track;
    if (current !== null) {
        const stillSame = track !== null && track.id === current.trackId && state.playing;
        if (!stillSame) {
            finalizeCurrent();
        }
    }
    if (track !== null && state.playing && current === null) {
        current = {
            trackId: track.id,
            title: track.title,
            artist: track.artist,
            source: track.source,
            coverUrl: track.coverUrl,
            startedAt: Date.now(),
        };
    }
}

function finalizeCurrent(): void {
    if (current === null) {
        return;
    }
    const segment = current;
    current = null;
    const listenedMs = Date.now() - segment.startedAt;
    if (listenedMs < MIN_SESSION_MS) {
        return;
    }
    const list = loadSessions();
    list.push({
        trackId: segment.trackId,
        title: segment.title,
        artist: segment.artist,
        source: segment.source,
        coverUrl: segment.coverUrl,
        startedAt: segment.startedAt,
        listenedMs,
    });
    while (list.length > MAX_SESSIONS) {
        list.shift();
    }
    saveSessions(list);
}

export interface TopSong {
    trackId: string;
    title: string;
    artist: string;
    source: SourceId;
    coverUrl?: string;
    plays: number;
    listenedMs: number;
}

export interface TopArtist {
    artist: string;
    plays: number;
    listenedMs: number;
}

export interface WallItem {
    trackId: string;
    title: string;
    artist: string;
    coverUrl?: string;
    lastPlayedAt: number;
}

export interface FootprintStats {
    totalMs: number;
    songCount: number;
    playCount: number;
    activeDays: number;
    topSongs: TopSong[];
    topArtists: TopArtist[];
    sourcePlays: Record<SourceId, number>;
    sourceMs: Record<SourceId, number>;
    wall: WallItem[];
    // 存 YYYY-MM-DD 全量日期：只存几号会在累计时把不同月的同一天算成一天。
    activeDaySet: Set<string>;
}

function emptyStats(): FootprintStats {
    return {
        totalMs: 0,
        songCount: 0,
        playCount: 0,
        activeDays: 0,
        topSongs: [],
        topArtists: [],
        sourcePlays: { local: 0, netease: 0, ytm: 0 },
        sourceMs: { local: 0, netease: 0, ytm: 0 },
        wall: [],
        activeDaySet: new Set<string>(),
    };
}

function monthKeyOf(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function aggregate(list: PlaySession[]): FootprintStats {
    const stats = emptyStats();
    const songMap = new Map<string, TopSong>();
    const artistMap = new Map<string, TopArtist>();
    const wallMap = new Map<string, WallItem>();
    for (const session of list) {
        stats.totalMs += session.listenedMs;
        const day = new Date(session.startedAt);
        stats.activeDaySet.add(
            `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
        );
        const counted = session.listenedMs >= COUNT_THRESHOLD_MS;
        if (counted) {
            stats.playCount += 1;
            stats.sourcePlays[session.source] += 1;
        }
        stats.sourceMs[session.source] += session.listenedMs;
        const song = songMap.get(session.trackId);
        if (song === undefined) {
            songMap.set(session.trackId, {
                trackId: session.trackId,
                title: session.title,
                artist: session.artist,
                source: session.source,
                coverUrl: session.coverUrl,
                plays: counted ? 1 : 0,
                listenedMs: session.listenedMs,
            });
        } else {
            if (counted) {
                song.plays += 1;
            }
            song.listenedMs += session.listenedMs;
            if (session.coverUrl !== undefined && song.coverUrl === undefined) {
                song.coverUrl = session.coverUrl;
            }
        }
        const artist = artistMap.get(session.artist);
        if (artist === undefined) {
            artistMap.set(session.artist, {
                artist: session.artist,
                plays: counted ? 1 : 0,
                listenedMs: session.listenedMs,
            });
        } else {
            if (counted) {
                artist.plays += 1;
            }
            artist.listenedMs += session.listenedMs;
        }
        const wall = wallMap.get(session.trackId);
        if (wall === undefined) {
            wallMap.set(session.trackId, {
                trackId: session.trackId,
                title: session.title,
                artist: session.artist,
                coverUrl: session.coverUrl,
                lastPlayedAt: session.startedAt,
            });
        } else if (session.startedAt > wall.lastPlayedAt) {
            wall.lastPlayedAt = session.startedAt;
            if (session.coverUrl !== undefined) {
                wall.coverUrl = session.coverUrl;
            }
        }
    }
    stats.songCount = songMap.size;
    stats.activeDays = stats.activeDaySet.size;
    stats.topSongs = [...songMap.values()]
        .filter((song) => song.plays > 0)
        .sort((a, b) => b.plays - a.plays || b.listenedMs - a.listenedMs)
        .slice(0, 10);
    stats.topArtists = [...artistMap.values()]
        .filter((artist) => artist.plays > 0)
        .sort((a, b) => b.plays - a.plays || b.listenedMs - a.listenedMs)
        .slice(0, 10);
    stats.wall = [...wallMap.values()]
        .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
        .slice(0, 60);
    return stats;
}

/** 指定月的足迹（month 1-12）；传 null 则为全部累计。 */
// 原始播放记录（0.1.101 私人漫游用）：按 trackId 聚合出常听曲目。
// 只读、不改写；返回副本，调用方不改原缓存。
export function getPlaySessions(): PlaySession[] {
    return [...loadSessions()];
}

export function getFootprint(year: number | null, month: number | null): FootprintStats {
    const all = loadSessions();
    if (year === null || month === null) {
        return aggregate(all);
    }
    const key = `${year}-${String(month).padStart(2, '0')}`;
    return aggregate(all.filter((session) => monthKeyOf(session.startedAt) === key));
}

/** 指定年的足迹（0.1.55 年视图用）。 */
export function getYearFootprint(year: number): FootprintStats {
    const prefix = `${year}-`;
    return aggregate(
        loadSessions().filter((session) => monthKeyOf(session.startedAt).startsWith(prefix)),
    );
}

/** 某月每天是否有收听（日历用，返回日期号集合）；累计模式不画日历。 */
export function getMonthActiveDays(year: number, month: number): Set<number> {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const days = new Set<number>();
    for (const session of loadSessions()) {
        if (monthKeyOf(session.startedAt) === key) {
            days.add(new Date(session.startedAt).getDate());
        }
    }
    return days;
}

export function hasAnyHistory(): boolean {
    return loadSessions().length > 0;
}

/** 时长文案：9小时32分 / 45分钟 / 0分钟。 */
export function formatListenedMs(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) {
        return `${hours}小时${minutes}分`;
    }
    return `${minutes}分钟`;
}
