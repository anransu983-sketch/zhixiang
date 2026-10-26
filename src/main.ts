import './style.css';
import { renderHome } from './home';
import { initLogger } from './logger';
import { initMediaSession } from './native/media-session';

// 日志拦截要在所有模块输出之前装好，首页底部的开发者区靠它展示与复制。
initLogger();

// 系统播放卡监听只注册一次：起歌/暂停/停止都走 onTrackChange 同步。
initMediaSession();

const root = document.getElementById('app');
if (root) {
    root.appendChild(renderHome());
}
