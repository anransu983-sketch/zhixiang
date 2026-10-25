// 首页组装：按音源注册表渲染各音源的浏览区，尚未实现的块留在清单里。
// 本文件只做组装与界面接线，不放音源与播放逻辑。

import { getCurrentState, next, onTrackChange, playQueue, previous, togglePlay } from './playback';
import type { PlaybackState } from './playback';
import { SOURCES } from './sources/index';
import { getLocalNotice } from './sources/local';
import type { AudioSource, Track } from './types';

const UPCOMING = [
    '首页海报墙',
    '3D 歌单架',
    '歌词动态壁纸 · 雨滴玻璃 · 粒子舞台 · 节奏脉动 · 氛围星空'
];

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

export function renderHome(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'home';

    const title = document.createElement('h1');
    title.textContent = '芷湘';
    section.appendChild(title);

    const hint = document.createElement('p');
    hint.textContent = '全新重做版，首版功能正在一块一块接上来。';
    section.appendChild(hint);

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

    for (const source of SOURCES) {
        section.appendChild(renderSourceSection(source, status));
    }

    const upcomingTitle = document.createElement('h2');
    upcomingTitle.textContent = '即将接上';
    section.appendChild(upcomingTitle);

    const list = document.createElement('ul');
    list.className = 'feature-list';
    for (const name of UPCOMING) {
        const item = document.createElement('li');
        item.textContent = name;
        list.appendChild(item);
    }
    section.appendChild(list);

    return section;
}

function renderSourceSection(source: AudioSource, status: HTMLElement): HTMLElement {
    const block = document.createElement('div');
    block.className = 'source-section';

    const heading = document.createElement('h2');
    heading.textContent = source.label;
    block.appendChild(heading);

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = `在${source.label}里搜索歌曲、歌手或专辑`;
    search.className = 'source-search';
    block.appendChild(search);

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
        void refresh(search.value);
    });
    void refresh('');

    return block;
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

        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.className = 'track-play';
        playButton.textContent = '播放';
        playButton.addEventListener('click', () => {
            void (async () => {
                try {
                    // 点一首即把该区当前列表作为队列，从点中的这首起播。
                    await playQueue(tracks, index);
                    status.textContent = `正在播放：${track.title} — ${track.artist}`;
                } catch (error) {
                    status.textContent = friendlyPlayError(error);
                }
            })();
        });
        item.appendChild(playButton);

        list.appendChild(item);
    }
}
