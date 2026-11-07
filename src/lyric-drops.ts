// 歌词卡水滴（0.1.138）：把全屏视觉舞台（visuals.ts）的玻璃水滴落到
// 播放页歌词卡面上——用户参照的雨滴玻璃歌词页：重模糊封面作底，磨砂
// 卡面上覆盖带折射/高光的水珠。
//
// 0.1.139 两改（用户装 0.1.138 回图后下令）：
// - 「改成滴压」：层位由 CSS z-index 抬到歌词内容之上（见 style.css
//   .lyric-card-drops），水滴压在歌词字上，与参照照片一致。
// - 去「黑珍珠」：0.1.138 的滴在深色封面上是深色实心圆＋白点，像黑
//   泡泡——根子是透镜采样取了 brightness 0.72 的暗底图、整圆实画，
//   再叠整圈暗边。本版透镜改采一份提亮版离屏（brightness≈1.05），滴
//   内比卡面略亮略鲜；小滴改透明中心，只靠 1px 亮边、高光点和底部
//   一弧极淡阴影成形，不再整圆压底、不再整圈暗边。
//
// 画法与手感搬自 visuals.ts 的 drawRain / ensureBackground（静止圆滴的
// 透镜采样、亮边＋高光点、下滑滴拖尾、大光斑柔光），按卡面尺寸等比
// 缩了密度与半径，在这里自带一份精简实现；visuals.ts 本体不动，全屏
// 舞台行为不受影响。
//
// 透镜底图：自维护两张与卡同尺寸（设备像素）的离屏画布——暗版与卡面
// .lyric-card-bg 同滤镜（blur＋saturate＋brightness 0.72，保留作口径
// 对照），提亮版 blur 同步、brightness≈1.05 供透镜采样；大滴从提亮版
// 按滴的位置放大采样（与 visuals.ts 同口径的 1.3 倍），滴里看到的是
// 卡底封面提亮后的扭曲映像。无封面时离屏留空，滴只画边线＋高光，
// 在卡的渐变底上照样成立。
//
// 档位跟随视觉开关 rainMode（同一份存储 zhixiang.visual.toggles，不
// 新增设置项）：0 关＝canvas 隐藏不画；1 静态＝画一帧静止滴，封面或
// 卡尺寸变了才重画；2 动态＝rAF 动画（下滑滴滑落、光斑微动、亮边呼吸）。
//
// 动画纪律同 VisualStage 的 poke/suspend：只在外部告知「已呈现」
// （播放页打开、歌词卡显示中、未折叠）且 document 可见时跑 rAF，
// 其余一律停画不空转；document 隐藏停、恢复可见由监听 poke 回来。

interface Drop {
    x: number;
    y: number;
    radius: number;
    speed: number;
    trail: number;
    phase: number;
}

interface Bokeh {
    x: number;
    y: number;
    radius: number;
    alpha: number;
    phase: number;
}

export interface LyricDropsOptions {
    /** 播放页打开、歌词卡显示中、未折叠——三者齐了水滴才露面/才动。 */
    isPresented: () => boolean;
}

export class LyricDrops {
    private canvas: HTMLCanvasElement;
    private context: CanvasRenderingContext2D | null;
    private options: LyricDropsOptions;
    private mode = 0;
    private rafId: number | null = null;
    private running = false;
    private drops: Drop[] = [];
    private bokeh: Bokeh[] = [];
    private seededWidth = 0;
    private seededHeight = 0;
    private bgCanvas: HTMLCanvasElement | null = null;
    // 提亮采样源（0.1.139）：与 bgCanvas 同步重建，透镜滴只采这一份。
    private bgBrightCanvas: HTMLCanvasElement | null = null;
    private bgKey = '';
    private coverImage: HTMLImageElement | null = null;
    private coverSrc = '';
    private coverReady = false;
    private onVisibilityChange = (): void => {
        if (!document.hidden) {
            this.poke();
        }
    };

    constructor(canvas: HTMLCanvasElement, options: LyricDropsOptions) {
        this.canvas = canvas;
        this.options = options;
        this.context = canvas.getContext('2d');
        // 模式由外部紧接着 setMode 定，先藏起来免得空画布闪一帧。
        this.canvas.hidden = true;
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    /** 雨滴档位（0 关 / 1 静态 / 2 动态），跟视觉开关 rainMode 走。 */
    setMode(mode: number): void {
        this.mode = mode >= 0 && mode <= 2 ? mode : 0;
        this.poke();
    }

    /** 封面图源，与卡面 .lyric-card-bg 完全同源同歩（空串＝无封面）。 */
    setCover(src: string): void {
        if (src === this.coverSrc) {
            return;
        }
        this.coverSrc = src;
        this.coverReady = false;
        this.coverImage = null;
        this.bgKey = '';
        if (!src) {
            this.bgCanvas = null;
            this.bgBrightCanvas = null;
            this.poke();
            return;
        }
        const img = new Image();
        img.onload = (): void => {
            // 加载期间又切了歌：旧图作废，别把上一首的底盖上来。
            if (this.coverSrc !== src) {
                return;
            }
            this.coverImage = img;
            this.coverReady = true;
            this.bgKey = '';
            this.poke();
        };
        img.onerror = (): void => {
            if (this.coverSrc !== src) {
                return;
            }
            this.coverImage = null;
            this.coverReady = false;
            this.bgKey = '';
            this.poke();
        };
        img.src = src;
    }

    /** 尺寸可能变了（开页、窗口旋转/缩放）：重同步后按当前档位重画。 */
    resize(): void {
        this.poke();
    }

    // 状态变化后调用：该露面就画（静态一帧/动态起循环），不该就停。
    poke(): void {
        const presented = this.options.isPresented();
        this.canvas.hidden = this.mode === 0 || !presented;
        if (this.mode === 0 || !presented || document.hidden) {
            this.stopLoop();
            return;
        }
        this.syncSize();
        if (this.mode === 1) {
            // 静态档：画一帧就停，不空转 rAF；封面/尺寸变化时外部会再 poke。
            this.drawFrame(0, false);
            this.stopLoop();
            return;
        }
        if (!this.running) {
            this.running = true;
            const step = (time: number): void => {
                if (!this.running) {
                    return;
                }
                if (document.hidden || this.mode !== 2 || !this.options.isPresented()) {
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

    private stopLoop(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.running = false;
    }

    private syncSize(): void {
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (width <= 1 || height <= 1) {
            // 卡还没布局/被藏起来时尺寸为 0，不动现有画布，等可见时再同步。
            return;
        }
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
            this.canvas.width = width * ratio;
            this.canvas.height = height * ratio;
        }
        this.seed(width, height);
        this.rebuildBackground();
    }

    private seed(width: number, height: number): void {
        if (
            width === this.seededWidth &&
            height === this.seededHeight &&
            this.drops.length > 0
        ) {
            return;
        }
        this.seededWidth = width;
        this.seededHeight = height;
        this.drops = [];
        this.bokeh = [];
        const area = width * height;
        // 密度按卡面积换算：参照密铺观感，以约 300×260 的卡面给静止滴
        // 约 50 颗为锚（每 1600px² 一颗），密度总数不减；半径 3–12px
        // （0.1.139 上限从 14 收到 12、指数 1.6→1.9 更偏小头），大滴
        // （透镜滴）占比压下来，免得几颗大滴压字面积太招摇；
        // 卡变大变小都按面积等比增减，钳住上下限免得极端尺寸失真。
        const stillCount = Math.round(Math.min(90, Math.max(16, area / 1600)));
        for (let i = 0; i < stillCount; i++) {
            this.drops.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius: 3 + Math.pow(Math.random(), 1.9) * 9,
                speed: 0,
                trail: 0,
                phase: Math.random() * Math.PI * 2
            });
        }
        // 下滑滴：全屏舞台是 16 颗/整屏，卡面按面积约 5 颗；半径 5–11
        // （0.1.139 同步收小），生长感靠速度慢、拖尾短先立住，
        // 滑落→出界→顶部重生。
        const sliderCount = Math.round(Math.min(8, Math.max(2, area / 16000)));
        for (let i = 0; i < sliderCount; i++) {
            this.drops.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius: 5 + Math.random() * 6,
                speed: 0.25 + Math.random() * 0.45,
                trail: 14 + Math.random() * 26,
                phase: Math.random() * Math.PI * 2
            });
        }
        // 大光斑：只做柔光深度，半径按卡面缩（全屏 30–80 → 卡面 22–58）。
        const bokehCount = Math.round(Math.min(6, Math.max(2, area / 26000)));
        for (let i = 0; i < bokehCount; i++) {
            this.bokeh.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius: 22 + Math.random() * 36,
                alpha: 0.05 + Math.random() * 0.07,
                phase: Math.random() * Math.PI * 2
            });
        }
    }

    // 透镜底图离屏缓存：封面或尺寸没变就复用（键同 visuals.ts 口径）；
    // 无封面时置空，drawDrops 自动退回无透镜画法。
    private rebuildBackground(): void {
        const width = this.canvas.width;
        const height = this.canvas.height;
        const key = `${width}x${height}|${this.coverReady ? this.coverSrc : 'none'}`;
        if (this.bgCanvas && this.bgKey === key) {
            return;
        }
        this.bgKey = key;
        const img = this.coverImage;
        if (!this.coverReady || !img || img.naturalWidth <= 0 || width <= 1 || height <= 1) {
            this.bgCanvas = null;
            this.bgBrightCanvas = null;
            return;
        }
        // 与卡面 .lyric-card-bg 同观感：blur 28px 是 CSS 像素口径，离屏在
        // 设备像素上画，半径按倍率折算；saturate/brightness 与 CSS 一致。
        const ratio = this.seededWidth > 0 ? width / this.seededWidth : 1;
        const blurPx = Math.round(24 * ratio);
        const paint = (filter: string): HTMLCanvasElement | null => {
            const target = document.createElement('canvas');
            target.width = width;
            target.height = height;
            const tctx = target.getContext('2d');
            if (!tctx) {
                return null;
            }
            tctx.save();
            try {
                tctx.filter = filter;
                const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
                const drawWidth = img.naturalWidth * scale;
                const drawHeight = img.naturalHeight * scale;
                tctx.drawImage(
                    img,
                    (width - drawWidth) / 2,
                    (height - drawHeight) / 2,
                    drawWidth,
                    drawHeight
                );
                return target;
            } catch {
                // 图源跨域/损坏时 drawImage 可能抛错：无透镜兜底，不掀翻整卡。
                return null;
            } finally {
                tctx.filter = 'none';
                tctx.restore();
            }
        };
        this.bgCanvas = paint(`blur(${blurPx}px) saturate(1.25) brightness(0.72)`);
        // 提亮采样源（0.1.139）：同一封面多画一份，blur 同步、亮度回到
        // ≈1.05、饱和略提——透镜滴只采它，滴内图比卡面略亮略鲜，不再
        // 把暗底图的近黑采样整圆实画成黑珍珠。离屏重建时一次画好，
        // 不在每帧每滴上用 ctx.filter。
        this.bgBrightCanvas = paint(`blur(${blurPx}px) saturate(1.35) brightness(1.05)`);
    }

    private drawFrame(time: number, animated: boolean): void {
        const ctx = this.context;
        if (!ctx) {
            return;
        }
        const width = this.canvas.width;
        const height = this.canvas.height;
        ctx.clearRect(0, 0, width, height);
        this.drawDrops(ctx, width, height, time, animated);
    }

    // 水滴本体：画法逐项对着 visuals.ts 的 drawRain 搬（坐标同它一样存
    // CSS 像素、绘制时按 scale 换到设备像素），只多光斑微动一项。
    private drawDrops(
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
        const tick = animated ? performance.now() / 1000 : 0;
        ctx.save();
        // 大光斑：失焦柔光，只做深度；动态档给几像素的正弦微动（全屏版
        // 是静止的，卡面小，微动才看得出「活气」），静态帧不偏移。
        for (const spot of this.bokeh) {
            const driftX = animated ? Math.sin(time / 2600 + spot.phase) * 4 : 0;
            const driftY = animated ? Math.cos(time / 3200 + spot.phase) * 3 : 0;
            ctx.fillStyle = `rgba(255, 255, 255, ${spot.alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(
                (spot.x + driftX) * scaleX,
                (spot.y + driftY) * scaleY,
                spot.radius * scaleX,
                0,
                Math.PI * 2
            );
            ctx.fill();
        }
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
            // 下滑拖尾（0.1.139）：半透明白色渐变细线，尾端全透明、近滴
            // 处 0.35——水痕是亮的，不再用偏蓝深色线。
            if (drop.trail > 0) {
                const trailTop = y - drop.trail * scaleY;
                const gradient = ctx.createLinearGradient(0, trailTop, 0, y);
                gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
                gradient.addColorStop(1, 'rgba(255, 255, 255, 0.35)');
                ctx.strokeStyle = gradient;
                ctx.lineWidth = Math.max(1, r * 0.25);
                ctx.beginPath();
                ctx.moveTo(x, trailTop);
                ctx.lineTo(x, y);
                ctx.stroke();
            }
            // 圆滴（0.1.139 质感改版，顺序固定）：
            // 大滴（CSS 半径 ≥6）走透镜——clip 圆 → 画提亮采样 → 底部内
            // 阴影弧 → 亮边 → 高光点；透镜只采提亮版离屏（bgBrightCanvas，
            // 缺失时退暗版），滴内图比周围卡面略亮略鲜，不再是黑盘子。
            // 小滴/贴边滴/无封面：透明中心，不整圆压底、不整圈暗边——只
            // 画底部一弧极淡阴影、1px 亮边（rgba(255,255,255,0.38)）、
            // 左上高光点，靠这三样在玻璃上成形。
            const shimmer = 0.4 + 0.25 * Math.sin(tick * 0.8 + drop.phase);
            const rimWidth = Math.max(1, scaleX);
            const shadowWidth = Math.max(1.5, scaleX * 1.5);
            const drawBottomShadow = (): void => {
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
                ctx.lineWidth = shadowWidth;
                ctx.beginPath();
                ctx.arc(
                    x,
                    y,
                    Math.max(0.5, r - shadowWidth / 2),
                    Math.PI * 0.15,
                    Math.PI * 0.85
                );
                ctx.stroke();
            };
            const srcSize = (r * 2) / 1.3;
            const lensSrc = this.bgBrightCanvas ?? this.bgCanvas;
            if (
                lensSrc &&
                drop.radius >= 6 &&
                x - srcSize / 2 >= 0 &&
                y - srcSize / 2 >= 0 &&
                x + srcSize / 2 <= width &&
                y + srcSize / 2 <= height
            ) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(
                    lensSrc,
                    x - srcSize / 2,
                    y - srcSize / 2,
                    srcSize,
                    srcSize,
                    x - r,
                    y - r,
                    r * 2,
                    r * 2
                );
                drawBottomShadow();
                ctx.restore();
                ctx.strokeStyle = `rgba(255, 255, 255, ${shimmer.toFixed(3)})`;
                ctx.lineWidth = rimWidth;
                ctx.beginPath();
                ctx.arc(x, y, Math.max(0.5, r - rimWidth / 2), 0, Math.PI * 2);
                ctx.stroke();
            } else {
                drawBottomShadow();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
                ctx.lineWidth = rimWidth;
                ctx.beginPath();
                ctx.arc(x, y, Math.max(0.5, r - rimWidth / 2), 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.beginPath();
            ctx.arc(x - r * 0.3, y - r * 0.3, Math.max(0.8, r * 0.22), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }
}
