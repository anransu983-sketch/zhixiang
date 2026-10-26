// 播放页视觉（第 8 块，全新写）：单块画布上的五项独立图层。
//
// 五项开关各自独立，互不依赖，存在 localStorage，键 zhixiang.visual.toggles：
// - rain（雨滴玻璃，默认开）：封面模糊底 + 玻璃水滴（静止圆滴＋下滑拖尾＋大光斑）。
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

export interface VisualToggles {
    rain: boolean;
    particles: boolean;
    pulse: boolean;
    stars: boolean;
    sword: boolean;
}

const STORAGE_KEY = 'zhixiang.visual.toggles';

export const DEFAULT_TOGGLES: VisualToggles = {
    rain: true,
    particles: false,
    pulse: false,
    stars: false,
    sword: false
};

export function loadVisualToggles(): VisualToggles {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_TOGGLES };
        }
        const parsed = JSON.parse(raw) as Partial<VisualToggles>;
        return {
            rain: typeof parsed.rain === 'boolean' ? parsed.rain : DEFAULT_TOGGLES.rain,
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

// 玻璃水滴：静止圆滴（speed 0）＋下滑滴（带拖尾）；
// 大光斑（bokeh）另起数组，只做柔光深度，不参与下落。
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
        if (!this.options.isPlaying()) {
            // 暂停/停止：画一帧静态画面后停画，不空转。
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
                if (document.hidden || !this.options.isPlaying()) {
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
        this.bokeh = [];
        this.particles = [];
        this.stars = [];
        this.seededWidth = width;
        this.seededHeight = height;
        if (this.drops.length === 0) {
            // 静止圆滴为主（玻璃上的水珠本来就不怎么动），少量下滑滴带拖尾。
            for (let i = 0; i < 140; i++) {
                this.drops.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    radius: 1.5 + Math.pow(Math.random(), 1.5) * 12.5,
                    speed: 0,
                    trail: 0,
                    phase: Math.random() * Math.PI * 2
                });
            }
            for (let i = 0; i < 16; i++) {
                this.drops.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    radius: 8 + Math.random() * 10,
                    speed: 0.2 + Math.random() * 0.4,
                    trail: 20 + Math.random() * 40,
                    phase: Math.random() * Math.PI * 2
                });
            }
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

        // 底：有封面时一律画封面模糊底（雨滴开关只管雨滴本身）；
        // 无封面时，雨滴开画渐变底、雨滴关画深色底（保持旧观感）。
        const cover = this.options.getCoverImage();
        if (cover || toggles.rain) {
            const bg = this.ensureBackground(width, height);
            if (bg) {
                ctx.drawImage(bg, 0, 0);
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
        if (toggles.rain) {
            this.drawRain(ctx, width, height, animated);
        }
        // 剑来画在最上层：剑光斜划＋诗句，静态帧不画。
        if (toggles.sword && animated) {
            this.drawSword(ctx, width, height);
        }

        // 脉动作用在封面元素上，不在画布里画。
        if (toggles.pulse) {
            if (energy !== null) {
                const scale = 1 + energy * 0.06;
                this.coverElement.style.transform = `scale(${scale.toFixed(3)})`;
                this.coverElement.style.boxShadow = `0 0 ${Math.round(
                    12 + energy * 36
                )}px rgba(232, 160, 191, ${0.35 + energy * 0.45})`;
            } else if (animated) {
                // 降级呼吸：跟随播放状态的缓慢呼吸，不伪造频谱。
                const scale = 1 + 0.02 * Math.sin(time / 900);
                this.coverElement.style.transform = `scale(${scale.toFixed(3)})`;
                this.coverElement.style.boxShadow = '0 0 18px rgba(232, 160, 191, 0.4)';
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
    // 水滴的透镜采样也从这张底图里取（与主画布同尺寸同坐标）。
    private ensureBackground(width: number, height: number): HTMLCanvasElement | null {
        const cover = this.options.getCoverImage();
        const key = `${width}x${height}|${
            cover && cover.complete && cover.naturalWidth > 0 ? cover.src : 'none'
        }`;
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
        const tick = animated ? performance.now() / 1000 : 0;
        ctx.save();
        // 大光斑：失焦的光点，只做深度，不动。
        for (const spot of this.bokeh) {
            ctx.fillStyle = `rgba(255, 255, 255, ${spot.alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(spot.x * scaleX, spot.y * scaleY, spot.radius * scaleX, 0, Math.PI * 2);
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
            // 下滑拖尾：从滴的上方渐淡到滴本身。
            if (drop.trail > 0) {
                ctx.strokeStyle = 'rgba(200, 220, 255, 0.28)';
                ctx.lineWidth = Math.max(1, r * 0.25);
                ctx.beginPath();
                ctx.moveTo(x, y - drop.trail * scaleY);
                ctx.lineTo(x, y);
                ctx.stroke();
            }
            // 圆滴：大滴做透镜（把底图局部放大画进圆里，滴里能看到底色扭曲），
            // 小滴和贴边滴用淡白填充；暗边＋亮边＋高光让它在亮底暗底都看得见。
            const shimmer = 0.4 + 0.25 * Math.sin(tick * 0.8 + drop.phase);
            const srcSize = (r * 2) / 1.3;
            if (
                this.bgCanvas &&
                r >= 6 &&
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
                    this.bgCanvas,
                    x - srcSize / 2,
                    y - srcSize / 2,
                    srcSize,
                    srcSize,
                    x - r,
                    y - r,
                    r * 2,
                    r * 2
                );
                ctx.restore();
            } else {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = `rgba(255, 255, 255, ${shimmer.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(x, y, Math.max(0.5, r - 1), 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.beginPath();
            ctx.arc(x - r * 0.3, y - r * 0.3, Math.max(0.8, r * 0.22), 0, Math.PI * 2);
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
