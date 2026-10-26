// 音乐足迹页（0.1.54）：照网易云月报的样子，数据只用本地播放记录。
//
// 能做的：月切换、收听时长、唱片墙、TOP 歌曲/歌手、来源分布、收听日历。
// 做不了的：曲风与年代——曲目对象没有这个字段，页底会写明，不编假数据。
// 封面：远程 http(s) 直出；本地 content:// 不走 data URL 回炉（v1 不解析），
// 露 id 色相渐变 + ♪ 占位，与海报墙占位同款。
// 关闭直接 remove，不用 hidden——0.1.53 刚吃过 display 盖 hidden 的亏。

import {
    formatListenedMs,
    getFootprint,
    getMonthActiveDays,
    hasAnyHistory,
    SOURCE_NAMES,
} from './playback-history';
import type { FootprintStats } from './playback-history';
import { posterFallbackBackground } from './posters';
import type { SourceId } from './types';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function openFootprintPage(): void {
    const now = new Date();
    const page = buildFootprintPage(now.getFullYear(), now.getMonth() + 1);
    document.body.appendChild(page);
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
    title.textContent = '音乐足迹';
    head.appendChild(title);
    page.appendChild(head);

    if (!hasAnyHistory()) {
        const firstNote = document.createElement('p');
        firstNote.className = 'footprint-total';
        firstNote.textContent = '足迹从 0.1.54 开始记录，之前的收听补不回来。';
        page.appendChild(firstNote);
    }

    let viewedYear = year;
    let viewedMonth = month;
    const body = document.createElement('div');
    page.appendChild(body);

    const monthRow = document.createElement('div');
    monthRow.className = 'footprint-month';
    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.textContent = '◀︎';
    const monthLabel = document.createElement('span');
    monthLabel.className = 'footprint-month-label';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.textContent = '▶︎';
    monthRow.append(prevButton, monthLabel, nextButton);
    page.insertBefore(monthRow, body);

    const render = (): void => {
        const current = new Date();
        const currentKey = current.getFullYear() * 12 + (current.getMonth() + 1);
        const viewedKey = viewedYear * 12 + viewedMonth;
        monthLabel.textContent = `${viewedYear}年${viewedMonth}月`;
        nextButton.disabled = viewedKey >= currentKey;
        body.replaceChildren();
        renderMonth(body, viewedYear, viewedMonth);
    };
    prevButton.addEventListener('click', () => {
        if (viewedMonth === 1) {
            viewedYear -= 1;
            viewedMonth = 12;
        } else {
            viewedMonth -= 1;
        }
        render();
    });
    nextButton.addEventListener('click', () => {
        const current = new Date();
        const currentKey = current.getFullYear() * 12 + (current.getMonth() + 1);
        const viewedKey = viewedYear * 12 + viewedMonth;
        if (viewedKey >= currentKey) {
            return;
        }
        if (viewedMonth === 12) {
            viewedYear += 1;
            viewedMonth = 1;
        } else {
            viewedMonth += 1;
        }
        render();
    });
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

function section(titleText: string): { wrap: HTMLElement; } {
    const wrap = document.createElement('div');
    wrap.className = 'footprint-section';
    const heading = document.createElement('h3');
    heading.textContent = titleText;
    wrap.appendChild(heading);
    return { wrap };
}

function renderMonth(body: HTMLElement, year: number, month: number): void {
    const totals = getFootprint(null, null);
    const totalLine = document.createElement('p');
    totalLine.className = 'footprint-total';
    totalLine.textContent = `累计收听 ${formatListenedMs(totals.totalMs)} · 累计 ${totals.songCount} 首`;
    body.appendChild(totalLine);

    const stats: FootprintStats = getFootprint(year, month);
    const daysInMonth = new Date(year, month, 0).getDate();
    const hero = document.createElement('div');
    hero.className = 'footprint-hero';
    const heroTime = document.createElement('div');
    heroTime.className = 'footprint-hero-time';
    heroTime.textContent = formatListenedMs(stats.totalMs);
    const heroSub = document.createElement('div');
    heroSub.className = 'footprint-hero-sub';
    heroSub.textContent = `本月收听 · 已听 ${stats.activeDays} / ${daysInMonth} 天`;
    hero.append(heroTime, heroSub);
    body.appendChild(hero);

    if (stats.totalMs === 0) {
        const empty = document.createElement('p');
        empty.className = 'footprint-empty';
        empty.textContent = '本月还没有收听记录，听首歌再回来看看。';
        body.appendChild(empty);
        return;
    }

    const wallSection = section(`唱片墙 · ${stats.songCount} 首`);
    const wall = document.createElement('div');
    wall.className = 'footprint-wall';
    for (const item of stats.wall) {
        wall.appendChild(coverThumb(item.trackId, item.coverUrl, 'footprint-wall-item'));
    }
    wallSection.wrap.appendChild(wall);
    body.appendChild(wallSection.wrap);

    const songSection = section('TOP 歌曲');
    if (stats.topSongs.length === 0) {
        const note = document.createElement('p');
        note.className = 'footprint-note';
        note.textContent = '暂无计次收听：播放 30 秒以上才计一次。';
        songSection.wrap.appendChild(note);
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
            songSection.wrap.appendChild(row);
        }
    }
    body.appendChild(songSection.wrap);

    const artistSection = section('TOP 歌手');
    if (stats.topArtists.length === 0) {
        const note = document.createElement('p');
        note.className = 'footprint-note';
        note.textContent = '暂无计次收听：播放 30 秒以上才计一次。';
        artistSection.wrap.appendChild(note);
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
            artistSection.wrap.appendChild(row);
        }
    }
    body.appendChild(artistSection.wrap);

    const sourceSection = section('来源分布');
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
        sourceSection.wrap.appendChild(row);
    }
    if (anySource) {
        body.appendChild(sourceSection.wrap);
    }

    const calSection = section('收听日历');
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
    calSection.wrap.appendChild(calendar);
    body.appendChild(calSection.wrap);

    const footnote = document.createElement('p');
    footnote.className = 'footprint-note';
    footnote.textContent = '播放 30 秒以上计一次收听；时长按实际播放累计。曲风与年代暂无——曲库没有这个字段，不编假数据。';
    body.appendChild(footnote);
}
