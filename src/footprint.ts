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
} from './playback-history';
import type { FootprintStats } from './playback-history';
import { posterFallbackBackground } from './posters';
import type { SourceId } from './types';

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

function coverThumb(trackId: string, coverUrl: string | undefined, sizeClass: string): HTMLElement {
    if (coverUrl !== undefined && coverUrl.startsWith('http')) {
        const wrap = document.createElement('div');
        wrap.className = sizeClass;
        const img = document.createElement('img');
        img.src = coverUrl;
        img.alt = '';
        wrap.appendChild(img);
        return wrap;
    }
    const fallback = document.createElement('div');
    fallback.className = sizeClass;
    fallback.style.background = posterFallbackBackground(trackId);
    fallback.textContent = '♪';
    return fallback;
}

function section(titleText: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'footprint-section';
    const heading = document.createElement('h3');
    heading.textContent = titleText;
    wrap.appendChild(heading);
    return wrap;
}

function renderHero(
    body: HTMLElement,
    timeText: string,
    subText: string,
): void {
    const hero = document.createElement('div');
    hero.className = 'footprint-hero';
    const heroTime = document.createElement('div');
    heroTime.className = 'footprint-hero-time';
    heroTime.textContent = timeText;
    const heroSub = document.createElement('div');
    heroSub.className = 'footprint-hero-sub';
    heroSub.textContent = subText;
    hero.append(heroTime, heroSub);
    body.appendChild(hero);
}

function renderWall(body: HTMLElement, stats: FootprintStats): void {
    const wrap = section(`唱片墙 · ${stats.songCount} 首`);
    const wall = document.createElement('div');
    wall.className = 'footprint-wall';
    for (const item of stats.wall) {
        wall.appendChild(coverThumb(item.trackId, item.coverUrl, 'footprint-wall-item'));
    }
    wrap.appendChild(wall);
    body.appendChild(wrap);
}

function renderTopSongs(body: HTMLElement, stats: FootprintStats): void {
    const wrap = section('TOP 歌曲');
    if (stats.topSongs.length === 0) {
        const note = document.createElement('p');
        note.className = 'footprint-note';
        note.textContent = '暂无计次收听：播放 30 秒以上才计一次。';
        wrap.appendChild(note);
    } else {
        for (let index = 0; index < stats.topSongs.length; index += 1) {
            const song = stats.topSongs[index] as (typeof stats.topSongs)[number];
            const row = document.createElement('div');
            row.className = 'footprint-row';
            const rank = document.createElement('span');
            rank.className = 'footprint-rank';
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
            row.className = 'footprint-row';
            const rank = document.createElement('span');
            rank.className = 'footprint-rank';
            rank.textContent = String(index + 1);
            const main = document.createElement('div');
            main.className = 'footprint-row-main';
            const titleText = document.createElement('div');
            titleText.className = 'footprint-row-title';
            titleText.textContent = artist.artist;
            main.appendChild(titleText);
            const count = document.createElement('span');
            count.className = 'footprint-row-count';
            count.textContent = `${artist.plays} 次`;
            row.append(rank, main, count);
            wrap.appendChild(row);
        }
    }
    body.appendChild(wrap);
}

function renderSources(body: HTMLElement, stats: FootprintStats): void {
    const wrap = section('来源分布');
    const sources: SourceId[] = ['local', 'netease', 'ytm'];
    let anySource = false;
    for (const source of sources) {
        const plays = stats.sourcePlays[source];
        const ms = stats.sourceMs[source];
        if (plays === 0 && ms === 0) {
            continue;
        }
        anySource = true;
        const row = document.createElement('div');
        row.className = 'footprint-row';
        const main = document.createElement('div');
        main.className = 'footprint-row-main';
        const titleText = document.createElement('div');
        titleText.className = 'footprint-row-title';
        titleText.textContent = SOURCE_NAMES[source];
        const bar = document.createElement('div');
        bar.className = 'footprint-source-bar';
        const fill = document.createElement('div');
        fill.className = 'footprint-source-fill';
        const pct = stats.playCount > 0 ? Math.round((plays / stats.playCount) * 100) : 0;
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        main.append(titleText, bar);
        const count = document.createElement('span');
        count.className = 'footprint-row-count';
        count.textContent = `${plays} 次 · ${formatListenedMs(ms)}`;
        row.append(main, count);
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
        renderHero(
            body,
            formatListenedMs(stats.totalMs),
            `累计收听 · 已听 ${stats.activeDays} 天 · ${stats.songCount} 首`,
        );
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
        renderHero(
            body,
            formatListenedMs(stats.totalMs),
            `${year}年收听 · 已听 ${stats.activeDays} 天 · ${stats.songCount} 首`,
        );
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
    renderHero(
        body,
        formatListenedMs(stats.totalMs),
        `本月收听 · 已听 ${stats.activeDays} / ${daysInMonth} 天`,
    );
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
