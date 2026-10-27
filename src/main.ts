import './style.css';
import { applyStoredPerfMode, applyStoredTheme } from './appearance';
import { renderHome } from './home';
import { initLogger } from './logger';
import { initMediaSession } from './native/media-session';
import { initPlaybackHistory } from './playback-history';

// 日志拦截要在所有模块输出之前装好，首页底部的开发者区靠它展示与复制。
initLogger();

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
