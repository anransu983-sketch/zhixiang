// 系统播放卡（0.1.52）：原生 MediaSession 的 JS 侧。
//
// WebView 不支持 Media Session Web API，navigator.mediaSession 到不了
// 三星系统播放卡，所以会话与通知全在 PlaybackService，JS 只做两件事：
// 1. 逻辑状态一变就同步：onTrackChange 是唯一入口——起歌、暂停、恢复、
//    停止、队列播完都会 emit，100ms 防抖后一次把曲目 + 播放态递过去，
//    不跟双槽 audio 元素的事件走（3 秒重叠淡入会让卡闪）。
// 2. 接会话回调：耳机与通知按钮只发 mediaAction 事件，JS 按逻辑状态
//    幂等处理（play 时已在播不动、pause 时已停不动），绝不直接 toggle。
// 全程失败静默：同步失败只是系统卡不更新，播放本身不受影响。

import {
    getCurrentState,
    next,
    onTrackChange,
    pause,
    previous,
    resume,
} from '../playback';
import {
    addMediaActionListener,
    clearMediaSession,
    setMediaSessionPlaying,
    setMediaSessionTrack,
} from './playback-plugin';

let started = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function initMediaSession(): void {
    if (started) {
        return;
    }
    started = true;
    void addMediaActionListener((action) => {
        void handleMediaAction(action);
    }).then(() => {
        console.log('[MediaSession] 系统按键监听已注册');
    }).catch(() => {
        // 非原生环境（浏览器预览）无此事件，忽略。
        console.log('[MediaSession] 系统按键监听注册失败');
    });
    onTrackChange(() => {
        if (syncTimer !== null) {
            clearTimeout(syncTimer);
        }
        syncTimer = setTimeout(() => {
            void syncMediaSession();
        }, 100);
    });
}

async function syncMediaSession(): Promise<void> {
    try {
        const state = getCurrentState();
        const track = state.track;
        if (!track) {
            await clearMediaSession();
            return;
        }
        const coverUrl = track.coverUrl ?? '';
        let albumId: number | undefined;
        if (coverUrl.startsWith('content://')) {
            const parts = coverUrl.split('/');
            const last = parts[parts.length - 1];
            if (last !== undefined && /^\d+$/.test(last)) {
                albumId = Number(last);
            }
        }
        // exactOptionalPropertyTypes 下不能显式传 undefined，逐项补。
        const media: {
            title: string;
            artist: string;
            album?: string;
            coverUrl?: string;
            albumId?: number;
        } = { title: track.title, artist: track.artist };
        if (track.album) {
            media.album = track.album;
        }
        if (coverUrl.startsWith('http')) {
            media.coverUrl = coverUrl;
        }
        if (albumId !== undefined) {
            media.albumId = albumId;
        }
        await setMediaSessionTrack(media);
        await setMediaSessionPlaying(state.playing);
    } catch {
        // 静默：系统卡同步失败不影响播放。
    }
}

async function handleMediaAction(action: string): Promise<void> {
    try {
        const state = getCurrentState();
        // 关键诊断行（0.1.56）：卡上按键有没有走到 JS、以及系统发来的
        // 动作与当前态是否对得上（比如点暂停却收到 play），全看这一行。
        // 我的页 → 开发者 → 运行日志里能看到。
        console.log(`[MediaSession] 收到系统按键：${action}（当前${state.playing ? '播放中' : '已暂停'}）`);
        if (action === 'play') {
            if (!state.playing) {
                await resume();
            }
        } else if (action === 'pause') {
            // 原生 onStop 也映射成 pause：停当暂停处理。
            if (state.playing) {
                pause();
            }
        } else if (action === 'next') {
            await next();
        } else if (action === 'previous') {
            await previous();
        }
    } catch {
        // 静默：按键处理失败不影响播放。
    }
}
