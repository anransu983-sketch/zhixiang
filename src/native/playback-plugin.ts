// 保活与流代理的原生插件封装：与 PlaybackPlugin.java / PlaybackService.java /
// StreamProxyServer.java 对应。Web 层只经这层调原生，不直接拼插件名。
//
// 约定：
// - start/stop 只管前台服务（常驻通知、无控制按钮）；原生侧失败不抛给播放流程，
//   由 playback.ts 捕获后降级（继续播，只是保活可能失效），绝不因此中断播放。
// - ensureProxy 返回本机代理端口；只有拿到端口后，远程流地址才允许交给 audio
//   元素。代理不可用时 playback.ts 对 YTM 直接抛错，绝不把 googlevideo 直链
//   交给 audio 元素；浏览器预览里非 YTM 的远程流才允许直连降级。

import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

interface PlaybackPlugin {
    start(options: { title: string; artist: string }): Promise<void>;
    stop(): Promise<void>;
    ensureProxy(): Promise<{ port: number }>;
    stopProxy(): Promise<void>;
    setMedia(options: {
        title: string;
        artist: string;
        album?: string;
        coverUrl?: string;
        albumId?: number;
    }): Promise<void>;
    setPlaying(options: { playing: boolean }): Promise<void>;
    clearMedia(): Promise<void>;
    addListener(
        eventName: 'mediaAction',
        listener: (event: { action: string }) => void,
    ): Promise<PluginListenerHandle>;
}

const Playback = registerPlugin<PlaybackPlugin>('Playback');

export async function startPlaybackService(title: string, artist: string): Promise<void> {
    await Playback.start({ title, artist });
}

export async function stopPlaybackService(): Promise<void> {
    await Playback.stop();
}

export async function ensureStreamProxy(): Promise<number> {
    const result = await Playback.ensureProxy();
    return result.port;
}

export async function stopStreamProxy(): Promise<void> {
    await Playback.stopProxy();
}

// 系统播放卡同步（0.1.52）：只负责把曲目与播放态递给原生会话，
// 失败由调用方捕获后静默，绝不干扰播放流程。
export async function setMediaSessionTrack(options: {
    title: string;
    artist: string;
    album?: string;
    coverUrl?: string;
    albumId?: number;
}): Promise<void> {
    await Playback.setMedia(options);
}

export async function setMediaSessionPlaying(playing: boolean): Promise<void> {
    await Playback.setPlaying({ playing });
}

export async function clearMediaSession(): Promise<void> {
    await Playback.clearMedia();
}

export async function addMediaActionListener(
    listener: (action: string) => void,
): Promise<PluginListenerHandle> {
    return Playback.addListener('mediaAction', (event: { action: string }) => {
        listener(event.action);
    });
}
