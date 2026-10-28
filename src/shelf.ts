// 3D 歌单架形态（全新写）：海报模块三种形态之一，不再是首页内单独的一区。
// 内容就是海报墙那三路歌单（本地专辑、网易云榜单、YTM 热门专辑），
// 每页只摆本页那一路，不另造数据、不另发请求：直接复用 posters.ts 的
// 加载函数，那里已有成功结果共享缓存，海报墙形态与 3D 架形态调用同一路时只发一次请求。
// 形态只用 CSS 3D（perspective + rotateY），不引入 WebGL 或新依赖，
// 不做拖拽旋转、陀螺仪与复杂动画，只给整体一个轻微倾角。
// 交互：横向滑动浏览（overflow-x 滚动，移动端手势优先）；
// 点一张歌单即 playQueue(该单曲目列表, 0)，与海报墙同款思路；
// 正在播的歌单用 onTrackChange + 曲目 id 匹配做简单高亮。
// 任何一路失败或为空，都只在该层留一句中文提示，不拖垮整架。

import { getCurrentState, onTrackChange, playQueue, seekTo } from './playback';
import type { PlaybackState } from './playback';
import { friendlyPosterError, posterFallbackBackground, posterHue } from './posters';
import type { PosterSectionDefinition } from './posters';
import type { Poster } from './types';

function friendlyPlayError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/[\u4e00-\u9fff]/.test(message)) {
        return message;
    }
    return '播放失败，请确认文件仍在且已授予读取音频文件的权限。';
}

// 单层 3D 架：只渲染一路歌单（本地专辑／网易云榜单／YTM 热门专辑之一），
// 供首页海报模块的 3D 架形态复用；数据仍走 posters.ts 的共享缓存，
// 与海报墙形态调用同一路时只发一次请求。withLabel 为 false 时不画层标题，
// 由海报模块自己的头（标题＋三向切换）统一展示。
export function renderShelfLayer(
    definition: PosterSectionDefinition,
    playNotice: HTMLElement,
    withLabel = true
): HTMLElement {
    const layer = document.createElement('div');
    layer.className = 'shelf-layer';

    if (withLabel) {
        const label = document.createElement('h3');
        label.textContent = definition.label;
        layer.appendChild(label);
    }

    const scroll = document.createElement('div');
    scroll.className = 'shelf-scroll';
    layer.appendChild(scroll);

    // 内层随内容撑宽，架板宽度跟整排歌单走，不只跟屏幕宽走。
    const viewport = document.createElement('div');
    viewport.className = 'shelf-viewport';
    scroll.appendChild(viewport);

    const stage = document.createElement('div');
    stage.className = 'shelf-stage';
    viewport.appendChild(stage);

    // 底部架板：纯 CSS 的一根板子，不用图片素材。
    const board = document.createElement('div');
    board.className = 'shelf-board';
    board.hidden = true;
    viewport.appendChild(board);

    const notice = document.createElement('p');
    notice.className = 'shelf-notice';
    notice.textContent = '正在加载…';
    layer.appendChild(notice);

    // 架内控制条（0.1.101）：搜索收拢＋随机挑歌＋高潮试听，只动本层已加载的歌单，
    // 不另发请求。搜索按标题＋副标题过滤；随机与试听都只在可见歌单里挑。
    const controls = document.createElement('div');
    controls.className = 'shelf-controls';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'shelf-search';
    search.placeholder = '搜这架上的歌单';
    search.setAttribute('aria-label', '搜索歌单');
    const randomButton = document.createElement('button');
    randomButton.type = 'button';
    randomButton.className = 'shelf-btn';
    randomButton.textContent = '随机挑歌';
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'shelf-btn';
    previewButton.textContent = '高潮试听';
    controls.append(search, randomButton, previewButton);
    layer.insertBefore(controls, scroll);

    let loadedPosters: Poster[] = [];
    const visiblePosters = (): Poster[] => {
        const query = search.value.trim().toLowerCase();
        if (!query) {
            return loadedPosters;
        }
        return loadedPosters.filter((poster) =>
            `${poster.title} ${poster.subtitle ?? ''}`.toLowerCase().includes(query));
    };
    const applyFilter = (): void => {
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        for (const [id, record] of records) {
            const poster = postersById.get(id);
            const hit =
                !query ||
                `${poster?.title ?? ''} ${poster?.subtitle ?? ''}`
                    .toLowerCase()
                    .includes(query);
            record.hidden = !hit;
            if (hit) {
                visible += 1;
            }
        }
        // 只在已加载时接管 notice；加载中／失败时 notice 另有用途，不抢。
        if (loadedPosters.length > 0) {
            board.hidden = visible === 0;
            notice.hidden = visible > 0;
            if (visible === 0) {
                notice.textContent = '没有匹配的歌单，换个词试试。';
            }
        }
    };
    search.addEventListener('input', applyFilter);

    const pickRandom = (): { poster: Poster; index: number } | null => {
        const pool = visiblePosters().filter((poster) => poster.tracks.length > 0);
        if (pool.length === 0) {
            return null;
        }
        const poster = pool[Math.floor(Math.random() * pool.length)]!;
        const index = Math.floor(Math.random() * poster.tracks.length);
        return { poster, index };
    };
    const playPicked = (picked: { poster: Poster; index: number } | null, chorus: boolean): void => {
        if (!picked) {
            playNotice.textContent =
                loadedPosters.length === 0
                    ? '这架还没有歌单。'
                    : '没有匹配的歌单，换个词试试。';
            playNotice.hidden = false;
            return;
        }
        void (async () => {
            try {
                await playQueue(picked.poster.tracks, picked.index);
                if (chorus) {
                    // 高潮点按 45% 估算（无副歌检测）；流不支持跳转时从头播。
                    const track = picked.poster.tracks[picked.index];
                    if (track && track.durationMs && track.durationMs > 0) {
                        seekTo((track.durationMs * 0.45) / 1000);
                    }
                }
                playNotice.hidden = true;
            } catch (error) {
                playNotice.textContent = friendlyPlayError(error);
                playNotice.hidden = false;
            }
        })();
    };
    randomButton.addEventListener('click', () => {
        playPicked(pickRandom(), false);
    });
    previewButton.addEventListener('click', () => {
        playPicked(pickRandom(), true);
    });

    const records = new Map<string, HTMLElement>();
    const postersById = new Map<string, Poster>();
    const refreshHighlight = (state: PlaybackState): void => {
        // 简单高亮：当前曲目属于哪张歌单，那张歌单就高亮，不做复杂状态机。
        for (const [id, record] of records) {
            const poster = postersById.get(id);
            const playing =
                state.track !== null &&
                poster !== undefined &&
                poster.tracks.some((track) => track.id === state.track?.id);
            record.classList.toggle('is-playing', playing);
        }
    };
    onTrackChange(refreshHighlight);
    refreshHighlight(getCurrentState());

    void (async () => {
        let posters: Poster[];
        try {
            posters = await definition.load();
        } catch (error) {
            notice.textContent = friendlyPosterError(definition, error);
            return;
        }
        if (posters.length === 0) {
            notice.textContent = definition.emptyNotice;
            return;
        }
        loadedPosters = posters;
        notice.hidden = true;
        for (const [index, poster] of posters.entries()) {
            postersById.set(poster.id, poster);
            const record = renderShelfRecord(poster, playNotice);
            // 入场 stagger 与海报卡同口径：最多前 8 张。
            record.style.setProperty('--i', String(Math.min(index, 7)));
            records.set(poster.id, record);
            stage.appendChild(record);
        }
        board.hidden = false;
        refreshHighlight(getCurrentState());
    })();

    return layer;
}

function renderShelfRecord(poster: Poster, playNotice: HTMLElement): HTMLElement {
    const record = document.createElement('button');
    record.type = 'button';
    record.className = 'shelf-record';
    // 辉光取色：id 哈希色相，与海报占位同一口径。
    record.style.setProperty('--hue', String(posterHue(poster.id)));

    const cover = document.createElement('div');
    cover.className = 'shelf-record-cover';

    // 封面面：纯色占位在下层，封面缺失或加载失败时露出来，不贴图。
    const face = document.createElement('div');
    face.className = 'shelf-record-face';
    const placeholder = document.createElement('div');
    placeholder.className = 'shelf-record-placeholder';
    placeholder.style.background = posterFallbackBackground(poster.id);
    face.appendChild(placeholder);
    if (poster.coverUrl) {
        const image = document.createElement('img');
        image.className = 'shelf-record-image';
        image.src = poster.coverUrl;
        image.alt = '';
        image.onerror = () => {
            image.remove();
        };
        face.appendChild(image);
    }
    cover.appendChild(face);

    // 侧边厚度：一小条深色边，站在封面右侧，做出唱片/书脊的厚度感。
    const edge = document.createElement('div');
    edge.className = 'shelf-record-edge';
    cover.appendChild(edge);

    record.appendChild(cover);

    const title = document.createElement('div');
    title.className = 'shelf-record-title';
    title.textContent = poster.title;
    record.appendChild(title);

    if (poster.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.className = 'shelf-record-subtitle';
        subtitle.textContent = poster.subtitle;
        record.appendChild(subtitle);
    }

    const count = document.createElement('div');
    count.className = 'shelf-record-count';
    count.textContent = `${poster.tracks.length} 首`;
    record.appendChild(count);

    record.addEventListener('click', () => {
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

    return record;
}
