// 音乐足迹页（0.1.54 建，0.1.55 加年/全部视图）：照网易云月报的样子，
// 数据只用本地播放记录。
//
// 范围三档：月 / 年 / 全部，存在 zx_footprint_range_v1，下次打开接着看。
// 月视图：时长＋已听天数、唱片墙、TOP 歌曲/歌手、来源分布、收听日历。
// 年视图：时长＋已听天数、唱片墙、TOP 歌曲/歌手、来源分布、月度分布
//   （当年只列到本月，往年列 12 个月）。
// 全部视图：累计时长＋天数＋首数、唱片墙、TOP 歌曲/歌手、来源分布。
// 做不了的：曲风与年代——曲目对象没有这个字段，页底会写明，不编假数据。
// 封面：远程 http(s) 直出；本地 content:// 不走 data URL 回炉（v1 不解析），
// 露 id 色相渐变 + ♪ 占位，与海报墙占位同款。
// 关闭直接 remove，不用 hidden——0.1.53 刚吃过 display 盖 hidden 的亏。

import {
    formatListenedMs,
    getFootprint,
    getMonthActiveDays,
    getYearFootprint,
    hasAnyHistory,
    SOURCE_NAMES,
    updateSessionCover,
} from './playback-history';
import type { FootprintStats } from './playback-history';
import { posterFallbackBackground } from './posters';
import { getLocalCoverFromNetease } from './sources/local';
import type { SourceId, Track } from './types';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const RANGE_KEY = 'zx_footprint_range_v1';

type FootprintRange = 'month' | 'year' | 'all';

const RANGE_LABELS: Record<FootprintRange, string> = {
    month: '月',
    year: '年',
    all: '全部',
};

export function openFootprintPage(): void {
    const now = new Date();
    const page = buildFootprintPage(now.getFullYear(), now.getMonth() + 1);
    document.body.appendChild(page);
}

function loadRange(): FootprintRange {
    try {
        const stored = localStorage.getItem(RANGE_KEY);
        if (stored === 'year' || stored === 'all') {
            return stored;
        }
    } catch {
        // 忽略。
    }
    return 'month';
}

function buildFootprintPage(year: number, month: number): HTMLElement {
    const page = document.createElement('section');
    page.className = 'footprint-page';

    const head = document.createElement('div');
    head.className = 'footprint-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'footprint-back';
    back.textContent = '返回';
    back.addEventListener('click', () => {
        page.remove();
    });
    head.appendChild(back);
    const title = document.createElement('h2');
    title.textContent = '旋律手记';
    head.appendChild(title);
    page.appendChild(head);

    if (!hasAnyHistory()) {
        const firstNote = document.createElement('p');
        firstNote.className = 'footprint-total';
        firstNote.textContent = '足迹从 0.1.54 开始记录，之前的收听补不回来。';
        page.appendChild(firstNote);
    }

    let range = loadRange();
    let viewedYear = year;
    let viewedMonth = month;
    const body = document.createElement('div');
    page.appendChild(body);

    const rangeRow = document.createElement('div');
    rangeRow.className = 'footprint-range';
    const rangeButtons = new Map<FootprintRange, HTMLButtonElement>();
    (['month', 'year', 'all'] as FootprintRange[]).forEach((key) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = RANGE_LABELS[key];
        button.addEventListener('click', () => {
            if (range === key) {
                return;
            }
            range = key;
            try {
                localStorage.setItem(RANGE_KEY, key);
            } catch {
                // 忽略。
            }
            render();
        });
        rangeButtons.set(key, button);
        rangeRow.appendChild(button);
    });
    page.insertBefore(rangeRow, body);

    const navRow = document.createElement('div');
    navRow.className = 'footprint-month';
    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.textContent = '◀︎';
    const navLabel = document.createElement('span');
    navLabel.className = 'footprint-month-label';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.textContent = '▶︎';
    navRow.append(prevButton, navLabel, nextButton);
    page.insertBefore(navRow, body);

    const step = (delta: -1 | 1): void => {
        if (range === 'month') {
            const total = viewedYear * 12 + viewedMonth + delta;
            viewedYear = Math.floor((total - 1) / 12);
            viewedMonth = total - viewedYear * 12;
        } else if (range === 'year') {
            viewedYear += delta;
        }
        render();
    };
    prevButton.addEventListener('click', () => {
        step(-1);
    });
    nextButton.addEventListener('click', () => {
        step(1);
    });

    const render = (): void => {
        for (const [key, button] of rangeButtons) {
            button.classList.toggle('is-active', key === range);
        }
        navRow.hidden = range === 'all';
        const current = new Date();
        if (range === 'month') {
            const currentKey = current.getFullYear() * 12 + (current.getMonth() + 1);
            const viewedKey = viewedYear * 12 + viewedMonth;
            navLabel.textContent = `${viewedYear}年${viewedMonth}月`;
            nextButton.disabled = viewedKey >= currentKey;
        } else if (range === 'year') {
            navLabel.textContent = `${viewedYear}年`;
            nextButton.disabled = viewedYear >= current.getFullYear();
        }
        body.replaceChildren();
        renderRange(body, range, viewedYear, viewedMonth);
    };
    render();
    return page;
}

function fallbackThumb(trackId: string, sizeClass: string): HTMLElement {
    const fallback = document.createElement('div');
    fallback.className = sizeClass;
    fallback.style.background = posterFallbackBackground(trackId);
    fallback.textContent = '♪';
    return fallback;
}

function coverThumb(trackId: string, coverUrl: string | undefined, sizeClass: string): HTMLElement {
    if (coverUrl !== undefined && coverUrl.startsWith('http')) {
        const wrap = document.createElement('div');
        wrap.className = sizeClass;
        const img = document.createElement('img');
        img.src = coverUrl;
        img.alt = '';
        // 0.1.116：B 站图床禁非 B 站 Referer，不带则通；加载失败时
        // 退回渐变占位，不留破图。
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => {
            wrap.replaceWith(fallbackThumb(trackId, sizeClass));
        };
        wrap.appendChild(img);
        return wrap;
    }
    return fallbackThumb(trackId, sizeClass);
}

function section(titleText: string, smallText?: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'footprint-section';
    const head = document.createElement('div');
    head.className = 'footprint-section-head';
    const heading = document.createElement('h3');
    heading.textContent = titleText;
    head.appendChild(heading);
    if (smallText) {
        const small = document.createElement('small');
        small.textContent = smallText;
        head.appendChild(small);
    }
    wrap.appendChild(head);
    return wrap;
}

// 0.1.114 新版式：月报渐变卡——眉标＋大时长＋三格小统计
// （歌曲数／已听天数／最爱歌手），旧的两行散文本废弃。
function renderHero(
    body: HTMLElement,
    eyebrow: string,
    timeText: string,
    stats: Array<{ value: string; label: string }>,
): void {
    const hero = document.createElement('div');
    hero.className = 'footprint-hero';
    const heroEyebrow = document.createElement('div');
    heroEyebrow.className = 'footprint-hero-eyebrow';
    heroEyebrow.textContent = eyebrow;
    const heroTime = document.createElement('div');
    heroTime.className = 'footprint-hero-time';
    heroTime.textContent = timeText;
    const heroStats = document.createElement('div');
    heroStats.className = 'footprint-hero-stats';
    for (const stat of stats) {
        const cell = document.createElement('div');
        cell.className = 'footprint-hero-stat';
        const value = document.createElement('b');
        value.textContent = stat.value;
        const label = document.createElement('span');
        label.textContent = stat.label;
        cell.append(value, label);
        heroStats.appendChild(cell);
    }
    hero.append(heroEyebrow, heroTime, heroStats);
    body.appendChild(hero);
}

// 0.1.116 唱片墙补封面：墙只认记录里的 http 封面，本地歌记录的是
// content://，所以迷你条那套补源从没落到墙上。这里对无 http 封面
// 的墙砖按最近播放顺序补网易云搜索（一次最多 24 张，串行），补到
// 就地换图并写回历史记录，下次打开直接显示；补不到的不重复查。
const attemptedWallCovers = new Set<string>();

function renderWall(body: HTMLElement, stats: FootprintStats): void {
    // 0.1.118 唱片墙改成网易云式马赛克卡片（用户给的本周唱片墙参考）：
    // 收起态是一张无缝拼接的大圆角卡（前 16 张封面＋压字标题／总数），
    // 读起来是一张海报而不是 60 块砖；点卡片展开成 3 列大砖全量。
    if (stats.wall.length === 0) {
        const wrap = section('唱片墙 · 0 首');
        const empty = document.createElement('div');
        empty.className = 'footprint-wall';
        wrap.appendChild(empty);
        body.appendChild(wrap);
        return;
    }
    const block = document.createElement('div');
    block.className = 'footprint-wall-block';
    const tiles = new Map<string, HTMLElement[]>();
    const trackTile = (trackId: string, el: HTMLElement): void => {
        const list = tiles.get(trackId) ?? [];
        list.push(el);
        tiles.set(trackId, list);
    };
    const wall = document.createElement('div');
    wall.className = 'footprint-wall';
    wall.hidden = true;
    stats.wall.forEach((item) => {
        const tile = coverThumb(item.trackId, item.coverUrl, 'footprint-wall-item');
        trackTile(item.trackId, tile);
        wall.appendChild(tile);
    });
    const MOSAIC_COUNT = 16;
    const mosaic = document.createElement('div');
    mosaic.className = 'footprint-wall-mosaic';
    mosaic.addEventListener('click', () => {
        mosaic.hidden = true;
        wall.hidden = false;
        collapseButton.hidden = false;
    });
    stats.wall.slice(0, MOSAIC_COUNT).forEach((item) => {
        const tile = coverThumb(item.trackId, item.coverUrl, 'footprint-mosaic-item');
        trackTile(item.trackId, tile);
        mosaic.appendChild(tile);
    });
    const overlay = document.createElement('div');
    overlay.className = 'footprint-mosaic-overlay';
    const overlayTitle = document.createElement('div');
    overlayTitle.className = 'footprint-mosaic-title';
    overlayTitle.textContent = '唱片墙';
    const overlayBottom = document.createElement('div');
    overlayBottom.className = 'footprint-mosaic-bottom';
    const overlayCount = document.createElement('span');
    overlayCount.textContent = `${stats.songCount}首`;
    const overlayHint = document.createElement('span');
    overlayHint.textContent = '点开看全部 ▸';
    overlayBottom.append(overlayCount, overlayHint);
    overlay.append(overlayTitle, overlayBottom);
    mosaic.appendChild(overlay);
    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'footprint-wall-expand';
    collapseButton.textContent = '收起 ▴';
    collapseButton.hidden = true;
    collapseButton.addEventListener('click', () => {
        mosaic.hidden = false;
        wall.hidden = true;
        collapseButton.hidden = true;
    });
    block.append(mosaic, wall, collapseButton);
    body.appendChild(block);
    const targets = stats.wall.filter((item) => {
        if (item.coverUrl !== undefined && item.coverUrl.startsWith('http')) {
            return false;
        }
        if (attemptedWallCovers.has(item.trackId)) {
            return false;
        }
        attemptedWallCovers.add(item.trackId);
        return true;
    }).slice(0, 24);
    let chain = Promise.resolve();
    for (const item of targets) {
        chain = chain.then(async () => {
            const els = tiles.get(item.trackId);
            if (!els || els.length === 0) {
                return;
            }
            let coverUrl: string | null = null;
            try {
                const probe: Track = {
                    id: item.trackId,
                    title: item.title,
                    artist: item.artist,
                    source: 'local'
                };
                coverUrl = await getLocalCoverFromNetease(probe);
            } catch {
                coverUrl = null;
            }
            if (!coverUrl) {
                return;
            }
            for (const el of els) {
                const fresh = coverThumb(
                    item.trackId,
                    coverUrl,
                    el.classList.contains('footprint-mosaic-item')
                        ? 'footprint-mosaic-item'
                        : 'footprint-wall-item'
                );
                el.replaceWith(fresh);
            }
            updateSessionCover(item.trackId, coverUrl);
        });
    }
    void chain;
}

function renderTopSongs(body: HTMLElement, stats: FootprintStats): void {
    const wrap = section('TOP 歌曲', '播放 30 秒以上计一次');
    if (stats.topSongs.length === 0) {
        const note = document.createElement('p');
        note.className = 'footprint-note';
        note.textContent = '暂无计次收听：播放 30 秒以上才计一次。';
        wrap.appendChild(note);
    } else {
        for (let index = 0; index < stats.topSongs.length; index += 1) {
            const song = stats.topSongs[index] as (typeof stats.topSongs)[number];
            const row = document.createElement('div');
            row.className = index === 0 ? 'footprint-row is-hot' : 'footprint-row';
            const rank = document.createElement('span');
            rank.className =
                index < 3 ? `footprint-rank medal m${index + 1}` : 'footprint-rank';
            rank.textContent = String(index + 1);
            const main = document.createElement('div');
            main.className = 'footprint-row-main';
            const titleText = document.createElement('div');
            titleText.className = 'footprint-row-title';
            titleText.textContent = song.title;
            const sub = document.createElement('div');
            sub.className = 'footprint-row-sub';
            sub.textContent = song.artist;
            main.append(titleText, sub);
            const count = document.createElement('span');
            count.className = 'footprint-row-count';
            count.textContent = `${song.plays} 次`;
            row.append(rank, coverThumb(song.trackId, song.coverUrl, 'footprint-thumb'), main, count);
            wrap.appendChild(row);
        }
    }
    body.appendChild(wrap);
}

function renderTopArtists(body: HTMLElement, stats: FootprintStats): void {
    const wrap = section('TOP 歌手');
    if (stats.topArtists.length === 0) {
        const note = document.createElement('p');
        note.className = 'footprint-note';
        note.textContent = '暂无计次收听：播放 30 秒以上才计一次。';
        wrap.appendChild(note);
    } else {
        for (let index = 0; index < stats.topArtists.length; index += 1) {
            const artist = stats.topArtists[index] as (typeof stats.topArtists)[number];
            const row = document.createElement('div');
            row.className = index === 0 ? 'footprint-row is-hot' : 'footprint-row';
            const rank = document.createElement('span');
            rank.className =
                index < 3 ? `footprint-rank medal m${index + 1}` : 'footprint-rank';
            rank.textContent = String(index + 1);
            // 歌手数据没有封面字段：首字＋色相渐变圆，不编假图。
            const avatar = document.createElement('span');
            avatar.className = 'footprint-avatar';
            avatar.style.background = posterFallbackBackground(artist.artist);
            avatar.textContent = artist.artist.slice(0, 1);
            const main = document.createElement('div');
            main.className = 'footprint-row-main';
            const titleText = document.createElement('div');
            titleText.className = 'footprint-row-title';
            titleText.textContent = artist.artist;
            main.appendChild(titleText);
            const count = document.createElement('span');
            count.className = 'footprint-row-count';
            count.textContent = `${artist.plays} 次`;
            row.append(rank, avatar, main, count);
            wrap.appendChild(row);
        }
    }
    body.appendChild(wrap);
}

function renderSources(body: HTMLElement, stats: FootprintStats): void {
    const wrap = section('来源分布');
    const sources: SourceId[] = ['local', 'netease', 'ytm', 'bilibili'];
    let anySource = false;
    for (const source of sources) {
        const plays = stats.sourcePlays[source];
        const ms = stats.sourceMs[source];
        if (plays === 0 && ms === 0) {
            continue;
        }
        anySource = true;
        const row = document.createElement('div');
        row.className = 'footprint-source';
        const headRow = document.createElement('div');
        headRow.className = 'footprint-source-head';
        const titleText = document.createElement('span');
        titleText.className = 'footprint-source-name';
        titleText.textContent = SOURCE_NAMES[source];
        const pct = stats.playCount > 0 ? Math.round((plays / stats.playCount) * 100) : 0;
        const pctEl = document.createElement('span');
        pctEl.className = 'footprint-source-pct';
        pctEl.textContent = `${pct}%`;
        headRow.append(titleText, pctEl);
        const bar = document.createElement('div');
        bar.className = 'footprint-source-bar';
        const fill = document.createElement('div');
        fill.className = `footprint-source-fill src-${source}`;
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        const meta = document.createElement('div');
        meta.className = 'footprint-source-meta';
        meta.textContent = `${plays} 次 · ${formatListenedMs(ms)}`;
        row.append(headRow, bar, meta);
        wrap.appendChild(row);
    }
    if (anySource) {
        body.appendChild(wrap);
    }
}

function renderFootnote(body: HTMLElement): void {
    const footnote = document.createElement('p');
    footnote.className = 'footprint-note';
    footnote.textContent = '播放 30 秒以上计一次收听；时长按实际播放累计。曲风与年代暂无——曲库没有这个字段，不编假数据。';
    body.appendChild(footnote);
}

function renderEmpty(body: HTMLElement, text: string): void {
    const empty = document.createElement('p');
    empty.className = 'footprint-empty';
    empty.textContent = text;
    body.appendChild(empty);
}

function renderRange(
    body: HTMLElement,
    range: FootprintRange,
    year: number,
    month: number,
): void {
    if (range === 'all') {
        const stats = getFootprint(null, null);
        renderHero(body, '全部 · 累计', formatListenedMs(stats.totalMs), [
            { value: `${stats.songCount} 首`, label: '累计歌曲' },
            { value: `${stats.activeDays} 天`, label: '已听天数' },
            { value: stats.topArtists[0]?.artist ?? '—', label: '累计最爱' },
        ]);
        if (stats.totalMs === 0) {
            renderEmpty(body, '还没有收听记录，听首歌再回来看看。');
            return;
        }
        renderWall(body, stats);
        renderTopSongs(body, stats);
        renderTopArtists(body, stats);
        renderSources(body, stats);
        renderFootnote(body);
        return;
    }

    if (range === 'year') {
        const stats = getYearFootprint(year);
        renderHero(body, `${year}年 · 年报`, formatListenedMs(stats.totalMs), [
            { value: `${stats.songCount} 首`, label: '当年歌曲' },
            { value: `${stats.activeDays} 天`, label: '已听天数' },
            { value: stats.topArtists[0]?.artist ?? '—', label: '当年最爱' },
        ]);
        if (stats.totalMs === 0) {
            renderEmpty(body, '今年还没有收听记录，听首歌再回来看看。');
            return;
        }
        renderWall(body, stats);
        renderTopSongs(body, stats);
        renderTopArtists(body, stats);
        renderSources(body, stats);
        const current = new Date();
        const lastMonth = year === current.getFullYear() ? current.getMonth() + 1 : 12;
        const monthStats: { month: number; ms: number }[] = [];
        let maxMs = 0;
        for (let m = 1; m <= lastMonth; m += 1) {
            const ms = getFootprint(year, m).totalMs;
            monthStats.push({ month: m, ms });
            if (ms > maxMs) {
                maxMs = ms;
            }
        }
        const distWrap = section('月度分布');
        for (const entry of monthStats) {
            const row = document.createElement('div');
            row.className = 'footprint-row';
            const main = document.createElement('div');
            main.className = 'footprint-row-main';
            const titleText = document.createElement('div');
            titleText.className = 'footprint-row-title';
            titleText.textContent = `${entry.month}月`;
            const bar = document.createElement('div');
            bar.className = 'footprint-source-bar';
            const fill = document.createElement('div');
            fill.className = 'footprint-source-fill';
            fill.style.width = maxMs > 0 ? `${Math.round((entry.ms / maxMs) * 100)}%` : '0%';
            bar.appendChild(fill);
            main.append(titleText, bar);
            const count = document.createElement('span');
            count.className = 'footprint-row-count';
            count.textContent = formatListenedMs(entry.ms);
            row.append(main, count);
            distWrap.appendChild(row);
        }
        body.appendChild(distWrap);
        renderFootnote(body);
        return;
    }

    const totals = getFootprint(null, null);
    const totalLine = document.createElement('p');
    totalLine.className = 'footprint-total';
    totalLine.textContent = `累计收听 ${formatListenedMs(totals.totalMs)} · 累计 ${totals.songCount} 首`;
    body.appendChild(totalLine);

    const stats = getFootprint(year, month);
    const daysInMonth = new Date(year, month, 0).getDate();
    renderHero(body, `${year}年${month}月 · 月报`, formatListenedMs(stats.totalMs), [
        { value: `${stats.songCount} 首`, label: '本月歌曲' },
        { value: `${stats.activeDays} / ${daysInMonth} 天`, label: '已听天数' },
        { value: stats.topArtists[0]?.artist ?? '—', label: '本月最爱' },
    ]);
    if (stats.totalMs === 0) {
        renderEmpty(body, '本月还没有收听记录，听首歌再回来看看。');
        return;
    }
    renderWall(body, stats);
    renderTopSongs(body, stats);
    renderTopArtists(body, stats);
    renderSources(body, stats);

    const calWrap = section('收听日历');
    const calendar = document.createElement('div');
    calendar.className = 'footprint-calendar';
    for (const weekday of WEEKDAYS) {
        const headCell = document.createElement('div');
        headCell.className = 'footprint-cal-head';
        headCell.textContent = weekday;
        calendar.appendChild(headCell);
    }
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const offset = (firstWeekday + 6) % 7;
    for (let index = 0; index < offset; index += 1) {
        calendar.appendChild(document.createElement('div'));
    }
    const activeDays = getMonthActiveDays(year, month);
    const today = new Date();
    for (let day = 1; day <= daysInMonth; day += 1) {
        const cell = document.createElement('div');
        cell.className = 'footprint-cal-day';
        cell.textContent = String(day);
        if (activeDays.has(day)) {
            cell.classList.add('is-active');
        }
        if (year === today.getFullYear() && month === today.getMonth() + 1 && day === today.getDate()) {
            cell.classList.add('is-today');
        }
        calendar.appendChild(cell);
    }
    calWrap.appendChild(calendar);
    body.appendChild(calWrap);
    renderFootnote(body);
}
