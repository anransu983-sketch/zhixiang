// 播放页视觉（第 8 块，全新写）：单块画布上的四项独立图层。
//
// 四项开关各自独立，互不依赖，存在 localStorage，键 zhixiang.visual.toggles：
// - rain（雨滴玻璃，默认开）：封面模糊底 + 雨滴下落 + 落点涟漪。
// - particles（粒子舞台，默认关）：粒子随频谱能量律动。
// - pulse（节奏脉动，默认关）：封面随频谱能量缩放发光。
// - stars（氛围星空，默认关）：星空闪烁漂移。
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
}

const STORAGE_KEY = 'zhixiang.visual.toggles';

export const DEFAULT_TOGGLES: VisualToggles = {
    rain: true,
    particles: false,
    pulse: false,
    stars: false
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
            stars: typeof parsed.stars === 'boolean' ? parsed.stars : DEFAULT_TOGGLES.stars
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

interface Drop {
    x: number;
    y: number;
    speed: number;
    length: number;
}

interface Ripple {
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
    private staticDrawn = false;
    private drops: Drop[] = [];
    private ripples: Ripple[] = [];
    private particles: Particle[] = [];
    private stars: Star[] = [];
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
        if (this.drops.length === 0) {
            for (let i = 0; i < 60; i++) {
                this.drops.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    speed: 3 + Math.random() * 5,
                    length: 10 + Math.random() * 18
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

        // 底：雨滴玻璃开时画封面模糊底，否则画深色底。
        if (toggles.rain) {
            this.drawRainBackground(ctx, width, height);
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

    private drawRainBackground(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number
    ): void {
        const cover = this.options.getCoverImage();
        ctx.save();
        try {
            if (cover && cover.complete && cover.naturalWidth > 0) {
                ctx.filter = 'blur(18px) brightness(0.55)';
                const scale = Math.max(
                    width / cover.naturalWidth,
                    height / cover.naturalHeight
                );
                const drawWidth = cover.naturalWidth * scale;
                const drawHeight = cover.naturalHeight * scale;
                ctx.drawImage(
                    cover,
                    (width - drawWidth) / 2,
                    (height - drawHeight) / 2,
                    drawWidth,
                    drawHeight
                );
            } else {
                const gradient = ctx.createLinearGradient(0, 0, 0, height);
                gradient.addColorStop(0, '#2a1a30');
                gradient.addColorStop(1, '#14101c');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, width, height);
            }
        } catch {
            ctx.fillStyle = '#1c1424';
            ctx.fillRect(0, 0, width, height);
        } finally {
            ctx.filter = 'none';
            ctx.restore();
        }
    }

    private drawRain(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        animated: boolean
    ): void {
        const cssWidth = this.canvas.clientWidth || width;
        const cssHeight = this.canvas.clientHeight || height;
        ctx.save();
        ctx.strokeStyle = 'rgba(200, 220, 255, 0.55)';
        ctx.lineWidth = 1;
        for (const drop of this.drops) {
            if (animated) {
                drop.y += drop.speed;
                if (drop.y > cssHeight) {
                    drop.y = -drop.length;
                    drop.x = Math.random() * cssWidth;
                    this.ripples.push({ x: drop.x, y: cssHeight - 8, radius: 2, alpha: 0.5 });
                    if (this.ripples.length > 24) {
                        this.ripples.shift();
                    }
                }
            }
            const scaleX = width / cssWidth;
            const scaleY = height / cssHeight;
            ctx.beginPath();
            ctx.moveTo(drop.x * scaleX, drop.y * scaleY);
            ctx.lineTo(drop.x * scaleX, (drop.y + drop.length) * scaleY);
            ctx.stroke();
        }
        for (const ripple of this.ripples) {
            if (animated) {
                ripple.radius += 0.8;
                ripple.alpha -= 0.02;
            }
            if (ripple.alpha <= 0) {
                continue;
            }
            ctx.strokeStyle = `rgba(200, 220, 255, ${ripple.alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.ellipse(
                ripple.x * (width / cssWidth),
                ripple.y * (height / cssHeight),
                ripple.radius * (width / cssWidth),
                ripple.radius * 0.4 * (height / cssHeight),
                0,
                0,
                Math.PI * 2
            );
            ctx.stroke();
        }
        this.ripples = this.ripples.filter((ripple) => ripple.alpha > 0);
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
}
