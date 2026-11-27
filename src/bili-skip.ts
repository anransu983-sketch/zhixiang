// B 站自定义跳过区间（借鉴 NeriPlayer Bilibili 自定义跳过区间）：
// 按 BVID+CID 存本地区间，播放进度进入区间自动跳到区间尾。
// 只存本机，不联网、不改拆歌章节逻辑。
export interface BiliSkipInterval {
    startSec: number;
    endSec: number;
}

const KEY = 'zx.biliSkip.v1';

type SkipMap = Record<string, BiliSkipInterval[]>;

let cache: SkipMap | null = null;
const listeners = new Set<() => void>();

function load(): SkipMap {
    if (cache) {
        return cache;
    }
    try {
        const raw = localStorage.getItem(KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        const map: SkipMap = {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (!Array.isArray(value)) {
                    continue;
                }
                const intervals = value.filter(
                    (item): item is BiliSkipInterval =>
                        !!item &&
                        typeof item === 'object' &&
                        typeof (item as BiliSkipInterval).startSec === 'number' &&
                        typeof (item as BiliSkipInterval).endSec === 'number' &&
                        (item as BiliSkipInterval).endSec > (item as BiliSkipInterval).startSec
                );
                if (intervals.length > 0) {
                    map[key] = intervals;
                }
            }
        }
        cache = map;
    } catch {
        cache = {};
    }
    return cache;
}

function save(): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(load()));
    } catch {
        // 存储满了就跳过，本次区间仍在内存缓存里生效。
    }
    for (const listener of listeners) {
        listener();
    }
}

export function getSkipIntervals(key: string): BiliSkipInterval[] {
    return [...(load()[key] ?? [])].sort((a, b) => a.startSec - b.startSec);
}

export function addSkipInterval(key: string, startSec: number, endSec: number): void {
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        return;
    }
    const map = load();
    const list = map[key] ?? [];
    list.push({ startSec: Math.max(0, startSec), endSec });
    map[key] = list;
    save();
}

export function removeSkipInterval(key: string, index: number): void {
    const map = load();
    const sorted = getSkipIntervals(key);
    const target = sorted[index];
    if (!target) {
        return;
    }
    map[key] = (map[key] ?? []).filter(
        (item) => item.startSec !== target.startSec || item.endSec !== target.endSec
    );
    if (map[key].length === 0) {
        delete map[key];
    }
    save();
}

export function onSkipChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
