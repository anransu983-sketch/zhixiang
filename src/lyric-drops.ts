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
// 0.1.143 照片级折射引擎（用户对着《刀马旦》参照照片逐像素核对后
// 定版，前几版全栽在同一个根子上：**拿糊图采样**——卡面底图是重模
// 糊的，滴里再怎么画也只有一团色；照片里的滴恰恰相反：背景越糊、
// 滴里越锐）。新引擎三要素：
// - 锐图翻转采样：另备一份不加 blur 的锐版封面离屏，滴的采样窗比滴
//   径小一圈（约滴径/1.55，等于放大 1.55 倍看），绘入时上下翻转
//   （真折射是倒像），alpha 约 0.9 近实——滴里装的是清清楚楚的实景。
// - 团块形状：中大滴是主圆＋2–4 颗卫星圆黏连的并集 path，不再是
//   圆/椭圆；卫星位置 seed 时定死、逐帧不变。
// - 密布：团块＋中滴＋细小水点三档按面积密铺（参照照片整屏满铺的
//   密度），细点不采样、只给底色淡芯＋一颗白亮点。
// 光影只做收尾：1–2 颗偏边小高光火花＋下缘一道细亮弧；整圈描边与
// 月牙渐变取消——照片里的滴靠折射内容成形，不靠描边。0.1.141 的半透
// 口径（LENS_ALPHA、月牙、提亮/清透采样源）就此废除，不留两套。
//
// 0.1.145 滴答循环（用户装 0.1.144 后指着歌词卡下令「做成那种动
// 态，雨滴滴答滴答滴压那种」）：动态档原先的下滑滴是恒速匀速下滑＋
// 白色渐变细线拖尾，像一道雨幕——真实雨滴在玻璃上是一颗一颗过日
// 子的：先在原地凝聚长大，攒到临界时压扁微颤（就是「压」），然后
// 突然滑落、沿途留下会自己消失的残留微滴。本版把下滑滴换成状态
// 机：凝聚（dwell，2.5–6 秒由小长到释放阈值）→ 临界微颤（teeter，
// 纵向压到约 0.82、越临界颤得越明显）→ 滑落（slide，自静止加速到
// 与半径成正比的终端速度，轻微蛇形、纵向拉长，约三成概率半途挂
// 住回到凝聚）→ 等待（wait，随机延迟后在卡面上部 2/3 凝聚重
// 生）。同一时刻最多 2 颗在滑，相位全程错开，要的是间歇的滴答节
// 奏、不是雨量。白色细线拖尾废弃，改残留微滴（滑过路径上每隔数
// px 留一颗，1.2–2 秒内缩小淡出，全卡上限 120 颗）。滴身画法、
// 折射采样、静态层机制全部不动，动态滴仍复用 paintDropBody。
//
// 静态滴（团块＋中滴＋细点）在种子/底图变化时先预渲染到一层离屏
// （staticLayer），每帧只 drawImage 这层＋活画下滑滴，禁止逐帧重算
// 团块采样（性能红线）；动态档同理，静态层打底、下滑滴活绘。
//
// 透镜底图：自维护与卡同尺寸（设备像素）的离屏画布——暗版与卡面
// .lyric-card-bg 同滤镜（blur＋saturate＋brightness 0.72，保留作口径
// 对照，不再被采样）；锐版是同一封面原图不加 blur、按卡面尺寸 cover
// 绘制，与暗版同键同批重建/清理，是新引擎唯一的采样源。采样坐标与
// 卡面底图共用同一 cover 映射，翻转只翻滴内图、不挪位置。无封面时
// 离屏留空，滴只画形状＋高光＋亮弧，在卡的渐变底上照样成立。
//
// 档位跟随视觉开关 rainMode（同一份存储 zhixiang.visual.toggles，不
// 新增设置项）：0 关＝canvas 隐藏不画；1 静态＝画一帧静止滴，封面或
// 卡尺寸变了才重画；2 动态＝rAF 动画（下滑滴走滴答循环、光斑微动）。
//
// 动画纪律同 VisualStage 的 poke/suspend：只在外部告知「已呈现」
// （播放页打开、歌词卡显示中、未折叠）且 document 可见时跑 rAF，
// 其余一律停画不空转；document 隐藏停、恢复可见由监听 poke 回来。

import { AnimClock } from './anim-rate';

// 折射采样（0.1.143）：采样窗与滴径之比的倒数——窗越小、滴里放得
// 越大。照片级水珠的放大感约 1.55 倍。
const REFRACT_ZOOM = 1.55;
// 团块滴采样叠加的不透明度：照片里的滴近实，滴里是锐图不是雾。
const REFRACT_ALPHA_BLOB = 0.9;
// 中滴个头小、采样窗更小，略透一点免得成色块。
const REFRACT_ALPHA_MID = 0.85;

type DropKind = 'blob' | 'mid' | 'speck' | 'slider';

interface DropPart {
    /** 圆心偏移（以主圆半径为单位），seed 时定死。 */
    dx: number;
    dy: number;
    /** 该圆半径（以主圆半径为单位；主圆恒为 1）。 */
    rr: number;
}

interface DropSpark {
    /** 高光火花位置（以主圆半径为单位，偏边定死、不取正中）。 */
    dx: number;
    dy: number;
    /** 火花半径（以主圆半径为单位）。 */
    rr: number;
}

/** 下滑滴滴答循环的阶段（0.1.145）：凝聚→临界微颤→滑落→等待重生。 */
type SliderPhase = 'dwell' | 'teeter' | 'slide' | 'wait';

interface Drop {
    x: number;
    y: number;
    radius: number;
    // —— 以下为下滑滴（kind 'slider'）的滴答循环状态，其余 kind 不用 ——
    /** 当前阶段；非 slider 恒为 'dwell' 且从不推进。 */
    phase: SliderPhase;
    /** 当前阶段已耗时（ms，动画时间口径）。 */
    phaseT: number;
    /** 当前阶段总时长（ms）：凝聚/微颤/等待各有随机量。 */
    phaseDur: number;
    /** 凝聚起点半径（约 3）：长大从这里算。 */
    startRadius: number;
    /** 释放阈值半径（随机 8–12，挂住后再长时顺延）：长到它就滑。 */
    threshold: number;
    /** 凝聚起点 y：全程只许极轻微下沉（≤2px），以它为锚。 */
    dwellY: number;
    /** 滑落当前速度（CSS px/s），自 0 加速到 terminal。 */
    speed: number;
    /** 终端速度（CSS px/s，与半径成正比）。 */
    terminal: number;
    /** 滑落起点半径：沿途吞并长大的上限是它的 1.25 倍。 */
    slideBase: number;
    /** 滑落锚点 x 与已滑距离：蛇形横摆按距离算，不逐帧漂移累积。 */
    anchorX: number;
    dist: number;
    /** 半途挂住的 y（seed 滑落时约三成概率定下）；null＝一路滑出。 */
    hangY: number | null;
    /** 微颤正弦相位与蛇形相位（seed/入阶段时随机）。 */
    wobblePhase: number;
    snakePhase: number;
    /** 残留微滴落点间距（6–10px）与距上个落点已滑距离。 */
    residueGap: number;
    residueSince: number;
    /** 纵向微椭圆系数（seed 时定死、逐帧不变）：团块在并集之上再略压。 */
    squash: number;
    kind: DropKind;
    /** 团块并集的圆组成（主圆＋卫星圆）；单圆滴为 null。 */
    parts: DropPart[] | null;
    /** 并集外接半宽（以主圆半径为单位，≥1）：定采样窗与绘制范围。 */
    extent: number;
    /** 偏边小高光火花（1–2 颗，seed 时定死）；细水点不用（自带亮点）。 */
    sparks: DropSpark[];
}

/** 滑落路径上的残留微滴（0.1.145）：细点简形，生老病死自带时钟。 */
interface Residue {
    x: number;
    y: number;
    radius: number;
    /** 已存活时间与总寿命（ms）：寿命内线性缩小＋淡出。 */
    age: number;
    life: number;
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
    // 动画速率：同 VisualStage 口径，rAF 时间经 AnimClock 缩放成
    // 动画时间（anim-rate.ts）；滴答状态机按动画时间的帧差 dt 推
    // 进，速率已含在 dt 里，不再另乘逐帧位移系数。
    private animClock = new AnimClock();
    private drops: Drop[] = [];
    private residues: Residue[] = [];
    // 上一动画帧的动画时间（ms）：滴答状态机按相邻帧差 dt 推进，
    // dt 钳 50ms 上限——切回前台时 AnimClock 累计会跳一大截，不能
    // 让滴一帧窜出去。-1＝还没有上一帧。
    private lastAnimTime = -1;
    private bokeh: Bokeh[] = [];
    private seededWidth = 0;
    private seededHeight = 0;
    private bgCanvas: HTMLCanvasElement | null = null;
    // 锐版采样源（0.1.143）：同一封面原图不加 blur、cover 绘满卡面，
    // 与 bgCanvas 同步重建；团块/中滴/下滑滴的折射只采这一份。
    private bgSharpCanvas: HTMLCanvasElement | null = null;
    private bgKey = '';
    // 静态滴预渲染层（0.1.143）：种子或底图一变就置脏，下一帧重建；
    // 尺寸与主画布不一致时也重建（DPR 变化等）。
    private staticLayer: HTMLCanvasElement | null = null;
    private staticDirty = true;
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
            this.bgSharpCanvas = null;
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
                this.drawFrame(this.animClock.advance(time), true);
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

    // 团块并集：主圆＋2–4 颗卫星圆（半径 0.38–0.68 主圆、圆心距
    // 0.45–0.85 主圆半径、纵向再乘 0.85 略压），seed 时定死。
    private makeParts(): DropPart[] {
        const parts: DropPart[] = [{ dx: 0, dy: 0, rr: 1 }];
        const satellites = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < satellites; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 0.45 + Math.random() * 0.4;
            parts.push({
                dx: Math.cos(angle) * dist,
                dy: Math.sin(angle) * dist * 0.85,
                rr: 0.38 + Math.random() * 0.3
            });
        }
        return parts;
    }

    private extentOf(parts: DropPart[] | null): number {
        if (!parts) {
            return 1;
        }
        let extent = 1;
        for (const part of parts) {
            extent = Math.max(extent, Math.abs(part.dx) + part.rr, Math.abs(part.dy) + part.rr);
        }
        return extent;
    }

    // 高光火花：1–2 颗，离心 0.35–0.62（偏边、不取正中），seed 定死。
    private makeSparks(): DropSpark[] {
        const sparks: DropSpark[] = [];
        const count = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 0.35 + Math.random() * 0.27;
            sparks.push({
                dx: Math.cos(angle) * dist,
                dy: Math.sin(angle) * dist,
                rr: 0.09 + Math.random() * 0.07
            });
        }
        return sparks;
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
        this.residues = [];
        this.bokeh = [];
        const area = width * height;
        const push = (kind: DropKind, radius: number, blob: boolean): Drop => {
            const parts = blob ? this.makeParts() : null;
            const drop: Drop = {
                x: Math.random() * width,
                y: Math.random() * height,
                radius,
                phase: 'dwell',
                phaseT: 0,
                phaseDur: 0,
                startRadius: radius,
                threshold: radius,
                dwellY: 0,
                speed: 0,
                terminal: 0,
                slideBase: radius,
                anchorX: 0,
                dist: 0,
                hangY: null,
                wobblePhase: Math.random() * Math.PI * 2,
                snakePhase: Math.random() * Math.PI * 2,
                residueGap: 6 + Math.random() * 4,
                residueSince: 0,
                squash: blob ? 0.94 + Math.random() * 0.06 : 1,
                kind,
                parts,
                extent: this.extentOf(parts),
                sparks: kind === 'speck' ? [] : this.makeSparks()
            };
            drop.dwellY = drop.y;
            this.drops.push(drop);
            return drop;
        };
        // 密度按卡面积换算（0.1.143 照片级密布口径）：以约 300×260 的
        // 卡面为锚——团块约 28 颗（area/2800，半径 7–20）、中滴约 70
        // 颗（area/1100，半径 3–7）、细水点约 170 颗（area/450，半径
        // 0.8–2.2）；卡变大变小按面积等比增减，钳住上下限防极端尺寸
        // 失真。参照照片是整屏满铺，这个密度只少不多。
        const blobCount = Math.round(Math.min(64, Math.max(8, area / 2800)));
        for (let i = 0; i < blobCount; i++) {
            push('blob', 7 + Math.pow(Math.random(), 1.5) * 13, true);
        }
        const midCount = Math.round(Math.min(170, Math.max(24, area / 1100)));
        for (let i = 0; i < midCount; i++) {
            push('mid', 3 + Math.random() * 4, false);
        }
        const speckCount = Math.round(Math.min(400, Math.max(60, area / 450)));
        for (let i = 0; i < speckCount; i++) {
            push('speck', 0.8 + Math.pow(Math.random(), 1.3) * 1.4, false);
        }
        // 下滑滴（0.1.145 滴答循环）：数量保持原量级（卡面按面积约
        // 5 颗）。播种即进凝聚态：从约 3 长到阈值 8–12，各滴的凝聚
        // 进度随机散开（phaseT 预填随机一段），保证开画就是「这滴
        // 在攒、那滴快满」的错相；半径 ≥7 的走团块＋锐采样（长到阈
        // 值后自然达标），团块/火花/压扁系数全程不变。
        const sliderCount = Math.round(Math.min(8, Math.max(2, area / 16000)));
        for (let i = 0; i < sliderCount; i++) {
            const drop = push('slider', 3, false);
            this.resetDwell(drop, width, height, true);
            // 团块按最终个头定（阈值 8–12 恒 ≥7，与现行「半径 ≥7 走
            // 团块」同口径）：seed 时定死，之后凝聚/滑落/重生都不换。
            if (drop.threshold >= 7) {
                drop.parts = this.makeParts();
                drop.extent = this.extentOf(drop.parts);
            }
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
        // 种子换了：静态层作废，下一帧重建。
        this.staticDirty = true;
    }

    // 采样底图离屏缓存：封面或尺寸没变就复用（键同 visuals.ts 口径）；
    // 无封面时置空，滴自动退回无折射画法（只剩形状＋高光＋亮弧）。
    private rebuildBackground(): void {
        const width = this.canvas.width;
        const height = this.canvas.height;
        const key = `${width}x${height}|${this.coverReady ? this.coverSrc : 'none'}`;
        if (this.bgCanvas && this.bgKey === key) {
            return;
        }
        this.bgKey = key;
        // 底图换了：静态层里的折射内容作废，下一帧重建。
        this.staticDirty = true;
        const img = this.coverImage;
        if (!this.coverReady || !img || img.naturalWidth <= 0 || width <= 1 || height <= 1) {
            this.bgCanvas = null;
            this.bgSharpCanvas = null;
            return;
        }
        // 与卡面 .lyric-card-bg 同 cover 映射：三份离屏共用同一套
        // cover 几何（居中裁切绘满），采样坐标才与卡面底图对得齐。
        // blur 28px 是 CSS 像素口径，离屏在设备像素上画，半径按倍率
        // 折算；saturate/brightness 与 CSS 一致（仅暗版需要）。
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
                if (filter) {
                    tctx.filter = filter;
                }
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
                // 图源跨域/损坏时 drawImage 可能抛错：无折射兜底，不掀翻整卡。
                return null;
            } finally {
                tctx.filter = 'none';
                tctx.restore();
            }
        };
        this.bgCanvas = paint(`blur(${blurPx}px) saturate(1.25) brightness(0.72)`);
        // 锐版（0.1.143）：不加任何滤镜——滴里要的就是未模糊的原图，
        // 与暗版同批重建。旧提亮/清透版离屏随半透画法一并废除。
        this.bgSharpCanvas = paint('');
    }

    // —— 滴答循环状态机（0.1.145，只管 kind 'slider' 的滴） ——

    // 进凝聚态：全新一滴（播种/重生）从约 3 长到阈值 8–12，位置在
    // 卡面上部 2/3 随机落点；scatter 时预填一段随机进度，错开相位。
    private resetDwell(drop: Drop, width: number, height: number, scatter: boolean): void {
        drop.phase = 'dwell';
        drop.phaseDur = 2500 + Math.random() * 3500;
        drop.phaseT = scatter ? Math.random() * drop.phaseDur * 0.92 : 0;
        drop.startRadius = 2.8 + Math.random() * 0.7;
        drop.threshold = 8 + Math.random() * 4;
        drop.speed = 0;
        drop.hangY = null;
        drop.dist = 0;
        drop.x = Math.random() * width;
        drop.dwellY = Math.random() * height * (2 / 3);
        const eased = Math.pow(drop.phaseT / drop.phaseDur, 1.6);
        drop.radius =
            drop.startRadius + (drop.threshold - drop.startRadius) * eased;
        drop.y = drop.dwellY + 2 * eased;
    }

    // 挂住后回凝聚：不换位置、不回小滴，从当前个头继续往上攒一点。
    private resumeDwell(drop: Drop): void {
        drop.phase = 'dwell';
        drop.phaseDur = 1500 + Math.random() * 2000;
        drop.phaseT = 0;
        drop.startRadius = drop.radius;
        drop.threshold = Math.min(14, drop.radius + 1.5 + Math.random() * 2.5);
        drop.speed = 0;
        drop.hangY = null;
        drop.dwellY = drop.y;
    }

    // 释放滑落：速度从 0 起，终端速度与半径成正比（约 13px/s 每
    // 1px 半径，合现行恒速的 2–4 倍量级）；约三成概率半途挂住。
    private startSlide(drop: Drop, height: number): void {
        drop.phase = 'slide';
        drop.phaseT = 0;
        drop.speed = 0;
        drop.slideBase = drop.radius;
        drop.terminal = drop.radius * 13;
        drop.anchorX = drop.x;
        drop.dist = 0;
        drop.snakePhase = Math.random() * Math.PI * 2;
        drop.residueSince = 0;
        drop.residueGap = 6 + Math.random() * 4;
        drop.hangY = null;
        if (Math.random() < 0.3) {
            const hangY = drop.y + (0.25 + Math.random() * 0.45) * (height - drop.y);
            if (hangY < height - drop.radius) {
                drop.hangY = hangY;
            }
        }
    }

    private addResidue(x: number, y: number): void {
        this.residues.push({
            x,
            y,
            radius: 0.8 + Math.random() * 1.0,
            age: 0,
            life: 1200 + Math.random() * 800
        });
        // 全卡上限 120 颗，超了先淘汰最老的。
        while (this.residues.length > 120) {
            this.residues.shift();
        }
    }

    private updateResidues(dtMs: number): void {
        for (let i = this.residues.length - 1; i >= 0; i--) {
            const item = this.residues[i];
            if (!item) {
                continue;
            }
            item.age += dtMs;
            if (item.age >= item.life) {
                this.residues.splice(i, 1);
            }
        }
    }

    private updateSliders(dtMs: number, width: number, height: number): void {
        const dt = dtMs / 1000;
        let sliding = 0;
        for (const drop of this.drops) {
            if (drop.kind === 'slider' && drop.phase === 'slide') {
                sliding++;
            }
        }
        for (const drop of this.drops) {
            if (drop.kind !== 'slider') {
                continue;
            }
            if (drop.phase === 'wait') {
                drop.phaseT += dtMs;
                if (drop.phaseT >= drop.phaseDur) {
                    this.resetDwell(drop, width, height, false);
                }
            } else if (drop.phase === 'dwell') {
                drop.phaseT += dtMs;
                const p = Math.min(1, drop.phaseT / drop.phaseDur);
                // 长大前慢后快（p^1.6）：慢得看得出在「攒」。
                const eased = Math.pow(p, 1.6);
                drop.radius =
                    drop.startRadius + (drop.threshold - drop.startRadius) * eased;
                drop.y = drop.dwellY + 2 * eased;
                if (drop.radius >= drop.threshold * 0.85) {
                    drop.phase = 'teeter';
                    drop.phaseT = 0;
                    drop.phaseDur = 300 + Math.random() * 900;
                    drop.wobblePhase = Math.random() * Math.PI * 2;
                }
            } else if (drop.phase === 'teeter') {
                drop.phaseT += dtMs;
                // 越临界颤得越快：相位推进随阶段进度加速。
                drop.wobblePhase +=
                    dtMs * (0.022 + 0.028 * Math.min(1, drop.phaseT / drop.phaseDur));
                // 微颤期间仍极慢地往阈值 creep。
                drop.radius = Math.min(
                    drop.threshold,
                    drop.radius +
                        ((drop.threshold - drop.radius) * dtMs) /
                            Math.max(1, drop.phaseDur)
                );
                if (drop.phaseT >= drop.phaseDur) {
                    if (sliding < 2) {
                        this.startSlide(drop, height);
                        sliding++;
                    } else {
                        // 已有 2 颗在滑：排队，留在临界态继续颤。
                        drop.phaseT = drop.phaseDur - 120;
                    }
                }
            } else {
                // slide：加速到终端速度，过了挂点则减速到停。
                drop.phaseT += dtMs;
                let hung = false;
                if (drop.hangY !== null && drop.y >= drop.hangY) {
                    drop.speed = Math.max(0, drop.speed - drop.terminal * 2.8 * dt);
                    if (drop.speed <= 0.5) {
                        this.resumeDwell(drop);
                        hung = true;
                    }
                } else {
                    drop.speed = Math.min(
                        drop.terminal,
                        drop.speed + (drop.terminal / 0.28) * dt
                    );
                }
                if (hung) {
                    sliding--;
                    continue;
                }
                const dy = drop.speed * dt;
                drop.y += dy;
                drop.dist += dy;
                // 蛇形横摆：按已滑距离算正弦，幅度 ≤ 半径 0.3，起步
                // 30px 内渐入免得横跳。
                drop.x =
                    drop.anchorX +
                    Math.sin(drop.dist * 0.05 + drop.snakePhase) *
                        drop.radius *
                        0.3 *
                        Math.min(1, drop.dist / 30);
                // 沿途吞并长大：滑过半个卡高约长满 +25%。
                drop.radius = Math.min(
                    drop.slideBase * 1.25,
                    drop.radius + (drop.slideBase * 0.25 * dy) / (height * 0.5)
                );
                // 残留微滴：每滑过一个间距落一颗在身后。
                drop.residueSince += dy;
                while (drop.residueSince >= drop.residueGap) {
                    drop.residueSince -= drop.residueGap;
                    this.addResidue(
                        drop.x,
                        drop.y - drop.residueSince - drop.radius * 0.6
                    );
                    drop.residueGap = 6 + Math.random() * 4;
                }
                if (drop.y - drop.radius * drop.extent > height) {
                    drop.phase = 'wait';
                    drop.phaseT = 0;
                    drop.phaseDur = 400 + Math.random() * 2100;
                    sliding--;
                }
            }
        }
    }

    // 动态压扁/拉长（paintDropBody 的可选入参）：凝聚态为中性 1；
    // 微颤态纵向在 1 与约 0.82 间正弦压扁（进度越深幅度越大，横向
    // 按 1/√sy 略宽，体积感守恒的大意）；滑落态按速度比纵向拉长到
    // 约 1.28、横向相应略窄。与 seed 定死的 squash 是两回事，叠乘。
    private dynSquash(drop: Drop): { sx: number; sy: number } {
        if (drop.phase === 'teeter') {
            const p = Math.min(1, drop.phaseT / drop.phaseDur);
            const sy = 1 - 0.18 * p * (0.5 + 0.5 * Math.sin(drop.wobblePhase));
            return { sx: 1 / Math.sqrt(sy), sy };
        }
        if (drop.phase === 'slide' && drop.terminal > 0) {
            const sy = 1 + 0.28 * Math.min(1, drop.speed / drop.terminal);
            return { sx: 1 / Math.sqrt(sy), sy };
        }
        return { sx: 1, sy: 1 };
    }

    private drawFrame(time: number, animated: boolean): void {
        const ctx = this.context;
        if (!ctx) {
            return;
        }
        const width = this.canvas.width;
        const height = this.canvas.height;
        ctx.clearRect(0, 0, width, height);
        const cssWidth = this.canvas.clientWidth || width;
        const cssHeight = this.canvas.clientHeight || height;
        const scaleX = width / cssWidth;
        const scaleY = height / cssHeight;
        // 滴答循环推进（只动态档）：dt 是 AnimClock 缩放后的动画时间
        // 差（速率已在里面），钳 50ms 上限防切回前台一帧跳很远；静
        // 态帧不推进状态、只按当前状态画一帧。
        if (animated) {
            const dtMs =
                this.lastAnimTime < 0
                    ? 16
                    : Math.min(50, Math.max(0, time - this.lastAnimTime));
            this.lastAnimTime = time;
            this.updateSliders(dtMs, cssWidth, cssHeight);
            this.updateResidues(dtMs);
        }
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
        // 静态滴：预渲染层整张贴上（团块采样只在重建时算一次）。
        this.buildStaticLayer(scaleX, scaleY);
        if (this.staticLayer) {
            ctx.drawImage(this.staticLayer, 0, 0);
        }
        // 残留微滴：画在静态层之上、下滑滴之下，细点简形（淡芯＋左
        // 上一颗小亮点，随年龄缩小并淡出），不走团块采样。
        for (const item of this.residues) {
            const ageRatio = item.age / item.life;
            const fade = 1 - ageRatio;
            const x = item.x * scaleX;
            const y = item.y * scaleY;
            const r = Math.max(0.3, item.radius * scaleX * (1 - 0.55 * ageRatio));
            ctx.fillStyle = `rgba(255, 255, 255, ${(0.3 * fade).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = `rgba(255, 255, 255, ${(0.75 * fade).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x - r * 0.35, y - r * 0.38, Math.max(0.3, r * 0.34), 0, Math.PI * 2);
            ctx.fill();
        }
        // 下滑滴：活画（静态档也画一帧，停在当前凝聚态、不推进）；
        // 等待重生中的滴不画。动态压扁/拉长经可选入参进 paintDropBody。
        for (const drop of this.drops) {
            if (drop.kind !== 'slider' || drop.phase === 'wait') {
                continue;
            }
            const x = drop.x * scaleX;
            const y = drop.y * scaleY;
            const r = drop.radius * scaleX;
            this.paintDropBody(ctx, drop, x, y, r, scaleX, this.dynSquash(drop));
        }
    }

    // 静态层预渲染（0.1.143 性能红线）：团块＋中滴＋细点在种子/底图
    // 变化时绘到离屏一次，逐帧只贴图。细点的底色靠读一次锐版像素
    // （重建时一次性开销），不逐点 drawImage。
    private buildStaticLayer(scaleX: number, scaleY: number): void {
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (
            !this.staticDirty &&
            this.staticLayer &&
            this.staticLayer.width === width &&
            this.staticLayer.height === height
        ) {
            return;
        }
        const layer = document.createElement('canvas');
        layer.width = width;
        layer.height = height;
        const lctx = layer.getContext('2d');
        if (!lctx) {
            return;
        }
        let speckData: ImageData | null = null;
        const sharp = this.bgSharpCanvas;
        if (sharp) {
            const sctx = sharp.getContext('2d');
            if (sctx) {
                try {
                    speckData = sctx.getImageData(0, 0, width, height);
                } catch {
                    speckData = null;
                }
            }
        }
        for (const drop of this.drops) {
            if (drop.kind === 'slider') {
                continue;
            }
            const x = drop.x * scaleX;
            const y = drop.y * scaleY;
            const r = drop.radius * scaleX;
            if (drop.kind === 'speck') {
                // 细水点：不采样，底色淡芯（有锐版就取该点像素色，没有
                // 退半透明白）＋左上一颗白色小亮点。
                let core = 'rgba(255, 255, 255, 0.12)';
                if (speckData) {
                    const px = Math.min(width - 1, Math.max(0, Math.round(x)));
                    const py = Math.min(height - 1, Math.max(0, Math.round(y)));
                    const idx = (py * width + px) * 4;
                    core = `rgba(${speckData.data[idx]}, ${speckData.data[idx + 1]}, ${speckData.data[idx + 2]}, 0.5)`;
                }
                lctx.fillStyle = core;
                lctx.beginPath();
                lctx.arc(x, y, r, 0, Math.PI * 2);
                lctx.fill();
                lctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                lctx.beginPath();
                lctx.arc(
                    x - r * 0.35,
                    y - r * 0.38,
                    Math.max(0.4, r * 0.34),
                    0,
                    Math.PI * 2
                );
                lctx.fill();
                continue;
            }
            this.paintDropBody(lctx, drop, x, y, r, scaleX);
        }
        this.staticLayer = layer;
        this.staticDirty = false;
    }

    // 单滴滴身（团块/中滴/下滑滴共用，0.1.143 照片级折射画法）：
    // 以滴心为原点、纵向 scale 了 squash 的局部坐标里绘制——
    // 并集 path（主圆＋卫星圆同 path 多 arc，nonzero 填充即并集）→
    // clip → 锐版采样上下翻转＋放大绘入（采样窗＝并集外接宽/1.55，
    // 居中对滴心；卫星区由同一张采样图自然延展覆盖）→ 下缘细亮弧 →
    // 偏边高光火花。采样窗出界（贴边滴）或无锐版时跳过采样，只剩
    // 形状＋亮弧＋火花，边缘不消失靠的就是这道下缘弧兜底。
    // dyn（0.1.145 可选）：下滑滴的动态压扁/拉长（dynSquash 算），
    // 与 seed 定死的 squash 叠乘；不传即 {1,1}，静态层构建路径的
    // 调用不传、画面与改前逐像素同口径。
    private paintDropBody(
        ctx: CanvasRenderingContext2D,
        drop: Drop,
        x: number,
        y: number,
        r: number,
        scaleX: number,
        dyn?: { sx: number; sy: number }
    ): void {
        const width = this.canvas.width;
        const height = this.canvas.height;
        const sharp = this.bgSharpCanvas;
        const alpha = drop.kind === 'mid' ? REFRACT_ALPHA_MID : REFRACT_ALPHA_BLOB;
        const extentPx = r * drop.extent;
        const win = (extentPx * 2) / REFRACT_ZOOM;
        const canRefract =
            !!sharp &&
            x - win / 2 >= 0 &&
            y - win / 2 >= 0 &&
            x + win / 2 <= width &&
            y + win / 2 <= height;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(dyn?.sx ?? 1, drop.squash * (dyn?.sy ?? 1));
        ctx.beginPath();
        if (drop.parts) {
            for (const part of drop.parts) {
                ctx.moveTo(part.dx * r + part.rr * r, part.dy * r);
                ctx.arc(part.dx * r, part.dy * r, part.rr * r, 0, Math.PI * 2);
            }
        } else {
            ctx.arc(0, 0, r, 0, Math.PI * 2);
        }
        ctx.clip();
        if (canRefract && sharp) {
            ctx.save();
            // 上下翻转只作用于滴内采样图：scale(1,-1) 后同一目标矩形
            // 落位不变、内容倒置（真折射的倒像）；位置仍对滴心，采样
            // 坐标走锐版的 cover 映射，与卡面底图对齐。
            ctx.scale(1, -1);
            ctx.globalAlpha = alpha;
            ctx.drawImage(
                sharp,
                x - win / 2,
                y - win / 2,
                win,
                win,
                -extentPx,
                -extentPx,
                extentPx * 2,
                extentPx * 2
            );
            ctx.globalAlpha = 1;
            ctx.restore();
        }
        // 下缘细亮弧：光从滴底透出的亮边，只走下半（0.15π–0.85π），
        // 是全删描边后唯一的边缘兜底。
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = Math.max(1, scaleX * 0.9);
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(0.5, r * 0.94), Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        // 高光火花：seed 时定死的偏边小亮点（椭圆、略压），1–2 颗。
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        for (const spark of drop.sparks) {
            ctx.beginPath();
            ctx.ellipse(
                spark.dx * r,
                spark.dy * r,
                Math.max(0.5, spark.rr * r),
                Math.max(0.35, spark.rr * r * 0.7),
                0,
                0,
                Math.PI * 2
            );
            ctx.fill();
        }
        ctx.restore();
    }
}
