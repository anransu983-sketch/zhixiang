// 播放页视觉（第 8 块，全新写）：单块画布上的五项独立图层。
//
// 五项开关各自独立，互不依赖，存在 localStorage，键 zhixiang.visual.toggles：
// - rainMode（雨滴三档，默认 2 动态）：0 关（不画水滴）、1 静态水滴
//   （只画静止圆滴，下滑滴不动，不空转 rAF）、2 动态滑落（静止圆滴＋
//   下滑拖尾＋大光斑，即旧 rain=true 的行为）。封面模糊底不受档位影响。
// - particles（粒子舞台，默认关）：粒子随频谱能量律动。
// - pulse（节奏脉动，默认关）：封面随频谱能量缩放发光。
// - stars（氛围星空，默认关）：星空闪烁漂移。
// - sword（剑来，默认关）：切歌时剑光斜划全屏＋诗句逐字浮现后淡出，
//   只在播放页打开且正在播放时触发，静态帧不画。
//
// 频谱降级（诚实降级，不伪造频谱）：
// - 有 AnalyserNode 时，粒子速度/大小与脉动缩放都取真实频谱能量
//   （getByteFrequencyData 的均值归一化到 0~1）。
// - 无 AnalyserNode 时（getAnalyser() 返回 null），粒子只做氛围慢动，
//   脉动只做跟随播放/暂停的缓慢呼吸（播放时呼吸、暂停时回到原尺寸），
//   绝不拿随机数假装频谱。播放页在降级时另有一句文字说明。
//
// 性能底线：
// - 页面不可见（document.hidden）时停掉 rAF，可见恢复后由 poke() 重启。
// - 播放停止/暂停时只画一帧静态画面就停画，不空转；状态变化时由
//   播放页调用 poke() 重启动画。toggle 变化也调 poke() 立即生效。

import { sampleCoverColor } from './cover-color';

// 高光火花种子：主火花在左上偏边处，二号火花（团块才有）在右侧偏上。
// dx/dy/radius 均为相对主圆半径的比例，seed 时定死、逐帧不变。
function makeSparks(
    withSecond: boolean
): Array<{ dx: number; dy: number; radius: number }> {
    const sparks = [
        { dx: -0.42 + Math.random() * 0.14, dy: -0.44 + Math.random() * 0.14, radius: 0.13 }
    ];
    if (withSecond) {
        sparks.push({
            dx: 0.3 + Math.random() * 0.22,
            dy: -0.24 + Math.random() * 0.2,
            radius: 0.08
        });
    }
    return sparks;
}

// #rrggbb 转 rgba() 字符串（封面取色晕染与脉动辉光用）。
function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface VisualToggles {
    rainMode: number;
    particles: boolean;
    pulse: boolean;
    stars: boolean;
    sword: boolean;
}

const STORAGE_KEY = 'zhixiang.visual.toggles';

export const DEFAULT_TOGGLES: VisualToggles = {
    rainMode: 2,
    particles: false,
    pulse: false,
    stars: false,
    sword: false
};

// 0.1.115 视觉预设：把五项独立开关打包成命名组合，一键应用；
// 应用后仍可单项微调，预设本身不另存状态。
export const VISUAL_PRESETS: Array<{ id: string; label: string; toggles: VisualToggles }> = [
    { id: 'live', label: '现场', toggles: { rainMode: 2, particles: true, pulse: true, stars: true, sword: true } },
    { id: 'night', label: '深夜', toggles: { rainMode: 1, particles: false, pulse: false, stars: true, sword: false } },
    { id: 'rainy', label: '雨夜', toggles: { rainMode: 2, particles: false, pulse: true, stars: true, sword: false } },
    { id: 'clean', label: '干净', toggles: { rainMode: 0, particles: false, pulse: false, stars: false, sword: false } }
];

export function loadVisualToggles(): VisualToggles {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_TOGGLES };
        }
        const parsed = JSON.parse(raw) as Partial<VisualToggles>;
        // 旧形状迁移：rain=true→2 动态，rain=false→0 关（保持旧观感不变）。
        const legacy = parsed as Partial<VisualToggles> & { rain?: unknown };
        const migrated =
            typeof parsed.rainMode === 'number' && parsed.rainMode >= 0 && parsed.rainMode <= 2
                ? parsed.rainMode
                : typeof legacy.rain === 'boolean'
                    ? legacy.rain ? 2 : 0
                    : DEFAULT_TOGGLES.rainMode;
        return {
            rainMode: migrated,
            particles:
                typeof parsed.particles === 'boolean'
                    ? parsed.particles
                    : DEFAULT_TOGGLES.particles,
            pulse: typeof parsed.pulse === 'boolean' ? parsed.pulse : DEFAULT_TOGGLES.pulse,
            stars: typeof parsed.stars === 'boolean' ? parsed.stars : DEFAULT_TOGGLES.stars,
            sword: typeof parsed.sword === 'boolean' ? parsed.sword : DEFAULT_TOGGLES.sword
        };
    } catch {
        return { ...DEFAULT_TOGGLES };
    }
}

export function saveVisualToggles(toggles: VisualToggles): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toggles));
    } catch {
        // 存储不可用时只影响下次打开的默认值，不中断播放页。
    }
}

// 照片级折射引擎（0.1.143）：舞台雨与歌词卡（lyric-drops.ts）共用同一
// 套成形口径，定版参照是用户给的《刀马旦》歌词页照片——整屏密布的
// 照片级水珠。三要素：①滴里是放大＋上下翻转的清晰实景（背景糊、滴
// 里锐，这是核心；与 0.1.142 拿糊底图半透叠加的旧口径正相反，旧的
// LENS_ALPHA 已废除）；②中大滴是主圆＋卫星圆黏连的不规则团块；
// ③密度极高（团块＋中滴＋几百颗细水点满铺）。
// 折射采样倍率：采样窗边长 = 滴包围直径 / 此值（窗比滴小、绘入即放大）。
const REFRACTION_ZOOM = 1.55;
// 折射采样绘入的不透明度：近实绘，让滴里的锐图压住背后的糊底。
const REFRACTION_ALPHA = 0.9;

// 下滑滴（带拖尾，逐帧活绘）；静止滴三类（团块/中滴/细水点）走预渲染
// 静态层（ensureStaticRain），不进这个数组。
// 大光斑（bokeh）另起数组，只做柔光深度，不参与下落。
interface Drop {
    x: number;
    y: number;
    radius: number;
    speed: number;
    trail: number;
    /** 纵向微椭圆系数（0.92–1.0，seed 时定死、逐帧不变）：去正圆盘感。 */
    squash: number;
    /** 偏边高光火花（相对主圆半径的比例，seed 时定死）。 */
    sparks: Array<{ dx: number; dy: number; radius: number }>;
}

// 静态采样滴：团块（satellites 非空）与中滴（satellites 为空）共用此形。
// 坐标/半径均为 CSS px；extent 是含卫星的包围半径，采样窗按它定。
interface RainBlob {
    x: number;
    y: number;
    radius: number;
    extent: number;
    satellites: Array<{ dx: number; dy: number; radius: number }>;
    sparks: Array<{ dx: number; dy: number; radius: number }>;
    squash: number;
}

// 细水点：不采样，只画淡芯＋一个白亮点。
interface RainSpeckle {
    x: number;
    y: number;
    radius: number;
}

interface Bokeh {
    x: number;
    y: number;
    radius: number;
    alpha: number;
}

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
}

interface Star {
    x: number;
    y: number;
    radius: number;
    phase: number;
    speed: number;
}

export interface VisualStageOptions {
    getAnalyser: () => AnalyserNode | null;
    isPlaying: () => boolean;
    getToggles: () => VisualToggles;
    getCoverImage: () => HTMLImageElement | null;
}

export class VisualStage {
    private canvas: HTMLCanvasElement;
    private context: CanvasRenderingContext2D | null;
    private coverElement: HTMLElement;
    private options: VisualStageOptions;
    private rafId: number | null = null;
    private running = false;
    private suspended = false;
    private staticDrawn = false;
    private drops: Drop[] = [];
    private bokeh: Bokeh[] = [];
    private particles: Particle[] = [];
    private stars: Star[] = [];
    private swordStart: number | null = null;
    private seededWidth = 0;
    private seededHeight = 0;
    private bgCanvas: HTMLCanvasElement | null = null;
    private bgKey = '';
    // 锐图采样源（与 bgCanvas 同批维护）：未模糊的背景原图，水滴折射采它。
    private sharpCanvas: HTMLCanvasElement | null = null;
    // 静态水滴预渲染层：静态滴全部画在这一张里，每帧只 drawImage。
    private staticBlobs: RainBlob[] = [];
    private staticMids: RainBlob[] = [];
    private staticSpeckles: RainSpeckle[] = [];
    private rainLayer: HTMLCanvasElement | null = null;
    private rainLayerKey = '';
    // 封面取色（0.1.101）：当前封面的主色，采样失败时 null（用主题粉兜底）。
    private coverColor: string | null = null;
    private coverColorSrc = '';
    private freqData: Uint8Array<ArrayBuffer> | null = null;
    private onVisibilityChange = (): void => {
        if (!document.hidden) {
            this.poke();
        }
    };

    constructor(canvas: HTMLCanvasElement, coverElement: HTMLElement, options: VisualStageOptions) {
        this.canvas = canvas;
        this.coverElement = coverElement;
        this.options = options;
        this.context = canvas.getContext('2d');
        this.resize();
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    start(): void {
        this.poke();
    }

    // 状态变化（播放/暂停、切歌、开关变化）后调用：需要画就重启，不需要就停。
    poke(): void {
        if (this.suspended) {
            // 播放页关闭期间：连可见性变化导致的 poke() 也不重启循环，
            // 否则后台切回前台会把画布在隐藏的播放页里悄悄跑起来。
            this.stopLoop();
            return;
        }
        if (document.hidden) {
            this.stopLoop();
            return;
        }
        if (!this.needsLoop()) {
            // 暂停/停止、轻装模式、或只剩静态层（雨滴静态档且其余动效全关）：
            // 画一帧静态画面后停画，不空转 rAF。
            if (!this.staticDrawn) {
                this.drawFrame(0, false);
                this.staticDrawn = true;
            }
            this.stopLoop();
            return;
        }
        this.staticDrawn = false;
        if (!this.running) {
            this.running = true;
            const step = (time: number): void => {
                if (!this.running) {
                    return;
                }
                if (document.hidden || !this.needsLoop()) {
                    this.running = false;
                    this.rafId = null;
                    this.poke();
                    return;
                }
                this.drawFrame(time, true);
                this.rafId = requestAnimationFrame(step);
            };
            this.rafId = requestAnimationFrame(step);
        }
    }

    // 是否值得跑 rAF 循环：播放中、非轻装模式，且至少有一层会随时间变。
    // 雨滴动态档（2）算一层；静态档（1）不算——水滴不动，不必空转。
    private needsLoop(): boolean {
        if (document.body.classList.contains('perf-mode')) {
            return false;
        }
        if (!this.options.isPlaying()) {
            return false;
        }
        const toggles = this.options.getToggles();
        return (
            toggles.rainMode === 2 ||
            toggles.particles ||
            toggles.pulse ||
            toggles.stars ||
            this.swordStart !== null
        );
    }

    stop(): void {
        this.stopLoop();
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.coverElement.style.transform = '';
        this.coverElement.style.boxShadow = '';
    }

    // 播放页关闭时调用：只停 rAF 循环，不解绑监听、不清封面样式，
    // 重开播放页时 resume() 恢复，不用重建 VisualStage。
    suspend(): void {
        this.suspended = true;
        this.stopLoop();
    }

    // 播放页重开时调用：解除挂起并按当前状态恢复（poke 语义）。
    resume(): void {
        this.suspended = false;
        this.poke();
    }

    // 切歌时调用：剑来开着才起效，记下出鞘时刻，动画由 drawFrame 逐帧画；
    // 暂停/静态帧不画，动画跑完自动收尾，不用额外停循环。
    triggerSword(): void {
        if (!this.options.getToggles().sword) {
            return;
        }
        this.swordStart = performance.now();
        this.poke();
    }

    resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
            this.canvas.width = width * ratio;
            this.canvas.height = height * ratio;
        }
        this.seed(width, height);
    }

    private stopLoop(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.running = false;
    }

    private seed(width: number, height: number): void {
        if (width <= 1 || height <= 1) {
            // 页面隐藏时尺寸为 0，不播种，等可见时再播。
            return;
        }
        if (
            width === this.seededWidth &&
            height === this.seededHeight &&
            this.drops.length > 0
        ) {
            return;
        }
        // 尺寸变了就重播：构造时页面若还没挂上 DOM，尺寸是 0，
        // 旧逻辑只播一次，会把全部粒子永远挤在 1px 角落里。
        this.drops = [];
        this.staticBlobs = [];
        this.staticMids = [];
        this.staticSpeckles = [];
        this.bokeh = [];
        this.particles = [];
        this.stars = [];
        this.seededWidth = width;
        this.seededHeight = height;
        if (this.drops.length === 0) {
            // 下滑滴：保持旧量级（16 颗），逐帧活绘；静止滴不在此列。
            for (let i = 0; i < 16; i++) {
                this.drops.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    radius: 8 + Math.random() * 10,
                    speed: 0.2 + Math.random() * 0.4,
                    trail: 20 + Math.random() * 40,
                    squash: 0.92 + Math.random() * 0.08,
                    sparks: makeSparks(false)
                });
            }
        }
        // 静态水滴三类（照片级密度，CSS px 面积口径，参照《刀马旦》图
        // 的满铺感）：团块约 area/15000、中滴约 area/5500、细水点约
        // area/2200。以 390×844 为例约 22 团块＋60 中滴＋150 细点。
        // 全部只预渲染一次（ensureStaticRain），不进逐帧绘制。
        const area = width * height;
        const blobCount = Math.max(6, Math.round(area / 15000));
        for (let i = 0; i < blobCount; i++) {
            const radius = 11 + Math.pow(Math.random(), 1.7) * 19;
            const satellites: RainBlob['satellites'] = [];
            let extent = radius;
            const satCount = 2 + Math.floor(Math.random() * 3);
            for (let s = 0; s < satCount; s++) {
                const ang = Math.random() * Math.PI * 2;
                const dist = radius * (0.45 + Math.random() * 0.4);
                const sr = radius * (0.38 + Math.random() * 0.3);
                const dx = Math.cos(ang) * dist;
                const dy = Math.sin(ang) * dist * (0.8 + Math.random() * 0.2);
                satellites.push({ dx, dy, radius: sr });
                extent = Math.max(extent, Math.abs(dx) + sr, Math.abs(dy) + sr);
            }
            this.staticBlobs.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius,
                extent,
                satellites,
                sparks: makeSparks(true),
                squash: 0.94 + Math.random() * 0.06
            });
        }
        const midCount = Math.max(10, Math.round(area / 5500));
        for (let i = 0; i < midCount; i++) {
            const radius = 3.5 + Math.random() * 6;
            this.staticMids.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius,
                extent: radius,
                satellites: [],
                sparks: makeSparks(false),
                squash: 0.92 + Math.random() * 0.08
            });
        }
        const speckleCount = Math.max(24, Math.round(area / 2200));
        for (let i = 0; i < speckleCount; i++) {
            this.staticSpeckles.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius: 0.8 + Math.random() * 1.4
            });
        }
        if (this.bokeh.length === 0) {
            for (let i = 0; i < 10; i++) {
                this.bokeh.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    radius: 30 + Math.random() * 50,
                    alpha: 0.05 + Math.random() * 0.07
                });
            }
        }
        if (this.particles.length === 0) {
            for (let i = 0; i < 70; i++) {
                this.particles.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    vx: (Math.random() - 0.5) * 0.6,
                    vy: (Math.random() - 0.5) * 0.6,
                    size: 1.5 + Math.random() * 2.5
                });
            }
        }
        if (this.stars.length === 0) {
            for (let i = 0; i < 90; i++) {
                this.stars.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    radius: 0.6 + Math.random() * 1.4,
                    phase: Math.random() * Math.PI * 2,
                    speed: 0.5 + Math.random() * 1.5
                });
            }
        }
    }

    // 返回 0~1 的频谱能量；无 AnalyserNode 时返回 null，调用方走降级分支。
    private spectrumEnergy(): number | null {
        const analyser = this.options.getAnalyser();
        if (!analyser) {
            return null;
        }
        if (!this.freqData || this.freqData.length !== analyser.frequencyBinCount) {
            this.freqData = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(this.freqData);
        let sum = 0;
        for (let i = 0; i < this.freqData.length; i++) {
            sum += this.freqData[i] ?? 0;
        }
        return this.freqData.length > 0 ? sum / this.freqData.length / 255 : 0;
    }

    private drawFrame(time: number, animated: boolean): void {
        const ctx = this.context;
        if (!ctx) {
            return;
        }
        const width = this.canvas.width;
        const height = this.canvas.height;
        const cssWidth = Math.max(1, this.canvas.clientWidth);
        const cssHeight = Math.max(1, this.canvas.clientHeight);
        const toggles = this.options.getToggles();
        const energy = this.spectrumEnergy();

        ctx.clearRect(0, 0, width, height);

        // 底：有封面时一律画封面模糊底（雨滴档位只管水滴本身）；
        // 无封面时，雨滴有关外档位画渐变底、0 关画深色底（保持旧观感）。
        const cover = this.options.getCoverImage();
        if (cover || toggles.rainMode > 0) {
            const bg = this.ensureBackground(width, height);
            if (bg) {
                ctx.drawImage(bg, 0, 0);
            }
            // 封面取色晕染：主色径向晕开、边缘淡出，给模糊底加一层 Monet 味；
            // 封面元素在画布上层，不会被盖住。无取色时不画，保持旧观感。
            if (cover && this.coverColor) {
                const wash = ctx.createRadialGradient(
                    width / 2,
                    height / 2,
                    0,
                    width / 2,
                    height / 2,
                    Math.max(width, height) / 2
                );
                wash.addColorStop(0, hexToRgba(this.coverColor, 0.32));
                wash.addColorStop(1, hexToRgba(this.coverColor, 0));
                ctx.fillStyle = wash;
                ctx.fillRect(0, 0, width, height);
            }
        } else {
            ctx.fillStyle = '#14101c';
            ctx.fillRect(0, 0, width, height);
        }

        if (toggles.stars) {
            this.drawStars(ctx, width, height, time, animated);
        }
        if (toggles.particles) {
            this.drawParticles(ctx, width, height, energy, animated);
        }
        if (toggles.rainMode === 2) {
            this.drawRain(ctx, width, height, animated);
        } else if (toggles.rainMode === 1) {
            // 静态档：水滴单独给 animated=false，下滑滴不动；其余层不受影响。
            this.drawRain(ctx, width, height, false);
        }
        // 剑来画在最上层：剑光斜划＋诗句，静态帧不画。
        if (toggles.sword && animated) {
            this.drawSword(ctx, width, height);
        }

        // 脉动作用在封面元素上，不在画布里画。辉光颜色跟封面主色走，
        // 采不到时回落旧的主题粉。
        if (toggles.pulse) {
            const glow = this.coverColor ?? '#e8a0bf';
            if (energy !== null) {
                const scale = 1 + energy * 0.06;
                this.coverElement.style.transform = `scale(${scale.toFixed(3)})`;
                this.coverElement.style.boxShadow = `0 0 ${Math.round(
                    12 + energy * 36
                )}px ${hexToRgba(glow, 0.35 + energy * 0.45)}`;
            } else if (animated) {
                // 降级呼吸：跟随播放状态的缓慢呼吸，不伪造频谱。
                const scale = 1 + 0.02 * Math.sin(time / 900);
                this.coverElement.style.transform = `scale(${scale.toFixed(3)})`;
                this.coverElement.style.boxShadow = `0 0 18px ${hexToRgba(glow, 0.4)}`;
            } else {
                this.coverElement.style.transform = 'scale(1)';
                this.coverElement.style.boxShadow = '';
            }
        } else {
            this.coverElement.style.transform = '';
            this.coverElement.style.boxShadow = '';
        }

        void cssWidth;
        void cssHeight;
    }

    // 底图离屏缓存：封面或尺寸没变就复用，省掉每帧一次全屏模糊；
    // 与主画布同尺寸同坐标。这张是糊图（可见背景的糊就来自它本身，
    // 无 CSS filter 参与）；水滴折射不采它，采同批维护的锐图
    // sharpCanvas（见函数尾）。
    private ensureBackground(width: number, height: number): HTMLCanvasElement | null {
        const cover = this.options.getCoverImage();
        const coverSrc =
            cover && cover.complete && cover.naturalWidth > 0 ? cover.src : 'none';
        // 封面换了就重采主色（异步；采到后强制重画一帧让晕染与辉光生效，
        // 静态帧下也要把 staticDrawn 清掉，否则 poke() 不重画）。
        if (coverSrc !== 'none' && coverSrc !== this.coverColorSrc) {
            this.coverColorSrc = coverSrc;
            this.coverColor = null;
            void sampleCoverColor(coverSrc).then((hex) => {
                if (hex && this.coverColorSrc === coverSrc) {
                    this.coverColor = hex;
                    this.staticDrawn = false;
                    this.poke();
                }
            });
        }
        const key = `${width}x${height}|${coverSrc}`;
        if (this.bgCanvas && this.bgKey === key) {
            return this.bgCanvas;
        }
        const bg = document.createElement('canvas');
        bg.width = width;
        bg.height = height;
        const bctx = bg.getContext('2d');
        if (!bctx) {
            return null;
        }
        bctx.save();
        try {
            if (cover && cover.complete && cover.naturalWidth > 0) {
                bctx.filter = 'blur(28px) brightness(0.85) saturate(1.4)';
                const scale = Math.max(
                    width / cover.naturalWidth,
                    height / cover.naturalHeight
                );
                const drawWidth = cover.naturalWidth * scale;
                const drawHeight = cover.naturalHeight * scale;
                bctx.drawImage(
                    cover,
                    (width - drawWidth) / 2,
                    (height - drawHeight) / 2,
                    drawWidth,
                    drawHeight
                );
            } else {
                const gradient = bctx.createLinearGradient(0, 0, 0, height);
                gradient.addColorStop(0, '#2a1a30');
                gradient.addColorStop(1, '#14101c');
                bctx.fillStyle = gradient;
                bctx.fillRect(0, 0, width, height);
            }
        } catch {
            bctx.fillStyle = '#1c1424';
            bctx.fillRect(0, 0, width, height);
        } finally {
            bctx.filter = 'none';
            bctx.restore();
        }
        // 锐图采样源（0.1.143）：同一张封面、同一 cover 映射，但不加
        // 任何 filter——背景原图直绘。水滴折射采它，才有「背景糊、滴
        // 里锐」的照片感。与 bgCanvas 同批重建（同 key 门控）；可见
        // 背景的呈现仍只由上面的糊底负责，这张不直接出画。
        const sharp = document.createElement('canvas');
        sharp.width = width;
        sharp.height = height;
        const sctx = sharp.getContext('2d');
        if (sctx) {
            try {
                if (cover && cover.complete && cover.naturalWidth > 0) {
                    const scale = Math.max(
                        width / cover.naturalWidth,
                        height / cover.naturalHeight
                    );
                    const drawWidth = cover.naturalWidth * scale;
                    const drawHeight = cover.naturalHeight * scale;
                    sctx.drawImage(
                        cover,
                        (width - drawWidth) / 2,
                        (height - drawHeight) / 2,
                        drawWidth,
                        drawHeight
                    );
                } else {
                    const gradient = sctx.createLinearGradient(0, 0, 0, height);
                    gradient.addColorStop(0, '#2a1a30');
                    gradient.addColorStop(1, '#14101c');
                    sctx.fillStyle = gradient;
                    sctx.fillRect(0, 0, width, height);
                }
            } catch {
                sctx.fillStyle = '#1c1424';
                sctx.fillRect(0, 0, width, height);
            }
        }
        this.sharpCanvas = sharp;
        this.bgCanvas = bg;
        this.bgKey = key;
        return bg;
    }

    private drawRain(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        animated: boolean
    ): void {
        const cssWidth = this.canvas.clientWidth || width;
        const cssHeight = this.canvas.clientHeight || height;
        const scaleX = width / cssWidth;
        const scaleY = height / cssHeight;
        ctx.save();
        // 大光斑：失焦的光点，只做深度，不动（与水滴是两回事，保留）。
        for (const spot of this.bokeh) {
            ctx.fillStyle = `rgba(255, 255, 255, ${spot.alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(spot.x * scaleX, spot.y * scaleY, spot.radius * scaleX, 0, Math.PI * 2);
            ctx.fill();
        }
        // 静态水滴：预渲染层整张贴入（团块/中滴/细水点都在里面）。
        const layer = this.ensureStaticRain(width, height, scaleX, scaleY);
        if (layer) {
            ctx.drawImage(layer, 0, 0);
        }
        // 下滑滴：保持旧量级逐帧活绘（移动/拖尾形态不变，滴身换新引擎）。
        for (const drop of this.drops) {
            if (animated && drop.speed > 0) {
                drop.y += drop.speed;
                if (drop.y - drop.trail > cssHeight) {
                    drop.y = -drop.trail;
                    drop.x = Math.random() * cssWidth;
                }
            }
            const x = drop.x * scaleX;
            const y = drop.y * scaleY;
            const r = drop.radius * scaleX;
            // 下滑拖尾：从滴的上方渐淡到滴本身。
            if (drop.trail > 0) {
                ctx.strokeStyle = 'rgba(200, 220, 255, 0.28)';
                ctx.lineWidth = Math.max(1, r * 0.25);
                ctx.beginPath();
                ctx.moveTo(x, y - drop.trail * scaleY);
                ctx.lineTo(x, y);
                ctx.stroke();
            }
            // 滴身：照片级折射引擎（团块/采样口径见 paintRefractionDrop）。
            this.paintRefractionDrop(ctx, x, y, r, r, [], drop.sparks, drop.squash);
        }
        ctx.restore();
    }

    // 静态水滴预渲染层（性能红线）：团块＋中滴＋细水点全部只在这里画
    // 一次，进与画布同尺寸的离屏；key 含底图 key 与播种尺寸，背景/
    // 尺寸/重播种任一变化才重建。每帧 drawRain 只 drawImage 本层，
    // 绝不逐帧对静态滴重采样。
    private ensureStaticRain(
        width: number,
        height: number,
        scaleX: number,
        scaleY: number
    ): HTMLCanvasElement | null {
        const key = `${width}x${height}|${this.bgKey}|${this.seededWidth}x${this.seededHeight}`;
        if (this.rainLayer && this.rainLayerKey === key) {
            return this.rainLayer;
        }
        const layer = document.createElement('canvas');
        layer.width = width;
        layer.height = height;
        const lctx = layer.getContext('2d');
        if (!lctx) {
            return null;
        }
        for (const blob of this.staticBlobs) {
            this.paintRefractionDrop(
                lctx,
                blob.x * scaleX,
                blob.y * scaleY,
                blob.radius * scaleX,
                blob.extent * scaleX,
                blob.satellites.map((s) => ({
                    dx: s.dx * scaleX,
                    dy: s.dy * scaleY,
                    radius: s.radius * scaleX
                })),
                blob.sparks,
                blob.squash
            );
        }
        for (const mid of this.staticMids) {
            this.paintRefractionDrop(
                lctx,
                mid.x * scaleX,
                mid.y * scaleY,
                mid.radius * scaleX,
                mid.extent * scaleX,
                [],
                mid.sparks,
                mid.squash
            );
        }
        // 细水点：不采样，只一层淡芯＋左上一个白亮点；单颗极小，
        // 靠数量成满铺的细密水雾感。
        for (const sp of this.staticSpeckles) {
            const x = sp.x * scaleX;
            const y = sp.y * scaleY;
            const r = Math.max(0.8, sp.radius * scaleX);
            lctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
            lctx.beginPath();
            lctx.arc(x, y, r, 0, Math.PI * 2);
            lctx.fill();
            lctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            lctx.beginPath();
            lctx.arc(x - r * 0.3, y - r * 0.35, Math.max(0.4, r * 0.32), 0, Math.PI * 2);
            lctx.fill();
        }
        this.rainLayer = layer;
        this.rainLayerKey = key;
        return layer;
    }

    // 单颗采样滴的画法（照片级折射引擎，与歌词卡 lyric-drops.ts 同口径）：
    // 形状 = 主圆＋卫星圆的并集 path（satellites 为空即单圆）；采样采
    // 锐图 sharpCanvas（未模糊原图），以包围圆定窗、上下翻转＋
    // REFRACTION_ZOOM 放大、REFRACTION_ALPHA 近实绘入 clip——滴里是
    // 锐的倒像、滴外是糊的正像，照片感来自这组反差。收尾只做下缘
    // 一段细亮弧＋种子定死的偏边高光火花：无整圈描边、无正中白点
    // （那是旧画法「珍珠感」的来源，已废除）。
    // cx/cy/r/extent/卫星均为设备 px；调用方（预渲染层/下滑滴）负责换算。
    private paintRefractionDrop(
        ctx: CanvasRenderingContext2D,
        cx: number,
        cy: number,
        r: number,
        extent: number,
        satellites: Array<{ dx: number; dy: number; radius: number }>,
        sparks: Array<{ dx: number; dy: number; radius: number }>,
        squash: number
    ): void {
        const sharp = this.sharpCanvas ?? this.bgCanvas;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, squash);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        for (const sat of satellites) {
            ctx.arc(sat.dx, sat.dy, sat.radius, 0, Math.PI * 2);
        }
        ctx.save();
        ctx.clip();
        if (sharp) {
            // 采样窗：边长 = 包围直径 / REFRACTION_ZOOM（窗比滴小，
            // 绘进滴内即放大）；窗心钳进锐图内，贴边滴不采空。
            const srcSize = (extent * 2) / REFRACTION_ZOOM;
            let scx = cx;
            let scy = cy;
            if (sharp.width >= srcSize) {
                scx = Math.min(Math.max(cx, srcSize / 2), sharp.width - srcSize / 2);
            }
            if (sharp.height >= srcSize) {
                scy = Math.min(Math.max(cy, srcSize / 2), sharp.height - srcSize / 2);
            }
            // 上下翻转：局部再叠一层 scale(1, -1)，采样图以倒像绘入
            // （与 squash 的纵向缩放叠乘，形状仍与 clip 一致）。
            ctx.save();
            ctx.scale(1, -1);
            ctx.globalAlpha = REFRACTION_ALPHA;
            ctx.drawImage(
                sharp,
                scx - srcSize / 2,
                scy - srcSize / 2,
                srcSize,
                srcSize,
                -extent,
                -extent,
                extent * 2,
                extent * 2
            );
            ctx.restore();
        } else {
            // 无任何底图可采（离屏建立失败）：极淡芯兜底，形状可读即可。
            ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
            ctx.fill();
        }
        ctx.restore();
        // 下缘细亮弧：只压主圆下缘一段，是光从滴底透出的亮边。
        const rimWidth = Math.max(1, r * 0.06);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = rimWidth;
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(0.5, r - rimWidth / 2), Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        // 高光火花：种子定死的偏边小亮点（主火花左上、二号在右侧），
        // 位置/大小都是相对主圆半径的比例，不居中、不逐帧变。
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        for (const spark of sparks) {
            ctx.beginPath();
            ctx.arc(
                spark.dx * r,
                spark.dy * r,
                Math.max(0.6, spark.radius * r),
                0,
                Math.PI * 2
            );
            ctx.fill();
        }
        ctx.restore();
    }

    private drawParticles(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        energy: number | null,
        animated: boolean
    ): void {
        const cssWidth = this.canvas.clientWidth || width;
        const cssHeight = this.canvas.clientHeight || height;
        const scaleX = width / cssWidth;
        const scaleY = height / cssHeight;
        // 有频谱时速度与大小随能量放大；无频谱时只做氛围慢动。
        const boost = energy !== null ? 0.6 + energy * 1.8 : 0.6;
        ctx.save();
        ctx.fillStyle = 'rgba(232, 160, 191, 0.85)';
        for (const particle of this.particles) {
            if (animated) {
                particle.x += particle.vx * boost;
                particle.y += particle.vy * boost;
                if (particle.x < 0 || particle.x > cssWidth) {
                    particle.vx *= -1;
                }
                if (particle.y < 0 || particle.y > cssHeight) {
                    particle.vy *= -1;
                }
            }
            const size = particle.size * (energy !== null ? 0.8 + energy * 1.4 : 1);
            ctx.beginPath();
            ctx.arc(
                particle.x * scaleX,
                particle.y * scaleY,
                size * scaleX,
                0,
                Math.PI * 2
            );
            ctx.fill();
        }
        ctx.restore();
    }

    private drawStars(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        time: number,
        animated: boolean
    ): void {
        const cssWidth = this.canvas.clientWidth || width;
        const cssHeight = this.canvas.clientHeight || height;
        const scaleX = width / cssWidth;
        const scaleY = height / cssHeight;
        ctx.save();
        for (const star of this.stars) {
            const tick = animated ? time / 1000 : 0;
            if (animated) {
                star.y += 0.02 * star.speed;
                if (star.y > cssHeight) {
                    star.y = 0;
                    star.x = Math.random() * cssWidth;
                }
            }
            const alpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tick * star.speed + star.phase));
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(
                star.x * scaleX,
                star.y * scaleY,
                star.radius * scaleX,
                0,
                Math.PI * 2
            );
            ctx.fill();
        }
        ctx.restore();
    }

    // 剑来：0–0.55s 剑光自左上斜划到右下（带拖尾与出鞘闪光），
    // 0.45s 起诗句逐字浮现（两行），2.8–3.4s 整体淡出；
    // 诗句放画面下方空带，避开中央封面与歌词区。
    private drawSword(ctx: CanvasRenderingContext2D, width: number, height: number): void {
        if (this.swordStart === null) {
            return;
        }
        const elapsed = (performance.now() - this.swordStart) / 1000;
        const total = 3.4;
        if (elapsed >= total) {
            this.swordStart = null;
            return;
        }
        const cssWidth = this.canvas.clientWidth || width;
        const cssHeight = this.canvas.clientHeight || height;
        const scaleX = width / cssWidth;
        const scaleY = height / cssHeight;
        ctx.save();
        // 出鞘闪光：前 0.15s 全屏微亮后迅速收掉。
        if (elapsed < 0.15) {
            ctx.fillStyle = `rgba(255, 255, 255, ${(0.1 * (1 - elapsed / 0.15)).toFixed(3)})`;
            ctx.fillRect(0, 0, width, height);
        }
        // 剑光斜划：起点左上、终点右下，拖尾约占全程 35%，划完 0.55s 后淡出。
        const slashDuration = 0.55;
        const slashFade = 0.55;
        const fromX = cssWidth * 0.05;
        const fromY = cssHeight * 0.1;
        const toX = cssWidth * 0.95;
        const toY = cssHeight * 0.7;
        const progress = Math.min(1, elapsed / slashDuration);
        const headX = fromX + (toX - fromX) * progress;
        const headY = fromY + (toY - fromY) * progress;
        const tailX = fromX + (toX - fromX) * Math.max(0, progress - 0.35);
        const tailY = fromY + (toY - fromY) * Math.max(0, progress - 0.35);
        let slashAlpha = 1;
        if (elapsed > slashDuration) {
            slashAlpha = Math.max(0, 1 - (elapsed - slashDuration) / slashFade);
        }
        if (slashAlpha > 0) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.shadowColor = 'rgba(232, 160, 191, 0.9)';
            ctx.shadowBlur = 24 * scaleX;
            ctx.strokeStyle = `rgba(232, 160, 191, ${(0.5 * slashAlpha).toFixed(3)})`;
            ctx.lineWidth = 10 * scaleX;
            ctx.beginPath();
            ctx.moveTo(tailX * scaleX, tailY * scaleY);
            ctx.lineTo(headX * scaleX, headY * scaleY);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = `rgba(255, 255, 255, ${slashAlpha.toFixed(3)})`;
            ctx.lineWidth = 3 * scaleX;
            ctx.beginPath();
            ctx.moveTo(tailX * scaleX, tailY * scaleY);
            ctx.lineTo(headX * scaleX, headY * scaleY);
            ctx.stroke();
            ctx.restore();
        }
        // 诗句逐字：0.45s 起、每字 0.13s，两行共 13 字，2.8s 起淡出。
        const line1 = '我有一剑，';
        const line2 = '可开天、辟地……';
        const textStart = 0.45;
        const perChar = 0.13;
        const shown = Math.max(
            0,
            Math.min(13, Math.floor((elapsed - textStart) / perChar))
        );
        if (shown > 0) {
            let textAlpha = Math.min(1, (elapsed - textStart) / 0.2);
            if (elapsed > 2.8) {
                textAlpha *= Math.max(0, (total - elapsed) / 0.6);
            }
            const fontSize = Math.max(20, Math.min(30, cssWidth * 0.062));
            const centerX = (cssWidth / 2) * scaleX;
            const baseY = cssHeight * 0.82 * scaleY;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `600 ${Math.round(fontSize * scaleX)}px sans-serif`;
            ctx.shadowColor = 'rgba(232, 160, 191, 0.9)';
            ctx.shadowBlur = 18 * scaleX;
            ctx.lineWidth = 4 * scaleX;
            ctx.strokeStyle = `rgba(0, 0, 0, ${(0.45 * textAlpha).toFixed(3)})`;
            ctx.fillStyle = `rgba(255, 255, 255, ${textAlpha.toFixed(3)})`;
            const visible1 = line1.slice(0, Math.min(shown, line1.length));
            const visible2 =
                shown > line1.length ? line2.slice(0, shown - line1.length) : '';
            if (visible1) {
                ctx.strokeText(visible1, centerX, baseY - fontSize * scaleX * 0.8);
                ctx.fillText(visible1, centerX, baseY - fontSize * scaleX * 0.8);
            }
            if (visible2) {
                ctx.strokeText(visible2, centerX, baseY + fontSize * scaleX * 0.8);
                ctx.fillText(visible2, centerX, baseY + fontSize * scaleX * 0.8);
            }
        }
        ctx.restore();
    }
}
