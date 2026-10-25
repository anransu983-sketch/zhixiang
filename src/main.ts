import './style.css';
import { renderHome } from './home';
import { initLogger } from './logger';

// 日志拦截要在所有模块输出之前装好，首页底部的开发者区靠它展示与复制。
initLogger();

const root = document.getElementById('app');
if (root) {
    root.appendChild(renderHome());
}
