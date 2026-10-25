// 临时极简播放实现（第 5 块会替换内部实现，但保持 playTrack 签名不变）。
// 当前行为：只用一个 plain HTMLAudioElement 直接播放解析出的地址，
// 没有淡入淡出、没有后台保活、切歌时直接停掉上一首。
// 不要在此基础上叠加播放能力，等待第 5 块统一替换。

import { getSource } from './sources/index';
import type { Track } from './types';

let currentAudio: HTMLAudioElement | null = null;

export async function playTrack(track: Track): Promise<void> {
    const source = getSource(track.source);
    if (!source) {
        throw new Error('该音源尚未接上');
    }
    const url = track.streamUrl ?? (await source.resolveStream(track));
    if (!url) {
        throw new Error('拿不到这首歌的播放地址');
    }
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
    }
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.src = url;
    currentAudio = audio;
    await audio.play();
}
