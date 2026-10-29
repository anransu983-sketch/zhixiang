// 0.1.115 断点续听：切歌＋播放进度（10 秒节流）时把队列、序号、
// 位置存 localStorage，键 zx.resume.v1。流地址不进库（签名会过期，
// 恢复时按曲目 id 重新取链）；我的页“上次听到”卡片读它恢复。
import { getCurrentState, onTimeUpdate, onTrackChange } from './playback';
import type { Track } from './types';

const KEY = 'zx.resume.v1';

export interface ResumeData {
    queue: Track[];
    index: number;
    positionMs: number;
    savedAt: number;
}

function sanitize(tracks: Track[]): Track[] {
    return tracks.map((track) => {
        const { streamUrl: _streamUrl, ...rest } = track;
        return rest;
    });
}

export function loadResume(): ResumeData | null {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<ResumeData>;
        if (!Array.isArray(parsed.queue) || parsed.queue.length === 0) {
            return null;
        }
        const index = typeof parsed.index === 'number' ? parsed.index : 0;
        if (index < 0 || index >= parsed.queue.length) {
            return null;
        }
        return {
            queue: parsed.queue,
            index,
            positionMs: typeof parsed.positionMs === 'number' ? parsed.positionMs : 0,
            savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0
        };
    } catch {
        return null;
    }
}

export function saveResumeNow(): void {
    const state = getCurrentState();
    if (!state.track || state.queue.length === 0) {
        return;
    }
    try {
        const data: ResumeData = {
            queue: sanitize(state.queue),
            index: state.index,
            // currentTime 是秒，duration 是毫秒（playback.ts 口径）。
            positionMs: Math.floor(state.currentTime * 1000),
            savedAt: Date.now()
        };
        localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
        // 存储满了就跳过，下次切歌再试。
    }
}

let lastSaveAt = 0;

export function initResumeTracking(): void {
    onTrackChange(() => {
        saveResumeNow();
    });
    onTimeUpdate(() => {
        const now = Date.now();
        if (now - lastSaveAt < 10000) {
            return;
        }
        lastSaveAt = now;
        saveResumeNow();
    });
}
