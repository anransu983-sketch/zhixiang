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

interface PlaybackPlugin {
    start(options: { title: string; artist: string }): Promise<void>;
    stop(): Promise<void>;
    ensureProxy(): Promise<{ port: number }>;
    stopProxy(): Promise<void>;
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
