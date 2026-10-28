// 外观（0.1.85）：主题衣橱 + 轻装模式。
//
// 主题：三套，壁纸是自家设计的三张原图（与探针同源），import 后由 Vite
// 打进 dist/assets。切换只换 CSS 变量 + body[data-zx-theme]，不重写全站颜色：
// 标题、激活态、卡片玻璃底色深浅、选中态跟随变量走；其余硬编码颜色不动。
// 轻装模式：一根总开关，body 加 perf-mode 类，CSS 里关模糊/阴影/动效，
// 播放页视觉画布在 poke() 里按暂停态处理（只画一帧就停）。

import bocchiWallpaper from './assets/bocchi.jpg';
import nightcityGlassWallpaper from './assets/nightcity_glass.jpg';
import nightcityDuskWallpaper from './assets/nightcity_dusk.jpg';

export interface ThemeDef {
    id: string;
    name: string;
    desc: string;
    /** 主色（主题配色行展示的色值）。 */
    accent: string;
    wallpaper: string;
}

export const THEMES: ThemeDef[] = [
    {
        id: 'bocchi',
        name: '波奇酱',
        desc: '粉色经典：波奇酱壁纸 + 粉白毛玻璃',
        accent: '#EC407A',
        wallpaper: bocchiWallpaper
    },
    {
        id: 'nightcity_glass',
        name: '夜之城·毛玻璃',
        desc: '赛博朋克 2077：雨夜壁纸 + 深色毛玻璃 + 2077 黄',
        accent: '#FCEE0A',
        wallpaper: nightcityGlassWallpaper
    },
    {
        id: 'nightcity_dusk',
        name: '夜之城·黄昏',
        desc: '赛博朋克 2077：黄昏城市壁纸 + 浅色磨砂玻璃 + 品红粉',
        accent: '#FF4D8D',
        wallpaper: nightcityDuskWallpaper
    }
];

export function themeById(id: string): ThemeDef {
    return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}

const THEME_KEY = 'zx.theme.id';
const PERF_KEY = 'zx.perf.mode';
const ACCENT_KEY_PREFIX = 'zx.theme.accent.';
const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** 该主题用户自选的主色（无则 null）。每套主题各记一个。 */
export function loadCustomAccent(id: string): string | null {
    try {
        const stored = localStorage.getItem(ACCENT_KEY_PREFIX + id);
        return stored && HEX_RE.test(stored) ? stored : null;
    } catch {
        return null;
    }
}

/** 该主题当前生效的主色：自选色优先，否则主题默认色。 */
export function loadAccent(id: string): string {
    return loadCustomAccent(id) ?? themeById(id).accent;
}

export function saveCustomAccent(id: string, hex: string): void {
    if (!HEX_RE.test(hex)) {
        return;
    }
    try {
        localStorage.setItem(ACCENT_KEY_PREFIX + id, hex);
    } catch {
        // 写不进只影响下次打开的默认值。
    }
}

export function clearCustomAccent(id: string): void {
    try {
        localStorage.removeItem(ACCENT_KEY_PREFIX + id);
    } catch {
        // 写不进只影响下次打开的默认值。
    }
}

export function loadThemeId(): string {
    try {
        const stored = localStorage.getItem(THEME_KEY);
        if (stored && THEMES.some((theme) => theme.id === stored)) {
            return stored;
        }
    } catch {
        // 存储不可用时回默认主题，不中断启动。
    }
    return 'bocchi';
}

export function applyTheme(id: string): ThemeDef {
    const theme = themeById(id);
    document.body.dataset.zxTheme = theme.id;
    document.body.style.setProperty('--theme-wallpaper', `url("${theme.wallpaper}")`);
    document.body.style.setProperty('--theme-accent', loadAccent(theme.id));
    try {
        localStorage.setItem(THEME_KEY, theme.id);
    } catch {
        // 写不进只影响下次打开的默认值。
    }
    return theme;
}

export function applyStoredTheme(): ThemeDef {
    return applyTheme(loadThemeId());
}

export function loadPerfMode(): boolean {
    try {
        return localStorage.getItem(PERF_KEY) === '1';
    } catch {
        return false;
    }
}

export function applyPerfMode(on: boolean): void {
    document.body.classList.toggle('perf-mode', on);
    try {
        localStorage.setItem(PERF_KEY, on ? '1' : '0');
    } catch {
        // 写不进只影响下次打开的默认值。
    }
}

export function applyStoredPerfMode(): void {
    applyPerfMode(loadPerfMode());
}
