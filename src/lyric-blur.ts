// 双向歌词模糊策略（借鉴 AM++ 的 BidirectionalBlurPolicy 思路全新写，
// 其上游 AMLyricBlur 为 MIT）：以当前高亮行为清晰中心，已唱与待唱
// 按行距查不同的半径表——已唱离得越远糊得越快，待唱先轻后重。
// 本模块只做纯计算（查表＋量化＋偏移钳制），不碰 DOM，播放页负责赋样式。
//
// 半径口径（px，0.1.136 改小）：
// - 当前行：0
// - 已唱方向（offset<0）：距离 1/2/3+ → 2/3/5
// - 待唱方向（offset>0）：距离 1/2/3/4+ → 1/3/4/6
// 为什么从大半径（旧表 13/17/22）改小：歌词字号才 20–24px，十几 px 的
// 模糊直接把邻行糊成一团雾，真机上只剩当前行＋下一行看得清、整卡发空
// 发单调。层次改靠下面的透明度梯度拉开，模糊只留一点点景深感，邻行
// 必须留得住字形、能读。强度偏移在查表后叠加（弱 -1／标准 0／强 +2，
// 与新半径成比例），整体钳制 0..32，当前行恒为 0（偏移不许把当前行
// 也糊掉）。结果量化到整数 px 再赋 CSS filter，避免小数半径在每次
// 进度回调里反复触发重绘。

const PAST_RADII = [0, 2, 3, 5];
const FUTURE_RADII = [0, 1, 3, 4, 6];
export const MAX_BLUR_RADIUS = 6;
const RENDER_BLUR_MAX = 32;

// 强度三档：偏移量直接加到查表半径上。（旧三档口径保留兼容：
// 无级强度迁移与个别旧调用仍可查，下面的滑杆口径才是现行真值。）
export const BLUR_STRENGTH_OFFSETS = {
    weak: -1,
    standard: 0,
    strong: 2
} as const;
export type LyricBlurStrength = keyof typeof BLUR_STRENGTH_OFFSETS;

function baseRadiusForOffset(offset: number): number {
    if (offset === 0) {
        return 0;
    }
    const table = offset < 0 ? PAST_RADII : FUTURE_RADII;
    return table[Math.min(Math.abs(offset), table.length - 1)] ?? MAX_BLUR_RADIUS;
}

// 单行半径：offset = 行下标 - 高亮行下标（负=已唱，正=待唱）。
export function blurRadiusForOffset(offset: number, strengthOffset = 0): number {
    const shifted = baseRadiusForOffset(offset) + (offset === 0 ? 0 : strengthOffset);
    return Math.round(Math.min(RENDER_BLUR_MAX, Math.max(0, shifted)));
}

// 无级强度（0–100，百分比）：半径 = round(查表半径 × intensity/50)。
// 50 与旧「标准」档逐行等值（现行观感不变）、0 恒无模糊、100 约两倍；
// 当前行恒 0（强度再高也不糊正在唱的行）。量化与钳制同查表口径。
export function blurRadiusForIntensity(offset: number, intensity: number): number {
    const scaled = baseRadiusForOffset(offset) * (Math.max(0, Math.min(100, intensity)) / 50);
    return Math.round(Math.min(RENDER_BLUR_MAX, Math.max(0, scaled)));
}

// 整盒半径分布：highlighted 为高亮行下标集合（可多行，取最近的一个算距离）；
// 集合为空回全 0（调用方对「前奏无当前行」另行传首行当焦点，不在这里猜）。
export function computeBlurRadii(
    lineCount: number,
    highlighted: ReadonlySet<number>,
    strengthOffset = 0
): number[] {
    if (lineCount <= 0 || highlighted.size === 0) {
        return new Array<number>(lineCount > 0 ? lineCount : 0).fill(0);
    }
    const radii: number[] = [];
    for (let i = 0; i < lineCount; i++) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const h of highlighted) {
            const offset = i - h;
            if (Math.abs(offset) < Math.abs(nearest)) {
                nearest = offset;
            }
        }
        radii.push(blurRadiusForOffset(nearest, strengthOffset));
    }
    return radii;
}

// 透明度梯度（0.1.136）：层次的主力，模糊只是辅助。按与当前行的距离
// 对称查表——offset 0 → 1、±1 → 0.82、±2 → 0.62、±3 → 0.48、≥±4 → 0.38。
// 关模糊时播放页不调本函数、opacity 一律回 1，别在这里猜开关状态。
const OPACITY_BY_DISTANCE = [1, 0.82, 0.62, 0.48];
const OPACITY_FARTHEST = 0.38;

export function lyricOpacityForOffset(offset: number): number {
    const distance = Math.abs(offset);
    return distance >= OPACITY_BY_DISTANCE.length
        ? OPACITY_FARTHEST
        : (OPACITY_BY_DISTANCE[distance] ?? 1);
}

// 整盒半径分布（无级强度版）：与 computeBlurRadii 同分布逻辑，
// 半径走 blurRadiusForIntensity。播放页现行调用走这一份。
export function computeBlurRadiiByIntensity(
    lineCount: number,
    highlighted: ReadonlySet<number>,
    intensity: number
): number[] {
    if (lineCount <= 0 || highlighted.size === 0) {
        return new Array<number>(lineCount > 0 ? lineCount : 0).fill(0);
    }
    const radii: number[] = [];
    for (let i = 0; i < lineCount; i++) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const h of highlighted) {
            const offset = i - h;
            if (Math.abs(offset) < Math.abs(nearest)) {
                nearest = offset;
            }
        }
        radii.push(blurRadiusForIntensity(nearest, intensity));
    }
    return radii;
}

// 设置持久化：跟播放页既有键风格（zx.player.* 点分小字段）。
const BLUR_ENABLED_KEY = 'zx.player.lyricBlur';
const BLUR_STRENGTH_KEY = 'zx.player.lyricBlurStrength';
const BLUR_INTENSITY_KEY = 'zx.player.lyricBlurIntensity';
const TRANSLATION_KEY = 'zx.player.showTranslation';
const GLOW_KEY = 'zx.player.lyricGlow';
const BOUNCE_KEY = 'zx.lyrics.bounce.v1';

export function loadLyricBlurEnabled(): boolean {
    try {
        // 默认开：只有存过明确的 '0' 才关。
        return localStorage.getItem(BLUR_ENABLED_KEY) !== '0';
    } catch {
        return true;
    }
}

export function saveLyricBlurEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(BLUR_ENABLED_KEY, enabled ? '1' : '0');
    } catch {
        // 存不进只影响下次打开的默认值。
    }
}

export function loadLyricBlurStrength(): LyricBlurStrength {
    try {
        const raw = localStorage.getItem(BLUR_STRENGTH_KEY);
        if (raw === 'weak' || raw === 'strong') {
            return raw;
        }
    } catch {
        // 读不到按标准。
    }
    return 'standard';
}

export function saveLyricBlurStrength(strength: LyricBlurStrength): void {
    try {
        localStorage.setItem(BLUR_STRENGTH_KEY, strength);
    } catch {
        // 同上。
    }
}

// 无级强度持久化：新键存 0–100 的整数百分比，是现行真值。
// 迁移：新键缺失时读旧三档键换算（weak→30、standard→50、strong→80），
// 并把换算结果写进新键——迁完以新键为准，旧键只留作回滚参考。
export function loadLyricBlurIntensity(): number {
    try {
        const raw = localStorage.getItem(BLUR_INTENSITY_KEY);
        if (raw !== null) {
            const value = Number(raw);
            if (Number.isFinite(value)) {
                return Math.round(Math.max(0, Math.min(100, value)));
            }
        }
        const legacy = localStorage.getItem(BLUR_STRENGTH_KEY);
        if (legacy === 'weak' || legacy === 'standard' || legacy === 'strong') {
            const migrated = legacy === 'weak' ? 30 : legacy === 'strong' ? 80 : 50;
            try {
                localStorage.setItem(BLUR_INTENSITY_KEY, String(migrated));
            } catch {
                // 写不进迁移值只影响下次还要再迁一次，结果不变。
            }
            return migrated;
        }
    } catch {
        // 读不到按标准。
    }
    return 50;
}

export function saveLyricBlurIntensity(intensity: number): void {
    try {
        const value = Math.round(Math.max(0, Math.min(100, intensity)));
        localStorage.setItem(BLUR_INTENSITY_KEY, String(value));
    } catch {
        // 同上。
    }
}

export function loadShowTranslation(): boolean {
    try {
        return localStorage.getItem(TRANSLATION_KEY) !== '0';
    } catch {
        return true;
    }
}

export function saveShowTranslation(show: boolean): void {
    try {
        localStorage.setItem(TRANSLATION_KEY, show ? '1' : '0');
    } catch {
        // 同上。
    }
}

// 歌词辉光（0.1.131）：CJK 逐字正在唱时的辉光开关，默认开。
export function loadLyricGlow(): boolean {
    try {
        return localStorage.getItem(GLOW_KEY) !== '0';
    } catch {
        return true;
    }
}

export function saveLyricGlow(enabled: boolean): void {
    try {
        localStorage.setItem(GLOW_KEY, enabled ? '1' : '0');
    } catch {
        // 同上。
    }
}

// 歌词跳动（0.1.134）：逐字弹跳＋整行弹动的开关，默认开（只有存 '0' 才关）。
// 动画本体全在 CSS，播放页只按开关给歌词盒切 lyrics-bounce-off 类。
export function loadLyricBounce(): boolean {
    try {
        return localStorage.getItem(BOUNCE_KEY) !== '0';
    } catch {
        return true;
    }
}

export function saveLyricBounce(enabled: boolean): void {
    try {
        localStorage.setItem(BOUNCE_KEY, enabled ? '1' : '0');
    } catch {
        // 同上。
    }
}
