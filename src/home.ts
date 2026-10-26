// 首页组装：按音源注册表渲染各音源的浏览区，尚未实现的块留在清单里。
// 本文件只做组装与界面接线，不放音源与播放逻辑。

import { getCurrentState, next, onTrackChange, playQueue, previous, runYtmUpstreamExperiment, togglePlay } from './playback';
import { openPlayerPage } from './player';
import type { PlaybackState } from './playback';
import { POSTER_SECTIONS, friendlyPosterError, posterFallbackBackground } from './posters';
import type { PosterSectionDefinition } from './posters';
import { renderShelfLayer } from './shelf';
import { clearLogs, copyPlainText, getLogEntries, getLogModules, getLogText, subscribeLogs, type LogEntry } from './logger';
import { SOURCES } from './sources/index';
import { getLocalNotice } from './sources/local';
import {
    checkQr,
    clearSession as clearNeteaseSession,
    fetchQrKey,
    loadSession as loadNeteaseSession,
    qrContentUrl,
    qrImageUrl,
    saveSession as saveNeteaseSession,
    validateStoredSession,
    type NeteaseSession
} from './sources/netease-session';
import { buildEapiCookieHeader, shortHash } from './sources/netease-eapi';
import { httpGet, httpPost } from './native/http';
import { openExternalUrl } from './native/external-open';
import { APP_VERSION } from './version';
import {
    clearYtmSession,
    loadYtmSession,
    signInYtm
} from './sources/ytm-session';
import type { AudioSource, Poster, Track } from './types';

// 第 8 块已接上：歌词动态壁纸与四项视觉都在播放页里，清单不再列它。

function formatDuration(durationMs?: number): string {
    if (!durationMs || durationMs <= 0) {
        return '';
    }
    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function friendlyPlayError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/[\u4e00-\u9fff]/.test(message)) {
        return message;
    }
    return '播放失败，请确认文件仍在且已授予读取音频文件的权限。';
}

function friendlySearchError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/[\u4e00-\u9fff]/.test(message)) {
        return message;
    }
    return '搜索失败，请稍后重试。';
}

// 扫码轮询失败时把原因浓缩成一小段，贴在“正在重试”后面，下次截图就能定位。
function qrFailureReason(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const http = /HTTP (\d+)/.exec(message);
    if (http) {
        return `HTTP ${http[1]}`;
    }
    if (message.includes('超时')) {
        return '请求超时';
    }
    if (message.includes('网络')) {
        return '网络异常';
    }
    if (message.includes('返回异常')) {
        return '返回异常';
    }
    const code = /code (\d+)/.exec(message);
    if (code) {
        return `状态码 ${code[1]}`;
    }
    return '未知原因';
}

// 首页 Tab 化（0.1.42）：底部四 Tab（本地／网易云／YTM／我的），一次只看一个源，
// 不再把所有模块沿长页摊开。每页懒挂载（首次进 Tab 时才建 DOM、才发海报与搜索请求），
// DOM 常驻、按 Tab 存 window.scrollY 恢复；上次 Tab 存在 localStorage。
// 迷你播放条全局常驻，不跟 Tab 走，位置在 Tab 栏上方（CSS 里算）。

type HomeTabId = 'local' | 'netease' | 'ytm' | 'me';

interface TabPage {
    page: HTMLElement;
    search?: HTMLInputElement;
    loginChip?: HTMLButtonElement;
    loginKind?: 'netease' | 'ytm';
}

export function renderHome(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'home';

    const pagesWrap = document.createElement('div');
    pagesWrap.className = 'tab-pages';
    section.appendChild(pagesWrap);

    // 最小正在播放条：歌名、歌手、播放/暂停、上一首/下一首，样式与首页卡片一致。
    // 点一首即把该区当前列表作为队列，条上的上一首/下一首就在该队列里切。
    const bar = document.createElement('div');
    bar.className = 'now-playing-bar';

    const status = document.createElement('span');
    status.className = 'now-playing-info';
    status.textContent = '还没播放任何歌曲。';
    bar.appendChild(status);

    const controls = document.createElement('div');
    controls.className = 'now-playing-controls';

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'now-playing-btn';
    prevButton.textContent = '上一首';
    prevButton.addEventListener('click', () => {
        void previous();
    });
    controls.appendChild(prevButton);

    const playPauseButton = document.createElement('button');
    playPauseButton.type = 'button';
    playPauseButton.className = 'now-playing-btn';
    playPauseButton.textContent = '播放';
    playPauseButton.addEventListener('click', () => {
        void togglePlay();
    });
    controls.appendChild(playPauseButton);

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'now-playing-btn';
    nextButton.textContent = '下一首';
    nextButton.addEventListener('click', () => {
        void next();
    });
    controls.appendChild(nextButton);

    const playerButton = document.createElement('button');
    playerButton.type = 'button';
    playerButton.className = 'now-playing-btn';
    playerButton.textContent = '打开播放页';
    playerButton.addEventListener('click', () => {
        openPlayerPage();
    });
    controls.appendChild(playerButton);

    bar.appendChild(controls);
    section.appendChild(bar);

    const refreshBar = (state: PlaybackState): void => {
        if (state.error) {
            status.textContent = state.error;
        } else if (state.track) {
            const verb = state.playing ? '正在播放' : '已暂停';
            status.textContent = `${verb}：${state.track.title} — ${state.track.artist}`;
        } else {
            status.textContent = '还没播放任何歌曲。';
        }
        playPauseButton.textContent = state.playing ? '暂停' : '播放';
    };
    onTrackChange(refreshBar);
    refreshBar(getCurrentState());

    // ---- 底部四 Tab 脚手架 ----
    const pages = new Map<HomeTabId, TabPage>();
    const scrollTops = new Map<HomeTabId, number>();
    const tabButtons = new Map<HomeTabId, HTMLButtonElement>();
    let currentTab: HomeTabId = 'local';

    function refreshLoginChip(record: TabPage): void {
        if (!record.loginChip || !record.loginKind) {
            return;
        }
        const loggedIn = record.loginKind === 'netease' ? loadNeteaseSession() !== null : loadYtmSession() !== null;
        record.loginChip.hidden = loggedIn;
    }

    function mountPage(tabId: HomeTabId): TabPage {
        if (tabId === 'me') {
            const page = document.createElement('div');
            page.className = 'tab-page';
            const heading = document.createElement('h2');
            heading.textContent = '我的';
            page.appendChild(heading);
            page.appendChild(renderLoginArea());
            page.appendChild(renderDeveloperSection());
            const record: TabPage = { page };
            pages.set(tabId, record);
            pagesWrap.appendChild(page);
            return record;
        }
        const source = SOURCES.find((item) => item.id === tabId);
        const definition = POSTER_SECTIONS.find((item) => item.key === tabId);
        if (!source || !definition) {
            throw new Error(`未知 Tab：${tabId}`);
        }
        const page = document.createElement('div');
        page.className = 'tab-page';

        const head = document.createElement('div');
        head.className = 'tab-page-head';
        const heading = document.createElement('h2');
        heading.textContent = source.label;
        head.appendChild(heading);
        let loginChip: HTMLButtonElement | undefined;
        let loginKind: 'netease' | 'ytm' | undefined;
        if (tabId === 'netease' || tabId === 'ytm') {
            loginKind = tabId;
            loginChip = document.createElement('button');
            loginChip.type = 'button';
            loginChip.className = 'tab-login-chip';
            loginChip.textContent = '登录';
            loginChip.addEventListener('click', () => {
                switchTab('me');
            });
            head.appendChild(loginChip);
        }
        page.appendChild(head);

        page.appendChild(renderPosterModule(definition));

        const { block, search } = renderSourceSection(source, status, (query) => {
            // 有查询时海报区收成细条（只剩标题＋切换行），结果接管页面。
            page.classList.toggle('has-query', query.trim().length > 0);
        });
        page.appendChild(block);

        const record: TabPage = { page, search, loginChip, loginKind };
        pages.set(tabId, record);
        pagesWrap.appendChild(page);
        return record;
    }

    function switchTab(tabId: HomeTabId): void {
        scrollTops.set(currentTab, window.scrollY);
        currentTab = tabId;
        localStorage.setItem('zx_home_tab_v1', tabId);
        let record = pages.get(tabId);
        if (!record) {
            record = mountPage(tabId);
        }
        for (const [id, other] of pages) {
            other.page.hidden = id !== tabId;
        }
        refreshLoginChip(record);
        for (const [id, button] of tabButtons) {
            button.classList.toggle('is-active', id === tabId);
        }
        window.scrollTo(0, scrollTops.get(tabId) ?? 0);
    }

    const tabBar = document.createElement('nav');
    tabBar.className = 'tab-bar';
    const TAB_DEFS: Array<{ id: HomeTabId; label: string }> = [
        { id: 'local', label: '本地' },
        { id: 'netease', label: '网易云' },
        { id: 'ytm', label: 'YTM' },
        { id: 'me', label: '我的' }
    ];
    for (const def of TAB_DEFS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tab-btn';
        button.textContent = def.label;
        button.addEventListener('click', () => {
            if (def.id === currentTab) {
                // 再点当前 Tab：回顶并聚焦搜索框（我的页没有搜索框，只回顶）。
                window.scrollTo({ top: 0, behavior: 'smooth' });
                pages.get(def.id)?.search?.focus();
                return;
            }
            switchTab(def.id);
        });
        tabButtons.set(def.id, button);
        tabBar.appendChild(button);
    }
    section.appendChild(tabBar);

    // 初始 Tab：上次停留的页，没有则本地页；只挂载这一页，其余首次进入时再挂。
    const storedTab = localStorage.getItem('zx_home_tab_v1');
    const initialTab: HomeTabId =
        storedTab === 'netease' || storedTab === 'ytm' || storedTab === 'me' ? storedTab : 'local';
    switchTab(initialTab);

    return section;
}

// 开发者区（首页最底部）：对齐 Folia 开发者页的控制台——CONSOLE 计数、
// COPY/CLEAR、搜索框、LEVEL 与 MODULE 过滤、时间戳＋模块标签的行。出问题
// 不用截图，筛好后点 COPY 直接发我。日志只存本机内存，重启后清空；
// 各音源失败提示本就不含凭证，复制出去也是安全的。
const EAPI_UA = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';

// 回显测试：把 eapi 的原样请求头经桥发到 httpbin.org/headers，看服务端
// 实际收到什么。测两次：第一次看原样头是否完整出网；第二次先让服务端
// 种一个 cookie（模拟 eapi 首响应下发 Set-Cookie），再看头是否被全局
// CookieHandler 覆盖。只记指纹与是否一致，不记 Cookie 原始值。
async function runEchoTest(button: HTMLButtonElement): Promise<void> {
    button.textContent = '回显中…';
    button.disabled = true;
    try {
        const checkEcho = (label: string, sent: string, body: string): void => {
            let echoedCookie = '';
            let echoedUa = '';
            try {
                const parsed = JSON.parse(body) as { headers?: Record<string, unknown> };
                const headers = parsed.headers ?? {};
                for (const [name, value] of Object.entries(headers)) {
                    if (name.toLowerCase() === 'cookie' && typeof value === 'string') {
                        echoedCookie = value;
                    }
                    if (name.toLowerCase() === 'user-agent' && typeof value === 'string') {
                        echoedUa = value;
                    }
                }
            } catch {
                // 解析失败也记一行，不中断第二次测试。
            }
            const cookieMatch = echoedCookie === sent;
            console.log(
                `[Netease] ${label}：Cookie${cookieMatch ? '一致' : '不一致'}（送出 ${shortHash(sent)}，回显 ${shortHash(echoedCookie)}），` +
                    `UA${echoedUa === EAPI_UA ? '一致' : '不一致'}，` +
                    `deviceId${echoedCookie.includes('deviceId=') ? '在' : '缺失'}，` +
                    `_ntes_nuid${echoedCookie.includes('_ntes_nuid=') ? '在' : '缺失'}`
            );
        };
        const sent = buildEapiCookieHeader();
        // 注意：httpbin 的 /headers 只接受 GET，用 POST 会回 405（0.1.19 的 bug）。
        const first = await httpGet('https://httpbin.org/headers', {
            'User-Agent': EAPI_UA,
            Cookie: sent
        });
        if (first.status !== 200) {
            throw new Error(`回显服务 HTTP ${first.status}`);
        }
        checkEcho('回显1', sent, first.body);
        // 让服务端种一个 cookie，再测一次：全局 handler 若存在，这次就会
        // 用存下的 cookie 覆盖我们设的头。
        await httpGet('https://httpbin.org/cookies/set?zx_probe=1');
        const second = await httpGet('https://httpbin.org/headers', {
            'User-Agent': EAPI_UA,
            Cookie: sent
        });
        if (second.status !== 200) {
            throw new Error(`回显服务 HTTP ${second.status}`);
        }
        checkEcho('回显2', sent, second.body);
    } catch (error) {
        console.error(`[Netease] 回显测试失败：${error instanceof Error ? error.message : '未知原因'}`);
    } finally {
        button.textContent = '回显测试';
        button.disabled = false;
    }
}

const LOG_UPLOAD_URL = 'https://probe.suanran9527.com/zhixiang-logs/upload';
const LOG_UPLOAD_TOKEN = import.meta.env.VITE_ZHIXIANG_LOG_TOKEN as string | undefined;

async function runLogUpload(button: HTMLButtonElement): Promise<void> {
    if (!LOG_UPLOAD_TOKEN) {
        console.error('[app] 日志上传未配置（CI secret 未设），无法上传');
        return;
    }
    button.textContent = '上传中…';
    button.disabled = true;
    try {
        const text = getLogText();
        if (!text) {
            console.log('[app] 暂无日志可上传');
            return;
        }
        const response = await httpPost(
            LOG_UPLOAD_URL,
            JSON.stringify({ version: APP_VERSION, device: 'phone', entries: text }),
            {
                'Content-Type': 'application/json',
                'X-ZX-Token': LOG_UPLOAD_TOKEN
            }
        );
        if (response.status !== 200) {
            throw new Error(`服务端 HTTP ${response.status}`);
        }
        console.log(`[app] 日志已上传到 VPS（${text.split('\n').length} 行）`);
    } catch (error) {
        console.error(`[app] 日志上传失败：${error instanceof Error ? error.message : '未知原因'}`);
    } finally {
        button.textContent = '上传日志';
        button.disabled = false;
    }
}

function renderDeveloperSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'developer';

    const title = document.createElement('h2');
    title.textContent = '开发者';
    section.appendChild(title);

    const hint = document.createElement('p');
    hint.className = 'developer-hint';
    hint.textContent = '运行日志存本机（重启后保留），并自动传到 VPS，不用再手动上传；筛好后点 COPY 可把当前看到的日志发出来定位问题。';
    section.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'developer-actions';

    const consoleLabel = document.createElement('span');
    consoleLabel.className = 'dev-console-label';
    actions.appendChild(consoleLabel);

    const copyButton = document.createElement('button');
    copyButton.className = 'login-btn';
    actions.appendChild(copyButton);

    const clearButton = document.createElement('button');
    clearButton.className = 'login-btn';
    clearButton.textContent = 'CLEAR';
    clearButton.addEventListener('click', () => {
        clearLogs();
    });
    actions.appendChild(clearButton);

    // 回显测试（Claude 2026-10-25 实验 1）：把 eapi 的原样请求头经桥发到
    // httpbin.org/headers，看服务端实际收到的是什么——先测一次原样头，
    // 再让服务端种一个 cookie 后测一次，看全局 CookieHandler 是否覆盖
    // 了我们设的 Cookie 头。日志里只记指纹与是否一致，不记任何原始值。
    const echoButton = document.createElement('button');
    echoButton.className = 'login-btn';
    echoButton.textContent = '回显测试';
    echoButton.addEventListener('click', () => {
        void runEchoTest(echoButton);
    });
    actions.appendChild(echoButton);

    // 上传日志（VPS 直读）：把当前全部日志原文发到英国 9929 VPS 的接收服务，
    // 以后不用再 COPY 粘贴。口令由 CI secret 在构建时注入，不进公开仓库源码；
    // 本地构建（无 secret）时按钮只记一行提示，不发请求。
    const uploadButton = document.createElement('button');
    uploadButton.className = 'login-btn';
    uploadButton.textContent = '上传日志';
    uploadButton.addEventListener('click', () => {
        void runLogUpload(uploadButton);
    });
    actions.appendChild(uploadButton);

    // 上游复现实验：同一 YTM 直链由代理原生取三段（0-1MiB、0-1MiB、
    // 1MiB-2MiB），区分双载伪影、重放被拒与后续窗口被拒。结果记日志。
    const experimentButton = document.createElement('button');
    experimentButton.className = 'login-btn';
    experimentButton.textContent = '上游复现实验';
    experimentButton.addEventListener('click', () => {
        experimentButton.disabled = true;
        experimentButton.textContent = '实验中…';
        void runYtmUpstreamExperiment().finally(() => {
            experimentButton.disabled = false;
            experimentButton.textContent = '上游复现实验';
        });
    });
    actions.appendChild(experimentButton);
    section.appendChild(actions);

    const filters = document.createElement('div');
    filters.className = 'dev-filters';

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'dev-search';
    search.placeholder = '搜索日志';
    filters.appendChild(search);

    const levelSelect = document.createElement('select');
    levelSelect.className = 'dev-select';
    for (const [value, label] of [
        ['ALL', 'LEVEL：全部'],
        ['log', 'LOG'],
        ['info', 'INFO'],
        ['warn', 'WARN'],
        ['error', 'ERROR']
    ] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        levelSelect.appendChild(option);
    }
    filters.appendChild(levelSelect);

    const moduleSelect = document.createElement('select');
    moduleSelect.className = 'dev-select';
    filters.appendChild(moduleSelect);
    section.appendChild(filters);

    const box = document.createElement('div');
    box.className = 'developer-log';
    section.appendChild(box);

    let searchText = '';
    let levelFilter = 'ALL';
    let moduleFilter = 'ALL';

    const filtered = (): LogEntry[] => {
        const needle = searchText.trim().toLowerCase();
        return getLogEntries().filter((entry) => {
            if (levelFilter !== 'ALL' && entry.level !== levelFilter) {
                return false;
            }
            if (moduleFilter !== 'ALL' && entry.module !== moduleFilter) {
                return false;
            }
            if (needle && !entry.text.toLowerCase().includes(needle)) {
                return false;
            }
            return true;
        });
    };

    const render = (): void => {
        const all = getLogEntries();
        const shown = filtered();
        consoleLabel.textContent = `CONSOLE (${all.length})`;
        copyButton.textContent = `COPY ${shown.length}`;

        // 模块下拉随日志里出现过的模块补齐，选中项还在就保留。
        const modules = getLogModules();
        const previous = moduleFilter;
        moduleSelect.replaceChildren();
        const allOption = document.createElement('option');
        allOption.value = 'ALL';
        allOption.textContent = 'MODULE：全部';
        moduleSelect.appendChild(allOption);
        for (const module of modules) {
            const option = document.createElement('option');
            option.value = module;
            option.textContent = module;
            moduleSelect.appendChild(option);
        }
        moduleFilter = modules.includes(previous) || previous === 'ALL' ? previous : 'ALL';
        moduleSelect.value = moduleFilter;

        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.replaceChildren();
        if (shown.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'dev-empty';
            empty.textContent = all.length === 0 ? '暂无日志' : '没有符合筛选的日志';
            box.appendChild(empty);
            return;
        }
        for (const entry of shown) {
            const line = document.createElement('div');
            line.className = 'dev-line';
            const time = document.createElement('span');
            time.className = 'dev-time';
            time.textContent = entry.time;
            line.appendChild(time);
            const level = document.createElement('span');
            level.className = `dev-level dev-level-${entry.level}`;
            level.textContent = entry.level.toUpperCase();
            line.appendChild(level);
            const module = document.createElement('span');
            module.className = 'dev-module';
            module.textContent = `[${entry.module}]`;
            line.appendChild(module);
            const text = document.createElement('span');
            text.className = 'dev-text';
            // 模块已单独显示一遍，消息开头的 [Tag] 再显示就重复了，去掉。
            text.textContent = entry.text.replace(/^\[[^\]]+\]\s*/, '');
            line.appendChild(text);
            box.appendChild(line);
        }
        // 用户没往上翻时才跟到底，正在翻旧日志不抢滚动。
        if (nearBottom) {
            box.scrollTop = box.scrollHeight;
        }
    };

    search.addEventListener('input', () => {
        searchText = search.value;
        render();
    });
    levelSelect.addEventListener('change', () => {
        levelFilter = levelSelect.value;
        render();
    });
    moduleSelect.addEventListener('change', () => {
        moduleFilter = moduleSelect.value;
        render();
    });
    copyButton.addEventListener('click', async () => {
        const lines = filtered().map((e) => `[${e.time}] ${e.level.toUpperCase()} ${e.text}`);
        const ok = await copyPlainText(lines.join('\n') || '暂无日志');
        const base = `COPY ${filtered().length}`;
        copyButton.textContent = ok ? '已复制' : '复制失败，请长按日志手动复制';
        window.setTimeout(() => {
            copyButton.textContent = base;
        }, 2000);
    });

    render();
    subscribeLogs(render);

    return section;
}

// 海报墙（第 6 块）：三路各自独立加载，任何一路失败或为空都只在该路
// 留一句中文提示，不影响其余路与整墙；点海报即 playQueue(该海报曲目, 0)。

// 登录区（网易云扫码 + YTM 原生登录）：两处入口放同一区，登录后显示账号标识
// 与退出登录；未登录时一切如旧，登录只影响对应音源。
function renderLoginArea(): HTMLElement {
    const area = document.createElement('section');
    area.className = 'login-area';

    const heading = document.createElement('h2');
    heading.textContent = '登录';
    area.appendChild(heading);

    area.appendChild(renderNeteaseLoginBlock());
    area.appendChild(renderYtmLoginBlock());
    return area;
}

function renderNeteaseLoginBlock(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'login-block';

    const title = document.createElement('h3');
    title.textContent = '网易云';
    box.appendChild(title);

    const body = document.createElement('div');
    box.appendChild(body);

    let pollTimer: number | undefined;
    let currentKey = '';
    // 轮询代次令牌：每次 startQr 换一个新对象；stopPoll 置空。
    // 旧流程里已发出的请求回来时若令牌已换，一律丢弃——防止一次重复
    // 触发产生两个取码、旧 tick 杀掉新轮询器这类竞态（Claude 实验 2 的一类）。
    let qrToken: object | null = null;
    // 连续自动换码计数：健康码（801）会清零；只有“一拿就过期”的坏流程
    // 才会连涨，涨满 10 次停下来给手动按钮，不对坏流程无限刷码。
    let qrAutoRefreshes = 0;
    let qrVisibilityHandler: (() => void) | null = null;
    const stopPoll = (): void => {
        if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
            pollTimer = undefined;
        }
        if (qrVisibilityHandler) {
            document.removeEventListener('visibilitychange', qrVisibilityHandler);
            qrVisibilityHandler = null;
        }
        qrToken = null;
    };

    const renderLoggedOut = (notice?: string): void => {
        stopPoll();
        body.replaceChildren();
        if (notice) {
            const note = document.createElement('p');
            note.className = 'login-notice';
            note.textContent = notice;
            body.appendChild(note);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'login-btn';
        button.textContent = '登录网易云';
        button.addEventListener('click', () => {
            void startQr();
        });
        body.appendChild(button);
    };

    const renderLoggedIn = (session: NeteaseSession): void => {
        stopPoll();
        body.replaceChildren();
        const row = document.createElement('div');
        row.className = 'login-row';
        if (session.avatarUrl) {
            const avatar = document.createElement('img');
            avatar.className = 'login-avatar';
            avatar.src = session.avatarUrl;
            avatar.alt = '';
            row.appendChild(avatar);
        }
        const name = document.createElement('span');
        name.textContent = session.nickname;
        row.appendChild(name);
        const logout = document.createElement('button');
        logout.type = 'button';
        logout.className = 'login-btn';
        logout.textContent = '退出登录';
        logout.addEventListener('click', () => {
            clearNeteaseSession();
            renderLoggedOut();
        });
        row.appendChild(logout);
        body.appendChild(row);
    };

    const startQr = async (auto = false): Promise<void> => {
        stopPoll();
        const token = {};
        qrToken = token;
        if (!auto) {
            qrAutoRefreshes = 0;
        }
        body.replaceChildren();
        const status = document.createElement('p');
        status.className = 'login-notice';
        status.textContent = '正在获取二维码…';
        body.appendChild(status);
        let key: string;
        try {
            key = await fetchQrKey();
        } catch {
            // 取码期间已有新流程开始时，旧流程不再碰界面（新流程已重建了 body）。
            if (token !== qrToken) {
                return;
            }
            status.textContent = '拿不到登录二维码，请稍后重试';
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'login-btn';
            retry.textContent = '重新获取';
            retry.addEventListener('click', () => {
                void startQr();
            });
            body.appendChild(retry);
            return;
        }
        if (token !== qrToken) {
            return;
        }
        currentKey = key;
        console.log('[Netease] 二维码已生成，等待扫码');
        status.textContent = '用网易云 App 扫码登录';
        // 在网易云 App 里打开确认（Claude 2026-10-25 绕过办法）：把二维码
        // 的链接直接发 ACTION_VIEW，系统若把该域名路由给网易云 App，
        // 就直接进 App 内确认页，不用相机、不用切屏，短命码也够用。
        // 自动换新码会重建整个 body，按钮每次都跟着新 key 重建。
        const makeOpenInAppButton = (): HTMLButtonElement => {
            const openInApp = document.createElement('button');
            openInApp.type = 'button';
            openInApp.className = 'login-btn';
            openInApp.textContent = '在网易云 App 里打开确认';
            openInApp.addEventListener('click', () => {
                openInApp.disabled = true;
                void (async () => {
                    try {
                        const handled = await openExternalUrl(qrContentUrl(key));
                        console.log(
                            handled
                                ? '[Netease] 已调起外部打开（网易云 App 或浏览器）'
                                : '[Netease] 无应用可处理该链接，只能扫码'
                        );
                    } catch {
                        console.log('[Netease] 无应用可处理该链接，只能扫码');
                    } finally {
                        openInApp.disabled = false;
                    }
                })();
            });
            return openInApp;
        };
        const qr = document.createElement('img');
        qr.className = 'login-qr';
        qr.src = qrImageUrl(key);
        qr.alt = '网易云登录二维码';
        qr.addEventListener('error', () => {
            if (token !== qrToken) {
                return;
            }
            stopPoll();
            status.textContent = '二维码图片加载失败，请检查网络后点刷新重试';
            body.appendChild(makeOpenInAppButton());
            const refresh = document.createElement('button');
            refresh.type = 'button';
            refresh.className = 'login-btn';
            refresh.textContent = '刷新二维码';
            refresh.addEventListener('click', () => {
                void startQr();
            });
            body.appendChild(refresh);
        });
        body.appendChild(qr);
        body.appendChild(makeOpenInAppButton());
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'login-btn';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => {
            renderLoggedOut();
        });
        body.appendChild(cancel);
        let polling = false;
        let lastPollCode = 0;
        const tick = async (): Promise<void> => {
            // 上一次轮询还没回来时跳过，避免 3 秒间隔下请求堆积。
            if (polling) {
                return;
            }
            // 旧流程的 tick（新流程已开始、或已停）直接丢弃，不碰状态。
            if (token !== qrToken) {
                return;
            }
            polling = true;
            let result;
            try {
                result = await checkQr(currentKey);
            } catch (error) {
                // 网络/HTTP 失败才重试；8821 已是 checkQr 返回的终态，不走这里。
                const reason = qrFailureReason(error);
                status.textContent = `查询失败（${reason}），正在重试…`;
                return;
            } finally {
                polling = false;
            }
            // 请求回来时流程已换代时同样丢弃：旧 tick 的 800 分支绝不能
            // 杀掉新轮询器、也不能再调度一次换码。
            if (token !== qrToken) {
                return;
            }
            // 状态变化才记一行：每 3 秒轮询都记会把控制台刷满。
            if (result.code !== lastPollCode) {
                lastPollCode = result.code;
                if (result.code === 801) {
                    qrAutoRefreshes = 0;
                    console.log('[Netease] 扫码等待中');
                } else if (result.code === 802) {
                    console.log('[Netease] 已扫码，等待手机确认');
                } else if (result.code === 800) {
                    console.log('[Netease] 二维码已过期');
                } else if (result.code === 8821) {
                    console.warn('[Netease] 扫码被拒绝（8821）');
                } else if (result.code === 803) {
                    console.log('[Netease] 扫码已确认');
                }
            }
            if (result.code === 801) {
                status.textContent = '等待扫码';
            } else if (result.code === 802) {
                status.textContent = '已扫码，请在手机上确认';
            } else if (result.code === 800) {
                // 码过期就自动换新码：用户切去网易云 App 扫码再回来时，
                // 旧码可能已过期，屏幕上永远有新鲜码可扫，不用手动点刷新。
                stopPoll();
                if (qrAutoRefreshes < 10) {
                    qrAutoRefreshes += 1;
                    console.log('[Netease] 二维码已过期，已自动换新码');
                    window.setTimeout(() => {
                        // 800ms 内已有新流程开始时跳过（stopPoll 已置空令牌，
                        // 新流程开始会把它换成新对象）；否则正常换新码。
                        if (qrToken !== null) {
                            return;
                        }
                        void startQr(true);
                    }, 800);
                } else {
                    status.textContent = '二维码已过期';
                    const refresh = document.createElement('button');
                    refresh.type = 'button';
                    refresh.className = 'login-btn';
                    refresh.textContent = '刷新二维码';
                    refresh.addEventListener('click', () => {
                        void startQr();
                    });
                    body.appendChild(refresh);
                }
            } else if (result.code === 8821) {
                // 这个码已被拒绝：停掉轮询（继续轮同一码只会一直 8821），
                // 给换新码按钮，不自动刷码以免无意义循环。
                stopPoll();
                status.textContent = '扫码被拒绝';
                const hint = document.createElement('p');
                hint.className = 'login-hint';
                hint.textContent = '这次扫码被网易云拒绝了，换个新码再扫一次。';
                body.appendChild(hint);
                const refresh = document.createElement('button');
                refresh.type = 'button';
                refresh.className = 'login-btn';
                refresh.textContent = '换新码重新扫';
                refresh.addEventListener('click', () => {
                    void startQr();
                });
                body.appendChild(refresh);
            } else if (result.code === 803) {
                stopPoll();
                if (result.session) {
                    saveNeteaseSession(result.session);
                    renderLoggedIn(result.session);
                } else {
                    status.textContent = '登录凭证不完整，请重新扫码';
                    const refresh = document.createElement('button');
                    refresh.type = 'button';
                    refresh.className = 'login-btn';
                    refresh.textContent = '刷新二维码';
                    refresh.addEventListener('click', () => {
                        void startQr();
                    });
                    body.appendChild(refresh);
                }
            }
        };
        // 从网易云 App 切回来时立刻查一次，不等 3 秒间隔：切出去期间
        // 计时器可能被系统节流，回来不补查就会错过 803、只剩过期。
        qrVisibilityHandler = () => {
            if (document.visibilityState === 'visible') {
                void tick();
            }
        };
        document.addEventListener('visibilitychange', qrVisibilityHandler);
        pollTimer = window.setInterval(() => {
            void tick();
        }, 3000);
    };

    const stored = loadNeteaseSession();
    if (stored) {
        // 先按已登录渲染，后台再校验；校验过期才清掉并提示重新登录，
        // 网络异常不断言，保留已登录视图。
        renderLoggedIn(stored);
        void validateStoredSession().then((validity) => {
            console.log(
                `[Netease] 会话校验：${validity === 'valid' ? '有效' : validity === 'expired' ? '已过期' : validity === 'none' ? '无会话' : '状态未知'}`
            );
            if (validity === 'expired' && loadNeteaseSession()?.cookie === stored.cookie) {
                renderLoggedOut('登录已过期，请重新登录');
            }
        });
    } else {
        renderLoggedOut();
    }
    return box;
}

function renderYtmLoginBlock(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'login-block';

    const title = document.createElement('h3');
    title.textContent = 'YouTube Music';
    box.appendChild(title);

    const body = document.createElement('div');
    box.appendChild(body);

    const renderLoggedOut = (notice?: string): void => {
        body.replaceChildren();
        if (notice) {
            const note = document.createElement('p');
            note.className = 'login-notice';
            note.textContent = notice;
            body.appendChild(note);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'login-btn';
        button.textContent = '登录 YouTube Music';
        button.addEventListener('click', () => {
            body.replaceChildren();
            const waiting = document.createElement('p');
            waiting.className = 'login-notice';
            waiting.textContent = '登录页已打开，完成或取消后自动返回…';
            body.appendChild(waiting);
            void signInYtm().then((result) => {
                if (result.ok) {
                    renderLoggedIn();
                } else if (result.cancelled) {
                    renderLoggedOut();
                } else {
                    renderLoggedOut(result.message ?? 'YTM 登录失败');
                }
            });
        });
        body.appendChild(button);
        const hint = document.createElement('p');
        hint.className = 'login-hint';
        hint.textContent = '用 YouTube 账号登录；不登录也能搜歌听歌。';
        body.appendChild(hint);
    };

    const renderLoggedIn = (): void => {
        body.replaceChildren();
        const row = document.createElement('div');
        row.className = 'login-row';
        const name = document.createElement('span');
        // 账号名没有可验证的直连端点，不编名字，只标已登录态。
        name.textContent = '已登录 YouTube Music';
        row.appendChild(name);
        const logout = document.createElement('button');
        logout.type = 'button';
        logout.className = 'login-btn';
        logout.textContent = '退出登录';
        logout.addEventListener('click', () => {
            clearYtmSession();
            renderLoggedOut();
        });
        row.appendChild(logout);
        body.appendChild(row);
    };

    if (loadYtmSession()) {
        renderLoggedIn();
    } else {
        renderLoggedOut();
    }
    return box;
}

// 海报模块（0.1.42）：每源页只放本源那一组海报，不再三组摊开。
// 海报模式（海报墙／卡片／3D 架）是全局值，存在 zx_poster_layout_v1，
// 各页模块共用，任何一页切换都同步到已挂载的全部模块；切换只翻 data-layout，不重渲染。
// 颜色全部走 :root 变量，以后主题深浅切换只需换一套变量值，这里不用动。

type PosterLayout = 'wall' | 'cards' | 'shelf';

const POSTER_LAYOUT_KEY = 'zx_poster_layout_v1';

const POSTER_LAYOUTS: Array<{ id: PosterLayout; label: string }> = [
    { id: 'wall', label: '海报墙' },
    { id: 'cards', label: '卡片' },
    { id: 'shelf', label: '3D 架' }
];

function loadPosterLayout(): PosterLayout {
    const stored = localStorage.getItem(POSTER_LAYOUT_KEY);
    return stored === 'cards' || stored === 'shelf' ? stored : 'wall';
}

let currentPosterLayout: PosterLayout = loadPosterLayout();
const posterModules = new Set<HTMLElement>();
const posterLayoutButtons: HTMLButtonElement[] = [];

function applyPosterLayout(layout: PosterLayout): void {
    currentPosterLayout = layout;
    localStorage.setItem(POSTER_LAYOUT_KEY, layout);
    for (const module of posterModules) {
        module.dataset.layout = layout;
    }
    for (const button of posterLayoutButtons) {
        button.classList.toggle('is-active', button.dataset.layout === layout);
    }
}

function renderPosterModule(definition: PosterSectionDefinition): HTMLElement {
    const module = document.createElement('section');
    module.className = 'poster-module';
    module.dataset.layout = currentPosterLayout;
    posterModules.add(module);

    const head = document.createElement('div');
    head.className = 'poster-module-head';
    const label = document.createElement('h3');
    label.textContent = definition.label;
    head.appendChild(label);

    const layoutSwitch = document.createElement('div');
    layoutSwitch.className = 'poster-layout-switch';
    for (const layout of POSTER_LAYOUTS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'poster-layout-btn';
        button.dataset.layout = layout.id;
        button.textContent = layout.label;
        button.classList.toggle('is-active', layout.id === currentPosterLayout);
        button.addEventListener('click', () => {
            applyPosterLayout(layout.id);
        });
        posterLayoutButtons.push(button);
        layoutSwitch.appendChild(button);
    }
    head.appendChild(layoutSwitch);
    module.appendChild(head);

    const playNotice = document.createElement('p');
    playNotice.className = 'poster-notice';
    playNotice.hidden = true;
    module.appendChild(playNotice);

    const grid = document.createElement('div');
    grid.className = 'poster-grid';
    module.appendChild(grid);

    // 3D 架形态：同一路数据走共享缓存，与海报墙形态只发一次请求；
    // 层标题不画，由模块头统一展示。
    const shelfWrap = document.createElement('div');
    shelfWrap.className = 'poster-shelf-wrap';
    shelfWrap.appendChild(renderShelfLayer(definition, playNotice, false));
    module.appendChild(shelfWrap);

    const notice = document.createElement('p');
    notice.className = 'poster-notice';
    notice.textContent = '正在加载…';
    module.appendChild(notice);

    const cards = new Map<string, HTMLElement>();
    const postersById = new Map<string, Poster>();
    const refreshHighlight = (state: PlaybackState): void => {
        // 简单高亮：当前曲目属于哪张海报，那张海报就高亮，不做复杂状态机。
        for (const [id, card] of cards) {
            const poster = postersById.get(id);
            const playing =
                state.track !== null &&
                poster !== undefined &&
                poster.tracks.some((track) => track.id === state.track?.id);
            card.classList.toggle('is-playing', playing);
        }
    };
    onTrackChange(refreshHighlight);
    refreshHighlight(getCurrentState());

    void (async () => {
        let posters: Poster[];
        try {
            posters = await definition.load();
        } catch (error) {
            const reason = friendlyPosterError(definition, error);
            console.warn(`[Poster] ${definition.label} 加载失败：${reason}`);
            notice.textContent = reason;
            return;
        }
        if (posters.length === 0) {
            notice.textContent = definition.emptyNotice;
            return;
        }
        notice.hidden = true;
        for (const poster of posters) {
            postersById.set(poster.id, poster);
            const card = renderPosterCard(poster, playNotice);
            cards.set(poster.id, card);
            grid.appendChild(card);
        }
        refreshHighlight(getCurrentState());
    })();

    return module;
}

function renderPosterCard(poster: Poster, playNotice: HTMLElement): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'poster-card';

    const coverWrap = document.createElement('div');
    coverWrap.className = 'poster-cover-wrap';
    // 纯色占位在下层：封面缺失或加载失败时露出来，不贴图。
    const placeholder = document.createElement('div');
    placeholder.className = 'poster-cover-placeholder';
    placeholder.style.background = posterFallbackBackground(poster.id);
    coverWrap.appendChild(placeholder);
    if (poster.coverUrl) {
        const cover = document.createElement('img');
        cover.className = 'poster-cover';
        cover.src = poster.coverUrl;
        cover.alt = '';
        cover.onerror = () => {
            cover.remove();
        };
        coverWrap.appendChild(cover);
    }
    // 角标放封面左上角，标题区压在封面底部渐变上：两种布局共用同一套 DOM。
    const badge = document.createElement('span');
    badge.className = 'poster-badge';
    const source = SOURCES.find((item) => item.id === poster.source);
    badge.textContent = source ? source.label : poster.source;
    coverWrap.appendChild(badge);

    const overlay = document.createElement('div');
    overlay.className = 'poster-overlay';

    const title = document.createElement('div');
    title.className = 'poster-title';
    title.textContent = poster.title;
    overlay.appendChild(title);

    if (poster.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.className = 'poster-subtitle';
        subtitle.textContent = poster.subtitle;
        overlay.appendChild(subtitle);
    }

    const count = document.createElement('span');
    count.className = 'poster-count';
    count.textContent = `${poster.tracks.length} 首`;
    overlay.appendChild(count);

    coverWrap.appendChild(overlay);

    // 卡片模式右下角的粉色播放圆点（纯视觉，整卡点击即播放）。
    const playDot = document.createElement('span');
    playDot.className = 'poster-play';
    playDot.textContent = '▶';
    coverWrap.appendChild(playDot);

    card.appendChild(coverWrap);

    card.addEventListener('click', () => {
        void (async () => {
            try {
                await playQueue(poster.tracks, 0);
                playNotice.hidden = true;
            } catch (error) {
                playNotice.textContent = friendlyPlayError(error);
                playNotice.hidden = false;
            }
        })();
    });

    return card;
}

// 音源区（0.1.42）：页头由 Tab 页自己画，这里只出吸顶搜索＋提示＋歌曲行；
// onQuery 供 Tab 页在有查询时把海报区收成细条。返回搜索框给 Tab 再点回顶时聚焦。
function renderSourceSection(
    source: AudioSource,
    status: HTMLElement,
    onQuery: (query: string) => void
): { block: HTMLElement; search: HTMLInputElement } {
    const block = document.createElement('div');
    block.className = 'source-section';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'source-search-wrap';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = `在${source.label}里搜索歌曲、歌手或专辑`;
    search.className = 'source-search';
    searchWrap.appendChild(search);
    block.appendChild(searchWrap);

    const notice = document.createElement('p');
    notice.className = 'source-notice';
    notice.hidden = true;
    block.appendChild(notice);

    const trackList = document.createElement('ul');
    trackList.className = 'track-list';
    block.appendChild(trackList);

    let requestToken = 0;
    const refresh = async (query: string): Promise<void> => {
        const token = ++requestToken;
        let tracks: Track[];
        try {
            tracks = await source.search(query);
        } catch (error) {
            // 网络音源搜索可能失败（断网、接口限流等）：不让异常悬空，
            // 用通用提示区展示中文原因，列表保持上一次的内容。
            if (token !== requestToken) {
                return;
            }
            notice.textContent = friendlySearchError(error);
            notice.hidden = false;
            return;
        }
        if (token !== requestToken) {
            return;
        }
        renderTracks(trackList, tracks, status);
        const localNotice = source.id === 'local' ? getLocalNotice() : null;
        if (tracks.length === 0 && localNotice) {
            notice.textContent = localNotice;
            notice.hidden = false;
        } else if (tracks.length === 0) {
            notice.textContent = query.trim() ? '没有匹配的曲目。' : '这里还没有歌曲。';
            notice.hidden = false;
        } else {
            notice.hidden = true;
        }
    };

    search.addEventListener('input', () => {
        onQuery(search.value);
        void refresh(search.value);
    });
    void refresh('');

    return { block, search };
}

function renderTracks(list: HTMLElement, tracks: Track[], status: HTMLElement): void {
    list.replaceChildren();
    for (const [index, track] of tracks.entries()) {
        const item = document.createElement('li');
        item.className = 'track-row';

        if (track.coverUrl) {
            const cover = document.createElement('img');
            cover.className = 'track-cover';
            cover.src = track.coverUrl;
            cover.alt = '';
            cover.onerror = () => {
                cover.remove();
            };
            item.appendChild(cover);
        }

        const info = document.createElement('div');
        info.className = 'track-info';

        const name = document.createElement('div');
        name.className = 'track-title';
        name.textContent = track.title;
        info.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'track-meta';
        const albumPart = track.album ? ` · ${track.album}` : '';
        const durationPart = formatDuration(track.durationMs);
        meta.textContent = `${track.artist}${albumPart}${durationPart ? ` · ${durationPart}` : ''}`;
        info.appendChild(meta);
        item.appendChild(info);

        // 整行可点：此前只有右侧小按钮有点击，点行本身（封面/歌名/歌手）
        // 全无反应——2026-10-26 用户在 YTM 搜索里点晴天那行正是这样哑火，
        // 日志里连取链都没出现。行点击与按钮共用同一处理，按钮处阻止冒泡，
        // 免得一次点触发两次（0.1.36 的同队列去重本已兜底，这里再挡一层）。
        const playFromRow = (): void => {
            void (async () => {
                try {
                    // 点一首即把该区当前列表作为队列，从点中的这首起播。
                    await playQueue(tracks, index);
                    status.textContent = `正在播放：${track.title} — ${track.artist}`;
                } catch (error) {
                    status.textContent = friendlyPlayError(error);
                }
            })();
        };
        item.addEventListener('click', playFromRow);

        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.className = 'track-play';
        playButton.textContent = '播放';
        playButton.addEventListener('click', (event) => {
            event.stopPropagation();
            playFromRow();
        });
        item.appendChild(playButton);

        list.appendChild(item);
    }
}
