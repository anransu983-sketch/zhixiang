// 播放页（第 8 块，全新写）：简单播放页视图，不重做首页。
//
// 进入方式：首页正在播放条上的「打开播放页」按钮。播放页是盖在首页上的
// 一层视图，点「返回」关闭，不改首页结构与顺序。
// 内容：封面 + 歌名/歌手 + 歌词区 + 视觉画布 + 四项视觉开关 +
// 「设为系统壁纸」按钮。歌词行只展示，不绑点击、不做跳转。
//
// 状态来源：只用第 5 块已有的 onTrackChange / onTimeUpdate /
// getCurrentState / getAnalyser，不新增播放引擎口子。
// 壁纸跟随：切歌、播放/暂停变化、歌词行变化时把状态推给原生插件，
// 壁纸引擎读 SharedPreferences 跟随；播放停止后壁纸侧自行闲置。

import {
    getAnalyser,
    getCurrentState,
    next,
    onTrackChange,
    onTimeUpdate,
    previous,
    togglePlay
} from './playback';
import type { PlaybackState } from './playback';
import { fetchLyrics, findCurrentLineIndex } from './lyrics';
import type { LyricLine } from './lyrics';
import { openLiveWallpaperPicker, setWallpaperState } from './native/wallpaper-plugin';
import { loadVisualToggles, saveVisualToggles, VisualStage } from './visuals';
import type { VisualToggles } from './visuals';

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

    const cover = document.createElement('img');
    cover.className = 'player-cover';
    cover.alt = '封面';
    content.appendChild(cover);

    const title = document.createElement('h2');
    title.className = 'player-title';
    title.textContent = '还没播放任何歌曲';
    content.appendChild(title);

    const artist = document.createElement('p');
    artist.className = 'player-artist';
    content.appendChild(artist);

    const degradedNote = document.createElement('p');
    degradedNote.className = 'player-note';
    degradedNote.hidden = true;
    degradedNote.textContent =
        '频谱不可用：粒子与脉动当前为氛围降级模式，不跟随真实频谱。';
    content.appendChild(degradedNote);

    const controls = document.createElement('div');
    controls.className = 'player-controls';
    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.textContent = '上一首';
    prevButton.addEventListener('click', () => {
        void previous();
    });
    const playPauseButton = document.createElement('button');
    playPauseButton.type = 'button';
    playPauseButton.textContent = '播放';
    playPauseButton.addEventListener('click', () => {
        void togglePlay();
    });
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.textContent = '下一首';
    nextButton.addEventListener('click', () => {
        void next();
    });
    controls.append(prevButton, playPauseButton, nextButton);
    content.appendChild(controls);

    const lyricBox = document.createElement('div');
    lyricBox.className = 'player-lyrics';
    content.appendChild(lyricBox);

    const toggleBox = document.createElement('div');
    toggleBox.className = 'player-toggles';
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
    content.appendChild(toggleBox);

    const wallpaperButton = document.createElement('button');
    wallpaperButton.type = 'button';
    wallpaperButton.className = 'player-wallpaper-btn';
    wallpaperButton.textContent = '设为系统壁纸';
    content.appendChild(wallpaperButton);

    const wallpaperNotice = document.createElement('p');
    wallpaperNotice.className = 'player-note';
    wallpaperNotice.hidden = true;
    content.appendChild(wallpaperNotice);

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

    const refresh = (state: PlaybackState): void => {
        if (state.track) {
            title.textContent = state.track.title;
            artist.textContent = state.track.artist;
            if (state.track.coverUrl) {
                if (cover.src !== state.track.coverUrl) {
                    cover.src = state.track.coverUrl;
                }
                cover.hidden = false;
            } else {
                cover.removeAttribute('src');
                cover.hidden = true;
            }
        } else {
            title.textContent = '还没播放任何歌曲';
            artist.textContent = '';
            cover.removeAttribute('src');
            cover.hidden = true;
        }
        playPauseButton.textContent = state.playing ? '暂停' : '播放';
        updateDegradedNote();
    };
    refreshPage = refresh;

    const renderLyrics = (note: string | null): void => {
        lyricBox.textContent = '';
        if (note) {
            const noteEl = document.createElement('p');
            noteEl.className = 'player-lyric-note';
            noteEl.textContent = note;
            lyricBox.appendChild(noteEl);
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
