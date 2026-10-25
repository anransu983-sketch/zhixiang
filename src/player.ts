// 播放页（第 8 块，全新写）：全屏播放页，参考另一 App 的全屏播放页布局。
//
// 布局（自上而下）：返回按钮 → 居中大歌词（默认显示）→ 歌名/歌手 →
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
import { fetchLyrics, findCurrentLineIndex } from './lyrics';
import type { LyricLine } from './lyrics';
import { openLiveWallpaperPicker, setWallpaperState } from './native/wallpaper-plugin';
import { loadVisualToggles, saveVisualToggles, VisualStage } from './visuals';
import type { VisualToggles } from './visuals';
import { getLocalCoverDataUrl } from './sources/local';
import { getLastYtmStreamMeta } from './sources/ytm';
import type { Track } from './types';

let overlay: HTMLElement | null = null;
let stage: VisualStage | null = null;
let refreshPage: ((state: PlaybackState) => void) | null = null;
let renderLyricsPage: ((note: string | null) => void) | null = null;
let highlightLinePage: ((index: number) => void) | null = null;
let updateDegradedNotePage: (() => void) | null = null;
let toggles: VisualToggles = loadVisualToggles();
let lyricLines: LyricLine[] = [];
let currentLineIndex = -1;
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
        stage?.resize();
        stage?.resume();
        return;
    }
    overlay = buildPlayerPage();
    document.body.appendChild(overlay);
    refreshFromState(getCurrentState());
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

    // 中央区：歌词（默认显示）与大封面（二选一，词隐藏时显示封面）。
    const lyricBox = document.createElement('div');
    lyricBox.className = 'player-lyrics';
    content.appendChild(lyricBox);

    const cover = document.createElement('img');
    cover.className = 'player-cover';
    cover.alt = '封面';
    cover.hidden = true;
    content.appendChild(cover);

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
    prevButton.textContent = '⏮';
    prevButton.addEventListener('click', () => {
        void previous();
    });
    const playPauseButton = document.createElement('button');
    playPauseButton.type = 'button';
    playPauseButton.className = 'player-icon-btn is-main';
    playPauseButton.textContent = '▶';
    playPauseButton.addEventListener('click', () => {
        void togglePlay();
    });
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'player-icon-btn';
    nextButton.textContent = '⏭';
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
    repeatGlyph.textContent = '↻';
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
        if (!track) {
            heartButton.classList.remove('is-active');
            return;
        }
        heartButton.classList.toggle('is-active', loadFavorites().has(favoriteKey(track)));
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

    bottomRow.append(repeatButton, heartButton, sleepButton, lyricsButton, qualityBadge);
    content.appendChild(bottomRow);
    content.appendChild(sleepPicker);

    // 可折叠「视觉」区：四项开关 + 设壁纸（默认收起）。
    const visualsButton = document.createElement('button');
    visualsButton.type = 'button';
    visualsButton.className = 'player-visuals-btn';
    visualsButton.textContent = '视觉 ▾';
    content.appendChild(visualsButton);

    const toggleBox = document.createElement('div');
    toggleBox.className = 'player-toggles';
    toggleBox.hidden = true;
    const toggleHeading = document.createElement('h3');
    toggleHeading.textContent = '视觉';
    toggleBox.appendChild(toggleHeading);
    const toggleDefs: { key: keyof VisualToggles; label: string }[] = [
        { key: 'rain', label: '雨滴玻璃（默认开）' },
        { key: 'particles', label: '粒子舞台' },
        { key: 'pulse', label: '节奏脉动' },
        { key: 'stars', label: '氛围星空' }
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
        toggleBox.appendChild(label);
    }

    const degradedNote = document.createElement('p');
    degradedNote.className = 'player-note';
    degradedNote.hidden = true;
    degradedNote.textContent =
        '频谱不可用：粒子与脉动当前为氛围降级模式，不跟随真实频谱。';
    toggleBox.appendChild(degradedNote);

    const wallpaperButton = document.createElement('button');
    wallpaperButton.type = 'button';
    wallpaperButton.className = 'player-wallpaper-btn';
    wallpaperButton.textContent = '设为系统壁纸';
    toggleBox.appendChild(wallpaperButton);

    const wallpaperNotice = document.createElement('p');
    wallpaperNotice.className = 'player-note';
    wallpaperNotice.hidden = true;
    toggleBox.appendChild(wallpaperNotice);

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
    content.appendChild(toggleBox);

    visualsButton.addEventListener('click', () => {
        toggleBox.hidden = !toggleBox.hidden;
        visualsButton.textContent = toggleBox.hidden ? '视觉 ▾' : '视觉 ▴';
    });

    // 封面：元素一直挂着（模糊底要靠它），是否显示由 updateCoverVisibility 定；
    // 加载完成才显示，加载失败隐藏，不露破图与 alt 文字。
    let coverExpected = '';
    let coverLoaded = false;
    let coverForTrackId: string | null = null;
    const coverCache = new Map<string, string>();
    const updateCoverVisibility = (): void => {
        const show = !lyricsShown && coverLoaded && coverExpected !== '';
        cover.hidden = !show;
        cover.classList.toggle('player-cover-large', show);
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
        if (!track || !track.coverUrl) {
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
            void getLocalCoverDataUrl(albumId).then((dataUrl) => {
                if (track.id !== coverForTrackId) {
                    return;
                }
                if (!dataUrl) {
                    hideCover();
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
        lyricBox.hidden = !lyricsShown;
        updateLyricsButton();
        updateCoverVisibility();
        stage?.poke();
    });

    stage = new VisualStage(canvas, cover, {
        getAnalyser,
        isPlaying: () => getCurrentState().playing,
        getToggles: () => toggles,
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
        playPauseButton.textContent = state.playing ? '⏸' : '▶';
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
            // 只展示，不绑点击、不做跳转。
            lineEl.textContent = line.text;
            lyricBox.appendChild(lineEl);
        });
        currentLineIndex = -1;
    };
    renderLyricsPage = renderLyrics;

    const highlightLine = (index: number): void => {
        const children = lyricBox.querySelectorAll('.player-lyric-line');
        children.forEach((child, childIndex) => {
            child.classList.toggle('is-active', childIndex === index);
        });
        if (index >= 0) {
            const active = children[index] as HTMLElement | undefined;
            active?.scrollIntoView({ block: 'center' });
        }
    };
    highlightLinePage = highlightLine;

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
        highlightLinePage?.(index);
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
