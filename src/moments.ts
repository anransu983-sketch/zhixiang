// 时刻标记（第 4 项）：播放页在当前秒打点，本地存储、跟歌走、不联网。
//
// 与速记簿（stash.ts）分工不同：速记簿只存整首收藏、无时间点备注；
// 时刻是「某首歌的第几秒」这个时间点本身，故另建本模块，不塞进
// stash.ts 混淆语义。存储口径与自建歌单一致：按 playlists.ts 的
// trackKey（同源同 id 才算同一首）分组存时刻列表。
//
// 存储键 zx.moments.v1，值是 Record<trackKey, TrackMoment[]>：
//   { "netease:123": [{ id, sec, createdAt }] }
// sec 是相对当前曲的整秒（分段曲同样是相对段首的秒，与 seekTo 的
// 入参口径一致）；createdAt 只作排序兜底，不展示、不参与去重。

import { trackKey } from './playlists';
import type { Track } from './types';

export interface TrackMoment {
    id: string;
    /** 相对当前曲的整秒。 */
    sec: number;
    createdAt: number;
}

/** 单首歌最多存多少个时刻：防误触连打把存档撑大。 */
const MAX_MOMENTS_PER_TRACK = 100;

const STORAGE_KEY = 'zx.moments.v1';

type MomentsStore = Record<string, TrackMoment[]>;

function cleanMoment(raw: unknown): TrackMoment | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
        return null;
    }
    if (typeof item.sec !== 'number' || !Number.isFinite(item.sec) || item.sec < 0) {
        return null;
    }
    const createdAt = typeof item.createdAt === 'number' ? item.createdAt : 0;
    return { id: item.id, sec: Math.floor(item.sec), createdAt };
}

function loadStore(): MomentsStore {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return {};
        }
        const store: MomentsStore = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(value)) {
                continue;
            }
            const moments = value
                .map(cleanMoment)
                .filter((moment): moment is TrackMoment => moment !== null)
                .sort((a, b) => a.sec - b.sec || a.createdAt - b.createdAt);
            if (moments.length > 0) {
                store[key] = moments;
            }
        }
        return store;
    } catch {
        return {};
    }
}

function saveStore(store: MomentsStore): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
        // 存不下只影响下次打开的时刻恢复，不中断当前播放。
    }
}

function makeId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 取某首歌的全部时刻，按秒升序。 */
export function listMoments(track: Track): TrackMoment[] {
    return listMomentsByKey(trackKey(track));
}

export function listMomentsByKey(key: string): TrackMoment[] {
    const moments = loadStore()[key];
    return moments ? [...moments] : [];
}

/** 返回 added（已记下）／exists（这一整秒已有时刻）／invalid（秒数非法）／full（本首已满）。 */
export function addMoment(
    track: Track,
    sec: number
): { status: 'added' | 'exists' | 'invalid' | 'full'; moment: TrackMoment | null } {
    const wholeSec = Math.floor(sec);
    if (!Number.isFinite(wholeSec) || wholeSec <= 0) {
        return { status: 'invalid', moment: null };
    }
    const key = trackKey(track);
    const store = loadStore();
    const moments = store[key] ?? [];
    if (moments.some((moment) => moment.sec === wholeSec)) {
        return { status: 'exists', moment: null };
    }
    if (moments.length >= MAX_MOMENTS_PER_TRACK) {
        return { status: 'full', moment: null };
    }
    const moment: TrackMoment = { id: makeId(), sec: wholeSec, createdAt: Date.now() };
    moments.push(moment);
    moments.sort((a, b) => a.sec - b.sec || a.createdAt - b.createdAt);
    store[key] = moments;
    saveStore(store);
    return { status: 'added', moment };
}

/** 删单条时刻；返回是否真的删掉了一条。 */
export function removeMoment(key: string, id: string): boolean {
    const store = loadStore();
    const moments = store[key];
    if (!moments) {
        return false;
    }
    const next = moments.filter((moment) => moment.id !== id);
    if (next.length === moments.length) {
        return false;
    }
    if (next.length === 0) {
        delete store[key];
    } else {
        store[key] = next;
    }
    saveStore(store);
    return true;
}
