// 私人漫游（0.1.101，参考 CurrentMusicX 的私人漫游）：
// 熟悉＝常听（播放记录按次数＋时长排），探索＝三路海报里没听过的歌，
// 拼图＝熟悉与探索交错。开漫游先存下原队列，漫游队尾剩 5 首时续推
// 下一批；点结束漫游恢复原队列（回到原来那首歌的开头）。
// 漫游中用户手动切了别的歌单，续推暂停（队头已不是漫游队），
// 但结束漫游仍能回到原队列。

import { appendToQueue, getCurrentState, onTrackChange, playQueue, stop } from './playback';
import { getPlaySessions } from './playback-history';
import type { PlaySession } from './playback-history';
import { POSTER_SECTIONS } from './posters';
import { localSource } from './sources/local';
import type { Track } from './types';

export type RoamScene = 'familiar' | 'explore' | 'puzzle';

export const ROAM_SCENE_NAMES: Record<RoamScene, string> = {
    familiar: '熟悉',
    explore: '探索',
    puzzle: '拼图'
};

const BATCH_INITIAL = 30;
const BATCH_APPEND = 20;
const APPEND_THRESHOLD = 5;
const FAMILIAR_MIN = 8;

function trackKey(track: Track): string {
    return `${track.source}:${track.id}`;
}

function shuffle<T>(list: T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = out[i]!;
        out[i] = out[j]!;
        out[j] = tmp;
    }
    return out;
}

interface RoamRuntime {
    scene: RoamScene;
    pool: Track[];
    pointer: number;
    savedQueue: Track[] | null;
    savedIndex: number;
    queueHeadKey: string;
    lastTrackId: string | null;
    played: number;
}

let runtime: RoamRuntime | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
    listeners.forEach((listener) => {
        try {
            listener();
        } catch {
            // 界面监听失败不影响播放。
        }
    });
}

export function onRoamChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getRoamState(): {
    active: boolean;
    scene: RoamScene | null;
    played: number;
} {
    if (!runtime) {
        return { active: false, scene: null, played: 0 };
    }
    return { active: true, scene: runtime.scene, played: runtime.played };
}

let listenerInstalled = false;

function ensureListener(): void {
    if (listenerInstalled) {
        return;
    }
    listenerInstalled = true;
    onTrackChange((state) => {
        if (!runtime) {
            return;
        }
        // 队头已不是漫游队（用户手动切了别的歌单）：不计数、不续推，
        // 但漫游状态保留，结束漫游仍能回到原队列。
        const isRoamQueue =
            state.queue.length > 0 && trackKey(state.queue[0]!) === runtime.queueHeadKey;
        if (!isRoamQueue) {
            return;
        }
        if (state.track && state.track.id !== runtime.lastTrackId) {
            runtime.lastTrackId = state.track.id;
            runtime.played += 1;
            emit();
        }
        const remaining = state.queue.length - 1 - state.index;
        if (remaining <= APPEND_THRESHOLD && runtime.pointer < runtime.pool.length) {
            const next = runtime.pool.slice(runtime.pointer, runtime.pointer + BATCH_APPEND);
            runtime.pointer += next.length;
            appendToQueue(next);
        }
    });
}

// 熟悉：播放记录按次数、累计时长排；本地曲按 id 还原完整曲目
// （含文件路径），网易云/YTM 用记录里的歌名歌手封面拼最小曲目，
// 起播时由各源按 id 取链，失败的单曲起播时自动往后跳。
async function buildFamiliar(): Promise<Track[]> {
    const sessions = getPlaySessions();
    interface Ranked {
        session: PlaySession;
        plays: number;
        listenedMs: number;
    }
    const counts = new Map<string, Ranked>();
    for (const session of sessions) {
        const key = `${session.source}:${session.trackId}`;
        const entry = counts.get(key) ?? { session, plays: 0, listenedMs: 0 };
        entry.plays += 1;
        entry.listenedMs += session.listenedMs;
        counts.set(key, entry);
    }
    const ranked = [...counts.values()].sort(
        (a, b) => b.plays - a.plays || b.listenedMs - a.listenedMs
    );
    let localById: Map<string, Track> | null = null;
    const out: Track[] = [];
    for (const entry of ranked) {
        const session = entry.session;
        if (session.source === 'local') {
            if (!localById) {
                try {
                    const all = await localSource.search('');
                    localById = new Map(all.map((track) => [track.id, track]));
                } catch {
                    localById = new Map();
                }
            }
            const full = localById.get(session.trackId);
            if (full) {
                out.push(full);
                continue;
            }
        }
        out.push({
            id: session.trackId,
            title: session.title,
            artist: session.artist,
            source: session.source,
            coverUrl: session.coverUrl
        });
    }
    return out;
}

// 探索：三路海报（本地藏碟、云端榜单、YTM 热碟，共享缓存不另发请求）
// 里的曲目，去掉已播、去重、打乱。
async function buildExplore(playedKeys: Set<string>): Promise<Track[]> {
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const section of POSTER_SECTIONS) {
        let posters;
        try {
            posters = await section.load();
        } catch {
            continue;
        }
        for (const poster of posters) {
            for (const track of poster.tracks) {
                const key = trackKey(track);
                if (playedKeys.has(key) || seen.has(key)) {
                    continue;
                }
                seen.add(key);
                out.push(track);
            }
        }
    }
    return shuffle(out);
}

async function buildPool(scene: RoamScene): Promise<Track[]> {
    const playedKeys = new Set(
        getPlaySessions().map((session) => `${session.source}:${session.trackId}`)
    );
    if (scene === 'familiar') {
        const familiar = await buildFamiliar();
        if (familiar.length >= FAMILIAR_MIN) {
            return familiar;
        }
        // 常听太少时用探索补满，不断档。
        const explore = await buildExplore(playedKeys);
        const familiarKeys = new Set(familiar.map(trackKey));
        return [...familiar, ...explore.filter((track) => !familiarKeys.has(trackKey(track)))];
    }
    if (scene === 'explore') {
        return buildExplore(playedKeys);
    }
    const familiar = await buildFamiliar();
    const explore = await buildExplore(playedKeys);
    const familiarKeys = new Set(familiar.map(trackKey));
    const exploreOnly = explore.filter((track) => !familiarKeys.has(trackKey(track)));
    const out: Track[] = [];
    for (let i = 0; i < Math.max(familiar.length, exploreOnly.length); i++) {
        if (i < familiar.length) {
            out.push(familiar[i]!);
        }
        if (i < exploreOnly.length) {
            out.push(exploreOnly[i]!);
        }
    }
    return out;
}

export async function startRoaming(scene: RoamScene): Promise<{ ok: boolean; note: string }> {
    ensureListener();
    const state = getCurrentState();
    // 已在漫游中换场景时，原队列仍是第一次漫游前存的那份，不覆盖。
    const savedQueue = runtime
        ? runtime.savedQueue
        : state.queue.length > 0
          ? [...state.queue]
          : null;
    const savedIndex = runtime ? runtime.savedIndex : state.index;
    const pool = await buildPool(scene);
    if (pool.length === 0) {
        return { ok: false, note: '还没找到能漫游的歌，先去听几首再来。' };
    }
    const first = pool.slice(0, BATCH_INITIAL);
    const next: RoamRuntime = {
        scene,
        pool,
        pointer: first.length,
        savedQueue,
        savedIndex,
        queueHeadKey: trackKey(first[0]!),
        lastTrackId: null,
        played: 0
    };
    runtime = next;
    try {
        await playQueue(first, 0);
    } catch (error) {
        runtime = null;
        emit();
        const message = error instanceof Error ? error.message : '';
        return {
            ok: false,
            note: /[\u4e00-\u9fff]/.test(message) ? message : '漫游起播失败，请稍后重试。'
        };
    }
    emit();
    return { ok: true, note: '' };
}

export async function endRoaming(): Promise<void> {
    const saved = runtime;
    runtime = null;
    emit();
    if (saved && saved.savedQueue && saved.savedQueue.length > 0) {
        try {
            await playQueue(saved.savedQueue, saved.savedIndex);
        } catch {
            // 恢复失败就停在原地，不抛错。
        }
    } else {
        try {
            await stop();
        } catch {
            // 忽略。
        }
    }
}
