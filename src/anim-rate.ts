// 全局动画速率（全新写）：0.5×–2.0×、步进 0.1、默认 1.0，持久化在
// zx.player.animRate。生效面两条：
// - CSS：把倍率换成时长因子（1/rate）写进 --zx-anim-dur-factor，
//   style.css 里播放页核心 transition/animation 时长走 calc(原时长
//   × var(--zx-anim-dur-factor))——速率越高时长越短。
// - 画布：AnimClock 把 rAF 的原始时间戳累加成「动画时间」（每帧
//   dt × 生效速率），visuals.ts / lyric-drops.ts 的动态帧按动画
//   时间推进；逐帧位移量同样按生效速率缩放（两文件各自应用）。
//
// 系统「减少动态效果」优先：prefers-reduced-motion 时生效速率
// 钳到 ≤1.0（设置再高也不放大），CSS 侧原有 reduce 媒体查询该关
// 的动画照常关，本模块不与之对抗。

const ANIM_RATE_KEY = 'zx.player.animRate';
export const ANIM_RATE_MIN = 0.5;
export const ANIM_RATE_MAX = 2;
export const ANIM_RATE_STEP = 0.1;

export function loadAnimRate(): number {
    try {
        const value = Number(localStorage.getItem(ANIM_RATE_KEY));
        if (Number.isFinite(value) && value > 0) {
            return Math.min(ANIM_RATE_MAX, Math.max(ANIM_RATE_MIN, value));
        }
    } catch {
        // 读不到按默认。
    }
    return 1;
}

export function saveAnimRate(rate: number): void {
    try {
        const value = Math.min(ANIM_RATE_MAX, Math.max(ANIM_RATE_MIN, rate));
        localStorage.setItem(ANIM_RATE_KEY, String(Math.round(value * 10) / 10));
    } catch {
        // 存不下只影响下次打开的默认值。
    }
}

export function prefersReducedMotion(): boolean {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

// 生效速率：用户设置经减动效钳制后的值，画布与 CSS 共用这一份。
export function effectiveAnimRate(): number {
    const rate = loadAnimRate();
    return prefersReducedMotion() ? Math.min(rate, 1) : rate;
}

// 把生效速率写进 CSS 变量（时长因子 = 1/速率）。
export function applyAnimRateToCss(): void {
    const rate = effectiveAnimRate();
    document.documentElement.style.setProperty(
        '--zx-anim-dur-factor',
        String(Math.round((1 / rate) * 1000) / 1000)
    );
}

// 动画时钟：把 rAF 原始时间戳（ms）累加为按生效速率缩放的动画时间。
// 首帧只记基准不推进；速率中途变化从下一帧自然接上（dt 按新速率算）。
export class AnimClock {
    private lastRaw = 0;
    private accumulated = 0;

    reset(): void {
        this.lastRaw = 0;
        this.accumulated = 0;
    }

    advance(rawTime: number): number {
        if (this.lastRaw === 0) {
            this.lastRaw = rawTime;
            return this.accumulated;
        }
        const dt = Math.max(0, rawTime - this.lastRaw);
        this.lastRaw = rawTime;
        this.accumulated += dt * effectiveAnimRate();
        return this.accumulated;
    }

    // 本帧的位移缩放（= 生效速率）：逐帧增量（滴速、粒子速度）乘它。
    frameScale(): number {
        return effectiveAnimRate();
    }
}
