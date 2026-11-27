// B 站 CC 字幕歌词偏好（借鉴 NeriPlayer CC 字幕面板）：可关字幕
// 歌词、可按视频选具体轨道、CC 来源独立偏移（±0.5s 步进），
// 只作用于 CC 歌词，不影响其他歌词来源的对齐。
import type { Track } from './types';

const KEY = 'zx.ccLyrics.v1';
export const CC_OFFSET_STEP_MS = 500;
export const CC_OFFSET_MAX_MS = 5000;

export interface CcPrefs {
    enabled: boolean;
    offsetMs: number;
    picks: Record<string, string>;
}

const DEFAULTS: CcPrefs = { enabled: true, offsetMs: 0, picks: {} };

export function loadCcPrefs(): CcPrefs {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return { ...DEFAULTS, picks: {} };
        }
        const parsed = JSON.parse(raw) as Partial<CcPrefs>;
        return {
            enabled: parsed.enabled !== false,
            offsetMs:
                typeof parsed.offsetMs === 'number' && Number.isFinite(parsed.offsetMs)
                    ? Math.max(-CC_OFFSET_MAX_MS, Math.min(CC_OFFSET_MAX_MS, parsed.offsetMs))
                    : 0,
            picks:
                parsed.picks && typeof parsed.picks === 'object' && !Array.isArray(parsed.picks)
                    ? (parsed.picks as Record<string, string>)
                    : {}
        };
    } catch {
        return { ...DEFAULTS, picks: {} };
    }
}

function saveCcPrefs(prefs: CcPrefs): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
        // 存储满了就跳过，本次选择仍在内存里由调用方刷新歌词。
    }
}

// 选轨按视频存：bvid＋分 P（剥掉拆歌分段的 @startSec 后缀）。
function pickKey(track: Track): string {
    const raw = track.id.startsWith('bilibili:')
        ? track.id.slice('bilibili:'.length)
        : track.id;
    return raw.split('@')[0] ?? raw;
}

export function ccPickFor(track: Track): string | null {
    return loadCcPrefs().picks[pickKey(track)] ?? null;
}

export function setCcEnabled(enabled: boolean): void {
    const prefs = loadCcPrefs();
    prefs.enabled = enabled;
    saveCcPrefs(prefs);
}

export function setCcPick(track: Track, url: string | null): void {
    const prefs = loadCcPrefs();
    if (url) {
        prefs.picks[pickKey(track)] = url;
    } else {
        delete prefs.picks[pickKey(track)];
    }
    saveCcPrefs(prefs);
}

export function setCcOffsetMs(offsetMs: number): number {
    const prefs = loadCcPrefs();
    prefs.offsetMs = Math.max(
        -CC_OFFSET_MAX_MS,
        Math.min(CC_OFFSET_MAX_MS, Math.round(offsetMs))
    );
    saveCcPrefs(prefs);
    return prefs.offsetMs;
}
