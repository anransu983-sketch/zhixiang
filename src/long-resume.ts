// 长音频单曲进度记忆（借鉴 NeriPlayer 长音频进度记忆）：时长
// ≥15 分钟的曲目按 source:id 存播放位置，下次起播自动续上。
// 位置 <5 秒不存；距结尾 <30 秒视为播完清零；地图上限 200 条
// 按最近更新淘汰。B 站拆歌分段曲有显式段首，显式起点优先，
// 本模块对分段曲一律不记不续。本文件只管存取（纯函数），
// 进度订阅在 resume.ts、起播续位在 playback.ts，避免循环导入。
import type { Track } from './types';

const KEY = 'zx.longResume.v1';
const MIN_DURATION_MS = 15 * 60 * 1000;
const MIN_SAVE_MS = 5000;
const END_CLEAR_MS = 30000;
const MAX_ENTRIES = 200;

interface Entry {
    posMs: number;
    updatedAt: number;
}

function isLongTrack(track: Track | null): track is Track {
    return (
        !!track &&
        typeof track.durationMs === 'number' &&
        track.durationMs >= MIN_DURATION_MS &&
        typeof track.segmentStartMs !== 'number'
    );
}

function loadMap(): Record<string, Entry> {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const map: Record<string, Entry> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const entry = value as Partial<Entry> | null;
            if (
                entry &&
                typeof entry.posMs === 'number' &&
                entry.posMs >= MIN_SAVE_MS &&
                typeof entry.updatedAt === 'number'
            ) {
                map[key] = { posMs: entry.posMs, updatedAt: entry.updatedAt };
            }
        }
        return map;
    } catch {
        return {};
    }
}

function saveMap(map: Record<string, Entry>): void {
    try {
        const keys = Object.keys(map);
        if (keys.length > MAX_ENTRIES) {
            keys
                .sort((a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0))
                .slice(0, keys.length - MAX_ENTRIES)
                .forEach((key) => {
                    delete map[key];
                });
        }
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
        // 存储满了就跳过，下次再试。
    }
}

function mapKey(track: Track): string {
    return `${track.source}:${track.id}`;
}

// 起播时查记忆位置；无记忆或不合条件回 null。
export function getLongResumeMs(track: Track): number | null {
    if (!isLongTrack(track)) {
        return null;
    }
    const entry = loadMap()[mapKey(track)];
    if (!entry) {
        return null;
    }
    if (track.durationMs! - entry.posMs < END_CLEAR_MS) {
        return null;
    }
    return entry.posMs;
}

let lastSaveAt = 0;

// 进度回调里调：10 秒节流落盘；播完或回到开头清掉记忆。
export function recordLongResumePosition(track: Track | null, posMs: number): void {
    if (!isLongTrack(track) || !Number.isFinite(posMs)) {
        return;
    }
    const durationMs = track.durationMs!;
    const key = mapKey(track);
    if (durationMs - posMs < END_CLEAR_MS || posMs < MIN_SAVE_MS) {
        const map = loadMap();
        if (map[key]) {
            delete map[key];
            saveMap(map);
        }
        return;
    }
    const now = Date.now();
    if (now - lastSaveAt < 10000) {
        return;
    }
    lastSaveAt = now;
    const map = loadMap();
    map[key] = { posMs: Math.floor(posMs), updatedAt: now };
    saveMap(map);
}
