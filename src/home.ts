// 首页组装：按音源注册表渲染各音源的浏览区，尚未实现的块留在清单里。
// 本文件只做组装与界面接线，不放音源与播放逻辑。

import { getCurrentState, next, onTrackChange, playQueue, previous, togglePlay } from './playback';
import { openPlayerPage } from './player';
import type { PlaybackState } from './playback';
import { POSTER_SECTIONS } from './posters';
import { renderShelf } from './shelf';
import { SOURCES } from './sources/index';
import { getLocalNotice } from './sources/local';
import {
    checkQr,
    clearSession as clearNeteaseSession,
    fetchQrKey,
    loadSession as loadNeteaseSession,
    qrImageUrl,
    saveSession as saveNeteaseSession,
    validateStoredSession,
    type NeteaseSession
} from './sources/netease-session';
import {
    clearYtmSession,
    loadYtmSession,
    signInYtm
} from './sources/ytm-session';
import type { AudioSource, Poster, Track } from './types';

// 第 8 块已接上：歌词动态壁纸与四项视觉都在播放页里，清单不再列它。
const UPCOMING: string[] = [];

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

    // 登录区放最上：网易云与 YTM 的登录入口都在这里，不藏进播放页深处。
    section.appendChild(renderLoginArea());

    // 海报墙放最上：原有正在播放条与各音源浏览区顺序保持不动。
    section.appendChild(renderPosterWall());

    // 3D 歌单架（第 7 块）：海报墙之后、正在播放条之前的一区。
    section.appendChild(renderShelf());

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

    for (const source of SOURCES) {
        section.appendChild(renderSourceSection(source, status));
    }

    if (UPCOMING.length > 0) {
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
    }

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
    const stopPoll = (): void => {
        if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
            pollTimer = undefined;
        }
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

    const startQr = async (): Promise<void> => {
        stopPoll();
        body.replaceChildren();
        const status = document.createElement('p');
        status.className = 'login-notice';
        status.textContent = '正在获取二维码…';
        body.appendChild(status);
        let key: string;
        try {
            key = await fetchQrKey();
        } catch {
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
        currentKey = key;
        status.textContent = '用网易云 App 扫码登录';
        const qr = document.createElement('img');
        qr.className = 'login-qr';
        qr.src = qrImageUrl(key);
        qr.alt = '网易云登录二维码';
        qr.addEventListener('error', () => {
            stopPoll();
            status.textContent = '二维码图片加载失败，请检查网络后点刷新重试';
        });
        body.appendChild(qr);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'login-btn';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => {
            renderLoggedOut();
        });
        body.appendChild(cancel);
        const tick = async (): Promise<void> => {
            let result;
            try {
                result = await checkQr(currentKey);
            } catch {
                status.textContent = '查询失败，正在重试…';
                return;
            }
            if (result.code === 801) {
                status.textContent = '等待扫码';
            } else if (result.code === 802) {
                status.textContent = '已扫码，请在手机上确认';
            } else if (result.code === 800) {
                stopPoll();
                status.textContent = '二维码已过期';
                const refresh = document.createElement('button');
                refresh.type = 'button';
                refresh.className = 'login-btn';
                refresh.textContent = '刷新二维码';
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

function renderPosterWall(): HTMLElement {
    const wall = document.createElement('section');
    wall.className = 'poster-wall';

    const heading = document.createElement('h2');
    heading.textContent = '海报墙';
    wall.appendChild(heading);

    const playNotice = document.createElement('p');
    playNotice.className = 'poster-notice';
    playNotice.hidden = true;
    wall.appendChild(playNotice);

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

    for (const definition of POSTER_SECTIONS) {
        const block = document.createElement('div');
        block.className = 'poster-section';

        const label = document.createElement('h3');
        label.textContent = definition.label;
        block.appendChild(label);

        const grid = document.createElement('div');
        grid.className = 'poster-grid';
        block.appendChild(grid);

        const notice = document.createElement('p');
        notice.className = 'poster-notice';
        notice.textContent = '正在加载…';
        block.appendChild(notice);

        void (async () => {
            let posters: Poster[];
            try {
                posters = await definition.load();
            } catch {
                notice.textContent = definition.failureNotice;
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

        wall.appendChild(block);
    }

    return wall;
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
    card.appendChild(coverWrap);

    const title = document.createElement('div');
    title.className = 'poster-title';
    title.textContent = poster.title;
    card.appendChild(title);

    if (poster.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.className = 'poster-subtitle';
        subtitle.textContent = poster.subtitle;
        card.appendChild(subtitle);
    }

    const meta = document.createElement('div');
    meta.className = 'poster-meta';

    const badge = document.createElement('span');
    badge.className = 'poster-badge';
    const source = SOURCES.find((item) => item.id === poster.source);
    badge.textContent = source ? source.label : poster.source;
    meta.appendChild(badge);

    const count = document.createElement('span');
    count.textContent = `${poster.tracks.length} 首`;
    meta.appendChild(count);

    card.appendChild(meta);

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
