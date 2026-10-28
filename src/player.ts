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
    setRepeatMode,
    togglePlay
} from './playback';
import type { PlaybackState, RepeatMode } from './playback';
import { approximateWords, fetchLyrics, findCurrentLineIndex } from './lyrics';
import type { LyricLine } from './lyrics';
import { openLiveWallpaperPicker, setWallpaperState } from './native/wallpaper-plugin';
import { loadVisualToggles, saveVisualToggles, VisualStage } from './visuals';
import type { VisualToggles } from './visuals';
import { getLocalCoverDataUrl, getLocalCoverFromNetease, getLocalSidecarCoverDataUrl } from './sources/local';
import { posterFallbackBackground, posterHue } from './posters';
import { getLastYtmStreamMeta } from './sources/ytm';
import type { Track } from './types';

let overlay: HTMLElement | null = null;
let stage: VisualStage | null = null;
let refreshPage: ((state: PlaybackState) => void) | null = null;
let renderLyricsPage: ((note: string | null) => void) | null = null;
let highlightLinePage: ((index: number, behavior?: ScrollBehavior) => void) | null = null;
let updateDegradedNotePage: (() => void) | null = null;
let toggles: VisualToggles = loadVisualToggles();
let lyricLines: LyricLine[] = [];
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

export function openPlayerPage(): void {
    if (overlay) {
        overlay.hidden = false;
        // 重开也要刷新：页关着时切过歌，标题/收藏/角标/歌词都会 stale，
        // 只 unhide 不刷新就是截图里那种标题还是旧文案的样子。
        refreshFromState(getCurrentState());
        stage?.resize();
        stage?.resume();
        return;
    }
    overlay = buildPlayerPage();
    document.body.appendChild(overlay);
    refreshFromState(getCurrentState());
    stage?.resize();
    stage?.resume();
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
        page.hidden = true;
        stage?.suspend();
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
    lyricCard.append(foldButton, lyricBarWrap, lyricCollapse);
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

    // 封面套：img 与占位共用；img 一直挂着（模糊底要靠它），
    // 是否显示由 updateCoverVisibility 定，无图时露占位不露破图。
    const coverWrap = document.createElement('div');
    coverWrap.className = 'player-cover-wrap';
    coverWrap.hidden = true;
    const cover = document.createElement('img');
    cover.className = 'player-cover';
    cover.alt = '封面';
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

    // 底排：循环 / 收藏 / 睡眠定时 / 词 / 音质角标。
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
    const repeatOrder: RepeatMode[] = ['off', 'queue', 'one'];
    const repeatLabelText: Record<RepeatMode, string> = {
        off: '关',
        queue: '循环',
        one: '单曲'
    };
    const updateRepeatButton = (): void => {
        const mode = getRepeatMode();
        repeatLabel.textContent = repeatLabelText[mode];
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
    bottomRow.append(repeatButton, heartButton, sleepButton, lyricsButton, qualityBadge, visualEntry);
    content.appendChild(bottomRow);
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
    for (const rainDef of rainModes) {
        const label = document.createElement('label');
        label.className = 'player-toggle';
        const box = document.createElement('input');
        box.type = 'radio';
        box.name = 'zx-player-rain-mode';
        box.checked = toggles.rainMode === rainDef.mode;
        box.addEventListener('change', () => {
            if (!box.checked) {
                return;
            }
            toggles = { ...toggles, rainMode: rainDef.mode };
            saveVisualToggles(toggles);
            stage?.poke();
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
        updateCoverVisibility();
    };
    const hideCover = (): void => {
        cover.removeAttribute('src');
        coverExpected = '';
        coverLoaded = false;
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

    const renderLyrics = (note: string | null): void => {
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
                for (const word of words) {
                    const wordEl = document.createElement('span');
                    wordEl.className = 'player-lyric-word';
                    wordEl.dataset.start = String(word.startMs);
                    wordEl.textContent = word.text;
                    lineEl.appendChild(wordEl);
                }
            } else {
                lineEl.textContent = line.text;
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
            lyricLines = [];
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
            lyricLines = result.lines;
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
        lyricLines = [];
        renderLyrics?.('还没播放任何歌曲，点一首歌开始播放。');
        return;
    }
    void fetchLyrics(track).then((result) => {
        if (generation !== lyricGeneration || !overlay || overlay.hidden) {
            return;
        }
        lyricLines = result.lines;
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
