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
// 0.1.140 再调（用户看 0.1.139 真机图后拍板「滴清透」）：提亮版在饱和
// 封面（蓝绿）上又把颜色原样吸进滴里还更艳，成了亮蓝糖豆——真水滴
// 近乎清透、只带淡色调。本版提亮版离屏改走降饱和＋更高提亮
// （saturate 0.55、brightness 1.18），透镜画完采样再在 clip 内叠一层
// rgba(255,255,255,0.16) 的白再冲淡一档，滴内只留淡色调。
//
// 0.1.141 画法重画（用户看 0.1.140 真机图判「还是蓝珍珠」，点名要参
// 照图《刀马旦》那种滴压）：连栽三版的教训是**滴身实填**——采样整圆
// 不透明画上去就是盘子，降饱和/提亮只是换个颜色的盘子。本版滴身改
// 透、靠光影结构成形：透镜采样只以 LENS_ALPHA 半透叠加（卡面从滴里
// 透出）；底部一道月牙亮光（光穿过滴身在底部聚焦）＋顶部内侧一弧薄
// 影，一亮一暗撑体积；高光改左上偏置的小椭圆＋一颗次级小点（正中大
// 白点是珍珠/眼睛感的元凶）；外圈亮边下半强、上半弱，不画均匀描边
// 圆；每滴带 seed 时定死的微椭圆系数（0.92–1.0），去掉正圆盘感。
//
// 画法与手感搬自 visuals.ts 的 drawRain / ensureBackground（静止圆滴的
// 透镜采样、亮边＋高光点、下滑滴拖尾、大光斑柔光），按卡面尺寸等比
// 缩了密度与半径，在这里自带一份精简实现；visuals.ts 本体不动，全屏
// 舞台行为不受影响。
//
// 透镜底图：自维护两张与卡同尺寸（设备像素）的离屏画布——暗版与卡面
// .lyric-card-bg 同滤镜（blur＋saturate＋brightness 0.72，保留作口径
// 对照），清透版 blur 同步、saturate 0.55＋brightness 1.18 供透镜采样
// （0.1.140：降饱和只留淡色调，见文件头）；大滴从清透版按滴的位置
// 放大采样（与 visuals.ts 同口径的 1.3 倍），滴里看到的是卡底封面
// 清透化后的扭曲映像。无封面时离屏留空，滴只画边线＋高光，在卡的
// 渐变底上照样成立。
//
// 档位跟随视觉开关 rainMode（同一份存储 zhixiang.visual.toggles，不
// 新增设置项）：0 关＝canvas 隐藏不画；1 静态＝画一帧静止滴，封面或
// 卡尺寸变了才重画；2 动态＝rAF 动画（下滑滴滑落、光斑微动、亮边呼吸）。
//
// 动画纪律同 VisualStage 的 poke/suspend：只在外部告知「已呈现」
// （播放页打开、歌词卡显示中、未折叠）且 document 可见时跑 rAF，
// 其余一律停画不空转；document 隐藏停、恢复可见由监听 poke 回来。

// 透镜滴采样叠加的不透明度（0.1.141）：滴身半透是本版画法的根，
// 调滴的「实/透」只动这一个数。
const LENS_ALPHA = 0.45;

interface Drop {
    x: number;
    y: number;
    radius: number;
    speed: number;
    trail: number;
    phase: number;
    /** 纵向微椭圆系数（0.92–1.0，seed 时定死、逐帧不变）：去正圆盘感。 */
    squash: number;
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
    // 清透采样源（0.1.139 建、0.1.140 改降饱和口径）：与 bgCanvas 同步
    // 重建，透镜滴只采这一份。
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
                phase: Math.random() * Math.PI * 2,
                squash: 0.92 + Math.random() * 0.08
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
                phase: Math.random() * Math.PI * 2,
                squash: 0.92 + Math.random() * 0.08
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
        // 清透采样源（0.1.139 建提亮版，0.1.140 改清透口径）：同一封面
        // 多画一份，blur 同步——取向是「滴内只留淡色调」：饱和压到
        // 0.55、亮度抬到 1.18，封面再艳（蓝绿）吸进滴里也只剩一层淡
        // 影，不再成糖豆。透镜滴只采它。离屏重建时一次画好，不在每
        // 帧每滴上用 ctx.filter；变量名沿用 bgBrightCanvas 不改。
        this.bgBrightCanvas = paint(`blur(${blurPx}px) saturate(0.55) brightness(1.18)`);
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

    // 水滴本体：坐标口径同 visuals.ts 的 drawRain（CSS 像素存、绘制时
    // 按 scale 换到设备像素），光斑微动是卡面多的一项；单滴画法
    // 0.1.141 起不再照搬全屏版，按参照图的透光结构自成一套（见文件头）。
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
            // 圆滴（0.1.141 画法重画，取向见文件头：滴身透、靠月牙与
            // 偏置高光成形、不实填）。以下绘制全在以滴心为原点、纵向
            // scale 了 squash 的局部坐标里做；拖尾已在变换外画完，不受
            // 椭圆影响。固定顺序：clip 圆 → 采样半透叠加（仅透镜滴）→
            // 底部月牙亮光 → 顶部内侧薄影 → 外圈亮边（下强上弱）→
            // 左上偏置高光。
            // 透镜滴＝大滴（CSS 半径 ≥6）且采样窗不出界：只采清透版离
            // 屏（bgBrightCanvas，降饱和＋提亮，缺失时退暗版）；小滴/
            // 贴边滴/无封面走无采样路径，透明中心、只上光影结构。
            const shimmer = 0.4 + 0.25 * Math.sin(tick * 0.8 + drop.phase);
            const rimWidth = Math.max(1, scaleX);
            const shadowWidth = Math.max(1.5, scaleX * 1.5);
            const srcSize = (r * 2) / 1.3;
            const lensSrc = this.bgBrightCanvas ?? this.bgCanvas;
            const hasLens =
                !!lensSrc &&
                drop.radius >= 6 &&
                x - srcSize / 2 >= 0 &&
                y - srcSize / 2 >= 0 &&
                x + srcSize / 2 <= width &&
                y + srcSize / 2 <= height;
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(1, drop.squash);
            // 底部月牙：光穿过滴身在底部聚焦的亮带——径向渐变的光源点
            // 压在滴心下方，亮度向外散尽，填满整圆后自然只在底部成
            // 月牙（顶部离光源远、渐变已散尽）。参照图里最显眼的水感
            // 特征就是它。
            const drawCrescent = (): void => {
                const glow = ctx.createRadialGradient(0, r * 0.55, 0, 0, r * 0.55, r * 0.95);
                glow.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
                glow.addColorStop(0.55, 'rgba(255, 255, 255, 0.13)');
                glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fill();
            };
            // 顶部内侧薄影：只占上缘一小段，与底部月牙一暗一亮撑出
            // 体积；不整圈描边（均匀整圈是圆盘感的来源之一）。
            const drawTopShadow = (): void => {
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
                ctx.lineWidth = shadowWidth;
                ctx.beginPath();
                ctx.arc(
                    0,
                    0,
                    Math.max(0.5, r - shadowWidth / 2),
                    Math.PI * 1.18,
                    Math.PI * 1.82
                );
                ctx.stroke();
            };
            if (hasLens && lensSrc) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.clip();
                // 滴身半透：采样只以 LENS_ALPHA 叠上来，卡面从滴里
                // 透出——滴是罩在字上的一层水膜，不再是实心盘子。
                // 0.1.140 的整圆叠白随实填一起废除（它的活由月牙接）。
                ctx.globalAlpha = LENS_ALPHA;
                ctx.drawImage(
                    lensSrc,
                    x - srcSize / 2,
                    y - srcSize / 2,
                    srcSize,
                    srcSize,
                    -r,
                    -r,
                    r * 2,
                    r * 2
                );
                ctx.globalAlpha = 1;
                drawCrescent();
                drawTopShadow();
                ctx.restore();
            } else {
                drawCrescent();
                drawTopShadow();
            }
            // 外圈亮边：保留 1px，但下半圈强、上半圈弱到 0.55 倍——
            // 贴近光从滴底透出的样子；均匀整圈亮边会把滴画成圆圈。
            const rimBase = hasLens ? shimmer : 0.38;
            const rimRadius = Math.max(0.5, r - rimWidth / 2);
            ctx.lineWidth = rimWidth;
            ctx.strokeStyle = `rgba(255, 255, 255, ${rimBase.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(0, 0, rimRadius, 0, Math.PI);
            ctx.stroke();
            ctx.strokeStyle = `rgba(255, 255, 255, ${(rimBase * 0.55).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(0, 0, rimRadius, Math.PI, Math.PI * 2);
            ctx.stroke();
            // 高光：左上偏置的小椭圆亮点（偏约 0.35r、长半径约 0.19r、
            // alpha 0.85）＋其右下一颗更小的次级点。正中大白点是珍珠
            // 感的元凶——务必偏、务必小。小滴（设备半径 <5）省次级点，
            // 免得糊成一团。
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.beginPath();
            ctx.ellipse(
                -r * 0.34,
                -r * 0.34,
                Math.max(0.7, r * 0.19),
                Math.max(0.5, r * 0.12),
                -0.7,
                0,
                Math.PI * 2
            );
            ctx.fill();
            if (r >= 5) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.beginPath();
                ctx.arc(-r * 0.16, -r * 0.14, Math.max(0.5, r * 0.07), 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
        ctx.restore();
    }
}
