// 首页组装：按音源注册表渲染各音源的浏览区，尚未实现的块留在清单里。
// 本文件只做组装与界面接线，不放音源与播放逻辑。

import { getCurrentState, next, onTimeUpdate, onTrackChange, playQueue, previous, runNeteaseProbe, runYtmUpstreamExperiment, togglePlay } from './playback';
import { openPlayerPage } from './player';
import { openFootprintPage } from './footprint';
import type { PlaybackState } from './playback';
import {
    POSTER_SECTIONS,
    friendlyPosterError,
    posterFallbackBackground,
    posterHue
} from './posters';
import type { PosterSectionDefinition } from './posters';
import { renderShelfLayer } from './shelf';
import { clearLogs, copyPlainText, getLogEntries, getLogModules, getLogText, subscribeLogs, type LogEntry } from './logger';
import {
    applyPerfMode,
    applyTheme,
    clearCustomAccent,
    loadAccent,
    loadCustomAccent,
    loadPerfMode,
    loadThemeId,
    saveCustomAccent,
    THEMES,
} from './appearance';
import { loadVisualToggles, saveVisualToggles } from './visuals';
import { nearestTraditionalColor } from './traditional-colors';
import { SOURCES } from './sources/index';
import { BILI_CHART_ZONES, fetchBilibiliChart } from './sources/bilibili';
import type { BiliChartZone } from './sources/bilibili';
import { checkAllFilesAccess, getLocalCoverDataUrl, getLocalCoverFromNetease, getLocalNotice, getLocalSidecarCoverDataUrl, localSource, requestAllFilesAccess } from './sources/local';
import { addMyImportIds, loadMyImportIds, removeMyImportId } from './my-imports';
import { runBatchWriteback } from './batch-writeback';
import {
    ROAM_SCENE_NAMES,
    endRoaming,
    getRoamState,
    onRoamChange,
    startRoaming
} from './roaming';
import type { RoamScene } from './roaming';
import { fetchNeteaseDailySongs } from './sources/netease';
import { fetchYtmDailyTracks, probeYtmHome } from './sources/ytm';
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

type HomeTabId = 'local' | 'netease' | 'ytm' | 'bilibili' | 'me';

interface TabPage {
    page: HTMLElement;
    search?: HTMLInputElement;
}

export function renderHome(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'home';

    // 花里胡哨的节流阀：减动效或低内存机器（deviceMemory<=4）直接进 lite，
    // CSS 里把光环/闪光/呼吸/入场动画一律关掉，只留静态辉光与渐变。
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        (deviceMemory !== undefined && deviceMemory <= 4)
    ) {
        document.documentElement.dataset.fx = 'lite';
    }

    // 涟漪：一次委托，点哪个按钮就把点击坐标写进该按钮的 --x/--y，
    // CSS 里 ::after 的径向渐变从该点晕开；海报卡与架子卡不走这套
    // （它们有自己的闪光/按压），免得两个 ::after 打架。
    document.addEventListener('pointerdown', (event) => {
        const target = event.target as HTMLElement | null;
        const button = target?.closest?.('button');
        if (!button) {
            return;
        }
        const rect = button.getBoundingClientRect();
        button.style.setProperty('--x', `${event.clientX - rect.left}px`);
        button.style.setProperty('--y', `${event.clientY - rect.top}px`);
    });

    const pagesWrap = document.createElement('div');
    pagesWrap.className = 'tab-pages';
    section.appendChild(pagesWrap);

    // 迷你播放条（0.1.44 单坞设计）：60px 一行，封面＋两行标题＋幽灵上一首／
    // 粉色播放圆＋幽灵下一首，顶部一条 2px 进度线（onTimeUpdate 驱动）；
    // 点标题区打开播放页，不再另放“打开播放页”按钮。空闲时 48px，只留文字＋禁用播放圆。
    const bar = document.createElement('div');
    bar.className = 'now-playing-bar';

    const progress = document.createElement('div');
    progress.className = 'np-progress';
    const progressFill = document.createElement('div');
    progressFill.className = 'np-progress-fill';
    progress.appendChild(progressFill);
    bar.appendChild(progress);

    const cover = document.createElement('img');
    cover.className = 'np-cover';
    cover.alt = '';
    // 0.1.106：B 站图床（hdslb）见非 B 站 Referer 直接 403，App 页源是
    // https://localhost，封面全灭；不带 Referer 则 200，故全部封面图禁 Referer。
    cover.referrerPolicy = 'no-referrer';
    cover.onerror = () => {
        cover.hidden = true;
        coverPlaceholder.hidden = false;
    };
    bar.appendChild(cover);
    const coverPlaceholder = document.createElement('span');
    coverPlaceholder.className = 'np-cover-placeholder';
    coverPlaceholder.textContent = '♪';
    bar.appendChild(coverPlaceholder);

    // 0.1.79 本地迷你条封面：content:// 不能直接塞 <img>（WebView 渲染不了），
    // 播放页同款按专辑 id 调原生转 data URL，取到后缓存复用，取不到仍占位。
    const miniLocalCoverCache = new Map<string, string>();
    let miniCoverTrackId: string | null = null;

    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'np-info';
    const infoTitle = document.createElement('div');
    infoTitle.className = 'np-title';
    infoTitle.textContent = '还没播放任何歌曲。';
    // 副标题同时是播放消息的落点：播歌失败时这里显示原因，下次切歌即恢复歌手名。
    const status = document.createElement('div');
    status.className = 'np-artist';
    info.append(infoTitle, status);
    info.addEventListener('click', () => {
        openPlayerPage();
    });
    bar.appendChild(info);

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'np-btn';
    prevButton.textContent = '◀';
    prevButton.addEventListener('click', () => {
        void previous();
    });
    bar.appendChild(prevButton);

    const playPauseButton = document.createElement('button');
    playPauseButton.type = 'button';
    playPauseButton.className = 'np-btn np-play';
    playPauseButton.textContent = '▶';
    playPauseButton.addEventListener('click', () => {
        // 播放圆一击光圈：box-shadow 扩散 450ms，不用伪元素（涟漪已占 ::after）。
        playPauseButton.classList.remove('burst');
        void playPauseButton.offsetWidth;
        playPauseButton.classList.add('burst');
        window.setTimeout(() => {
            playPauseButton.classList.remove('burst');
        }, 450);
        void togglePlay();
    });
    bar.appendChild(playPauseButton);

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'np-btn';
    nextButton.textContent = '▶';
    nextButton.addEventListener('click', () => {
        void next();
    });
    bar.appendChild(nextButton);
    section.appendChild(bar);

    const updateProgress = (state: PlaybackState): void => {
        // duration 是毫秒（audio.duration 秒 ×1000 或 durationMs），currentTime 是秒。
        const totalSeconds = state.duration > 0 ? state.duration / 1000 : 0;
        const percent = totalSeconds > 0 ? Math.min(100, (state.currentTime / totalSeconds) * 100) : 0;
        progressFill.style.width = `${percent}%`;
    };

    const refreshBar = (state: PlaybackState): void => {
        // 暂停态挂 body 上：均衡器、坞辉光呼吸等动画靠它停，不用各处再订阅。
        document.body.classList.toggle('is-paused', !state.playing);
        // 0.1.85：胶囊导航播放辉光——有曲目且播放中才亮脉动。
        document.querySelector('.tab-bar')?.classList.toggle(
            'is-playing',
            Boolean(state.track && state.playing)
        );
        if (state.track) {
            infoTitle.textContent = state.track.title;
            status.textContent = state.error ?? state.track.artist;
            // 坞辉光跟当前曲目走：id 哈希取色相，与海报占位同一口径。
            bar.style.setProperty('--hue', String(posterHue(state.track.id)));
            if (state.track.coverUrl) {
                const coverUrl = state.track.coverUrl;
                if (coverUrl.startsWith('content://')) {
                    miniCoverTrackId = state.track.id;
                    const cached = miniLocalCoverCache.get(state.track.id);
                    if (cached) {
                        cover.src = cached;
                        cover.hidden = false;
                        coverPlaceholder.hidden = true;
                    } else {
                        cover.hidden = true;
                        coverPlaceholder.hidden = false;
                        const last = coverUrl.split('/').pop() ?? '';
                        const albumId = Number(last);
                        if (Number.isInteger(albumId) && albumId > 0) {
                            // 0.1.106：sidecar 同名图优先；没有再走原有链
                            //（MediaStore 专辑图 → 网易云补源），原有体不动。
                            void getLocalSidecarCoverDataUrl(state.track)
                                .then((sidecar) => sidecar ?? getLocalCoverDataUrl(albumId))
                                .then((dataUrl) => {
                                if (miniCoverTrackId !== state.track?.id) {
                                    return;
                                }
                                if (!dataUrl) {
                                    // 0.1.85：MediaStore 无图时走网易云搜索匹配补封面。
                                    const track = state.track;
                                    if (!track) {
                                        return;
                                    }
                                    void getLocalCoverFromNetease(track).then((coverUrl) => {
                                        if (!coverUrl || miniCoverTrackId !== state.track?.id) {
                                            return;
                                        }
                                        miniLocalCoverCache.set(track.id, coverUrl);
                                        cover.src = coverUrl;
                                        cover.hidden = false;
                                        coverPlaceholder.hidden = true;
                                    });
                                    return;
                                }
                                miniLocalCoverCache.set(state.track.id, dataUrl);
                                cover.src = dataUrl;
                                cover.hidden = false;
                                coverPlaceholder.hidden = true;
                            });
                        }
                    }
                } else {
                    cover.src = coverUrl;
                    cover.hidden = false;
                    coverPlaceholder.hidden = true;
                }
            } else {
                cover.hidden = true;
                coverPlaceholder.hidden = false;
            }
            playPauseButton.textContent = state.playing ? '❚❚' : '▶';
            playPauseButton.disabled = false;
            bar.classList.remove('is-idle');
        } else {
            infoTitle.textContent = '还没播放任何歌曲。';
            status.textContent = state.error ?? '';
            cover.hidden = true;
            coverPlaceholder.hidden = false;
            playPauseButton.textContent = '▶';
            playPauseButton.disabled = true;
            bar.classList.add('is-idle');
        }
        updateProgress(state);
    };
    onTrackChange(refreshBar);
    onTimeUpdate(updateProgress);
    refreshBar(getCurrentState());

    // ---- 底部四 Tab 脚手架 ----
    const pages = new Map<HomeTabId, TabPage>();
    const scrollTops = new Map<HomeTabId, number>();
    const tabButtons = new Map<HomeTabId, HTMLButtonElement>();
    let currentTab: HomeTabId = 'local';

    function mountPage(tabId: HomeTabId): TabPage {
        if (tabId === 'me') {
            const page = document.createElement('div');
            page.className = 'tab-page';
            const heading = document.createElement('h2');
            heading.textContent = '我的';
            page.appendChild(heading);
            page.appendChild(renderLoginArea());
            page.appendChild(renderThemeWardrobe());
            page.appendChild(renderRainWindow());
            page.appendChild(renderPerfModeSection());
            page.appendChild(renderLayoutMixSection());
            page.appendChild(renderRoamingSection());
            page.appendChild(renderFootprintEntry());
            page.appendChild(renderDeveloperSection());
            const record: TabPage = { page };
            pages.set(tabId, record);
            pagesWrap.appendChild(page);
            return record;
        }
        const source = SOURCES.find((item) => item.id === tabId);
        const definition = POSTER_SECTIONS.find((item) => item.key === tabId);
        if (!source) {
            throw new Error(`未知 Tab：${tabId}`);
        }
        // 0.1.104：B 站页 v1 只有搜索，没有海报墙——海报模块改为可选，
        // 没有 definition 的源直接跳过海报区，只留搜索区。
        const page = document.createElement('div');
        page.className = 'tab-page';

        const head = document.createElement('div');
        head.className = 'tab-page-head';
        const heading = document.createElement('h2');
        heading.textContent = source.label;
        head.appendChild(heading);
        page.appendChild(head);

        if (definition) {
            page.appendChild(renderPosterModule(definition));
        }

        if (tabId === 'local') {
            page.appendChild(renderMyImportsSection());
            page.appendChild(renderWritebackSection());
        }

        if (tabId === 'netease') {
            page.appendChild(renderNeteaseDailySection());
        }

        if (tabId === 'ytm') {
            page.appendChild(renderYtmDailySection());
        }

        if (tabId === 'bilibili') {
            page.appendChild(renderBilibiliDiscoverySection(status));
        }

        const { block, search } = renderSourceSection(source, status, (query) => {
            // 有查询时海报区收成细条（只剩标题＋切换行），结果接管页面。
            page.classList.toggle('has-query', query.trim().length > 0);
        });
        page.appendChild(block);

        const record: TabPage = { page, search };
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
        for (const [id, button] of tabButtons) {
            button.classList.toggle('is-active', id === tabId);
        }
        // 滑动指示条：按激活按钮实测位置走，不用 25% 估算（padding/gap 会偏）。
        const activeButton = tabButtons.get(tabId);
        if (activeButton && tabIndicator) {
            tabIndicator.style.width = `${activeButton.offsetWidth}px`;
            tabIndicator.style.transform = `translateX(${activeButton.offsetLeft}px)`;
        }
        window.scrollTo(0, scrollTops.get(tabId) ?? 0);
        // 切页后海报开关滑块也要重定位（页刚挂上时量不到宽）。
        requestAnimationFrame(() => {
            positionPosterThumbs();
        });
    }

    window.addEventListener('resize', () => {
        positionPosterThumbs();
    });

    const tabBar = document.createElement('nav');
    tabBar.className = 'tab-bar';
    const tabIndicator = document.createElement('div');
    tabIndicator.className = 'tab-indicator';
    tabBar.appendChild(tabIndicator);
    const TAB_DEFS: Array<{ id: HomeTabId; label: string }> = [
        { id: 'local', label: '本地' },
        { id: 'netease', label: '网易云' },
        { id: 'ytm', label: 'YTM' },
        { id: 'bilibili', label: 'B站' },
        { id: 'me', label: '我的' }
    ];
    for (const def of TAB_DEFS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tab-btn';
        button.textContent = def.label;
        button.addEventListener('click', () => {
            // 0.1.85：胶囊导航点按轻震，不支持的设备静默跳过。
            try {
                navigator.vibrate?.(10);
            } catch {
                // 忽略震动不可用。
            }
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
        storedTab === 'netease' || storedTab === 'ytm' || storedTab === 'bilibili' || storedTab === 'me'
            ? storedTab
            : 'local';
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
        console.error(`[Netease] 回声测试失败：${error instanceof Error ? error.message : '未知原因'}`);
    } finally {
        button.textContent = '回声测试';
        button.disabled = false;
    }
}

const LOG_UPLOAD_URL = 'http://38.59.249.99:18091/upload';
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
        button.textContent = '上传现场';
        button.disabled = false;
    }
}

function renderDeveloperSection(): HTMLElement {
    // 磁吸折叠卡（Folia 设置页式）：平时只露头行，点整行展开；
    // 状态持久化，默认收起——你是主要使用者，重开回到上次的状态。
    const DEV_OPEN_KEY = 'zx.dev.open';
    let devOpen = localStorage.getItem(DEV_OPEN_KEY) === '1';

    const section = document.createElement('section');
    section.className = 'developer mag-card dev-card';
    section.dataset.open = devOpen ? 'true' : 'false';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'mag-head';
    head.setAttribute('aria-expanded', devOpen ? 'true' : 'false');
    head.setAttribute('aria-controls', 'dev-body');

    const tile = document.createElement('span');
    tile.className = 'mag-tile';
    tile.textContent = '>_';
    head.appendChild(tile);

    const headTitles = document.createElement('span');
    headTitles.className = 'mag-titles';
    const title = document.createElement('span');
    title.className = 'mag-title';
    title.textContent = '调音台';
    const debugChip = document.createElement('span');
    debugChip.className = 'dev-debug-chip';
    debugChip.textContent = 'DEBUG';
    title.appendChild(debugChip);
    headTitles.appendChild(title);
    const sub = document.createElement('span');
    sub.className = 'mag-sub';
    sub.textContent = '运行日志与内存监控';
    headTitles.appendChild(sub);
    head.appendChild(headTitles);

    // 收起时头行右侧只露总数徽标；有 ERR 时染红（下面 render 里刷）。
    const countBadge = document.createElement('span');
    countBadge.className = 'dev-count-badge';
    countBadge.textContent = '0';
    head.appendChild(countBadge);

    const chevron = document.createElement('span');
    chevron.className = 'mag-chevron';
    chevron.textContent = '▾';
    head.appendChild(chevron);
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'mag-body';
    body.id = 'dev-body';
    const inner = document.createElement('div');
    inner.className = 'mag-inner';
    body.appendChild(inner);
    section.appendChild(body);

    const hint = document.createElement('p');
    hint.className = 'developer-hint';
    hint.textContent = '运行日志存本机（重启后保留），并自动传到 VPS，不用再手动上传；筛好后点 复制 可把当前看到的日志发出来定位问题。';
    inner.appendChild(hint);

    // 展开后的顺序（Claude 稿，一个不少）：说明 → CONSOLE 行 → 三测试行 →
    // 搜索行 → LEVEL/MODULE 双列 → 日志盒。
    const consoleRow = document.createElement('div');
    consoleRow.className = 'dev-console-row';

    const consoleLabel = document.createElement('span');
    consoleLabel.className = 'dev-console-label';
    consoleRow.appendChild(consoleLabel);

    const copyButton = document.createElement('button');
    copyButton.className = 'login-btn';
    consoleRow.appendChild(copyButton);

    const clearButton = document.createElement('button');
    clearButton.className = 'login-btn login-btn-ghost';
    clearButton.textContent = '清空';
    clearButton.addEventListener('click', () => {
        clearLogs();
    });
    consoleRow.appendChild(clearButton);
    inner.appendChild(consoleRow);

    const testRow = document.createElement('div');
    testRow.className = 'dev-test-row';
    inner.appendChild(testRow);

    // 回显测试（Claude 2026-10-25 实验 1）：把 eapi 的原样请求头经桥发到
    // httpbin.org/headers，看服务端实际收到的是什么——先测一次原样头，
    // 再让服务端种一个 cookie 后测一次，看全局 CookieHandler 是否覆盖
    // 了我们设的 Cookie 头。日志里只记指纹与是否一致，不记任何原始值。
    const echoButton = document.createElement('button');
    echoButton.className = 'login-btn';
    echoButton.textContent = '回声测试';
    echoButton.addEventListener('click', () => {
        void runEchoTest(echoButton);
    });
    testRow.appendChild(echoButton);

    // 上传日志（VPS 直读）：把当前全部日志原文发到英国 9929 VPS 的接收服务，
    // 以后不用再 COPY 粘贴。口令由 CI secret 在构建时注入，不进公开仓库源码；
    // 本地构建（无 secret）时按钮只记一行提示，不发请求。
    const uploadButton = document.createElement('button');
    uploadButton.className = 'login-btn';
    uploadButton.textContent = '上传现场';
    uploadButton.addEventListener('click', () => {
        void runLogUpload(uploadButton);
    });
    testRow.appendChild(uploadButton);

    // 上游复现实验：同一 YTM 直链由代理原生取三段（0-1MiB、0-1MiB、
    // 1MiB-2MiB），区分双载伪影、重放被拒与后续窗口被拒。结果记日志。
    const experimentButton = document.createElement('button');
    experimentButton.className = 'login-btn';
    experimentButton.textContent = '上游复现';
    experimentButton.addEventListener('click', () => {
        experimentButton.disabled = true;
        experimentButton.textContent = '实验中…';
        void runYtmUpstreamExperiment().finally(() => {
            experimentButton.disabled = false;
            experimentButton.textContent = '上游复现';
        });
    });
    testRow.appendChild(experimentButton);

    // 网易云取流探针（0.1.74）：当前网易云曲目取新链后，原生 7 臂矩阵
    // 只变一个量，判 UA / Referer / Range / scheme / 重放哪一个翻 403。
    const neteaseProbeButton = document.createElement('button');
    neteaseProbeButton.className = 'login-btn';
    neteaseProbeButton.textContent = '取流探针';
    neteaseProbeButton.addEventListener('click', () => {
        neteaseProbeButton.disabled = true;
        neteaseProbeButton.textContent = '探针中…';
        void runNeteaseProbe().finally(() => {
            neteaseProbeButton.disabled = false;
            neteaseProbeButton.textContent = '取流探针';
        });
    });
    testRow.appendChild(neteaseProbeButton);

    // YTM 首页探针（0.1.82）：FEmusic_home 多臂分测，见 ytm.ts probeYtmHome。
    const ytmHomeProbeButton = document.createElement('button');
    ytmHomeProbeButton.className = 'login-btn';
    ytmHomeProbeButton.textContent = 'YTM 首页探针';
    ytmHomeProbeButton.addEventListener('click', () => {
        ytmHomeProbeButton.disabled = true;
        ytmHomeProbeButton.textContent = '探针中…';
        void probeYtmHome().finally(() => {
            ytmHomeProbeButton.disabled = false;
            ytmHomeProbeButton.textContent = 'YTM 首页探针';
        });
    });
    testRow.appendChild(ytmHomeProbeButton);

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
    inner.appendChild(filters);

    const box = document.createElement('div');
    box.className = 'developer-log';
    inner.appendChild(box);

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

    // 收起时不渲染日志 DOM（500 行），只刷头行徽标：总数＋有 ERR 染红；
    // 展开时再全量渲染——这是折叠卡真正的性能收益。
    const renderBadge = (all: LogEntry[]): void => {
        countBadge.textContent = String(all.length);
        countBadge.classList.toggle('has-err', all.some((entry) => entry.level === 'error'));
    };

    const render = (): void => {
        const all = getLogEntries();
        renderBadge(all);
        if (!devOpen) {
            return;
        }
        const shown = filtered();
        consoleLabel.textContent = `现场日志 (${all.length})`;
        copyButton.textContent = `复制 ${shown.length}`;

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
        const base = `复制 ${filtered().length}`;
        copyButton.textContent = ok ? '已复制' : '复制失败，请长按日志手动复制';
        window.setTimeout(() => {
            copyButton.textContent = base;
        }, 2000);
    });

    head.addEventListener('click', () => {
        devOpen = !devOpen;
        localStorage.setItem(DEV_OPEN_KEY, devOpen ? '1' : '0');
        section.dataset.open = devOpen ? 'true' : 'false';
        head.setAttribute('aria-expanded', devOpen ? 'true' : 'false');
        if (devOpen) {
            render();
            // 展开后把卡顶滚到视口顶，免得日志盒被坞盖住。
            section.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    });

    render();
    subscribeLogs(render);

    return section;
}

// 海报墙（第 6 块）：三路各自独立加载，任何一路失败或为空都只在该路
// 留一句中文提示，不影响其余路与整墙；点海报即 playQueue(该海报曲目, 0)。

// 登录区（网易云扫码 + YTM 原生登录）：两处入口放同一区，登录后显示账号标识
// 与退出登录；未登录时一切如旧，登录只影响对应音源。
// 音乐足迹入口（0.1.54）：放登录区与开发者区之间，点开足迹页。
function renderFootprintEntry(): HTMLElement {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'footprint-entry';
    const main = document.createElement('span');
    main.className = 'footprint-entry-main';
    const titleText = document.createElement('span');
    titleText.className = 'footprint-entry-title';
    titleText.textContent = '旋律手记';
    const sub = document.createElement('span');
    sub.className = 'footprint-entry-sub';
    sub.textContent = '收听时长 · 唱片墙 · TOP 歌曲';
    main.append(titleText, sub);
    const chev = document.createElement('span');
    chev.className = 'footprint-entry-chev';
    chev.textContent = '›';
    entry.append(main, chev);
    entry.addEventListener('click', () => {
        openFootprintPage();
    });
    return entry;
}

// 0.1.80 排布工坊（我的页单独做）：每个音源的海报排布单独选，
// 跟随全局 / 磁带馆 / 星卷 / 黑胶 / 巨幕五档，点选即时生效到已挂载
// 的海报模块，未挂载的页下次进页时按选择渲染。
// 0.1.82 版式配方（原排布工坊）：平时只露头行与当前配方，点开才见
// 预设 chips 与每音源的单选行。预设映射：混搭推荐=本地磁带馆+网易云
// 黑胶+YTM 星卷；其余三档是三源同版式全套。
function renderLayoutMixSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'layout-mix';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'layout-mix-head';
    const headTitle = document.createElement('span');
    headTitle.className = 'layout-mix-head-title';
    headTitle.textContent = '版式配方';
    const headCurrent = document.createElement('span');
    headCurrent.className = 'layout-mix-head-current';
    const headChev = document.createElement('span');
    headChev.className = 'layout-mix-head-chev';
    headChev.textContent = '▾';
    head.append(headTitle, headCurrent, headChev);
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'layout-mix-body';
    body.hidden = true;
    section.appendChild(body);

    const presets: Array<{ id: string; label: string; mix: Record<string, PosterLayoutMixValue> }> = [
        { id: 'mix-rec', label: '混搭推荐', mix: { local: 'tape', netease: 'vinyl', ytm: 'scroll' } },
        { id: 'tape-all', label: '磁带馆全套', mix: { local: 'tape', netease: 'tape', ytm: 'tape' } },
        { id: 'vinyl-night', label: '黑胶之夜', mix: { local: 'vinyl', netease: 'vinyl', ytm: 'vinyl' } },
        { id: 'scroll-roam', label: '星卷漫游', mix: { local: 'scroll', netease: 'scroll', ytm: 'scroll' } },
    ];
    const currentPresetLabel = (): string => {
        for (const preset of presets) {
            const match = (['local', 'netease', 'ytm'] as const).every(
                (key) => (posterLayoutMix[key] ?? 'follow') === preset.mix[key]
            );
            if (match) {
                return preset.label;
            }
        }
        return '自定义混搭';
    };
    const presetButtons: HTMLButtonElement[] = [];
    const refreshPreset = (): void => {
        const label = currentPresetLabel();
        headCurrent.textContent = `当前：${label} · 点开换配方`;
        for (const [index, button] of presetButtons.entries()) {
            button.classList.toggle('is-active', presets[index]?.label === label);
        }
    };

    const presetRow = document.createElement('div');
    presetRow.className = 'layout-mix-presets';
    for (const preset of presets) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'layout-mix-preset-btn';
        button.textContent = preset.label;
        button.addEventListener('click', () => {
            for (const key of ['local', 'netease', 'ytm'] as const) {
                applyPosterLayoutMix(key, preset.mix[key] as PosterLayoutMixValue);
            }
            refreshMixRows();
            refreshPreset();
        });
        presetButtons.push(button);
        presetRow.appendChild(button);
    }
    body.appendChild(presetRow);

    const mixRows: Array<{ key: string; buttons: HTMLButtonElement[] }> = [];
    for (const definition of POSTER_SECTIONS) {
        const row = document.createElement('div');
        row.className = 'layout-mix-row';
        const label = document.createElement('span');
        label.className = 'layout-mix-label';
        label.textContent = definition.label;
        row.appendChild(label);

        const options: Array<{ id: PosterLayoutMixValue; label: string }> = [
            { id: 'follow', label: '跟随全局' },
            ...POSTER_LAYOUTS
        ];
        const buttons: HTMLButtonElement[] = [];
        for (const option of options) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'layout-mix-btn';
            button.textContent = option.label;
            const current = posterLayoutMix[definition.key] ?? 'follow';
            button.classList.toggle('is-active', current === option.id);
            button.addEventListener('click', () => {
                applyPosterLayoutMix(definition.key, option.id);
                for (const other of buttons) {
                    other.classList.toggle('is-active', other === button);
                }
                refreshPreset();
            });
            buttons.push(button);
            row.appendChild(button);
        }
        mixRows.push({ key: definition.key, buttons });
        body.appendChild(row);
    }
    const refreshMixRows = (): void => {
        for (const entry of mixRows) {
            const current = posterLayoutMix[entry.key] ?? 'follow';
            for (const button of entry.buttons) {
                const option = POSTER_LAYOUTS.find((layout) => layout.label === button.textContent);
                const id: PosterLayoutMixValue = button.textContent === '跟随全局'
                    ? 'follow'
                    : (option?.id ?? 'follow');
                button.classList.toggle('is-active', current === id);
            }
        }
    };
    refreshPreset();

    head.addEventListener('click', () => {
        body.hidden = !body.hidden;
        headChev.textContent = body.hidden ? '▾' : '▴';
    });
    return section;
}

function renderLoginArea(): HTMLElement {
    // 0.1.85：听歌钥匙改成一个收起模块（折叠写法同版式配方卡）——平时只露
    // 标题、副标题、一行真实登录状态与箭头，点标题展开后两行登录才在模块
    // 里面出现。默认收起。
    const area = document.createElement('section');
    area.className = 'login-area login-key-module';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'login-key-head';
    const headText = document.createElement('span');
    headText.className = 'login-key-head-text';
    const heading = document.createElement('span');
    heading.className = 'login-key-head-title';
    heading.textContent = '听歌钥匙';
    const loginSub = document.createElement('span');
    loginSub.className = 'login-area-sub';
    loginSub.textContent = '双源登录 · 一处管理';
    headText.append(heading, loginSub);
    const summary = document.createElement('span');
    summary.className = 'login-key-summary';
    const headChev = document.createElement('span');
    headChev.className = 'login-key-head-chev';
    headChev.textContent = '▾';
    head.append(headText, summary, headChev);
    area.appendChild(head);

    const body = document.createElement('div');
    body.className = 'login-key-body';
    body.hidden = true;
    area.appendChild(body);

    // 收起态状态行：两块各自回调真实登录态，这里只聚合展示，不碰登录逻辑。
    let neteaseLoggedIn = false;
    let ytmLoggedIn = false;
    const refreshSummary = (): void => {
        summary.replaceChildren();
        const build = (loggedIn: boolean, label: string): HTMLElement => {
            const item = document.createElement('span');
            item.className = 'login-key-summary-item';
            if (loggedIn) {
                const dot = document.createElement('span');
                dot.className = 'login-key-summary-dot';
                item.appendChild(dot);
            }
            item.append(document.createTextNode(loggedIn ? `${label}已登录` : `${label}未登录`));
            return item;
        };
        summary.append(
            build(neteaseLoggedIn, '网易云'),
            document.createTextNode(' · '),
            build(ytmLoggedIn, 'YouTube Music')
        );
    };
    refreshSummary();
    body.appendChild(renderNeteaseLoginBlock((loggedIn) => {
        neteaseLoggedIn = loggedIn;
        refreshSummary();
    }));
    body.appendChild(renderYtmLoginBlock((loggedIn) => {
        ytmLoggedIn = loggedIn;
        refreshSummary();
    }));

    head.addEventListener('click', () => {
        body.hidden = !body.hidden;
        headChev.textContent = body.hidden ? '▾' : '▴';
    });
    return area;
}

// 取色面板 HSV 换算（滑杆式取色器用，色值与滑杆双向同步）。
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const hue = ((h % 360) + 360) % 360;
    const c = (v / 100) * (s / 100);
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = v / 100 - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (hue < 60) {
        r = c;
        g = x;
    } else if (hue < 120) {
        r = x;
        g = c;
    } else if (hue < 180) {
        g = c;
        b = x;
    } else if (hue < 240) {
        g = x;
        b = c;
    } else if (hue < 300) {
        r = x;
        b = c;
    } else {
        r = c;
        b = x;
    }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === rn) {
            h = 60 * (((gn - bn) / d) % 6);
        } else if (max === gn) {
            h = 60 * ((bn - rn) / d + 2);
        } else {
            h = 60 * ((rn - gn) / d + 4);
        }
    }
    if (h < 0) {
        h += 360;
    }
    const s = max === 0 ? 0 : (d / max) * 100;
    return [Math.round(h), Math.round(s), Math.round(max * 100)];
}

function hexByte(n: number): string {
    return Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();
}

function parseHexColor(text: string): { h: number; s: number; v: number; a: number } | null {
    const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(text.trim());
    if (!m) {
        return null;
    }
    const part = m[1]!;
    const r = parseInt(part.slice(0, 2), 16);
    const g = parseInt(part.slice(2, 4), 16);
    const b = parseInt(part.slice(4, 6), 16);
    const a = m[2] ? Math.round((parseInt(m[2], 16) / 255) * 100) : 100;
    const [h, s, v] = rgbToHsv(r, g, b);
    return { h, s, v, a };
}

// 主题配色取色面板（滑杆式）：色相 / 饱和度 / 明度 / 透明度四条滑杆＋
// 色值输入框双向同步，顶部 ✕ 取消、✓ 确定；确定才存该主题的自选色
// （等于主题默认色时不存），取消/点遮罩恢复打开前的主色，恢复默认色清掉自选。
function openColorSheet(themeId: string, onDone: () => void): void {
    const theme = THEMES.find((item) => item.id === themeId) ?? THEMES[0]!;
    const previous = loadAccent(themeId);
    const start = parseHexColor(previous) ?? { h: 330, s: 100, v: 100, a: 100 };
    let h = start.h;
    let s = start.s;
    let v = start.v;
    let a = start.a;

    const backdrop = document.createElement('div');
    backdrop.className = 'zx-color-sheet-backdrop';
    const sheet = document.createElement('div');
    sheet.className = 'zx-color-sheet';
    const close = (): void => {
        backdrop.remove();
    };
    const restorePrevious = (): void => {
        document.body.style.setProperty('--theme-accent', previous);
    };

    const top = document.createElement('div');
    top.className = 'zx-color-sheet-top';
    const cancelTop = document.createElement('button');
    cancelTop.type = 'button';
    cancelTop.className = 'zx-color-sheet-top-btn';
    cancelTop.textContent = '✕';
    cancelTop.addEventListener('click', () => {
        restorePrevious();
        close();
    });
    const title = document.createElement('span');
    title.className = 'zx-color-sheet-title';
    title.textContent = '选择主题色';
    const confirmTop = document.createElement('button');
    confirmTop.type = 'button';
    confirmTop.className = 'zx-color-sheet-top-btn';
    confirmTop.textContent = '✓';
    top.append(cancelTop, title, confirmTop);
    sheet.appendChild(top);

    const preview = document.createElement('div');
    preview.className = 'zx-color-sheet-preview';
    sheet.appendChild(preview);

    const slider = (cls: string, max: number, value: number): HTMLInputElement => {
        const input = document.createElement('input');
        input.type = 'range';
        input.className = `zx-color-slider ${cls}`;
        input.min = '0';
        input.max = String(max);
        input.value = String(value);
        return input;
    };
    const hueSlider = slider('zx-color-slider-hue', 360, h);
    const satSlider = slider('zx-color-slider-sat', 100, s);
    const valSlider = slider('zx-color-slider-val', 100, v);
    const alphaSlider = slider('zx-color-slider-alpha', 100, a);

    const rgb = (hh: number, ss: number, vv: number): string => {
        const [r, g, b] = hsvToRgb(hh, ss, vv);
        return `rgb(${r}, ${g}, ${b})`;
    };
    const currentHex = (): string => {
        const [r, g, b] = hsvToRgb(h, s, v);
        const base = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
        return a >= 100 ? base : base + hexByte((a / 100) * 255);
    };
    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.className = 'zx-color-sheet-hex-input';
    hexInput.setAttribute('aria-label', '主题色代码');
    const hexWrap = document.createElement('div');
    hexWrap.className = 'zx-color-sheet-hex-wrap';
    const hexLabel = document.createElement('span');
    hexLabel.className = 'zx-color-sheet-hex-label';
    hexLabel.textContent = '主题色代码';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'zx-color-sheet-hex-label';
    hexWrap.append(hexLabel, hexInput, nameLabel);

    const sync = (previewOnly: boolean, keepInput = false): void => {
        const [r, g, b] = hsvToRgb(h, s, v);
        const alpha = a / 100;
        preview.style.background =
            `linear-gradient(rgba(${r}, ${g}, ${b}, ${alpha}), rgba(${r}, ${g}, ${b}, ${alpha})), ` +
            'repeating-conic-gradient(#c8c8c8 0% 25%, #ffffff 0% 50%) 0 0 / 16px 16px';
        satSlider.style.background = `linear-gradient(90deg, ${rgb(h, 0, v)}, ${rgb(h, 100, v)})`;
        valSlider.style.background = `linear-gradient(90deg, #000000, ${rgb(h, s, 100)})`;
        alphaSlider.style.background =
            `linear-gradient(90deg, rgba(${r}, ${g}, ${b}, 0), rgba(${r}, ${g}, ${b}, 1)), ` +
            'repeating-conic-gradient(#c8c8c8 0% 25%, #ffffff 0% 50%) 0 0 / 16px 16px';
        const hex = currentHex();
        if (!keepInput) {
            hexInput.value = hex;
        }
        nameLabel.textContent = `当前颜色：${nearestTraditionalColor(r, g, b)}`;
        if (!previewOnly) {
            document.body.style.setProperty('--theme-accent', hex);
        }
    };
    const bind = (el: HTMLInputElement, set: (n: number) => void): void => {
        el.addEventListener('input', () => {
            set(Number(el.value));
            sync(false);
        });
    };
    bind(hueSlider, (n) => {
        h = n;
    });
    bind(satSlider, (n) => {
        s = n;
    });
    bind(valSlider, (n) => {
        v = n;
    });
    bind(alphaSlider, (n) => {
        a = n;
    });
    const applyHexText = (text: string): boolean => {
        const parsed = parseHexColor(text);
        if (!parsed) {
            return false;
        }
        h = parsed.h;
        s = parsed.s;
        v = parsed.v;
        a = parsed.a;
        hueSlider.value = String(h);
        satSlider.value = String(s);
        valSlider.value = String(v);
        alphaSlider.value = String(a);
        return true;
    };
    // 边输边提示：输满合法色值就立刻换滑杆位置、预览条和 App 主色；
    // 没输完（非法）时不动，等继续输；输错提交时弹回当前色。
    hexInput.addEventListener('input', () => {
        if (applyHexText(hexInput.value)) {
            sync(false, true);
        }
    });
    hexInput.addEventListener('change', () => {
        if (!applyHexText(hexInput.value)) {
            hexInput.value = currentHex();
            return;
        }
        sync(false);
    });
    sheet.append(hueSlider, satSlider, valSlider, alphaSlider, hexWrap);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'zx-color-sheet-reset';
    reset.textContent = '恢复默认色';
    reset.addEventListener('click', () => {
        clearCustomAccent(themeId);
        document.body.style.setProperty('--theme-accent', theme.accent);
        onDone();
        close();
    });
    sheet.appendChild(reset);

    confirmTop.addEventListener('click', () => {
        const hex = currentHex();
        if (hex.toUpperCase() === theme.accent.toUpperCase()) {
            clearCustomAccent(themeId);
        } else {
            saveCustomAccent(themeId, hex);
        }
        onDone();
        close();
    });
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
            restorePrevious();
            close();
        }
    });
    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);
    sync(true);
}

// 0.1.86 主题衣橱改成收起模块（同听歌钥匙）：外面只露模块头（标题＋副标题＋
// 当前主题＋箭头），点标题展开后三行主题与主题配色行才在模块里面出现。默认收起。
function renderThemeWardrobe(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'zx-appearance-card';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'zx-appearance-head';
    const headText = document.createElement('span');
    headText.className = 'zx-appearance-head-text';
    const heading = document.createElement('span');
    heading.className = 'zx-appearance-head-title';
    heading.textContent = '主题衣橱';
    const sub = document.createElement('span');
    sub.className = 'zx-appearance-sub';
    sub.textContent = '三套主题 · 一处换装';
    const summary = document.createElement('span');
    summary.className = 'zx-appearance-summary';
    headText.append(heading, sub, summary);
    const headChev = document.createElement('span');
    headChev.className = 'zx-appearance-head-chev';
    headChev.textContent = '▾';
    head.append(headText, headChev);
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'zx-appearance-body';
    body.hidden = true;
    section.appendChild(body);

    const checks = new Map<string, HTMLElement>();
    const hexText = document.createElement('span');
    hexText.className = 'zx-theme-hex';
    const customMark = document.createElement('span');
    customMark.className = 'zx-theme-hex';
    const refresh = (): void => {
        const current = loadThemeId();
        for (const [id, check] of checks) {
            check.textContent = id === current ? '✓' : '';
            check.parentElement?.classList.toggle('is-active', id === current);
        }
        const theme = THEMES.find((item) => item.id === current) ?? THEMES[0]!;
        hexText.textContent = loadAccent(current);
        customMark.textContent = loadCustomAccent(current) ? ' · 已自定义' : '';
        summary.textContent = `当前：${theme.name}`;
    };
    for (const theme of THEMES) {
        const row = document.createElement('div');
        row.className = 'zx-appearance-row';
        const thumb = document.createElement('span');
        thumb.className = 'zx-theme-thumb';
        thumb.style.backgroundImage = `url("${theme.wallpaper}")`;
        row.appendChild(thumb);
        const text = document.createElement('span');
        text.className = 'zx-appearance-row-text';
        const name = document.createElement('b');
        name.textContent = theme.name;
        const desc = document.createElement('p');
        desc.textContent = theme.desc;
        text.append(name, desc);
        row.appendChild(text);
        const check = document.createElement('span');
        check.className = 'zx-appearance-check';
        checks.set(theme.id, check);
        row.appendChild(check);
        row.addEventListener('click', () => {
            applyTheme(theme.id);
            refresh();
        });
        body.appendChild(row);
    }
    const colorRow = document.createElement('div');
    colorRow.className = 'zx-appearance-row zx-theme-color-row';
    const colorText = document.createElement('span');
    colorText.className = 'zx-appearance-row-text';
    const colorName = document.createElement('b');
    colorName.textContent = '主题配色';
    const colorDesc = document.createElement('p');
    colorDesc.append(document.createTextNode('当前主题色：'), hexText, customMark);
    colorText.append(colorName, colorDesc);
    colorRow.appendChild(colorText);
    const palette = document.createElement('span');
    palette.className = 'zx-theme-palette';
    palette.textContent = '🎨';
    colorRow.appendChild(palette);
    colorRow.addEventListener('click', () => {
        openColorSheet(loadThemeId(), refresh);
    });
    body.appendChild(colorRow);
    head.addEventListener('click', () => {
        body.hidden = !body.hidden;
        headChev.textContent = body.hidden ? '▾' : '▴';
    });
    refresh();
    return section;
}


// 0.1.86 雨窗改成收起模块（同听歌钥匙）：外面只露模块头（标题＋副标题＋
// 当前档位＋箭头），点标题展开后三档才在模块里面出现。默认收起。
function renderRainWindow(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'zx-appearance-card';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'zx-appearance-head';
    const headText = document.createElement('span');
    headText.className = 'zx-appearance-head-text';
    const heading = document.createElement('span');
    heading.className = 'zx-appearance-head-title';
    heading.textContent = '雨窗';
    const sub = document.createElement('span');
    sub.className = 'zx-appearance-sub';
    sub.textContent = '水滴落在玻璃上 · 三档可选';
    const summary = document.createElement('span');
    summary.className = 'zx-appearance-summary';
    headText.append(heading, sub, summary);
    const headChev = document.createElement('span');
    headChev.className = 'zx-appearance-head-chev';
    headChev.textContent = '▾';
    head.append(headText, headChev);
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'zx-appearance-body';
    body.hidden = true;
    section.appendChild(body);

    const modes: Array<{ mode: number; name: string; desc: string }> = [
        { mode: 0, name: '关', desc: '无效果，壁纸保持干净' },
        { mode: 1, name: '静态水滴', desc: '水滴贴在壁纸上不动，省电' },
        { mode: 2, name: '动态滑落', desc: '水滴会生长、滑落后重生，略费电' }
    ];
    const checks = new Map<number, HTMLElement>();
    const refresh = (): void => {
        const current = loadVisualToggles().rainMode;
        for (const [mode, check] of checks) {
            check.textContent = mode === current ? '✓' : '';
            check.parentElement?.classList.toggle('is-active', mode === current);
        }
        const currentMode = modes.find((item) => item.mode === current);
        summary.textContent = `当前：${currentMode ? currentMode.name : '动态滑落'}`;
    };
    for (const item of modes) {
        const row = document.createElement('div');
        row.className = 'zx-appearance-row';
        const icon = document.createElement('span');
        icon.className = 'zx-rain-icon';
        icon.textContent = item.mode === 0 ? '♡' : '💧';
        row.appendChild(icon);
        const text = document.createElement('span');
        text.className = 'zx-appearance-row-text';
        const name = document.createElement('b');
        name.textContent = item.name;
        const desc = document.createElement('p');
        desc.textContent = item.desc;
        text.append(name, desc);
        row.appendChild(text);
        const check = document.createElement('span');
        check.className = 'zx-appearance-check';
        checks.set(item.mode, check);
        row.appendChild(check);
        row.addEventListener('click', () => {
            saveVisualToggles({ ...loadVisualToggles(), rainMode: item.mode });
            refresh();
        });
        body.appendChild(row);
    }
    head.addEventListener('click', () => {
        body.hidden = !body.hidden;
        headChev.textContent = body.hidden ? '▾' : '▴';
    });
    refresh();
    return section;
}


// 0.1.85 轻装模式：一行性能开关，body 加 perf-mode 类。
// 私人漫游（0.1.101）：我的页卡片，熟悉/探索/拼图三场景；
// 漫游中显示场景与已播数，结束漫游回到原队列（见 roaming.ts）。
function renderRoamingSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'zx-appearance-card';

    const row = document.createElement('div');
    row.className = 'zx-appearance-row';
    const icon = document.createElement('span');
    icon.className = 'zx-rain-icon';
    icon.textContent = '🧭';
    row.appendChild(icon);
    const text = document.createElement('span');
    text.className = 'zx-appearance-row-text';
    const name = document.createElement('b');
    name.textContent = '私人漫游';
    const desc = document.createElement('p');
    desc.textContent = '连续推荐着播，队尾自动续推，结束回到原队列';
    text.append(name, desc);
    row.appendChild(text);
    section.appendChild(row);

    const sceneRow = document.createElement('div');
    sceneRow.className = 'roam-scene-row';
    const sceneButtons: HTMLButtonElement[] = [];
    (['familiar', 'explore', 'puzzle'] as RoamScene[]).forEach((scene) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'roam-scene-btn';
        button.dataset.scene = scene;
        button.textContent = ROAM_SCENE_NAMES[scene];
        button.addEventListener('click', () => {
            status.textContent = '正在拼歌单…';
            void startRoaming(scene).then((result) => {
                if (!result.ok) {
                    status.textContent = result.note;
                }
                refresh();
            });
        });
        sceneButtons.push(button);
        sceneRow.appendChild(button);
    });
    section.appendChild(sceneRow);

    const statusRow = document.createElement('div');
    statusRow.className = 'roam-status-row';
    const status = document.createElement('span');
    status.className = 'roam-status';
    const endButton = document.createElement('button');
    endButton.type = 'button';
    endButton.className = 'roam-end-btn';
    endButton.textContent = '结束漫游';
    endButton.hidden = true;
    endButton.addEventListener('click', () => {
        status.textContent = '正在回到原队列…';
        void endRoaming().then(refresh);
    });
    statusRow.append(status, endButton);
    section.appendChild(statusRow);

    const refresh = (): void => {
        const state = getRoamState();
        if (state.active && state.scene) {
            status.textContent = `漫游中：${ROAM_SCENE_NAMES[state.scene]} · 已播 ${state.played} 首`;
            endButton.hidden = false;
            sceneButtons.forEach((button) => {
                button.classList.toggle('is-active', button.dataset.scene === state.scene);
            });
        } else {
            status.textContent = '选个场景开始漫游。';
            endButton.hidden = true;
            sceneButtons.forEach((button) => {
                button.classList.remove('is-active');
            });
        }
    };
    onRoamChange(refresh);
    refresh();
    return section;
}

function renderPerfModeSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'zx-appearance-card';

    const row = document.createElement('div');
    row.className = 'zx-appearance-row zx-perf-row';
    const icon = document.createElement('span');
    icon.className = 'zx-rain-icon';
    icon.textContent = '⏱';
    row.appendChild(icon);
    const text = document.createElement('span');
    text.className = 'zx-appearance-row-text';
    const name = document.createElement('b');
    name.textContent = '轻装模式';
    const desc = document.createElement('p');
    desc.textContent = '关毛玻璃模糊、卡片阴影与呼吸/入场动效，流畅省电优先';
    text.append(name, desc);
    row.appendChild(text);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'zx-switch';
    toggle.setAttribute('role', 'switch');
    const refresh = (): void => {
        const on = loadPerfMode();
        toggle.classList.toggle('on', on);
        toggle.setAttribute('aria-checked', String(on));
    };
    toggle.addEventListener('click', () => {
        applyPerfMode(!loadPerfMode());
        refresh();
    });
    row.appendChild(toggle);
    section.appendChild(row);
    refresh();
    return section;
}

// 网易云扫码轮询诊断（Claude 第十七轮）：在途检查全局只许一个；
// run 全局递增，日志里两个 run 交错出现即双链并跑；上次结算时刻
// 用来算检查间隔，盖住后台冻结造成的空档。
let neteaseQrRunCounter = 0;
let neteaseQrChecksInFlight = 0;
let neteaseQrCatchUpPending = false;
let neteaseQrLastCheckSettledAt = 0;

function renderNeteaseLoginBlock(onState?: (loggedIn: boolean) => void): HTMLElement {
    const box = document.createElement('div');
    box.className = 'login-block';

    const head = document.createElement('div');
    head.className = 'login-head';
    const tile = document.createElement('span');
    tile.className = 'login-tile';
    tile.textContent = '网';
    head.appendChild(tile);
    const title = document.createElement('h3');
    title.textContent = '网易云';
    head.appendChild(title);
    box.appendChild(head);

    const body = document.createElement('div');
    box.appendChild(body);

    let pollTimer: number | undefined;
    let currentKey = '';
    // 轮询代次令牌：每次 startQr 换一个新对象；stopPoll 置空。
    // 旧流程里已发出的请求回来时若令牌已换，一律丢弃——防止一次重复
    // 触发产生两个取码、旧 tick 杀掉新轮询器这类竞态（Claude 实验 2 的一类）。
    let qrToken: object | null = null;
    // 累计自动换码计数：一次登录尝试内累计，801 不再清零——旧逻辑里
    // 801 会清零，24 秒短命码每次过期前都有 801 垫底，计数永远涨不到
    // 上限，等于无限刷码（还可能喂给限流器）。涨满 3 次停下来给手动
    // 按钮；手动重开（非 auto）时清零，扫码成功流程自然结束。
    let qrAutoRefreshes = 0;
    // 当前码生成时刻（毫秒）：801 状态里显示“码已生成 Xs”，让短命码
    // 在界面上就能看出来，不用翻日志算。
    let keyBornAt = 0;
    // 上次轮询完成时刻（毫秒）：回前台时若离上次轮询已久，说明切出
    // 去期间计时器被冻结，再约一次补查，盖住网络未恢复的空查。
    let lastPollDoneAt = 0;
    // 本次取码流程的编号（全局递增）：日志里两个 run 交错出现即双链并跑。
    let qrRunId = 0;
    let qrVisibilityHandler: (() => void) | null = null;
    const stopPoll = (): void => {
        if (pollTimer !== undefined) {
            window.clearTimeout(pollTimer);
            pollTimer = undefined;
        }
        if (qrVisibilityHandler) {
            document.removeEventListener('visibilitychange', qrVisibilityHandler);
            qrVisibilityHandler = null;
        }
        qrToken = null;
    };

    const renderLoggedOut = (notice?: string): void => {
        onState?.(false);
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
        button.className = 'login-btn login-btn-primary';
        button.textContent = '登录网易云';
        button.addEventListener('click', () => {
            void startQr();
        });
        body.appendChild(button);
    };

    const renderLoggedIn = (session: NeteaseSession): void => {
        onState?.(true);
        stopPoll();
        body.replaceChildren();
        const row = document.createElement('div');
        row.className = 'login-row';
        if (session.avatarUrl) {
            const avatar = document.createElement('img');
            avatar.className = 'login-avatar';
            avatar.src = session.avatarUrl.replace(/^http:/, 'https:');
            avatar.alt = '';
            row.appendChild(avatar);
        }
        const dot = document.createElement('span');
        dot.className = 'login-status-dot';
        row.appendChild(dot);
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

    const startQr = async (auto = false, expiredNotice = false): Promise<void> => {
        stopPoll();
        const token = {};
        qrToken = token;
        qrRunId = ++neteaseQrRunCounter;
        if (!auto) {
            qrAutoRefreshes = 0;
        }
        body.replaceChildren();
        const status = document.createElement('p');
        status.className = 'login-notice';
        status.textContent = expiredNotice ? '二维码已过期，正在换新码…' : '正在获取二维码…';
        body.appendChild(status);
        let key: string;
        // 取码原因记下来：短命码死时若对得上另一次取码时间，就是被顶掉；
        // 对不上，顶掉说就不成立。
        console.log(`[Netease] 取码 run=${qrRunId} 原因=${auto ? (expiredNotice ? '过期自动' : '自动') : '手动'}`);
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
        keyBornAt = Date.now();
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
        qr.addEventListener('load', () => {
            if (token !== qrToken) {
                return;
            }
            console.log(`[Netease] 二维码图已载入 图=${key.slice(0, 6)} 轮询=${currentKey.slice(0, 6)}`);
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
        let lastPollCode = 0;
        const tick = async (source: string): Promise<void> => {
            // 旧流程的 tick（新流程已开始、或已停）直接丢弃，不碰状态；
            // 丢弃也要记一行，否则 802/803 被静默丢掉永远看不出来。
            if (token !== qrToken) {
                console.log(`[Netease] 检查 run=${qrRunId} 码=${currentKey.slice(0, 6)} 源=${source} 结果=未发 处理=丢弃`);
                return;
            }
            // 全局只许一个检查在途：回前台补查不跟定时检查抢跑，排队等。
            if (neteaseQrChecksInFlight > 0) {
                if (source !== '定时') {
                    neteaseQrCatchUpPending = true;
                }
                return;
            }
            const checkedKey = currentKey;
            const sentAt = Date.now();
            const gapMs = neteaseQrLastCheckSettledAt > 0 ? sentAt - neteaseQrLastCheckSettledAt : 0;
            const inFlightAtSend = neteaseQrChecksInFlight + 1;
            neteaseQrChecksInFlight += 1;
            let result;
            try {
                result = await checkQr(checkedKey);
            } catch (error) {
                // 网络/HTTP 失败才重试；8821 已是 checkQr 返回的终态，不走这里。
                const reason = qrFailureReason(error);
                console.log(`[Netease] 检查 run=${qrRunId} 码=${checkedKey.slice(0, 6)} 源=${source} 耗时=${Date.now() - sentAt}ms 距上次=${gapMs}ms 结果=异常(${reason}) 在途=${inFlightAtSend} 处理=${token !== qrToken ? '丢弃' : '正常'}`);
                if (token === qrToken) {
                    status.textContent = `查询失败（${reason}），正在重试…`;
                }
                return;
            } finally {
                neteaseQrChecksInFlight -= 1;
                neteaseQrLastCheckSettledAt = Date.now();
                lastPollDoneAt = Date.now();
                if (neteaseQrCatchUpPending) {
                    neteaseQrCatchUpPending = false;
                    void tick('补查');
                }
            }
            lastPollCode = result.code;
            // 每查必记一行：801 不记、丢弃不记，H1/H2/H3 根本分不出来。
            // 处理：正常；丢弃（过期/等待/拒绝且流程已换代）；旧已扫/旧确认
            // （802/803 永不丢：哪怕流程已换代，确认也不能丢）。
            const stale = token !== qrToken;
            let handling = '正常';
            if (stale) {
                if (result.code === 802) {
                    handling = '旧已扫';
                } else if (result.code === 803) {
                    handling = '旧确认';
                } else {
                    handling = '丢弃';
                }
            }
            console.log(`[Netease] 检查 run=${qrRunId} 码=${checkedKey.slice(0, 6)} 源=${source} 耗时=${Date.now() - sentAt}ms 距上次=${gapMs}ms 结果=${result.code} 在途=${inFlightAtSend} 处理=${handling}`);
            if (stale && result.code !== 802 && result.code !== 803) {
                return;
            }
            if (result.code === 801) {
                status.textContent = keyBornAt
                    ? `等待扫码（码已生成 ${Math.floor((Date.now() - keyBornAt) / 1000)}s）`
                    : '等待扫码';
            } else if (result.code === 802) {
                status.textContent = '已扫码，请在手机上确认';
            } else if (result.code === 800) {
                // 码过期就停，不再静默换新码（Folia 同款：过期只报过期，
                // 由用户手动重新获取）。静默换码会在用户正在 App 里确认
                // 旧码时把轮询切到新码：旧码的确认落了地（授权设备+1），
                // 新码却永远等不到 803，表现就是“扫码不成功但设备会加”。
                stopPoll();
                status.textContent = '二维码已过期，点按重新获取';
                const refresh = document.createElement('button');
                refresh.type = 'button';
                refresh.className = 'login-btn';
                refresh.textContent = '刷新二维码';
                refresh.addEventListener('click', () => {
                    void startQr();
                });
                body.appendChild(refresh);
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
                void tick('回前台');
                // 切出去期间计时器可能被系统冻结（00:54 授权成功却没
                // 拿到 803 就是这么错过的）：上次轮询是很久以前时，
                // 再约一次补查，盖住回前台瞬间网络还没恢复的那次空查。
                if (Date.now() - lastPollDoneAt > 20000) {
                    window.setTimeout(() => {
                        if (qrToken === token) {
                            void tick('补查');
                        }
                    }, 2000);
                }
            }
        };
        document.addEventListener('visibilitychange', qrVisibilityHandler);
        // 自调度链：Folia 同款 2 秒一查（802 已扫码待确认后 1.5 秒快查，
        // 抢在用户点确认后第一时间拿到 803）；上轮跑完才约下轮，不重叠。
        // 链的代次用本轮 token 守：新流程开始后旧链的 finally 看到令牌
        // 已换就不再续约，不会双链并跑。
        const armPoll = (): void => {
            pollTimer = window.setTimeout(() => {
                void tick('定时').finally(() => {
                    if (qrToken === token) {
                        armPoll();
                    }
                });
            }, lastPollCode === 802 ? 1500 : 2000);
        };
        armPoll();
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

function renderYtmLoginBlock(onState?: (loggedIn: boolean) => void): HTMLElement {
    const box = document.createElement('div');
    box.className = 'login-block';

    const head = document.createElement('div');
    head.className = 'login-head';
    const tile = document.createElement('span');
    tile.className = 'login-tile';
    tile.textContent = 'Y';
    head.appendChild(tile);
    const title = document.createElement('h3');
    title.textContent = 'YouTube Music';
    head.appendChild(title);
    box.appendChild(head);

    const body = document.createElement('div');
    box.appendChild(body);

    const renderLoggedOut = (notice?: string): void => {
        onState?.(false);
        body.replaceChildren();
        if (notice) {
            const note = document.createElement('p');
            note.className = 'login-notice';
            note.textContent = notice;
            body.appendChild(note);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'login-btn login-btn-primary';
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
        onState?.(true);
        body.replaceChildren();
        const row = document.createElement('div');
        row.className = 'login-row';
        const dot = document.createElement('span');
        dot.className = 'login-status-dot';
        row.appendChild(dot);
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

// 0.1.80 海报四版全上（用户拍板“都要”）：旧海报墙/卡片/3D 架撤掉，
// 换成四版可切换布局，名字按用户要求起好听点，不再是直白的功能名。
// 磁带馆 = 玻璃磁带架，星卷 = 横向磁带卷轴，黑胶 = 黑胶唱片架，
// 巨幕 = 杂志大海报。切换仍只翻 data-layout，不重渲染。
type PosterLayout = 'tape' | 'scroll' | 'vinyl' | 'mag';

const POSTER_LAYOUT_KEY = 'zx_poster_layout_v1';

const POSTER_LAYOUTS: Array<{ id: PosterLayout; label: string }> = [
    { id: 'tape', label: '磁带馆' },
    { id: 'scroll', label: '星卷' },
    { id: 'vinyl', label: '黑胶' },
    { id: 'mag', label: '巨幕' }
];

function loadPosterLayout(): PosterLayout {
    const stored = localStorage.getItem(POSTER_LAYOUT_KEY);
    return stored === 'scroll' || stored === 'vinyl' || stored === 'mag' ? stored : 'tape';
}

let currentPosterLayout: PosterLayout = loadPosterLayout();
const posterModules = new Set<HTMLElement>();
const posterLayoutButtons: HTMLButtonElement[] = [];

// 0.1.80 排布工坊（我的页单独做）：每个音源的海报排布可以单独选，
// 混搭着用；没选或选“跟随全局”时，跟海报区顶部的全局开关走。
// 存 zx_poster_layout_mix_v1，形如 {"local":"vinyl","netease":"follow"}。
type PosterLayoutMixValue = PosterLayout | 'follow';
const POSTER_LAYOUT_MIX_KEY = 'zx_poster_layout_mix_v1';

function loadPosterLayoutMix(): Record<string, PosterLayoutMixValue> {
    try {
        const parsed = JSON.parse(localStorage.getItem(POSTER_LAYOUT_MIX_KEY) ?? '{}') as Record<
            string,
            unknown
        >;
        const mix: Record<string, PosterLayoutMixValue> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (value === 'follow' || value === 'tape' || value === 'scroll' || value === 'vinyl' || value === 'mag') {
                mix[key] = value;
            }
        }
        return mix;
    } catch {
        return {};
    }
}

let posterLayoutMix: Record<string, PosterLayoutMixValue> = loadPosterLayoutMix();

function resolvePosterLayout(sourceKey: string): PosterLayout {
    const picked = posterLayoutMix[sourceKey];
    return picked && picked !== 'follow' ? picked : currentPosterLayout;
}

function savePosterLayoutMix(): void {
    localStorage.setItem(POSTER_LAYOUT_MIX_KEY, JSON.stringify(posterLayoutMix));
}

function applyPosterLayoutMix(sourceKey: string, value: PosterLayoutMixValue): void {
    posterLayoutMix[sourceKey] = value;
    savePosterLayoutMix();
    for (const module of posterModules) {
        if (module.dataset.sourceKey === sourceKey) {
            module.dataset.layout = resolvePosterLayout(sourceKey);
        }
    }
}

// 海报三向开关的滑动滑块：每组开关一个，按激活按钮实测位置走；
// 页隐藏时量不到宽，跳过，等切页回来再定位。
function positionPosterThumbs(): void {
    for (const switchEl of document.querySelectorAll('.poster-layout-switch')) {
        const thumb = switchEl.querySelector('.poster-layout-thumb');
        const active = switchEl.querySelector('.poster-layout-btn.is-active');
        if (!(thumb instanceof HTMLElement) || !(active instanceof HTMLElement)) {
            continue;
        }
        if (active.offsetWidth === 0) {
            continue;
        }
        thumb.style.width = `${active.offsetWidth}px`;
        thumb.style.transform = `translateX(${active.offsetLeft}px)`;
    }
}

function applyPosterLayout(layout: PosterLayout): void {
    currentPosterLayout = layout;
    localStorage.setItem(POSTER_LAYOUT_KEY, layout);
    for (const module of posterModules) {
        // 混搭的模块跟自己的选择走，只有“跟随全局”的模块才跟全局开关。
        module.dataset.layout = resolvePosterLayout(module.dataset.sourceKey ?? '');
        // 入场动画重播：切形态时把 enter 摘掉、强制回流、再挂上，
        // 卡片 rise 动画重新跑一遍；只在切形态时做，不干扰滚动。
        module.classList.remove('enter');
        void module.offsetWidth;
        module.classList.add('enter');
    }
    for (const button of posterLayoutButtons) {
        button.classList.toggle('is-active', button.dataset.layout === layout);
    }
    // 滑块跟激活按钮走：按钮位置要等布局稳定，下一帧再量。
    requestAnimationFrame(() => {
        positionPosterThumbs();
    });
}

function renderPosterModule(definition: PosterSectionDefinition): HTMLElement {
    const module = document.createElement('section');
    module.className = 'poster-module enter';
    module.dataset.layout = resolvePosterLayout(definition.key);
    module.dataset.sourceKey = definition.key;
    posterModules.add(module);

    const head = document.createElement('div');
    head.className = 'poster-module-head';
    const label = document.createElement('h3');
    label.textContent = definition.label;
    head.appendChild(label);

    const layoutSwitch = document.createElement('div');
    layoutSwitch.className = 'poster-layout-switch';
    // 滑动滑块：垫在按钮下面，位置由 positionPosterThumbs 按激活按钮实测写。
    const layoutThumb = document.createElement('div');
    layoutThumb.className = 'poster-layout-thumb';
    layoutSwitch.appendChild(layoutThumb);
    for (const layout of POSTER_LAYOUTS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'poster-layout-btn';
        button.dataset.layout = layout.id;
        button.textContent = layout.label;
        // 0.1.91：开关高亮跟本模块实际版式走（混搭钉住的模块不再谎报全局版式）。
        button.classList.toggle('is-active', layout.id === resolvePosterLayout(definition.key));
        button.addEventListener('click', () => {
            // 0.1.91：模块上的开关只改本模块（写本源混搭），不再只改全局——
            // 混搭钉住的模块以前点开关只动高亮、画面不动。
            applyPosterLayoutMix(definition.key, layout.id);
            for (const other of layoutSwitch.querySelectorAll('.poster-layout-btn')) {
                other.classList.toggle(
                    'is-active',
                    (other as HTMLElement).dataset.layout === layout.id
                );
            }
            requestAnimationFrame(() => {
                positionPosterThumbs();
            });
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
        for (const [index, poster] of posters.entries()) {
            postersById.set(poster.id, poster);
            const card = renderPosterCard(poster, playNotice);
            // 入场 rise 的 stagger：最多前 8 张，后面的不再加延迟。
            card.style.setProperty('--i', String(Math.min(index, 7)));
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
    // 辉光取色：id 哈希色相，与占位渐变同一口径。
    card.style.setProperty('--hue', String(posterHue(poster.id)));

    const coverWrap = document.createElement('div');
    coverWrap.className = 'poster-cover-wrap';
    // 纯色占位在下层：封面缺失或加载失败时露出来，不贴图；
    // 颜色按海报 id 哈希（Folia 式），每张不同。
    const placeholder = document.createElement('div');
    placeholder.className = 'poster-cover-placeholder';
    placeholder.style.background = posterFallbackBackground(poster.id);
    coverWrap.appendChild(placeholder);
    if (poster.coverUrl) {
        // 特性位（海报墙首张）用的模糊背：同一张图放大模糊垫底，主图方形居中；
        // 其它形态下 CSS 把它藏起来，不额外发请求（同地址走缓存）。
        const blur = document.createElement('img');
        blur.className = 'poster-cover-blur';
        blur.referrerPolicy = 'no-referrer';
        blur.src = poster.coverUrl;
        blur.alt = '';
        blur.onerror = () => {
            blur.remove();
        };
        coverWrap.appendChild(blur);
        const cover = document.createElement('img');
        cover.className = 'poster-cover';
        cover.referrerPolicy = 'no-referrer';
        cover.src = poster.coverUrl;
        cover.alt = '';
        cover.onerror = () => {
            cover.remove();
            blur.remove();
        };
        coverWrap.appendChild(cover);
    }
    card.appendChild(coverWrap);

    // 标题区：海报墙小卡压在图底渐变上（absolute），特性位与卡片模式
    // 落在图下底栏里（static），形态切换只靠 CSS，不动 DOM。
    const overlay = document.createElement('div');
    overlay.className = 'poster-overlay';

    const text = document.createElement('div');
    text.className = 'poster-text';

    const title = document.createElement('div');
    title.className = 'poster-title';
    title.textContent = poster.title;
    text.appendChild(title);

    if (poster.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.className = 'poster-subtitle';
        subtitle.textContent = poster.subtitle;
        text.appendChild(subtitle);
    }

    const count = document.createElement('span');
    count.className = 'poster-count';
    count.textContent = `${poster.tracks.length} 首`;
    text.appendChild(count);

    overlay.appendChild(text);

    // 卡片模式底栏里的幽灵播放圆（纯视觉，整卡点击即播放；海报墙形态不显示）。
    const playDot = document.createElement('span');
    playDot.className = 'poster-play';
    playDot.textContent = '▶';
    overlay.appendChild(playDot);

    card.appendChild(overlay);

    // 磁带馆形态的小窗：纯装饰，两轴 + 磁带条，只在磁带馆形态下显示。
    const tape = document.createElement('div');
    tape.className = 'poster-tape';
    tape.setAttribute('aria-hidden', 'true');
    const reelLeft = document.createElement('span');
    reelLeft.className = 'poster-reel';
    const tapeBar = document.createElement('span');
    tapeBar.className = 'poster-tape-bar';
    const reelRight = document.createElement('span');
    reelRight.className = 'poster-reel';
    tape.append(reelLeft, tapeBar, reelRight);
    card.appendChild(tape);

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
// 0.1.79 每日推荐：网易云 Tab 海报区下方一段，列表复用搜索结果同款
// track-row（封面/歌名/歌手/时长，点行即从该首起播）。需登录会话，
// 未登录只留一句提示不发请求；加载失败也只留提示，不影响海报与搜索。
// 0.1.81 可折叠 + YTM 通用化：默认只露前 3 首，点“展开全部”才露全 list，
// 播放全部不受折叠影响（永远播整单）；同一函数供网易云每日推荐与
// YTM 今日星荐两路复用，只换标题/副标题/取数函数/登录判断。
// 0.1.82 每日推荐整页（网易云+YTM 同款）：Tab 上只留一张卡片，
// 点开进独立整页（日期头 + 口味副标题 + 播放全部 + 不折叠的全列表）。
// 旧 0.1.81 的 Tab 内折叠（前 3 首 + 展开）已废弃，不再用。
function renderDailySection(
    titleText: string,
    subText: string,
    fetchTracks: () => Promise<Track[]>,
    isLoggedIn: () => boolean,
    loginNotice: string
): HTMLElement {
    const section = document.createElement('section');
    section.className = 'daily-section';

    const head = document.createElement('div');
    head.className = 'daily-head';
    const heading = document.createElement('h2');
    heading.textContent = titleText;
    head.appendChild(heading);
    const sub = document.createElement('span');
    sub.className = 'daily-sub';
    sub.textContent = subText;
    head.appendChild(sub);
    section.appendChild(head);

    const playAll = document.createElement('button');
    playAll.type = 'button';
    playAll.className = 'login-btn';
    playAll.textContent = '▶ 播放全部';
    playAll.disabled = true;
    section.appendChild(playAll);

    const openPageButton = document.createElement('button');
    openPageButton.type = 'button';
    openPageButton.className = 'login-btn';
    openPageButton.textContent = '打开完整歌单 ›';
    openPageButton.disabled = true;
    section.appendChild(openPageButton);

    const notice = document.createElement('p');
    notice.className = 'source-notice';
    notice.textContent = '正在加载…';
    section.appendChild(notice);

    let tracks: Track[] = [];
    const openDailyPage = (): void => {
        if (tracks.length === 0) {
            return;
        }
        const now = new Date();
        const page = document.createElement('div');
        page.className = 'daily-page';
        const pageHead = document.createElement('div');
        pageHead.className = 'daily-page-head';
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'daily-page-back';
        back.textContent = '返回';
        back.addEventListener('click', () => {
            page.remove();
        });
        pageHead.appendChild(back);
        const pageTitle = document.createElement('h2');
        pageTitle.textContent = titleText;
        pageHead.appendChild(pageTitle);
        page.appendChild(pageHead);

        const date = document.createElement('div');
        date.className = 'daily-page-date';
        date.textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
        page.appendChild(date);
        const pageSub = document.createElement('p');
        pageSub.className = 'daily-page-sub';
        pageSub.textContent = subText;
        page.appendChild(pageSub);
        const pagePlayAll = document.createElement('button');
        pagePlayAll.type = 'button';
        pagePlayAll.className = 'login-btn';
        pagePlayAll.textContent = '▶ 播放全部';
        pagePlayAll.addEventListener('click', () => {
            void playQueue(tracks, 0);
        });
        page.appendChild(pagePlayAll);
        const pageNotice = document.createElement('p');
        pageNotice.className = 'source-notice';
        pageNotice.textContent = `共 ${tracks.length} 首`;
        page.appendChild(pageNotice);
        const trackList = document.createElement('ul');
        trackList.className = 'track-list';
        page.appendChild(trackList);
        renderTracks(trackList, tracks, pageNotice);
        document.body.appendChild(page);
    };
    playAll.addEventListener('click', () => {
        if (tracks.length > 0) {
            void playQueue(tracks, 0);
        }
    });
    openPageButton.addEventListener('click', openDailyPage);
    void (async () => {
        if (!isLoggedIn()) {
            notice.textContent = loginNotice;
            return;
        }
        try {
            tracks = await fetchTracks();
        } catch (error) {
            notice.textContent = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
                ? error.message
                : '今日推荐暂时拿不到，请稍后再试';
            return;
        }
        if (tracks.length === 0) {
            notice.textContent = `今天还没有${titleText}`;
            return;
        }
        notice.textContent = `共 ${tracks.length} 首`;
        playAll.disabled = false;
        openPageButton.disabled = false;
    })();

    return section;
}

// 0.1.87 私藏（原我的导入）：本地页在全量扫描之外另建的分组。用户从扫描结果里勾选
// 歌曲导进来，分组只显示自己挑的；删除只删芷湘的库记录，文件不动，可重新导入。
function renderMyImportsSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'daily-section';

    const head = document.createElement('div');
    head.className = 'daily-head';
    const heading = document.createElement('h2');
    heading.textContent = '私藏';
    head.appendChild(heading);
    const sub = document.createElement('span');
    sub.className = 'daily-sub';
    sub.textContent = '亲手挑的歌 · 删除只删库记录不删文件';
    head.appendChild(sub);
    section.appendChild(head);

    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'login-btn';
    importButton.textContent = '导入歌曲';
    section.appendChild(importButton);

    const playAll = document.createElement('button');
    playAll.type = 'button';
    playAll.className = 'login-btn';
    playAll.textContent = '▶ 播放全部';
    playAll.disabled = true;
    section.appendChild(playAll);

    const openPageButton = document.createElement('button');
    openPageButton.type = 'button';
    openPageButton.className = 'login-btn';
    openPageButton.textContent = '打开列表 ›';
    openPageButton.disabled = true;
    section.appendChild(openPageButton);

    const notice = document.createElement('p');
    notice.className = 'source-notice';
    notice.textContent = '正在加载…';
    section.appendChild(notice);

    let tracks: Track[] = [];
    const resolve = async (): Promise<Track[]> => {
        const ids = loadMyImportIds();
        if (ids.length === 0) {
            return [];
        }
        const scanned = await localSource.search('');
        const byId = new Map(scanned.map((track) => [track.id, track]));
        const resolved: Track[] = [];
        for (const id of ids) {
            const track = byId.get(id);
            if (track) {
                resolved.push(track);
            }
        }
        return resolved;
    };
    const refresh = async (): Promise<void> => {
        try {
            tracks = await resolve();
        } catch {
            notice.textContent = '私藏暂时加载不出来，请稍后再试';
            playAll.disabled = true;
            openPageButton.disabled = true;
            return;
        }
        if (tracks.length === 0) {
            notice.textContent = '还没有导入的歌，点导入歌曲从扫描结果里挑';
            playAll.disabled = true;
            openPageButton.disabled = true;
            return;
        }
        notice.textContent = `共 ${tracks.length} 首`;
        playAll.disabled = false;
        openPageButton.disabled = false;
    };
    const openPicker = (): void => {
        const page = document.createElement('div');
        page.className = 'daily-page';
        const pageHead = document.createElement('div');
        pageHead.className = 'daily-page-head';
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'daily-page-back';
        back.textContent = '返回';
        back.addEventListener('click', () => {
            page.remove();
        });
        pageHead.appendChild(back);
        const pageTitle = document.createElement('h2');
        pageTitle.textContent = '导入歌曲';
        pageHead.appendChild(pageTitle);
        page.appendChild(pageHead);
        const pageSub = document.createElement('p');
        pageSub.className = 'daily-page-sub';
        pageSub.textContent = '从扫描结果里勾选，导入到私藏';
        page.appendChild(pageSub);
        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = 'login-btn';
        confirmButton.textContent = '确认导入';
        confirmButton.disabled = true;
        page.appendChild(confirmButton);
        const pageNotice = document.createElement('p');
        pageNotice.className = 'source-notice';
        pageNotice.textContent = '正在扫描本地歌曲…';
        page.appendChild(pageNotice);
        const trackList = document.createElement('ul');
        trackList.className = 'track-list';
        page.appendChild(trackList);
        document.body.appendChild(page);
        void (async () => {
            let scanned: Track[];
            try {
                scanned = await localSource.search('');
            } catch {
                pageNotice.textContent = '扫描失败，请确认已授予读取音频文件的权限后重试';
                return;
            }
            if (scanned.length === 0) {
                pageNotice.textContent = '本地还没有扫描到歌曲';
                return;
            }
            pageNotice.textContent = `共 ${scanned.length} 首`;
            const imported = new Set(loadMyImportIds());
            const selected = new Set<string>();
            const updateConfirm = (): void => {
                confirmButton.disabled = selected.size === 0;
                confirmButton.textContent =
                    selected.size === 0 ? '确认导入' : `确认导入（${selected.size} 首）`;
            };
            for (const track of scanned) {
                const row = document.createElement('li');
                row.className = 'track-row';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = imported.has(track.id);
                box.disabled = imported.has(track.id);
                box.addEventListener('change', () => {
                    if (box.checked) {
                        selected.add(track.id);
                    } else {
                        selected.delete(track.id);
                    }
                    updateConfirm();
                });
                const text = document.createElement('span');
                text.className = 'track-row-text';
                text.textContent = imported.has(track.id)
                    ? `${track.title} — ${track.artist}（已导入）`
                    : `${track.title} — ${track.artist}`;
                row.append(box, text);
                trackList.appendChild(row);
            }
            confirmButton.addEventListener('click', () => {
                addMyImportIds([...selected]);
                page.remove();
                void refresh();
            });
        })();
    };
    const openListPage = (): void => {
        if (tracks.length === 0) {
            return;
        }
        const page = document.createElement('div');
        page.className = 'daily-page';
        const pageHead = document.createElement('div');
        pageHead.className = 'daily-page-head';
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'daily-page-back';
        back.textContent = '返回';
        back.addEventListener('click', () => {
            page.remove();
        });
        pageHead.appendChild(back);
        const pageTitle = document.createElement('h2');
        pageTitle.textContent = '私藏';
        pageHead.appendChild(pageTitle);
        page.appendChild(pageHead);
        const pagePlayAll = document.createElement('button');
        pagePlayAll.type = 'button';
        pagePlayAll.className = 'login-btn';
        pagePlayAll.textContent = '▶ 播放全部';
        pagePlayAll.addEventListener('click', () => {
            void playQueue(tracks, 0);
        });
        page.appendChild(pagePlayAll);
        const pageNotice = document.createElement('p');
        pageNotice.className = 'source-notice';
        pageNotice.textContent = `共 ${tracks.length} 首`;
        page.appendChild(pageNotice);
        const trackList = document.createElement('ul');
        trackList.className = 'track-list';
        page.appendChild(trackList);
        const renderList = (): void => {
            trackList.replaceChildren();
            pageNotice.textContent = `共 ${tracks.length} 首`;
            tracks.forEach((track, index) => {
                const row = document.createElement('li');
                row.className = 'track-row';
                const text = document.createElement('span');
                text.className = 'track-row-text';
                text.textContent = `${track.title} — ${track.artist}`;
                text.addEventListener('click', () => {
                    void playQueue(tracks, index);
                });
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'login-btn';
                del.textContent = '✕ 删除';
                del.addEventListener('click', () => {
                    // 只删芷湘库记录，文件不动；删完列表与卡片计数同步刷新。
                    removeMyImportId(track.id);
                    tracks = tracks.filter((item) => item.id !== track.id);
                    renderList();
                    void refresh();
                });
                row.append(text, del);
                trackList.appendChild(row);
            });
        };
        renderList();
        document.body.appendChild(page);
    };
    importButton.addEventListener('click', openPicker);
    playAll.addEventListener('click', () => {
        if (tracks.length > 0) {
            void playQueue(tracks, 0);
        }
    });
    openPageButton.addEventListener('click', openListPage);
    void refresh();
    return section;
}

// 词图写回（0.1.106）：把联网匹配到的歌词和封面写到歌旁边（同目录
// 同名 .lrc/.jpg），不动原文件；已有文件的歌跳过不覆盖。写之前须授予
// 所有文件访问权限，没开时只提示、不写。
function renderWritebackSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'daily-section';

    const head = document.createElement('div');
    head.className = 'daily-head';
    const heading = document.createElement('h2');
    heading.textContent = '词图写回';
    head.appendChild(heading);
    const sub = document.createElement('span');
    sub.className = 'daily-sub';
    sub.textContent = '把联网匹配到的歌词和封面写到歌旁边，不动原文件；需先开所有文件访问权限';
    head.appendChild(sub);
    section.appendChild(head);

    const checkButton = document.createElement('button');
    checkButton.type = 'button';
    checkButton.className = 'login-btn';
    checkButton.textContent = '检查权限';
    section.appendChild(checkButton);

    const startButton = document.createElement('button');
    startButton.type = 'button';
    startButton.className = 'login-btn';
    startButton.textContent = '开始写回';
    section.appendChild(startButton);

    const notice = document.createElement('p');
    notice.className = 'source-notice';
    notice.textContent = '还没开始';
    section.appendChild(notice);

    const setBusy = (busy: boolean): void => {
        checkButton.disabled = busy;
        startButton.disabled = busy;
    };

    checkButton.addEventListener('click', () => {
        void (async () => {
            setBusy(true);
            try {
                if (await checkAllFilesAccess()) {
                    notice.textContent = '已授予所有文件访问权限，可以开始写回';
                    return;
                }
                await requestAllFilesAccess();
                notice.textContent = '已打开设置页，开完权限回 App 再点检查';
            } catch {
                notice.textContent = '打不开设置页，请到系统设置里手动给芷湘开所有文件访问权限';
            } finally {
                setBusy(false);
            }
        })();
    });

    startButton.addEventListener('click', () => {
        void (async () => {
            setBusy(true);
            try {
                if (!(await checkAllFilesAccess())) {
                    notice.textContent = '请先点检查权限并授予所有文件访问权限';
                    return;
                }
                const result = await runBatchWriteback((progress) => {
                    notice.textContent =
                        `已处理 ${progress.done}/${progress.total}：成功 ${progress.ok} · ` +
                        `已有 ${progress.skipped} · 无匹配 ${progress.noMatch} · 失败 ${progress.failed}`;
                });
                notice.textContent =
                    `写回完成：成功 ${result.ok} · 已有 ${result.skipped} · ` +
                    `无匹配 ${result.noMatch} · 失败 ${result.failed}`;
            } catch (error) {
                notice.textContent =
                    error instanceof Error ? error.message : '写回失败，请稍后再试';
            } finally {
                setBusy(false);
            }
        })();
    });

    return section;
}

function renderNeteaseDailySection(): HTMLElement {
    return renderDailySection(
        '今日乐荐',
        '根据你的听歌口味，每日更新',
        fetchNeteaseDailySongs,
        () => loadNeteaseSession() !== null,
        '登录网易云后可看今日乐荐'
    );
}

// 0.1.105 B 站发现页（参考截图：今日推荐＋音乐排行榜四栏）：
// 今日推荐取全站音乐榜头条（个性化推荐要登录，v1 用榜单头条代替）；
// 排行榜四栏按栏懒加载、本页内缓存；点行即播整榜（复用 renderTracks）。
function renderBilibiliDiscoverySection(status: HTMLElement): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bili-discovery';

    const featuredHead = document.createElement('h2');
    featuredHead.textContent = '今日推荐';
    section.appendChild(featuredHead);

    const featured = document.createElement('div');
    featured.className = 'bili-featured';
    const featuredCover = document.createElement('img');
    featuredCover.className = 'bili-featured-cover';
    featuredCover.alt = '';
    featuredCover.referrerPolicy = 'no-referrer';
    featuredCover.hidden = true;
    featuredCover.onerror = () => {
        featuredCover.hidden = true;
    };
    const featuredInfo = document.createElement('div');
    featuredInfo.className = 'bili-featured-info';
    const featuredTitle = document.createElement('div');
    featuredTitle.className = 'bili-featured-title';
    featuredTitle.textContent = '加载中…';
    const featuredArtist = document.createElement('div');
    featuredArtist.className = 'bili-featured-artist';
    featuredInfo.append(featuredTitle, featuredArtist);
    const featuredPlay = document.createElement('button');
    featuredPlay.type = 'button';
    featuredPlay.className = 'bili-featured-play';
    featuredPlay.textContent = '▶ 立即播放';
    featuredPlay.disabled = true;
    featured.append(featuredCover, featuredInfo, featuredPlay);
    section.appendChild(featured);

    const chartHead = document.createElement('h2');
    chartHead.textContent = '音乐排行榜';
    section.appendChild(chartHead);

    const tabRow = document.createElement('div');
    tabRow.className = 'bili-chart-tabs';
    const tabButtons = new Map<string, HTMLButtonElement>();
    for (const zone of BILI_CHART_ZONES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bili-chart-tab';
        button.textContent = zone.label;
        button.addEventListener('click', () => {
            currentKey = zone.key;
            void renderZone(zone);
        });
        tabButtons.set(zone.key, button);
        tabRow.appendChild(button);
    }
    section.appendChild(tabRow);

    const notice = document.createElement('p');
    notice.className = 'source-notice';
    notice.hidden = true;
    section.appendChild(notice);

    const list = document.createElement('ul');
    list.className = 'track-list';
    section.appendChild(list);

    const cache = new Map<string, Track[]>();
    let currentKey = BILI_CHART_ZONES[0]!.key;
    let featuredTracks: Track[] = [];

    const renderZone = async (zone: BiliChartZone): Promise<void> => {
        for (const [key, button] of tabButtons) {
            button.classList.toggle('is-active', key === zone.key);
        }
        const cached = cache.get(zone.key);
        if (cached) {
            notice.hidden = true;
            renderTracks(list, cached, status);
            return;
        }
        notice.textContent = '加载中…';
        notice.classList.remove('is-error');
        notice.hidden = false;
        list.replaceChildren();
        try {
            const tracks = await fetchBilibiliChart(zone);
            cache.set(zone.key, tracks);
            if (currentKey !== zone.key) {
                return;
            }
            notice.hidden = true;
            renderTracks(list, tracks, status);
            if (zone.key === BILI_CHART_ZONES[0]!.key && tracks.length > 0) {
                featuredTracks = tracks;
                const first = tracks[0]!;
                featuredTitle.textContent = first.title;
                featuredArtist.textContent = first.artist;
                if (first.coverUrl) {
                    featuredCover.src = first.coverUrl;
                    featuredCover.hidden = false;
                } else {
                    featuredCover.hidden = true;
                }
                featuredPlay.disabled = false;
            }
        } catch (error) {
            if (currentKey !== zone.key) {
                return;
            }
            notice.textContent = friendlySearchError(error);
            notice.classList.add('is-error');
            notice.hidden = false;
        }
    };

    featuredPlay.addEventListener('click', () => {
        if (featuredTracks.length === 0) {
            return;
        }
        void (async () => {
            try {
                await playQueue(featuredTracks, 0);
            } catch (error) {
                status.textContent = friendlyPlayError(error);
            }
        })();
    });

    void renderZone(BILI_CHART_ZONES[0]!);
    return section;
}

function renderYtmDailySection(): HTMLElement {
    return renderDailySection(
        '今日星荐',
        '根据你的 YTM 收听，每日更新',
        fetchYtmDailyTracks,
        () => loadYtmSession() !== null,
        '登录 YouTube Music 后可看今日星荐'
    );
}

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
    const searchIcon = document.createElement('span');
    searchIcon.className = 'source-search-icon';
    searchIcon.textContent = '⌕';
    searchWrap.appendChild(searchIcon);
    block.appendChild(searchWrap);

    // 本地页歌曲列表默认隐藏（Folia 墙面模式：墙上只放海报，歌曲在海报里和搜索里）；
    // 开关持久化，默认藏；有查询时结果照常出现，不受开关影响。
    const tracksHiddenKey = 'zx_local_tracks_hidden_v1';
    const isLocalPage = source.id === 'local';
    const tracksHidden = (): boolean => isLocalPage && localStorage.getItem(tracksHiddenKey) !== '0';
    let toggleButton: HTMLButtonElement | undefined;
    if (isLocalPage) {
        const toolbar = document.createElement('div');
        toolbar.className = 'track-list-toolbar';
        toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'track-list-toggle';
        toggleButton.textContent = tracksHidden() ? '显示歌曲' : '隐藏歌曲';
        toggleButton.addEventListener('click', () => {
            const next = !tracksHidden();
            localStorage.setItem(tracksHiddenKey, next ? '1' : '0');
            toggleButton!.textContent = next ? '显示歌曲' : '隐藏歌曲';
            // 正在搜的时候先清查询、回默认视图，开关立即生效；否则只翻列表显隐。
            if (search.value.trim()) {
                search.value = '';
                onQuery('');
                void refresh('');
            } else {
                trackList.hidden = next;
                if (next) {
                    notice.hidden = true;
                    emptyIcon.hidden = true;
                    emptyHint.hidden = true;
                }
            }
        });
        toolbar.appendChild(toggleButton);
        block.appendChild(toolbar);
    }

    const notice = document.createElement('p');
    notice.className = 'source-notice';
    notice.hidden = true;
    block.appendChild(notice);

    // 空态装饰：同心圆环里的渐变音符，上下浮动；只在空态时出现，
    // 不跟提示文字抢——图标与提示、副提示同显同隐。
    const emptyIcon = document.createElement('div');
    emptyIcon.className = 'source-empty-icon';
    emptyIcon.textContent = '♪';
    emptyIcon.hidden = true;
    block.appendChild(emptyIcon);

    const emptyHint = document.createElement('p');
    emptyHint.className = 'source-empty-hint';
    emptyHint.hidden = true;
    block.appendChild(emptyHint);

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
            notice.classList.add('is-error');
            notice.hidden = false;
            emptyIcon.hidden = true;
            emptyHint.hidden = true;
            return;
        }
        if (token !== requestToken) {
            return;
        }
        notice.classList.remove('is-error');
        renderTracks(trackList, tracks, status);
        // 本地默认藏歌：无查询且开关开时列表与空态提示都不出；有查询时结果照常。
        const hideLocalList = isLocalPage && query.trim() === '' && tracksHidden();
        trackList.hidden = hideLocalList;
        if (hideLocalList) {
            notice.hidden = true;
            emptyIcon.hidden = true;
            emptyHint.hidden = true;
        }
        const localNotice = source.id === 'local' ? getLocalNotice() : null;
        if (tracks.length === 0 && localNotice) {
            notice.textContent = localNotice;
            notice.hidden = false;
            emptyIcon.hidden = false;
            emptyHint.hidden = true;
        } else if (tracks.length === 0) {
            notice.textContent = query.trim() ? '没有匹配的曲目。' : '这里还没有歌曲。';
            notice.hidden = false;
            emptyIcon.hidden = false;
            // 副提示：没搜时指引搜，有搜无结果时指引换词；主句保持原样。
            emptyHint.textContent = query.trim()
                ? '换个关键词试试。'
                : '在上面搜一首歌，结果会出现在这里。';
            emptyHint.hidden = false;
        } else {
            notice.hidden = true;
            emptyIcon.hidden = true;
            emptyHint.hidden = true;
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
    const playingId = getCurrentState().track?.id;
    const makeEq = (): HTMLElement => {
        const eq = document.createElement('span');
        eq.className = 'track-eq';
        eq.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < 3; i++) {
            eq.appendChild(document.createElement('i'));
        }
        return eq;
    };
    for (const [index, track] of tracks.entries()) {
        const item = document.createElement('li');
        item.className = 'track-row';
        // 正在播行的渐变与辉光取色：曲目 id 哈希，与海报同一口径。
        item.style.setProperty('--hue', String(posterHue(track.id)));
        if (track.id === playingId) {
            item.classList.add('is-playing');
        }

        if (track.coverUrl) {
            const cover = document.createElement('img');
            cover.className = 'track-cover';
            cover.referrerPolicy = 'no-referrer';
            cover.src = track.coverUrl;
            cover.alt = '';
            cover.onerror = () => {
                cover.remove();
            };
            item.appendChild(cover);
        } else {
            const glyph = document.createElement('span');
            glyph.className = 'track-glyph';
            glyph.textContent = '♪';
            item.appendChild(glyph);
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
        meta.textContent = `${track.artist}${albumPart}`;
        info.appendChild(meta);

        // 0.1.80 磁带小窗：纯装饰，两轴 + 磁带条，不参与点击。
        const tape = document.createElement('div');
        tape.className = 'track-tape';
        tape.setAttribute('aria-hidden', 'true');
        const reelLeft = document.createElement('span');
        reelLeft.className = 'track-reel';
        const tapeBar = document.createElement('span');
        tapeBar.className = 'track-tape-bar';
        const reelRight = document.createElement('span');
        reelRight.className = 'track-reel';
        tape.append(reelLeft, tapeBar, reelRight);
        info.appendChild(tape);
        item.appendChild(info);

        if (track.id === playingId) {
            item.appendChild(makeEq());
        }

        const duration = document.createElement('span');
        duration.className = 'track-duration';
        duration.textContent = formatDuration(track.durationMs);
        item.appendChild(duration);

        // 整行可点：此前只有右侧小按钮有点击，点行本身（封面/歌名/歌手）
        // 全无反应——2026-10-26 用户在 YTM 搜索里点晴天那行正是这样哑火，
        // 日志里连取链都没出现。行点击与按钮共用同一处理，按钮处阻止冒泡，
        // 免得一次点触发两次（0.1.36 的同队列去重本已兜底，这里再挡一层）。
        const playFromRow = (): void => {
            void (async () => {
                try {
                    await playQueue(tracks, index);
                    // 成功后刷新本列表的高亮：旧行去高亮与均衡器，点中行加上。
                    for (const row of list.querySelectorAll('.track-row.is-playing')) {
                        row.classList.remove('is-playing');
                        row.querySelector('.track-eq')?.remove();
                    }
                    item.classList.add('is-playing');
                    duration.before(makeEq());
                } catch (error) {
                    status.textContent = friendlyPlayError(error);
                }
            })();
        };
        item.addEventListener('click', playFromRow);

        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.className = 'track-play';
        playButton.textContent = '▶';
        playButton.addEventListener('click', (event) => {
            event.stopPropagation();
            playFromRow();
        });
        item.appendChild(playButton);

        list.appendChild(item);
    }
}
