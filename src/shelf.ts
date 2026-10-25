// 3D 歌单架（第 7 块，全新写）：首页内的一区，放在海报墙之后。
// 内容就是海报墙那三路歌单（本地专辑、网易云榜单、YTM 热门专辑），
// 按路分层摆，不另造数据、不另发请求：直接复用 posters.ts 的
// POSTER_SECTIONS 加载函数，那里已有成功结果共享缓存，海报墙与
// 歌单架调用同一路时只发一次请求。
// 形态只用 CSS 3D（perspective + rotateY），不引入 WebGL 或新依赖，
// 不做拖拽旋转、陀螺仪与复杂动画，只给整体一个轻微倾角。
// 交互：横向滑动浏览（overflow-x 滚动，移动端手势优先）；
// 点一张歌单即 playQueue(该单曲目列表, 0)，与海报墙同款思路；
// 正在播的歌单用 onTrackChange + 曲目 id 匹配做简单高亮。
// 任何一路失败或为空，都只在该层留一句中文提示，不拖垮整架。

import { getCurrentState, onTrackChange, playQueue } from './playback';
import type { PlaybackState } from './playback';
import { POSTER_SECTIONS, friendlyPosterError } from './posters';
import type { Poster } from './types';

function friendlyPlayError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/[\u4e00-\u9fff]/.test(message)) {
        return message;
    }
    return '播放失败，请确认文件仍在且已授予读取音频文件的权限。';
}

export function renderShelf(): HTMLElement {
    const shelf = document.createElement('section');
    shelf.className = 'shelf';

    const heading = document.createElement('h2');
    heading.textContent = '3D 歌单架';
    shelf.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'shelf-hint';
    hint.textContent = '横向滑动浏览，点击一张歌单从第一首开始播放。';
    shelf.appendChild(hint);

    const playNotice = document.createElement('p');
    playNotice.className = 'shelf-notice';
    playNotice.hidden = true;
    shelf.appendChild(playNotice);

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

    for (const definition of POSTER_SECTIONS) {
        const layer = document.createElement('div');
        layer.className = 'shelf-layer';

        const label = document.createElement('h3');
        label.textContent = definition.label;
        layer.appendChild(label);

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
            notice.hidden = true;
            for (const poster of posters) {
                postersById.set(poster.id, poster);
                const record = renderShelfRecord(poster, playNotice);
                records.set(poster.id, record);
                stage.appendChild(record);
            }
            board.hidden = false;
            refreshHighlight(getCurrentState());
        })();

        shelf.appendChild(layer);
    }

    return shelf;
}

function renderShelfRecord(poster: Poster, playNotice: HTMLElement): HTMLElement {
    const record = document.createElement('button');
    record.type = 'button';
    record.className = 'shelf-record';

    const cover = document.createElement('div');
    cover.className = 'shelf-record-cover';

    // 封面面：纯色占位在下层，封面缺失或加载失败时露出来，不贴图。
    const face = document.createElement('div');
    face.className = 'shelf-record-face';
    const placeholder = document.createElement('div');
    placeholder.className = 'shelf-record-placeholder';
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
