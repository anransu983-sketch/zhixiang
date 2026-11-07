import './style.css';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { applyStoredPerfMode, applyStoredTheme } from './appearance';
import { handleBack } from './back-stack';
import { renderHome } from './home';
import { initLogger } from './logger';
import { initMediaSession } from './native/media-session';
import { initPlaybackHistory } from './playback-history';

// 日志拦截要在所有模块输出之前装好，首页底部的开发者区靠它展示与复制。
initLogger();

// 系统返回（安卓返回键／全面屏侧滑返回）只在这里注册一次：
// 先让返回栈关掉最上层浮层（子页／速记簿／播放页）；什么都没得
// 关时退到后台而不是退出进程——音乐还在放，杀进程就断了。
// 只在原生端注册，网页调试环境没有这个事件，也别让它报错中断启动。
if (Capacitor.isNativePlatform()) {
    App.addListener('backButton', () => {
        if (!handleBack()) {
            void App.minimizeApp();
        }
    }).catch(() => {
        // 注册失败只意味着系统返回回到系统默认行为，不挡启动。
    });
}

// 系统播放卡监听只注册一次：起歌/暂停/停止都走 onTrackChange 同步。
initMediaSession();

// 足迹记录同款入口：只订阅 onTrackChange，不动播放逻辑。
initPlaybackHistory();

// 外观偏好要在首屏渲染前应用，否则我的页会先闪默认色再跳主题。
applyStoredTheme();
applyStoredPerfMode();

const root = document.getElementById('app');
if (root) {
    root.appendChild(renderHome());
}
