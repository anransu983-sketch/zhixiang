// 动态壁纸原生桥（第 8 块，全新写）：与 WallpaperPlugin.java 对应。
//
// - setWallpaperState：把 Web 播放页的当前播放状态写进 SharedPreferences，
//   供壁纸引擎定时读取。只在切歌、播放/暂停变化、歌词行变化时调用，
//   不在每次 timeupdate 时调用，避免高频写存储。
// - openLiveWallpaperPicker：发系统动态壁纸选择器，由用户自己确认设为
//   系统壁纸；本应用绝不静默改用户壁纸。
// 原生侧失败（例如浏览器预览里没有插件）时调用方捕获后只显示提示，
// 不中断播放页。

import { registerPlugin } from '@capacitor/core';
import type { VisualToggles } from '../visuals';

export interface WallpaperState {
    trackTitle: string;
    trackArtist: string;
    playing: boolean;
    positionMs: number;
    lyricLines: string[];
    currentLineIndex: number;
    toggles: VisualToggles;
}

// 原生侧按平铺键读开关（toggleRain / toggleParticles / togglePulse /
// toggleStars），不传嵌套 toggles 对象，避免 Capacitor 嵌套取键不一致。
interface WallpaperPluginCall {
    trackTitle: string;
    trackArtist: string;
    playing: boolean;
    positionMs: number;
    lyricLines: string[];
    currentLineIndex: number;
    toggleRain: boolean;
    toggleParticles: boolean;
    togglePulse: boolean;
    toggleStars: boolean;
}

interface WallpaperPlugin {
    setWallpaperState(options: WallpaperPluginCall): Promise<void>;
    openLiveWallpaperPicker(): Promise<void>;
}

const Wallpaper = registerPlugin<WallpaperPlugin>('Wallpaper');

export async function setWallpaperState(state: WallpaperState): Promise<void> {
    await Wallpaper.setWallpaperState({
        trackTitle: state.trackTitle,
        trackArtist: state.trackArtist,
        playing: state.playing,
        positionMs: state.positionMs,
        lyricLines: state.lyricLines,
        currentLineIndex: state.currentLineIndex,
        toggleRain: state.toggles.rainMode > 0,
        toggleParticles: state.toggles.particles,
        togglePulse: state.toggles.pulse,
        toggleStars: state.toggles.stars
    });
}

export async function openLiveWallpaperPicker(): Promise<void> {
    await Wallpaper.openLiveWallpaperPicker();
}
