// AutoMix 节拍跟踪（全新写，纯逻辑）：播放中对低频能量通量采样，
// 用自相关估一个节拍周期，供 playback.ts 在自然播完前踩着拍点附近
// 提前开始过渡。估计是尽力而为：样本不够、峰不明显一律回 null
// （未知），调用方按固定混合窗走，绝不因为估计失败阻塞播放。
//
// 采样口径：约 50ms 一次（playback.ts 的采样定时器管节奏），每次
// 一个低频通量值（相邻两帧低频能量的正向差，鼓点起音时冲高）。
// 保留最近约 20 秒样本（400 个），自相关在 60–200 BPM 对应的
// 滞后范围（周期 300–1000ms、即 6–20 个采样）里找峰；置信度 =
// 峰值相关 / 零滞后能量，低于阈值当未知。样本与计算都不碰 DOM、
// 不碰音频图，图与定时器都在 playback.ts。

const SAMPLE_INTERVAL_MS = 50;
const MAX_SAMPLES = 400; // 20 秒
const MIN_SAMPLES = 160; // 至少约 8 秒才估，短了峰不可信
const MIN_PERIOD_MS = 300; // 200 BPM
const MAX_PERIOD_MS = 1000; // 60 BPM
const MIN_CONFIDENCE = 0.18;

export interface BeatEstimate {
    bpm: number;
    periodMs: number;
    confidence: number;
}

export class BeatTracker {
    private flux: number[] = [];
    private prevLow: number[] | null = null;

    reset(): void {
        this.flux = [];
        this.prevLow = null;
    }

    // 喂一帧频谱字节数据：只看低频段（前 16 个 bin，鼓与贝斯所在），
    // 通量取本帧相对上帧的正向增量和；无起音时通量近零。
    sample(freqData: Uint8Array): void {
        const bins = Math.min(16, freqData.length);
        if (bins === 0) {
            return;
        }
        const low: number[] = [];
        for (let i = 0; i < bins; i++) {
            low.push(freqData[i] ?? 0);
        }
        let flux = 0;
        if (this.prevLow) {
            for (let i = 0; i < bins; i++) {
                const diff = low[i]! - (this.prevLow[i] ?? 0);
                if (diff > 0) {
                    flux += diff;
                }
            }
        }
        this.prevLow = low;
        this.flux.push(flux / bins);
        if (this.flux.length > MAX_SAMPLES) {
            this.flux.splice(0, this.flux.length - MAX_SAMPLES);
        }
    }

    estimate(): BeatEstimate | null {
        const n = this.flux.length;
        if (n < MIN_SAMPLES) {
            return null;
        }
        // 去均值，免得整体能量水平把自相关底噪抬平。
        let mean = 0;
        for (const v of this.flux) {
            mean += v;
        }
        mean /= n;
        const series = this.flux.map((v) => v - mean);
        let energy = 0;
        for (const v of series) {
            energy += v * v;
        }
        if (energy <= 0) {
            return null;
        }
        const minLag = Math.max(2, Math.round(MIN_PERIOD_MS / SAMPLE_INTERVAL_MS));
        const maxLag = Math.min(n - 1, Math.round(MAX_PERIOD_MS / SAMPLE_INTERVAL_MS));
        let bestLag = -1;
        let bestCorr = 0;
        for (let lag = minLag; lag <= maxLag; lag++) {
            let corr = 0;
            for (let i = 0; i + lag < n; i++) {
                corr += series[i]! * series[i + lag]!;
            }
            if (corr > bestCorr) {
                bestCorr = corr;
                bestLag = lag;
            }
        }
        if (bestLag < 0) {
            return null;
        }
        const confidence = bestCorr / energy;
        if (confidence < MIN_CONFIDENCE) {
            return null;
        }
        const periodMs = bestLag * SAMPLE_INTERVAL_MS;
        return {
            bpm: Math.round(60000 / periodMs),
            periodMs,
            confidence
        };
    }
}

// 混合窗：有节拍时取节拍的整数倍拍长（在当前剩余点附近凑整拍），
// 钳在 4–8 秒；节拍未知时固定 6 秒。纯函数，便于自查。
export function automixWindowMs(estimate: BeatEstimate | null): number {
    if (!estimate || estimate.periodMs <= 0) {
        return 6000;
    }
    const beats = Math.max(1, Math.round(6000 / estimate.periodMs));
    return Math.round(Math.min(8000, Math.max(4000, beats * estimate.periodMs)));
}

// 当前混音响度（时域 RMS）：静音/无图回 null，调用方按不缩放处理。
export function measureRms(analyser: AnalyserNode | null): number | null {
    if (!analyser) {
        return null;
    }
    try {
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data as Float32Array<ArrayBuffer>);
        let sum = 0;
        for (const v of data) {
            sum += v * v;
        }
        return Math.sqrt(sum / Math.max(1, data.length));
    } catch {
        return null;
    }
}

// 响度匹配：以当前 RMS 估新槽的起始增益目标——当前越响、新歌起得
// 越收（免得两首在峰值上叠爆），钳在 0.7–1.0；测不到回 1（不缩放）。
export function automixGainTarget(rms: number | null): number {
    if (rms === null || !Number.isFinite(rms)) {
        return 1;
    }
    const scaled = 1 - Math.max(0, rms - 0.2) * 0.9;
    return Math.min(1, Math.max(0.7, scaled));
}

// 开关持久化：跟播放设置既有键风格（zx.playback.*）。
const AUTOMIX_KEY = 'zx.playback.automix.v1';

export function loadAutoMixEnabled(): boolean {
    try {
        return localStorage.getItem(AUTOMIX_KEY) === '1';
    } catch {
        return false;
    }
}

export function saveAutoMixEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(AUTOMIX_KEY, enabled ? '1' : '0');
    } catch {
        // 存不下只影响下次打开的默认值。
    }
}

export const AUTOMIX_SAMPLE_MS = SAMPLE_INTERVAL_MS;
