// 0.1.115 手动贴词：用户在播放页底排给当前歌贴词，存 localStorage，
// 键 source:id，与歌单去重键同口径。fetchLyrics 里优先级最高，
// 高于内嵌／联网补源；删除只清这条覆盖，不动已写回的同名 .lrc。
import { trackKey } from './playlists';
import type { Track } from './types';

const KEY = 'zx.manual.lyrics.v1';

type ManualMap = Record<string, { text: string; savedAt: number }>;

function loadMap(): ManualMap {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return {};
        }
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return parsed as ManualMap;
    } catch {
        return {};
    }
}

function saveMap(map: ManualMap): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
        // 存储满了就静默失败，贴词入口会报。
    }
}

export function getManualLyrics(track: Track): string | null {
    const entry = loadMap()[trackKey(track)];
    if (!entry || typeof entry.text !== 'string' || entry.text.trim().length === 0) {
        return null;
    }
    return entry.text;
}

export function saveManualLyrics(track: Track, text: string): void {
    const map = loadMap();
    map[trackKey(track)] = { text, savedAt: Date.now() };
    saveMap(map);
}

export function deleteManualLyrics(track: Track): void {
    const map = loadMap();
    delete map[trackKey(track)];
    saveMap(map);
}

// ---- 备份恢复用口子（0.1.131，lyrics-backup.ts）：按存储键整表进出，
// 键口径与 trackKey 相同（source:id），既有按 Track 的 API 不动。

export interface ManualLyricsEntry {
    key: string;
    text: string;
    savedAt: number;
}

// 全部条目，按键排序回（备份包内顺序稳定，方便人工核对）。
export function listManualLyrics(): ManualLyricsEntry[] {
    const map = loadMap();
    return Object.keys(map)
        .sort()
        .map((key) => {
            const entry = map[key];
            return {
                key,
                text: typeof entry?.text === 'string' ? entry.text : '',
                savedAt: typeof entry?.savedAt === 'number' ? entry.savedAt : 0
            };
        })
        .filter((entry) => entry.text.trim().length > 0);
}

export function hasManualLyricsKey(key: string): boolean {
    const entry = loadMap()[key];
    return !!entry && typeof entry.text === 'string' && entry.text.trim().length > 0;
}

// 按键写入（导入恢复用）：覆盖与否由调用方先用 hasManualLyricsKey 决定，
// 这里只管落盘；savedAt 用备份里的原值，保留「这词什么时候贴的」。
export function setManualLyricsByKey(key: string, text: string, savedAt: number): void {
    if (!key || text.trim().length === 0) {
        return;
    }
    const map = loadMap();
    map[key] = { text, savedAt: savedAt > 0 ? savedAt : Date.now() };
    saveMap(map);
}
