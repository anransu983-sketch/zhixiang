// 播放页（第 8 块，全新写）：全屏播放页，参考另一 App 的全屏播放页布局。
//
// 布局（自上而下，内容收进居中悬浮板）：返回按钮 → 定高可折叠歌词卡（默认显示）→ 歌名/歌手 →
// 进度条（仅展示，不可拖动：第 5 块没有 seek 口子，不发明）→ 图标控制条 →
// 底排（循环 / 收藏 / 睡眠定时 / 词 / 音质角标）→ 可折叠「视觉」区。
// 歌词隐藏时中央改显示大封面；封面模糊底由第 8 块画布画（见 visuals.ts），
// 雨滴开关只管雨滴本身，关了雨滴模糊底仍在。
// 封面：远程 http(s) 直用；本地 content:// 由原生按专辑 id 转 data URL
// （播放页点开当前曲目时调一次，不批量扫库）；加载失败时隐藏，不露破图。
// 歌词行只展示，不绑点击、不做跳转。
//
// 状态来源：只用第 5 块已有的 onTrackChange / onTimeUpdate /
// getCurrentState / getAnalyser，不新增播放引擎口子。
// 壁纸跟随：切歌、播放/暂停变化、歌词行变化时把状态推给原生插件，
// 壁纸引擎读 SharedPreferences 跟随；播放停止后壁纸侧自行闲置。

import {
    getAnalyser,
    getCurrentState,
    getRepeatMode,
    next,
    onTrackChange,
    onTimeUpdate,
    pause,
    previous,
    refreshAutoMix,
    setRepeatMode,
    togglePlay
} from './playback';
import { loadAutoMixEnabled, saveAutoMixEnabled } from './automix';
import type { PlaybackState, RepeatMode } from './playback';
import {
    approximateWords,
    fetchLyrics,
    filterCreditLines,
    findCurrentLineIndex,
    loadFilterCreditsEnabled,
    saveFilterCreditsEnabled
} from './lyrics';
import type { LyricLine } from './lyrics';
import { openLiveWallpaperPicker, setWallpaperState } from './native/wallpaper-plugin';
import { loadVisualToggles, saveVisualToggles, VISUAL_PRESETS, VisualStage } from './visuals';
import { LyricDrops } from './lyric-drops';
import type { VisualToggles } from './visuals';
import { deleteManualLyrics, getManualLyrics, saveManualLyrics } from './manual-lyrics';
import {
    computeBlurRadiiByIntensity,
    loadLyricBlurEnabled,
    lyricOpacityForOffset,
    loadLyricBlurIntensity,
    loadLyricBounce,
    loadLyricGlow,
    loadShowTranslation,
    saveLyricBlurEnabled,
    saveLyricBlurIntensity,
    saveLyricBounce,
    saveLyricGlow,
    saveShowTranslation
} from './lyric-blur';
import { isTtmlText, parseTtml } from './ttml';
import { linesToLrc } from './batch-writeback';
import { clearLyricFont, getLyricFontName, importLyricFont, LYRIC_FONT_CSS, restoreLyricFont } from './lyric-font';
import { checkAllFilesAccess, getLocalCoverDataUrl, getLocalCoverFromNetease, getLocalPath, getLocalSidecarCoverDataUrl, requestAllFilesAccess, writeSidecar } from './sources/local';
import { posterFallbackBackground, posterHue } from './posters';
import { getLastYtmStreamMeta } from './sources/ytm';
import type { Track } from './types';
import { pushBackHandler } from './back-stack';

let overlay: HTMLElement | null = null;
let stage: VisualStage | null = null;
let lyricDrops: LyricDrops | null = null;
let refreshPage: ((state: PlaybackState) => void) | null = null;
let renderLyricsPage: ((note: string | null) => void) | null = null;
let highlightLinePage: ((index: number, behavior?: ScrollBehavior) => void) | null = null;
let updateDegradedNotePage: (() => void) | null = null;
let toggles: VisualToggles = loadVisualToggles();
let lyricLines: LyricLine[] = [];
// 歌词过滤（0.1.132）：rawLyricLines 是 fetchLyrics 回的原始行，
// lyricLines 是按「过滤制作信息」开关算出的展示行。切开关只重算
// 展示行并重渲染，不重新联网。开关状态在模块层持有一份，播放页
// 设置区的复选框与它同步。
let rawLyricLines: LyricLine[] = [];
let filterCreditsEnabled = loadFilterCreditsEnabled();

function setLyricLinesFromSource(lines: LyricLine[]): void {
    rawLyricLines = lines;
    lyricLines = filterCreditsEnabled ? filterCreditLines(rawLyricLines) : [...rawLyricLines];
}

function clearLyricLines(): void {
    rawLyricLines = [];
    lyricLines = [];
}

function reapplyLyricFilter(): void {
    lyricLines = filterCreditsEnabled ? filterCreditLines(rawLyricLines) : [...rawLyricLines];
}

let currentLineIndex = -1;
let currentSungWord = -1;
let lyricGeneration = 0;

const FAVORITES_KEY = 'zx_favorites_v1';

function loadFavorites(): Set<string> {
    try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (Array.isArray(parsed)) {
            return new Set(parsed.filter((item) => typeof item === 'string'));
        }
    } catch {
        // 存档损坏时按空处理。
    }
    return new Set();
}

function saveFavorites(favorites: Set<string>): void {
    try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
    } catch {
        // 存不下只影响下次打开的收藏状态。
    }
}

function favoriteKey(track: Track): string {
    return `${track.source}:${track.id}`;
}

function formatTime(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return '0:00';
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// 系统返回接入（back-stack）：播放页显示时把关闭动作压栈，
// 页内返回与系统返回都走 hidePlayerPage 一条路；隐藏即注销，
// 别让已关的页面还占着栈顶。
let unregisterPlayerBack: (() => void) | null = null;

function hidePlayerPage(): void {
    if (overlay) {
        overlay.hidden = true;
    }
    stage?.suspend();
    // 卡面水滴同停：poke 内部按呈现条件自判（页已 hidden → 停画藏层）。
    lyricDrops?.poke();
    unregisterPlayerBack?.();
    unregisterPlayerBack = null;
}

export function openPlayerPage(): void {
    if (overlay) {
        overlay.hidden = false;
        // 重开也要刷新：页关着时切过歌，标题/收藏/角标/歌词都会 stale，
        // 只 unhide 不刷新就是截图里那种标题还是旧文案的样子。
        refreshFromState(getCurrentState());
        stage?.resize();
        stage?.resume();
    } else {
        overlay = buildPlayerPage();
        document.body.appendChild(overlay);
        refreshFromState(getCurrentState());
        stage?.resize();
        stage?.resume();
    }
    // 雨滴档可能在我的页雨窗里改过：开页时现读存储同步给卡面水滴
    //（setMode 内部带 poke，呈现中会立刻按新档位画/动起来）。
    lyricDrops?.setMode(loadVisualToggles().rainMode);
    if (!unregisterPlayerBack) {
        unregisterPlayerBack = pushBackHandler(hidePlayerPage);
    }
}

function buildPlayerPage(): HTMLElement {
    const page = document.createElement('section');
    page.className = 'player-page';

    const canvas = document.createElement('canvas');
    canvas.className = 'player-canvas';
    page.appendChild(canvas);

    const content = document.createElement('div');
    content.className = 'player-content';
    page.appendChild(content);

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'player-back-btn';
    backButton.textContent = '返回';
    backButton.addEventListener('click', () => {
        hidePlayerPage();
    });
    content.appendChild(backButton);

    // 中央区：歌词卡（默认显示）与大封面（二选一，词隐藏时显示封面）。
    // 歌词卡定高 + 折叠：折叠时只露当前行一条，展开恢复居中滚动；
    // 折叠态存 localStorage，默认展开。无词时不露折叠钮，只显示提示。
    const lyricCard = document.createElement('section');
    lyricCard.className = 'lyric-card';
    const foldButton = document.createElement('button');
    foldButton.type = 'button';
    foldButton.className = 'lyric-fold';
    foldButton.textContent = '⌃';
    // 折叠条夹层（0.1.50）：bar 本身 48px 定高，0fr 轨道压不住它，
    // 必须经一层无定高的 clip 裁掉，做法与歌词侧 clip 同款。
    const lyricBarWrap = document.createElement('div');
    lyricBarWrap.className = 'lyric-bar-wrap';
    const lyricBarClip = document.createElement('div');
    lyricBarClip.className = 'lyric-bar-clip';
    const lyricBar = document.createElement('div');
    lyricBar.className = 'lyric-bar';
    lyricBarClip.appendChild(lyricBar);
    lyricBarWrap.appendChild(lyricBarClip);
    const lyricCollapse = document.createElement('div');
    lyricCollapse.className = 'lyric-collapse';
    const lyricClip = document.createElement('div');
    lyricClip.className = 'lyric-clip';
    const lyricBox = document.createElement('div');
    lyricBox.className = 'player-lyrics';
    lyricClip.appendChild(lyricBox);
    lyricCollapse.appendChild(lyricClip);
    // 封面虚化底（0.1.136）：卡最底层铺当前封面图重模糊版，去掉卡面
    // 一片平粉的单调感；图源由 applyCover 的 setCoverSrc/hideCover 与
    // 大封面 img 同步维护，无封面时透明、露出卡原有渐变底兜底。
    const lyricCardBg = document.createElement('div');
    lyricCardBg.className = 'lyric-card-bg';
    // 歌词底影垫（0.1.140）：虚化底之上、歌词内容之下的暗渐变层，把亮
    // 封面上的歌词行衬实；层位/z-index 见 style.css .lyric-card-scrim。
    const lyricCardScrim = document.createElement('div');
    lyricCardScrim.className = 'lyric-card-scrim';
    // 卡面水滴层（0.1.138；0.1.139 抬层）：canvas 铺满卡面，层位由 CSS
    // z-index 定（虚化底 0＜歌词内容 1＜水滴 2＜折叠钮 3），水滴压在
    // 歌词字上；水滴画法/档位/透镜底图全由 LyricDrops 管
    // （lyric-drops.ts），这里只建元素，实例在折叠状态定下来之后再建。
    const lyricDropsCanvas = document.createElement('canvas');
    lyricDropsCanvas.className = 'lyric-card-drops';
    // 间奏呼吸点（0.1.136）：长间奏/前奏没词时浮在卡底部中央，显隐与
    // 点亮数由 onTimeUpdate 里的 updateInterlude 按下一行时间算，不另开
    // 定时器；默认藏，切歌/无词时复位隐藏。
    const lyricInterlude = document.createElement('div');
    lyricInterlude.className = 'lyric-interlude';
    lyricInterlude.hidden = true;
    const interludeDots: HTMLSpanElement[] = [];
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        interludeDots.push(dot);
        lyricInterlude.appendChild(dot);
    }
    lyricCard.append(lyricCardBg, lyricCardScrim, lyricDropsCanvas, foldButton, lyricBarWrap, lyricCollapse, lyricInterlude);
    // 折叠偏好只在创建时读一次，之后由 applyFoldState 维护；
    // 这里直接写 dataset，不经过函数，免得撞上后面 const 的初始化顺序。
    const FOLD_KEY = 'zx.player.lyricsFolded';
    let lyricsFolded = false;
    try {
        lyricsFolded = localStorage.getItem(FOLD_KEY) === '1';
    } catch {
        lyricsFolded = false;
    }
    lyricCard.dataset.folded = lyricsFolded ? 'true' : 'false';
    foldButton.setAttribute('aria-expanded', lyricsFolded ? 'false' : 'true');
    foldButton.setAttribute('aria-label', lyricsFolded ? '展开歌词' : '折叠歌词');
    // 藏起的一侧不进无障碍树与焦点：展开时条 inert，折叠时歌词盒 inert。
    lyricBarWrap.inert = !lyricsFolded;
    lyricCollapse.inert = lyricsFolded;
    content.appendChild(lyricCard);

    // 卡面水滴实例（0.1.138）：呈现条件现算——播放页打开、歌词卡没被
    // 「词」开关藏掉、未折叠，三者齐了才露面/才动；档位先按存储里的
    // rainMode 定，开页时 openPlayerPage 还会再现读一次同步。
    lyricDrops = new LyricDrops(lyricDropsCanvas, {
        isPresented: () =>
            overlay !== null && !overlay.hidden && !lyricCard.hidden && !lyricsFolded
    });
    lyricDrops.setMode(loadVisualToggles().rainMode);

    // 封面套：img 与占位共用；img 一直挂着（模糊底要靠它），
    // 是否显示由 updateCoverVisibility 定，无图时露占位不露破图。
    const coverWrap = document.createElement('div');
    coverWrap.className = 'player-cover-wrap';
    coverWrap.hidden = true;
    const cover = document.createElement('img');
    cover.className = 'player-cover';
    cover.alt = '封面';
    // 0.1.106：与首页封面同理，B 站图床禁非 B 站 Referer，不带则通。
    cover.referrerPolicy = 'no-referrer';
    const coverPlaceholder = document.createElement('div');
    coverPlaceholder.className = 'player-cover-ph';
    coverPlaceholder.textContent = '♪';
    coverWrap.append(cover, coverPlaceholder);
    content.appendChild(coverWrap);

    const title = document.createElement('h2');
    title.className = 'player-title';
    title.textContent = '还没播放任何歌曲';
    content.appendChild(title);

    const artist = document.createElement('p');
    artist.className = 'player-artist';
    content.appendChild(artist);

    // 进度条：仅展示。currentTime 是秒，duration 是毫秒（见 playback.ts），
    // 按这个口径算百分比与时间，不拖动（第 5 块没有 seek 口子）。
    const progress = document.createElement('div');
    progress.className = 'player-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'player-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'player-progress-fill';
    progressBar.appendChild(progressFill);
    const progressTimes = document.createElement('div');
    progressTimes.className = 'player-progress-times';
    const timeCurrent = document.createElement('span');
    timeCurrent.textContent = '0:00';
    const timeTotal = document.createElement('span');
    timeTotal.textContent = '0:00';
    progressTimes.append(timeCurrent, timeTotal);
    progress.append(progressBar, progressTimes);
    content.appendChild(progress);

    const controls = document.createElement('div');
    controls.className = 'player-controls';
    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'player-icon-btn';
    prevButton.textContent = '◀︎';
    prevButton.addEventListener('click', () => {
        void previous();
    });
    const playPauseButton = document.createElement('button');
    playPauseButton.type = 'button';
    playPauseButton.className = 'player-icon-btn is-main';
    playPauseButton.textContent = '▶︎';
    playPauseButton.addEventListener('click', () => {
        // 一击光圈：与迷你播放圆同款，box-shadow 扩散 450ms。
        playPauseButton.classList.remove('burst');
        void playPauseButton.offsetWidth;
        playPauseButton.classList.add('burst');
        window.setTimeout(() => {
            playPauseButton.classList.remove('burst');
        }, 450);
        void togglePlay();
    });
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'player-icon-btn';
    nextButton.textContent = '▶︎';
    nextButton.addEventListener('click', () => {
        void next();
    });
    controls.append(prevButton, playPauseButton, nextButton);
    content.appendChild(controls);

    // 底排两行制（0.1.134）：板内可用宽约 280px，单行塞 7 颗图标钮＋
    // 角标必然溢出。第一行只放 5 颗图标钮（循环 / 收藏 / 睡眠定时 /
    // 词 / 视觉），第二行放贴词、换封面两颗文字片＋音质角标。
    const bottomRow = document.createElement('div');
    bottomRow.className = 'player-bottom-row';

    const repeatButton = document.createElement('button');
    repeatButton.type = 'button';
    repeatButton.className = 'player-bottom-btn';
    const repeatGlyph = document.createElement('span');
    repeatGlyph.className = 'player-bottom-glyph';
    repeatGlyph.textContent = '↻︎';
    const repeatLabel = document.createElement('span');
    repeatLabel.className = 'player-bottom-label';
    repeatLabel.textContent = '关';
    repeatButton.append(repeatGlyph, repeatLabel);
    const repeatOrder: RepeatMode[] = ['off', 'queue', 'one', 'shuffle'];
    const repeatLabelText: Record<RepeatMode, string> = {
        off: '关',
        queue: '循环',
        one: '单曲',
        shuffle: '随机'
    };
    const updateRepeatButton = (): void => {
        const mode = getRepeatMode();
        repeatLabel.textContent = repeatLabelText[mode];
        repeatGlyph.textContent = mode === 'shuffle' ? '⇌' : '↻︎';
        repeatButton.classList.toggle('is-active', mode !== 'off');
    };
    repeatButton.addEventListener('click', () => {
        const current = getRepeatMode();
        const nextMode = repeatOrder[(repeatOrder.indexOf(current) + 1) % repeatOrder.length] ?? 'off';
        setRepeatMode(nextMode);
        updateRepeatButton();
    });
    updateRepeatButton();

    const heartButton = document.createElement('button');
    heartButton.type = 'button';
    heartButton.className = 'player-bottom-btn';
    heartButton.textContent = '♥';
    const updateHeart = (track: Track | null): void => {
        // 闲置空心、收藏实心（参考图的样子）；之前两种状态都是实心只变颜色。
        const favorited = track ? loadFavorites().has(favoriteKey(track)) : false;
        heartButton.classList.toggle('is-active', favorited);
        heartButton.textContent = favorited ? '♥' : '♡';
    };
    heartButton.addEventListener('click', () => {
        const track = getCurrentState().track;
        if (!track) {
            return;
        }
        const favorites = loadFavorites();
        const key = favoriteKey(track);
        if (favorites.has(key)) {
            favorites.delete(key);
        } else {
            favorites.add(key);
        }
        saveFavorites(favorites);
        updateHeart(track);
    });

    // 睡眠定时：15/30/60/90 分钟选择器，到时 pause()；时间戳 guard，
    // 即使定时器被后台节流，播放进度回调也能补上。
    let sleepUntil: number | null = null;
    let sleepTimer: ReturnType<typeof setTimeout> | null = null;
    const sleepButton = document.createElement('button');
    sleepButton.type = 'button';
    sleepButton.className = 'player-bottom-btn';
    const sleepGlyph = document.createElement('span');
    sleepGlyph.className = 'player-bottom-glyph';
    sleepGlyph.textContent = '☾';
    const sleepRemaining = document.createElement('span');
    sleepRemaining.className = 'player-bottom-label';
    sleepRemaining.hidden = true;
    sleepButton.append(sleepGlyph, sleepRemaining);
    const sleepPicker = document.createElement('div');
    sleepPicker.className = 'player-sleep-picker';
    sleepPicker.hidden = true;
    const updateSleepButton = (): void => {
        sleepButton.classList.toggle('is-active', sleepUntil !== null);
        sleepRemaining.hidden = sleepUntil === null;
    };
    const cancelSleep = (): void => {
        if (sleepTimer !== null) {
            clearTimeout(sleepTimer);
            sleepTimer = null;
        }
        sleepUntil = null;
        updateSleepButton();
    };
    const fireSleep = (): void => {
        cancelSleep();
        pause();
    };
    const updateSleepRemaining = (): void => {
        if (sleepUntil === null) {
            return;
        }
        const left = sleepUntil - Date.now();
        if (left <= 0) {
            fireSleep();
            return;
        }
        sleepRemaining.textContent = formatTime(left / 1000);
    };
    for (const minutes of [15, 30, 60, 90]) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'player-sleep-option';
        option.textContent = `${minutes}分钟`;
        option.addEventListener('click', () => {
            cancelSleep();
            sleepUntil = Date.now() + minutes * 60000;
            sleepTimer = setTimeout(() => {
                fireSleep();
            }, minutes * 60000);
            updateSleepButton();
            updateSleepRemaining();
            sleepPicker.hidden = true;
        });
        sleepPicker.appendChild(option);
    }
    const sleepPickerCancel = document.createElement('button');
    sleepPickerCancel.type = 'button';
    sleepPickerCancel.className = 'player-sleep-option';
    sleepPickerCancel.textContent = '取消';
    sleepPickerCancel.addEventListener('click', () => {
        sleepPicker.hidden = true;
    });
    sleepPicker.appendChild(sleepPickerCancel);
    sleepButton.addEventListener('click', () => {
        if (sleepUntil !== null) {
            // 已有定时：再点即取消。
            cancelSleep();
            sleepPicker.hidden = true;
            return;
        }
        sleepPicker.hidden = !sleepPicker.hidden;
    });

    const lyricsButton = document.createElement('button');
    lyricsButton.type = 'button';
    lyricsButton.className = 'player-bottom-btn is-active';
    lyricsButton.textContent = '词';
    let lyricsShown = true;
    const updateLyricsButton = (): void => {
        lyricsButton.classList.toggle('is-active', lyricsShown);
    };

    // 音质角标：按真实格式显示，绝不贴假标。YTM 取链元数据（Opus/AAC＋码率），
    // 本地按文件扩展名；网易云无元数据、缓存直链 mimeType 为空时一律隐藏。
    const qualityBadge = document.createElement('span');
    qualityBadge.className = 'player-quality-badge';
    qualityBadge.hidden = true;
    const updateQualityBadge = (track: Track | null): void => {
        let text = '';
        if (track?.source === 'ytm') {
            const meta = getLastYtmStreamMeta();
            if (meta && meta.mimeType) {
                const codecMatch = /codecs="?([^";]+)/.exec(meta.mimeType);
                const codecRaw = (codecMatch?.[1] ?? '').toLowerCase();
                const codec = codecRaw.includes('opus')
                    ? 'Opus'
                    : codecRaw.includes('mp4a')
                      ? 'AAC'
                      : codecRaw;
                const kbps = meta.bitrate ? Math.round(meta.bitrate / 1000) : 0;
                text = codec && kbps > 0 ? `${codec} ${kbps}K` : codec;
            }
        } else if (track?.source === 'local') {
            text = track.format ?? '';
        }
        qualityBadge.textContent = text;
        qualityBadge.hidden = text === '';
    };

    const visualEntry = document.createElement('button');
    visualEntry.type = 'button';
    visualEntry.className = 'player-bottom-btn';
    visualEntry.setAttribute('aria-controls', 'visual-panel');
    const visualEntryTile = document.createElement('span');
    visualEntryTile.className = 'player-visual-tile';
    visualEntryTile.textContent = '✦';
    const visualEntryLabel = document.createElement('span');
    visualEntryLabel.className = 'player-bottom-label';
    visualEntryLabel.textContent = '视觉';
    visualEntry.append(visualEntryTile, visualEntryLabel);
    // 0.1.115 手动贴词＋换封面（Mineradio 借鉴）：贴词存 localStorage
    // 覆盖并优先于各路歌词；本地歌换封面写 sidecar 同名 .jpg。
    const pasteButton = document.createElement('button');
    pasteButton.type = 'button';
    pasteButton.className = 'player-text-chip';
    pasteButton.textContent = '贴词';
    const coverButton = document.createElement('button');
    coverButton.type = 'button';
    coverButton.className = 'player-text-chip';
    coverButton.textContent = '换封面';
    const flashButton = (button: HTMLButtonElement, text: string): void => {
        const original = button.textContent;
        button.textContent = text;
        window.setTimeout(() => {
            button.textContent = original;
        }, 2000);
    };
    const refreshLyricsNow = (): void => {
        const track = getCurrentState().track;
        if (!track) {
            return;
        }
        const generation = ++lyricGeneration;
        void fetchLyrics(track).then((result) => {
            if (generation !== lyricGeneration) {
                return;
            }
            setLyricLinesFromSource(result.lines);
            renderLyrics(result.note);
        });
    };
    const sheet = document.createElement('div');
    sheet.className = 'player-sheet';
    sheet.hidden = true;
    const sheetCard = document.createElement('div');
    sheetCard.className = 'player-sheet-card';
    const sheetTitle = document.createElement('div');
    sheetTitle.className = 'player-sheet-title';
    sheetTitle.textContent = '手动贴词';
    const sheetSong = document.createElement('div');
    sheetSong.className = 'player-sheet-song';
    const sheetArea = document.createElement('textarea');
    sheetArea.className = 'player-sheet-textarea';
    sheetArea.rows = 10;
    sheetArea.placeholder = '粘贴 LRC 歌词或 TTML，带时间标签可逐行高亮，纯文本只做展示';
    const sheetHint = document.createElement('p');
    sheetHint.className = 'player-note';
    sheetHint.textContent = '保存后立即生效，优先于各路歌词。本地歌还会写回同名 .lrc（贴的是 TTML 时先转成 LRC 正文再写）；删除只清手动贴词，已写回的 .lrc 仍会显示。';
    const sheetStatus = document.createElement('p');
    sheetStatus.className = 'player-note';
    sheetStatus.hidden = true;
    const sheetRow = document.createElement('div');
    sheetRow.className = 'player-sheet-row';
    const sheetSave = document.createElement('button');
    sheetSave.type = 'button';
    sheetSave.className = 'login-btn';
    sheetSave.textContent = '保存';
    const sheetDelete = document.createElement('button');
    sheetDelete.type = 'button';
    sheetDelete.className = 'login-btn';
    sheetDelete.textContent = '删除贴词';
    const sheetCancel = document.createElement('button');
    sheetCancel.type = 'button';
    sheetCancel.className = 'login-btn';
    sheetCancel.textContent = '取消';
    // 从文件导入（0.1.131）：选 .lrc/.ttml/.txt 读进来填编辑框，
    // 仍走原保存流程（存档保存原文，格式在 fetchLyrics 读取时判）。
    const sheetImport = document.createElement('button');
    sheetImport.type = 'button';
    sheetImport.className = 'login-btn';
    sheetImport.textContent = '从文件导入';
    const sheetFileInput = document.createElement('input');
    sheetFileInput.type = 'file';
    sheetFileInput.accept = '.lrc,.ttml,.txt';
    sheetFileInput.hidden = true;
    sheetImport.addEventListener('click', () => {
        sheetFileInput.click();
    });
    sheetFileInput.addEventListener('change', () => {
        const file = sheetFileInput.files?.[0];
        sheetFileInput.value = '';
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            sheetArea.value = typeof reader.result === 'string' ? reader.result : '';
            sheetStatus.textContent = `已导入 ${file.name}，点保存生效`;
            sheetStatus.hidden = false;
        };
        reader.onerror = () => {
            sheetStatus.textContent = '文件读不出来，换个文件再试';
            sheetStatus.hidden = false;
        };
        reader.readAsText(file);
    });
    sheetRow.append(sheetSave, sheetImport, sheetDelete, sheetCancel);
    sheetCard.append(sheetTitle, sheetSong, sheetArea, sheetHint, sheetStatus, sheetRow, sheetFileInput);
    sheet.appendChild(sheetCard);
    content.appendChild(sheet);
    pasteButton.addEventListener('click', () => {
        const track = getCurrentState().track;
        if (!track) {
            return;
        }
        sheetSong.textContent = `${track.title} · ${track.artist}`;
        sheetArea.value = getManualLyrics(track) ?? '';
        sheetStatus.hidden = true;
        sheet.hidden = false;
    });
    sheetCancel.addEventListener('click', () => {
        sheet.hidden = true;
    });
    sheetSave.addEventListener('click', () => {
        const track = getCurrentState().track;
        if (!track) {
            return;
        }
        const text = sheetArea.value;
        if (text.trim().length === 0) {
            deleteManualLyrics(track);
            sheetStatus.textContent = '已删除手动贴词';
            sheetStatus.hidden = false;
            refreshLyricsNow();
            return;
        }
        saveManualLyrics(track, text);
        refreshLyricsNow();
        // 0.1.131：贴词是 TTML 时写回 .lrc 的内容要先转——经 TTML 解析
        // 出行后用 linesToLrc 只拼正文行（逐字／译文不进 LRC），绝不把
        // XML 原文塞进 .lrc；解析不出行就不写回，状态里如实说明。
        // 非 TTML 保持原口径：原文即 LRC，直接写。
        let sidecarText: string | null = text;
        let sidecarSkipReason = '';
        if (isTtmlText(text)) {
            try {
                const ttmlLines = parseTtml(text);
                if (ttmlLines.length > 0) {
                    sidecarText = linesToLrc(ttmlLines);
                } else {
                    sidecarText = null;
                    sidecarSkipReason = 'TTML 没解析出歌词行';
                }
            } catch {
                sidecarText = null;
                sidecarSkipReason = 'TTML 解析失败';
            }
        }
        if (track.source === 'local') {
            const path = getLocalPath(track);
            if (!path) {
                sheetStatus.textContent = '已保存，只在本机覆盖生效';
                sheetStatus.hidden = false;
                return;
            }
            if (sidecarText === null) {
                sheetStatus.textContent = `已保存，${sidecarSkipReason}，未写回 .lrc，只在本机覆盖生效`;
                sheetStatus.hidden = false;
                return;
            }
            const lyricsToWrite = sidecarText;
            void (async () => {
                try {
                    if (!(await checkAllFilesAccess())) {
                        await requestAllFilesAccess();
                    }
                    if (await checkAllFilesAccess()) {
                        await writeSidecar({ path, lyrics: lyricsToWrite });
                        sheetStatus.textContent = '已保存，并写回同名 .lrc';
                    } else {
                        sheetStatus.textContent = '已保存，未拿到所有文件访问权限，只在本机覆盖生效';
                    }
                } catch {
                    sheetStatus.textContent = '已保存，写回 .lrc 失败，只在本机覆盖生效';
                }
                sheetStatus.hidden = false;
            })();
        } else {
            sheetStatus.textContent = '已保存';
            sheetStatus.hidden = false;
        }
    });
    sheetDelete.addEventListener('click', () => {
        const track = getCurrentState().track;
        if (!track) {
            return;
        }
        deleteManualLyrics(track);
        sheetArea.value = '';
        sheetStatus.textContent = '已删除手动贴词';
        sheetStatus.hidden = false;
        refreshLyricsNow();
    });
    const coverInput = document.createElement('input');
    coverInput.type = 'file';
    coverInput.accept = 'image/*';
    coverInput.hidden = true;
    content.appendChild(coverInput);
    coverButton.addEventListener('click', () => {
        const track = getCurrentState().track;
        if (!track) {
            return;
        }
        if (track.source !== 'local') {
            flashButton(coverButton, '仅本地歌');
            return;
        }
        coverInput.click();
    });
    coverInput.addEventListener('change', () => {
        const file = coverInput.files?.[0];
        coverInput.value = '';
        const track = getCurrentState().track;
        if (!file || !track || track.source !== 'local') {
            return;
        }
        const path = getLocalPath(track);
        if (!path) {
            flashButton(coverButton, '找不到文件');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const side = Math.min(img.width, img.height);
                const canvas = document.createElement('canvas');
                canvas.width = 640;
                canvas.height = 640;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    return;
                }
                ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 640, 640);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                void (async () => {
                    try {
                        if (!(await checkAllFilesAccess())) {
                            await requestAllFilesAccess();
                        }
                        if (!(await checkAllFilesAccess())) {
                            flashButton(coverButton, '需文件权限');
                            return;
                        }
                        await writeSidecar({ path, coverDataUrl: dataUrl });
                        cover.src = dataUrl;
                        coverPlaceholder.hidden = true;
                        flashButton(coverButton, '已换封面');
                    } catch {
                        flashButton(coverButton, '写回失败');
                    }
                })();
            };
            img.onerror = () => {
                flashButton(coverButton, '图片读不出');
            };
            img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    });
    bottomRow.append(repeatButton, heartButton, sleepButton, lyricsButton, visualEntry);
    // 第二行：文字片与角标单独成行居中排，窄板里也横得下，不再挤第一行。
    const bottomRow2 = document.createElement('div');
    bottomRow2.className = 'player-bottom-row2';
    bottomRow2.append(pasteButton, coverButton, qualityBadge);
    content.appendChild(bottomRow);
    content.appendChild(bottomRow2);
    content.appendChild(sleepPicker);

    // 「视觉」收进底排（0.1.57）：独立磁吸卡撤掉，底排末尾 ✦ 入口，
    // 点开展开玻璃面板（与睡眠选择器同款展开位）。折叠走 grid 0fr/1fr
    // + inner 夹层，padding 挂 pad 子层（0.1.49 折叠条教训）。
    const visualPanel = document.createElement('section');
    visualPanel.className = 'visual-panel';
    visualPanel.id = 'visual-panel';
    let storedVisualOpen = false;
    try {
        storedVisualOpen = localStorage.getItem('zx.player.visualOpen') === '1';
    } catch {
        storedVisualOpen = false;
    }
    visualPanel.dataset.open = String(storedVisualOpen);
    const visualInner = document.createElement('div');
    visualInner.className = 'visual-panel-inner';
    const visualPad = document.createElement('div');
    visualPad.className = 'visual-panel-pad';
    visualInner.appendChild(visualPad);
    visualPanel.appendChild(visualInner);
    content.appendChild(visualPanel);
    // 0.1.85 雨窗三档：播放页视觉面板里的雨滴复选框改成单选，与我的页雨窗
    // 共用同一份存储（zx.visual.toggles 的 rainMode）。
    const rainModes: Array<{ mode: number; label: string }> = [
        { mode: 0, label: '雨滴：关' },
        { mode: 1, label: '雨滴：静态水滴' },
        { mode: 2, label: '雨滴：动态滑落' }
    ];
    // 0.1.115 视觉预设（Mineradio 借鉴）：五项开关打包成命名组合。
    const rainRadios: HTMLInputElement[] = [];
    const toggleBoxes: Array<{ key: 'particles' | 'pulse' | 'stars' | 'sword'; box: HTMLInputElement }> = [];
    const applyPreset = (presetToggles: VisualToggles): void => {
        toggles = { ...presetToggles };
        saveVisualToggles(toggles);
        rainModes.forEach((rainDef, index) => {
            const radio = rainRadios[index];
            if (radio) {
                radio.checked = toggles.rainMode === rainDef.mode;
            }
        });
        for (const entry of toggleBoxes) {
            entry.box.checked = toggles[entry.key];
        }
        updateDegradedNote();
        stage?.poke();
        // 预设里带 rainMode：卡面水滴同档同步。
        lyricDrops?.setMode(toggles.rainMode);
        void pushWallpaperState();
    };
    // 歌词设置状态（模糊/译文/字体，与视觉开关同面板）：声明在设置 UI
    // 构建之前，后面的 applyLyricBlur 等函数只在构建完成后被调用。
    let lyricBlurEnabled = loadLyricBlurEnabled();
    let lyricBlurIntensity = loadLyricBlurIntensity();
    let showTranslation = loadShowTranslation();
    let lyricGlowEnabled = loadLyricGlow();
    // 歌词跳动（0.1.134）：动画全在 CSS，这里只按开关给歌词盒切类，
    // 切换即时生效、不重渲染。初始类在本行就挂好。
    let lyricBounceEnabled = loadLyricBounce();
    lyricBox.classList.toggle('lyrics-bounce-off', !lyricBounceEnabled);
    let lastLyricNote: string | null = null;
    const presetRow = document.createElement('div');
    presetRow.className = 'player-preset-row';
    const presetLabel = document.createElement('span');
    presetLabel.className = 'player-preset-label';
    presetLabel.textContent = '视觉预设';
    presetRow.appendChild(presetLabel);
    for (const preset of VISUAL_PRESETS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'player-preset-btn';
        button.textContent = preset.label;
        button.addEventListener('click', () => {
            applyPreset(preset.toggles);
        });
        presetRow.appendChild(button);
    }
    visualPad.appendChild(presetRow);
    for (const rainDef of rainModes) {
        const label = document.createElement('label');
        label.className = 'player-toggle';
        const box = document.createElement('input');
        box.type = 'radio';
        box.name = 'zx-player-rain-mode';
        box.checked = toggles.rainMode === rainDef.mode;
        rainRadios.push(box);
        box.addEventListener('change', () => {
            if (!box.checked) {
                return;
            }
            toggles = { ...toggles, rainMode: rainDef.mode };
            saveVisualToggles(toggles);
            stage?.poke();
            // 卡面水滴跟同一档位走（关/静态/动态）。
            lyricDrops?.setMode(toggles.rainMode);
            void pushWallpaperState();
        });
        label.append(box, document.createTextNode(rainDef.label));
        visualPad.appendChild(label);
    }
    const toggleDefs: { key: 'particles' | 'pulse' | 'stars' | 'sword'; label: string }[] = [
        { key: 'particles', label: '粒子舞台' },
        { key: 'pulse', label: '节奏脉动' },
        { key: 'stars', label: '氛围星空' },
        { key: 'sword', label: '剑来（切歌时）' }
    ];
    for (const def of toggleDefs) {
        const label = document.createElement('label');
        label.className = 'player-toggle';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = toggles[def.key];
        toggleBoxes.push({ key: def.key, box });
        box.addEventListener('change', () => {
            toggles = { ...toggles, [def.key]: box.checked };
            saveVisualToggles(toggles);
            updateDegradedNote();
            stage?.poke();
            void pushWallpaperState();
        });
        label.append(box, document.createTextNode(def.label));
        visualPad.appendChild(label);
    }

    // 歌词设置（跟视觉开关同面板、同 .player-toggle 样式）：模糊开关、
    // 译文开关、模糊强度无级滑杆、歌词字体导入/恢复。
    const blurLabel = document.createElement('label');
    blurLabel.className = 'player-toggle';
    const blurBox = document.createElement('input');
    blurBox.type = 'checkbox';
    blurBox.checked = lyricBlurEnabled;
    blurBox.addEventListener('change', () => {
        lyricBlurEnabled = blurBox.checked;
        saveLyricBlurEnabled(lyricBlurEnabled);
        blurIntensityRange.disabled = !lyricBlurEnabled;
        applyLyricBlur();
    });
    blurLabel.append(blurBox, document.createTextNode('歌词模糊'));
    visualPad.appendChild(blurLabel);

    // 模糊强度无级滑杆（0–100%）：50 是旧「标准」档的观感、0 无模糊、
    // 100 约两倍；拖动即存即生效。模糊关着时滑杆禁用，免得调了没反应。
    const blurStrengthRow = document.createElement('div');
    blurStrengthRow.className = 'player-preset-row';
    const blurStrengthLabel = document.createElement('span');
    blurStrengthLabel.className = 'player-preset-label';
    blurStrengthLabel.textContent = '模糊强度';
    const blurIntensityRange = document.createElement('input');
    blurIntensityRange.type = 'range';
    blurIntensityRange.className = 'player-range';
    blurIntensityRange.min = '0';
    blurIntensityRange.max = '100';
    blurIntensityRange.step = '1';
    blurIntensityRange.value = String(lyricBlurIntensity);
    blurIntensityRange.disabled = !lyricBlurEnabled;
    const blurIntensityValue = document.createElement('span');
    blurIntensityValue.className = 'player-preset-label';
    blurIntensityValue.textContent = `${lyricBlurIntensity}%`;
    blurIntensityRange.addEventListener('input', () => {
        lyricBlurIntensity = Number(blurIntensityRange.value);
        blurIntensityValue.textContent = `${lyricBlurIntensity}%`;
        saveLyricBlurIntensity(lyricBlurIntensity);
        applyLyricBlur();
    });
    blurStrengthRow.append(blurStrengthLabel, blurIntensityRange, blurIntensityValue);
    visualPad.appendChild(blurStrengthRow);

    const translationLabel = document.createElement('label');
    translationLabel.className = 'player-toggle';
    const translationBox = document.createElement('input');
    translationBox.type = 'checkbox';
    translationBox.checked = showTranslation;
    translationBox.addEventListener('change', () => {
        showTranslation = translationBox.checked;
        saveShowTranslation(showTranslation);
        // 数据照常挂在行上，只重渲染显隐；重渲染会把当前行清零，
        // 随即按当前进度一步复位，不平滑扫过去。
        renderLyrics(lastLyricNote);
        const index = findCurrentLineIndex(lyricLines, getCurrentState().currentTime * 1000);
        currentLineIndex = index;
        highlightLine(index, 'auto');
    });
    translationLabel.append(translationBox, document.createTextNode('显示译文'));
    visualPad.appendChild(translationLabel);

    // 歌词辉光开关（0.1.131）：关掉立即清掉正在唱的词的辉光样式。
    const glowLabel = document.createElement('label');
    glowLabel.className = 'player-toggle';
    const glowBox = document.createElement('input');
    glowBox.type = 'checkbox';
    glowBox.checked = lyricGlowEnabled;
    glowBox.addEventListener('change', () => {
        lyricGlowEnabled = glowBox.checked;
        saveLyricGlow(lyricGlowEnabled);
        if (!lyricGlowEnabled) {
            clearLyricGlow();
        }
    });
    glowLabel.append(glowBox, document.createTextNode('歌词辉光'));
    visualPad.appendChild(glowLabel);

    // 歌词跳动开关（0.1.134）：逐字弹跳＋整行弹动，纯 CSS 类切换。
    const bounceLabel = document.createElement('label');
    bounceLabel.className = 'player-toggle';
    const bounceBox = document.createElement('input');
    bounceBox.type = 'checkbox';
    bounceBox.checked = lyricBounceEnabled;
    bounceBox.addEventListener('change', () => {
        lyricBounceEnabled = bounceBox.checked;
        saveLyricBounce(lyricBounceEnabled);
        lyricBox.classList.toggle('lyrics-bounce-off', !lyricBounceEnabled);
    });
    bounceLabel.append(bounceBox, document.createTextNode('歌词跳动'));
    visualPad.appendChild(bounceLabel);

    // 过滤制作信息（0.1.132）：默认开。切开关只按原始行重算展示行
    // 并重渲染，不重新联网；重渲染后按当前进度复位当前行，与译文
    // 开关同口径。模块层的 filterCreditsEnabled 是真值来源，这里
    // 的复选框只是它的视图。
    const filterCreditsLabel = document.createElement('label');
    filterCreditsLabel.className = 'player-toggle';
    const filterCreditsBox = document.createElement('input');
    filterCreditsBox.type = 'checkbox';
    filterCreditsBox.checked = filterCreditsEnabled;
    filterCreditsBox.addEventListener('change', () => {
        filterCreditsEnabled = filterCreditsBox.checked;
        saveFilterCreditsEnabled(filterCreditsEnabled);
        reapplyLyricFilter();
        renderLyrics(lastLyricNote);
        const index = findCurrentLineIndex(lyricLines, getCurrentState().currentTime * 1000);
        currentLineIndex = index;
        highlightLine(index, 'auto');
    });
    filterCreditsLabel.append(filterCreditsBox, document.createTextNode('过滤制作信息'));
    visualPad.appendChild(filterCreditsLabel);

    // AutoMix 节拍过渡：默认关。开后自然播完时按估出的节拍提前
    // 重叠混音（机制在 playback.ts/automix.ts），手动切歌不受影响；
    // 切换即存，refreshAutoMix 让当前在播曲立即起/停采样。
    const automixLabel = document.createElement('label');
    automixLabel.className = 'player-toggle';
    const automixBox = document.createElement('input');
    automixBox.type = 'checkbox';
    automixBox.checked = loadAutoMixEnabled();
    automixBox.addEventListener('change', () => {
        saveAutoMixEnabled(automixBox.checked);
        refreshAutoMix();
    });
    automixLabel.append(automixBox, document.createTextNode('AutoMix 节拍过渡'));
    visualPad.appendChild(automixLabel);

    // 歌词字体行：当前字体名 + 导入 + 恢复默认；导入失败只提示，
    // 旧字体保留可用（事务口径在 lyric-font.ts）。
    const fontRow = document.createElement('div');
    fontRow.className = 'player-preset-row';
    const fontLabel = document.createElement('span');
    fontLabel.className = 'player-preset-label';
    fontLabel.textContent = '歌词字体';
    const fontName = document.createElement('span');
    fontName.className = 'player-preset-label';
    const fontImportButton = document.createElement('button');
    fontImportButton.type = 'button';
    fontImportButton.className = 'player-preset-btn';
    fontImportButton.textContent = '导入';
    const fontResetButton = document.createElement('button');
    fontResetButton.type = 'button';
    fontResetButton.className = 'player-preset-btn';
    fontResetButton.textContent = '恢复默认';
    const fontStatus = document.createElement('p');
    fontStatus.className = 'player-note';
    fontStatus.hidden = true;
    const fontInput = document.createElement('input');
    fontInput.type = 'file';
    fontInput.accept = '.ttf,.otf,font/*';
    fontInput.hidden = true;
    const updateFontRow = (): void => {
        const name = getLyricFontName();
        fontName.textContent = name !== '' ? name : '默认字体';
        fontResetButton.disabled = name === '';
    };
    const applyFontFamily = (enabled: boolean): void => {
        lyricBox.style.fontFamily = enabled ? LYRIC_FONT_CSS : '';
    };
    fontImportButton.addEventListener('click', () => {
        fontInput.click();
    });
    fontInput.addEventListener('change', () => {
        const file = fontInput.files?.[0];
        fontInput.value = '';
        if (!file) {
            return;
        }
        void importLyricFont(file).then((result) => {
            if (result.ok) {
                fontStatus.hidden = true;
                applyFontFamily(true);
                updateFontRow();
            } else {
                fontStatus.textContent = result.error;
                fontStatus.hidden = false;
            }
        });
    });
    fontResetButton.addEventListener('click', () => {
        void clearLyricFont().then(() => {
            applyFontFamily(false);
            fontStatus.hidden = true;
            updateFontRow();
        });
    });
    fontRow.append(fontLabel, fontName, fontImportButton, fontResetButton);
    visualPad.append(fontRow, fontInput, fontStatus);
    updateFontRow();
    // 进播放页恢复已存字体：注册成功才挂 font-family，失败保持默认。
    void restoreLyricFont().then((restored) => {
        if (restored) {
            applyFontFamily(true);
            updateFontRow();
        }
    });

    const degradedNote = document.createElement('p');
    degradedNote.className = 'player-note visual-degraded';
    degradedNote.hidden = true;
    degradedNote.textContent =
        '频谱不可用：粒子与脉动当前为氛围降级模式，不跟随真实频谱。';
    visualPad.appendChild(degradedNote);

    const wallpaperButton = document.createElement('button');
    wallpaperButton.type = 'button';
    wallpaperButton.className = 'player-wallpaper-btn';
    wallpaperButton.textContent = '设为系统壁纸';
    visualPad.appendChild(wallpaperButton);

    const wallpaperNotice = document.createElement('p');
    wallpaperNotice.className = 'player-note';
    wallpaperNotice.hidden = true;
    visualPad.appendChild(wallpaperNotice);

    wallpaperButton.addEventListener('click', () => {
        wallpaperNotice.hidden = true;
        openLiveWallpaperPicker()
            .then(() => {
                void pushWallpaperState();
            })
            .catch(() => {
                wallpaperNotice.textContent =
                    '打不开系统壁纸选择器，请在系统设置里手动选择芷湘动态壁纸。';
                wallpaperNotice.hidden = false;
            });
    });
    const setVisualOpen = (open: boolean, persist = true): void => {
        visualPanel.dataset.open = String(open);
        visualPanel.toggleAttribute('inert', !open);
        visualEntry.classList.toggle('is-active', open);
        visualEntry.setAttribute('aria-expanded', String(open));
        if (persist) {
            try {
                localStorage.setItem('zx.player.visualOpen', open ? '1' : '0');
            } catch {
                // 忽略。
            }
        }
        if (open) {
            window.setTimeout(() => {
                // nearest 只保证“露一点就够”：面板顶已在屏内时几乎不滚，
                // 面板身子就留在屏底之外。底超屏时才滚到底对齐，整块露出来。
                const rect = visualPanel.getBoundingClientRect();
                if (rect.bottom > window.innerHeight) {
                    visualPanel.scrollIntoView({ block: 'end', behavior: 'smooth' });
                }
            }, 280);
        }
    };
    visualEntry.addEventListener('click', () => {
        setVisualOpen(visualPanel.dataset.open !== 'true');
    });
    // 首帧：dataset 在挂载前已写，无过渡；收起时 inert 防焦点进面板。
    visualPanel.toggleAttribute('inert', !storedVisualOpen);
    visualEntry.classList.toggle('is-active', storedVisualOpen);
    visualEntry.setAttribute('aria-expanded', String(storedVisualOpen));

    // 封面：img 一直挂着（模糊底要靠它），是否显示由 updateCoverVisibility 定；
    // 套的显隐只看有没有曲 + 词开没开，img 与占位在套里二选一，
    // 加载完成露图，加载失败或无图露占位，不露破图与 alt 文字。
    let coverExpected = '';
    let coverLoaded = false;
    let coverForTrackId: string | null = null;
    let coverTrackPresent = false;
    const coverCache = new Map<string, string>();
    const updateCoverVisibility = (): void => {
        const showWrap = coverTrackPresent && !lyricsShown;
        coverWrap.hidden = !showWrap;
        coverWrap.classList.toggle('player-cover-large', showWrap);
        coverWrap.classList.toggle('has-img', coverLoaded);
        cover.hidden = !coverLoaded;
    };
    cover.addEventListener('load', () => {
        coverLoaded = true;
        updateCoverVisibility();
        stage?.poke();
    });
    cover.addEventListener('error', () => {
        if (coverExpected !== '' && cover.src === coverExpected) {
            coverLoaded = false;
            updateCoverVisibility();
            stage?.poke();
        }
    });
    const setCoverSrc = (url: string): void => {
        if (cover.src !== url) {
            coverLoaded = false;
            cover.src = url;
        }
        coverExpected = url;
        // 歌词卡虚化底与封面 img 同源（含本地歌的 dataURL）；JSON 串化
        // 给 url() 加引号并转义，URL 里带括号/引号也不会把 CSS 写坏。
        lyricCardBg.style.backgroundImage = `url(${JSON.stringify(url)})`;
        // 卡面水滴的透镜底图同源同步（LyricDrops 自维护离屏重模糊版）。
        lyricDrops?.setCover(url);
        updateCoverVisibility();
    };
    const hideCover = (): void => {
        cover.removeAttribute('src');
        coverExpected = '';
        coverLoaded = false;
        lyricCardBg.style.backgroundImage = '';
        lyricDrops?.setCover('');
        updateCoverVisibility();
    };
    const applyCover = (track: Track | null): void => {
        if (!track) {
            coverForTrackId = null;
            coverTrackPresent = false;
            hideCover();
            return;
        }
        coverTrackPresent = true;
        coverPlaceholder.style.background = posterFallbackBackground(track.id);
        if (!track.coverUrl) {
            coverForTrackId = null;
            hideCover();
            return;
        }
        if (track.id === coverForTrackId) {
            return;
        }
        coverForTrackId = track.id;
        const cached = coverCache.get(track.id);
        if (cached) {
            setCoverSrc(cached);
            return;
        }
        const coverUrl = track.coverUrl;
        if (coverUrl.startsWith('http://') || coverUrl.startsWith('https://')) {
            setCoverSrc(coverUrl);
            return;
        }
        if (coverUrl.startsWith('content://')) {
            const segments = coverUrl.split('/');
            const last = segments[segments.length - 1] ?? '';
            const albumId = Number(last);
            if (!Number.isInteger(albumId) || albumId <= 0) {
                hideCover();
                return;
            }
            // 0.1.106：sidecar 同名图优先；没有再走原有链
            //（MediaStore 专辑图 → 网易云补源），原有体不动。
            void getLocalSidecarCoverDataUrl(track)
                .then((sidecar) => sidecar ?? getLocalCoverDataUrl(albumId))
                .then((dataUrl) => {
                if (track.id !== coverForTrackId) {
                    return;
                }
                if (!dataUrl) {
                    // 0.1.85：MediaStore 无图时走网易云搜索匹配补封面。
                    void getLocalCoverFromNetease(track).then((coverUrl) => {
                        if (track.id !== coverForTrackId) {
                            return;
                        }
                        if (!coverUrl) {
                            hideCover();
                            return;
                        }
                        if (coverCache.size > 20) {
                            coverCache.clear();
                        }
                        coverCache.set(track.id, coverUrl);
                        setCoverSrc(coverUrl);
                    });
                    return;
                }
                if (coverCache.size > 20) {
                    coverCache.clear();
                }
                coverCache.set(track.id, dataUrl);
                setCoverSrc(dataUrl);
            });
            return;
        }
        hideCover();
    };

    lyricsButton.addEventListener('click', () => {
        lyricsShown = !lyricsShown;
        lyricCard.hidden = !lyricsShown;
        updateLyricsButton();
        updateCoverVisibility();
        stage?.poke();
        // 歌词卡藏/露直接决定水滴呈现条件，跟着 poke 一次。
        lyricDrops?.poke();
    });

    stage = new VisualStage(canvas, cover, {
        getAnalyser,
        isPlaying: () => getCurrentState().playing,
        // 0.1.85：每次现读存储，我的页雨窗改动不用重进播放页就生效。
        getToggles: () => loadVisualToggles(),
        getCoverImage: () => (cover.complete && cover.naturalWidth > 0 ? cover : null)
    });

    const updateDegradedNote = (): void => {
        degradedNote.hidden = !(
            getAnalyser() === null &&
            (toggles.particles || toggles.pulse)
        );
    };
    updateDegradedNotePage = updateDegradedNote;

    const updateProgress = (state: PlaybackState): void => {
        if (!state.track) {
            progressFill.style.width = '0%';
            timeCurrent.textContent = '0:00';
            timeTotal.textContent = '0:00';
            return;
        }
        const totalMs = state.duration;
        const currentMs = state.currentTime * 1000;
        const percent = totalMs > 0 ? Math.min(100, (currentMs / totalMs) * 100) : 0;
        progressFill.style.width = `${percent.toFixed(1)}%`;
        timeCurrent.textContent = formatTime(state.currentTime);
        timeTotal.textContent = totalMs > 0 ? formatTime(totalMs / 1000) : '0:00';
    };

    const refresh = (state: PlaybackState): void => {
        if (state.track) {
            title.textContent = state.track.title;
            artist.textContent = state.track.artist;
            applyCover(state.track);
            updateHeart(state.track);
            updateQualityBadge(state.track);
        } else {
            title.textContent = '还没播放任何歌曲';
            artist.textContent = '';
            applyCover(null);
            updateHeart(null);
            updateQualityBadge(null);
        }
        if (state.playing) {
            // 暂停不用 ⏸ 字符：三星会把它画成黄底 emoji，U+FE0E 也压不住，
            // 改用 CSS 画两条白杠，字体再也插不了手。
            playPauseButton.innerHTML = '<span class="player-pause-bars"><i></i><i></i></span>';
            playPauseButton.classList.add('is-bars');
        } else {
            playPauseButton.textContent = '▶︎';
            playPauseButton.classList.remove('is-bars');
        }
        updateProgress(state);
        updateDegradedNote();
    };
    refreshPage = refresh;

    // 双向歌词模糊＋透明度层次（策略在 lyric-blur.ts）：按当前行查表给
    // 每行赋 filter: blur() 与 opacity，值没变的项不重复写 style，免得
    // 每次进度回调都重启动画。0.1.136 起层次主力是透明度梯度、模糊只留
    // 小半径景深（邻行留字形能读）。关开关／纯文本词／折叠态／用户手动
    // 浏览时 blur 归零、opacity 一律回 1。
    let userBrowsingLyrics = false;
    let lyricTouching = false;
    let lyricSettleTimer: number | null = null;
    let lastAutoScrollAt = 0;
    // 辉光（0.1.131）：当前正在发光的词 span，切词/切行/关开关时摘掉。
    let currentGlowWord: HTMLElement | null = null;
    const clearLyricGlow = (): void => {
        lyricBox.querySelectorAll('.player-lyric-word.is-glowing').forEach((word) => {
            word.classList.remove('is-glowing');
            (word as HTMLElement).style.removeProperty('--glow');
        });
        currentGlowWord = null;
    };
    const applyLyricBlur = (): void => {
        const children = lyricBox.querySelectorAll<HTMLElement>('.player-lyric-line');
        const plain = lyricBox.classList.contains('is-plain');
        const active =
            lyricBlurEnabled && !plain && !lyricsFolded && !userBrowsingLyrics && lyricLines.length > 0;
        let radii: number[] = [];
        if (active) {
            // 前奏尚无当前行：以首行为焦点（首行清晰、其余走待唱曲线）；
            // 播完末行后当前行就是末行，分布自然保留，不会全糊。
            const highlighted = new Set<number>([currentLineIndex >= 0 ? currentLineIndex : 0]);
            radii = computeBlurRadiiByIntensity(
                lyricLines.length,
                highlighted,
                lyricBlurIntensity
            );
        }
        // 透明度梯度的焦点与模糊同一行（前奏无当前行时同样以首行为焦点）。
        const focusIndex = currentLineIndex >= 0 ? currentLineIndex : 0;
        children.forEach((child, childIndex) => {
            const radius = active ? (radii[childIndex] ?? 0) : 0;
            // dataset 记上次赋的整数半径，相同就不碰 style。
            if (child.dataset.blur !== String(radius)) {
                child.dataset.blur = String(radius);
                child.style.filter = radius > 0 ? `blur(${radius}px)` : '';
            }
            // 透明度同理走 dataset 防重复写；非激活态恒 1（清掉内联值）。
            const opacity = active ? lyricOpacityForOffset(childIndex - focusIndex) : 1;
            if (child.dataset.lyricOpacity !== String(opacity)) {
                child.dataset.lyricOpacity = String(opacity);
                child.style.opacity = opacity === 1 ? '' : String(opacity);
            }
        });
    };
    // 间奏呼吸点（0.1.136）：长间奏/前奏没词唱时，卡底部中央浮三点填
    // 空白。在既有 onTimeUpdate 里按 positionMs 算，不新开定时器。
    // 显示用闩锁：remaining（距下一行开始）≥3500 且已进入当前行满
    // 2000ms（前奏 index=-1 直接算满足）时点亮闩锁；闩上后 remaining
    // 跌进 3000 内转倒计时逐个亮（>2000 亮 1、>1000 亮 2、≤1000 亮 3），
    // 下一行开始（remaining≤0）或折叠/关页/无词时灭。闩锁是必要的：
    // 只看 remaining≥3500 的话，倒计时段（≤3000）永远显示不出来。
    let interludeLatched = false;
    let interludeShown = false;
    let interludeLitCount = -1;
    const hideInterlude = (): void => {
        interludeLatched = false;
        if (!interludeShown && interludeLitCount === 0) {
            return;
        }
        interludeShown = false;
        interludeLitCount = 0;
        lyricInterlude.hidden = true;
        lyricInterlude.classList.remove('is-countdown');
        interludeDots.forEach((dot) => dot.classList.remove('is-lit'));
    };
    const updateInterlude = (positionMs: number): void => {
        // 跳动关时只停脉动、点亮逻辑保留（与 CSS 的减动效口径分开管）。
        lyricInterlude.classList.toggle('no-pulse', !lyricBounceEnabled);
        let lit = 0;
        let show = false;
        const pageVisible = overlay !== null && !overlay.hidden;
        if (pageVisible && !lyricsFolded && lyricLines.length > 0) {
            const nextLine = lyricLines[currentLineIndex + 1];
            const nextStart = nextLine ? nextLine.timeMs : Number.NaN;
            if (Number.isFinite(nextStart)) {
                const remaining = nextStart - positionMs;
                const currentLine = currentLineIndex >= 0 ? lyricLines[currentLineIndex] : undefined;
                const entered =
                    currentLineIndex < 0 ||
                    (currentLine !== undefined &&
                        Number.isFinite(currentLine.timeMs) &&
                        positionMs - currentLine.timeMs >= 2000);
                if (remaining >= 3500 && entered) {
                    interludeLatched = true;
                }
                if (remaining <= 0 || !entered) {
                    interludeLatched = false;
                }
                show = interludeLatched;
                if (show) {
                    lit = remaining > 3000 ? 0 : remaining > 2000 ? 1 : remaining > 1000 ? 2 : 3;
                }
            } else {
                interludeLatched = false;
            }
        } else {
            interludeLatched = false;
        }
        if (show === interludeShown && lit === interludeLitCount) {
            return;
        }
        interludeShown = show;
        interludeLitCount = lit;
        lyricInterlude.hidden = !show;
        // 倒计时段停掉脉动，只留逐个点亮，读秒才读得清。
        lyricInterlude.classList.toggle('is-countdown', show && lit > 0);
        interludeDots.forEach((dot, dotIndex) => {
            dot.classList.toggle('is-lit', show && dotIndex < lit);
        });
    };
    // 手动浏览暂停：手指/滚轮动歌词盒即暂停模糊（行色区分保留），
    // 手离开且滚动静止满 1 秒才按当前行恢复。程序自动跟随的滚动
    // 在 highlightLine 里打时间戳，scroll 事件按时间戳忽略，
    // 不会误触发暂停（自动滚动事件与手势滚动在来源上分开）。
    const scheduleBlurResume = (): void => {
        if (lyricSettleTimer !== null) {
            window.clearTimeout(lyricSettleTimer);
        }
        lyricSettleTimer = window.setTimeout(() => {
            lyricSettleTimer = null;
            if (!lyricTouching) {
                userBrowsingLyrics = false;
                applyLyricBlur();
            }
        }, 1000);
    };
    const beginBrowsing = (): void => {
        if (!userBrowsingLyrics) {
            userBrowsingLyrics = true;
            applyLyricBlur();
        }
        scheduleBlurResume();
    };
    lyricBox.addEventListener('pointerdown', () => {
        lyricTouching = true;
        beginBrowsing();
    });
    window.addEventListener('pointerup', () => {
        if (lyricTouching) {
            lyricTouching = false;
            scheduleBlurResume();
        }
    });
    lyricBox.addEventListener('wheel', beginBrowsing, { passive: true });
    lyricBox.addEventListener('scroll', () => {
        if (!userBrowsingLyrics) {
            return;
        }
        // 自动跟随滚动刚发生的那一下不算用户滚动，别把恢复计时一直顶回去。
        if (Date.now() - lastAutoScrollAt < 800) {
            return;
        }
        scheduleBlurResume();
    });

    const renderLyrics = (note: string | null): void => {
        lastLyricNote = note;
        // 新一首的词（或无词提示）进来先把间奏点复位，下一拍再按新词算。
        hideInterlude();
        lyricBox.textContent = '';
        if (note) {
            const noteEl = document.createElement('p');
            noteEl.className = 'player-lyric-note';
            lyricBox.appendChild(noteEl);
            noteEl.textContent = note;
        }
        lyricLines.forEach((line, index) => {
            const lineEl = document.createElement('p');
            lineEl.className = 'player-lyric-line';
            lineEl.dataset.index = String(index);
            // 只展示，不绑点击、不做跳转。定时行按词分 span（真逐字或
            // 行内均分近似），纯文本行保持整行文本。
            const nextStart =
                index + 1 < lyricLines.length ? lyricLines[index + 1]!.timeMs : null;
            const words = Number.isFinite(line.timeMs)
                ? approximateWords(line, nextStart)
                : [];
            if (words.length > 0) {
                // 和声（0.1.131）：bg 词挂 .is-bg（更淡更小），整行皆 bg
                // 时行也挂类；CJK 词挂 .is-cjk 供辉光判定（与 lyrics.ts
                // 的 CJK 口径同范围）。词起止写进 dataset，进度回调里
                // 算逐词进度用，不另存一份状态。
                let allBg = true;
                for (const word of words) {
                    const wordEl = document.createElement('span');
                    wordEl.className = 'player-lyric-word';
                    wordEl.dataset.start = String(word.startMs);
                    wordEl.dataset.duration = String(word.durationMs);
                    if (word.bg) {
                        wordEl.classList.add('is-bg');
                    } else {
                        allBg = false;
                    }
                    if (/[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(word.text)) {
                        wordEl.classList.add('is-cjk');
                    }
                    wordEl.textContent = word.text;
                    lineEl.appendChild(wordEl);
                }
                if (allBg) {
                    lineEl.classList.add('is-bg-line');
                }
            } else {
                lineEl.textContent = line.text;
            }
            // 译文副行：正文下方小字，只展示、不参与逐字高亮；
            // 关「显示译文」时不渲染（数据仍挂在行上，重开即回来）。
            if (showTranslation && line.translation) {
                const transEl = document.createElement('span');
                transEl.className = 'player-lyric-translation';
                transEl.textContent = line.translation;
                lineEl.appendChild(transEl);
            }
            lyricBox.appendChild(lineEl);
        });
        // 纯文本词没有可居中的当前行：去 spacer padding，从顶正常排，
        // 否则首行被顶到卡片中央、上面空一半；上一首定时词留下的滚动位置也要清零。
        // 半定时半纯文本按定时算（some 有限时间即定时，往安全方向）。
        const timed = lyricLines.some((line) => Number.isFinite(line.timeMs));
        lyricBox.classList.toggle('is-plain', lyricLines.length > 0 && !timed);
        lyricBox.scrollTop = 0;
        currentLineIndex = -1;
        currentSungWord = -1;
        // 折叠条默认露首行；纯文本没有当前行，条就一直是首行。
        lyricBar.textContent = lyricLines[0]?.text ?? '';
        if (lyricLines.length === 0) {
            // 无词：不露折叠钮，卡片保持展开只显示提示，不改存档偏好。
            foldButton.hidden = true;
            applyFoldState(false, false);
        } else {
            foldButton.hidden = false;
            applyFoldState(lyricsFolded, false);
        }
        // 新词渲染完按当前行（此时多半还是 -1，走前奏分布）刷一遍模糊。
        applyLyricBlur();
    };
    renderLyricsPage = renderLyrics;

    const highlightLine = (index: number, behavior: ScrollBehavior = 'smooth'): void => {
        const children = lyricBox.querySelectorAll('.player-lyric-line');
        children.forEach((child, childIndex) => {
            child.classList.toggle('is-active', childIndex === index);
        });
        // 切行时清掉上一行的逐字高亮，下一 tick 的词更新再重算。
        lyricBox.querySelectorAll('.player-lyric-word.is-sung').forEach((word) => {
            word.classList.remove('is-sung');
        });
        currentSungWord = -1;
        // 辉光同理：上一行没唱完的词不许把光带到下一行。
        clearLyricGlow();
        // 当前行变了，模糊分布跟着换（半径没变的行不会重复写 style）。
        applyLyricBlur();
        if (index < 0) {
            return;
        }
        const active = children[index] as HTMLElement | undefined;
        if (!active) {
            return;
        }
        if (lyricsFolded) {
            // 折叠时不滚，只更新单行条；展开时 applyFoldState 会用 auto 复位。
            lyricBar.textContent = lyricLines[index]?.text ?? '';
            return;
        }
        // 手动居中：scrollIntoView 会连带滚外层播放页，只滚歌词盒本身。
        // 打时间戳让歌词盒的 scroll 监听认出这是程序滚动，不触发模糊暂停。
        lastAutoScrollAt = Date.now();
        lyricBox.scrollTo({
            top: active.offsetTop - lyricBox.clientHeight / 2 + active.offsetHeight / 2,
            behavior
        });
    };
    highlightLinePage = highlightLine;

    // 折叠状态机：展开时若已有当前行，用 auto 一步复位居中，
    // 不让用户看到从旧位置平滑扫过去；renderLyrics 调时 currentLineIndex
    // 已是 -1，不会误触。
    const applyFoldState = (folded: boolean, persist: boolean): void => {
        lyricsFolded = folded;
        lyricCard.dataset.folded = folded ? 'true' : 'false';
        lyricBarWrap.inert = !folded;
        lyricCollapse.inert = folded;
        foldButton.setAttribute('aria-expanded', folded ? 'false' : 'true');
        foldButton.setAttribute('aria-label', folded ? '展开歌词' : '折叠歌词');
        if (persist) {
            try {
                localStorage.setItem(FOLD_KEY, folded ? '1' : '0');
            } catch {
                // 存档写不进就当次有效，下次默认展开。
            }
        }
        if (!folded && currentLineIndex >= 0) {
            highlightLine(currentLineIndex, 'auto');
        }
        // 折叠态不加模糊、展开恢复分布；highlightLine 已刷过时这里是空转。
        applyLyricBlur();
        // 折叠/展开是水滴呈现条件之一：折叠停画藏层，展开按档位恢复。
        lyricDrops?.poke();
    };
    foldButton.addEventListener('click', () => {
        applyFoldState(!lyricsFolded, true);
    });
    lyricBar.addEventListener('click', () => {
        applyFoldState(false, true);
    });

    window.addEventListener('resize', () => {
        if (!page.hidden) {
            stage?.resize();
            // 卡尺寸变了水滴要重播种/重采透镜底图。
            lyricDrops?.resize();
        }
    });

    // 壁纸跟随不依赖播放页是否打开：页关了仍要推状态，歌词也照常拉取；
    // 只有 DOM 刷新（标题、歌词渲染、高亮滚动、画布）才要求页可见。
    onTrackChange((state) => {
        const visible = overlay !== null && !overlay.hidden;
        if (visible) {
            refresh(state);
            stage?.poke();
            // 剑来只在切歌且播放页打开时出鞘，开关关着时 triggerSword 直接空转。
            if (state.track) {
                stage?.triggerSword();
            }
        }
        const generation = ++lyricGeneration;
        const track = state.track;
        if (!track) {
            clearLyricLines();
            if (visible) {
                renderLyrics('还没播放任何歌曲，点一首歌开始播放。');
            }
            void pushWallpaperState();
            return;
        }
        void fetchLyrics(track).then((result) => {
            if (generation !== lyricGeneration) {
                return;
            }
            setLyricLinesFromSource(result.lines);
            if (overlay !== null && !overlay.hidden) {
                renderLyrics(result.note);
            }
            void pushWallpaperState();
        });
        void pushWallpaperState();
    });

    onTimeUpdate((state) => {
        // 进度与睡眠剩余不依赖页是否可见：页关了重开时状态也是对的。
        updateProgress(state);
        updateSleepRemaining();
        const index = findCurrentLineIndex(lyricLines, state.currentTime * 1000);
        if (index !== currentLineIndex) {
            currentLineIndex = index;
            if (overlay !== null && !overlay.hidden) {
                highlightLine(index);
            }
            void pushWallpaperState();
        }
        // 间奏呼吸点跟同一拍走：内部按页可见/折叠/下一行时间自判显隐。
        updateInterlude(state.currentTime * 1000);
        // 逐字高亮：只动当前行的词 span，唱到的词边界变了才改 DOM。
        if (overlay !== null && !overlay.hidden && currentLineIndex >= 0) {
            const positionMs = state.currentTime * 1000;
            const children = lyricBox.querySelectorAll('.player-lyric-line');
            const active = children[currentLineIndex] as HTMLElement | undefined;
            const words = active?.querySelectorAll('.player-lyric-word');
            if (words && words.length > 0) {
                let sung = -1;
                words.forEach((wordEl, wordIndex) => {
                    if (Number(wordEl.getAttribute('data-start')) <= positionMs) {
                        sung = wordIndex;
                    }
                });
                if (sung !== currentSungWord) {
                    currentSungWord = sung;
                    words.forEach((wordEl, wordIndex) => {
                        wordEl.classList.toggle('is-sung', wordIndex <= sung);
                    });
                }
                // 辉光（0.1.131，借鉴 AM++ 的 CJK 长尾辉光口径）：正在唱
                // 的那个 CJK 词按自身时间进度发光——进度 = (当前位置 −
                // 词始) / 词时长，钳 0..1，写进 --glow 喂 CSS 的
                // text-shadow 强度；词时长经末词补偿后末词也能完整亮满
                // 不被截断。非 CJK 词不发光（保持现有填充色）。同一时刻
                // 只亮一个词（和声与主声时间重叠时取 DOM 里靠后的），
                // 和声词照亮但 CSS 里强度减半。切词时旧词的光立即摘掉；
                // 跨行扫光在逐词 span 的连续高亮下天然衔接，不另设机制。
                // 译文副行不是 .player-lyric-word，不参与辉光。
                let glowTarget: HTMLElement | null = null;
                let glowProgress = 0;
                if (lyricGlowEnabled) {
                    for (const wordEl of words) {
                        const el = wordEl as HTMLElement;
                        if (!el.classList.contains('is-cjk')) {
                            continue;
                        }
                        const start = Number(el.dataset.start);
                        const duration = Number(el.dataset.duration ?? 0);
                        if (!Number.isFinite(start)) {
                            continue;
                        }
                        if (
                            start <= positionMs &&
                            (duration <= 0 || positionMs < start + duration)
                        ) {
                            glowTarget = el;
                            glowProgress =
                                duration > 0
                                    ? Math.min(1, Math.max(0, (positionMs - start) / duration))
                                    : 1;
                        }
                    }
                }
                if (glowTarget !== currentGlowWord) {
                    if (currentGlowWord) {
                        currentGlowWord.classList.remove('is-glowing');
                        currentGlowWord.style.removeProperty('--glow');
                    }
                    currentGlowWord = glowTarget;
                    if (currentGlowWord) {
                        currentGlowWord.classList.add('is-glowing');
                    }
                }
                if (currentGlowWord) {
                    currentGlowWord.style.setProperty('--glow', glowProgress.toFixed(2));
                }
            }
        }
    });

    return page;
}

function refreshFromState(state: PlaybackState): void {
    if (!overlay) {
        return;
    }
    refreshPage?.(state);
    const renderLyrics = renderLyricsPage;
    stage?.poke();
    const generation = ++lyricGeneration;
    const track = state.track;
    if (!track || !renderLyrics) {
        clearLyricLines();
        renderLyrics?.('还没播放任何歌曲，点一首歌开始播放。');
        return;
    }
    void fetchLyrics(track).then((result) => {
        if (generation !== lyricGeneration || !overlay || overlay.hidden) {
            return;
        }
        setLyricLinesFromSource(result.lines);
        renderLyrics(result.note);
        const index = findCurrentLineIndex(lyricLines, getCurrentState().currentTime * 1000);
        currentLineIndex = index;
        // 重开页直接定位，不平滑扫过去。
        highlightLinePage?.(index, 'auto');
        void pushWallpaperState();
    });
    void pushWallpaperState();
}

function updateDegradedNote(): void {
    updateDegradedNotePage?.();
}

async function pushWallpaperState(): Promise<void> {
    const state = getCurrentState();
    try {
        await setWallpaperState({
            trackTitle: state.track?.title ?? '',
            trackArtist: state.track?.artist ?? '',
            playing: state.playing,
            positionMs: Math.round(state.currentTime * 1000),
            lyricLines: lyricLines.map((line) => line.text),
            currentLineIndex,
            toggles
        });
    } catch {
        // 浏览器预览或插件不可用时不中断播放页。
    }
}
