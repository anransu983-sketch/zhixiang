// 封面取色（0.1.101 建，Folia dae91ddc 口径重写）：跨域匿名加载封面，
// 缩到 96px 后在 OKLCH 里按面积聚类，取面积最大的色簇均色，
// 再把明度钳到 [0.45, 0.72]、色度钳到 [0.05, 0.20] 后转回 sRGB。
// 旧版 4-bit 桶统计只看“饱和像素最多的桶”，深色封面常取到过暗
// 或过艳的色；面积聚类＋明度钳制后，晕染与辉光不再被极端色带偏。
// 网易云 p1/p2、YTM i.ytimg.com/lh3 均回 Access-Control-Allow-Origin: *
// （2026-10-29 实测），三源封面都能采；失败（跨域拦截、超时、
// 无可用像素）回 null，调用方用主题色兜底。
// 签名与调用点不变：sampleCoverColor(url, timeoutMs?)。

// sRGB → OKLCH（Björn Ottosson 的 OKLab 矩阵，L/C/H 分量）。
function srgbToOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
    const linear = (v: number): number => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    const red = linear(r);
    const green = linear(g);
    const blue = linear(b);
    const lmsL = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
    const lmsM = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
    const lmsS = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
    const l = Math.cbrt(lmsL);
    const m = Math.cbrt(lmsM);
    const s = Math.cbrt(lmsS);
    const light = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { l: light, c: Math.hypot(a, b2), h: Math.atan2(b2, a) };
}

// OKLCH → sRGB hex（与上式互逆；通道钳到 0–255）。
function oklchToHex(l: number, c: number, h: number): string {
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const lmsL = l + 0.3963377774 * a + 0.2158037573 * b;
    const lmsM = l - 0.1055613458 * a - 0.0638541728 * b;
    const lmsS = l - 0.0894841775 * a - 1.291485548 * b;
    const l3 = lmsL * lmsL * lmsL;
    const m3 = lmsM * lmsM * lmsM;
    const s3 = lmsS * lmsS * lmsS;
    const red = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    const green = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    const blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
    const encode = (v: number): number => {
        const x = Math.max(0, Math.min(1, v));
        return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    };
    const toHex = (v: number): string =>
        Math.round(encode(v) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

const clamp = (v: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, v));

export function sampleCoverColor(url: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (value: string | null): void => {
            if (done) {
                return;
            }
            done = true;
            resolve(value);
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            window.clearTimeout(timer);
            try {
                const size = 96;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) {
                    finish(null);
                    return;
                }
                ctx.drawImage(img, 0, 0, size, size);
                const data = ctx.getImageData(0, 0, size, size).data;
                interface Cluster {
                    count: number;
                    sumL: number;
                    sumA: number;
                    sumB: number;
                }
                const clusters = new Map<string, Cluster>();
                let allCount = 0;
                let allR = 0;
                let allG = 0;
                let allB = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i]!;
                    const g = data[i + 1]!;
                    const b = data[i + 2]!;
                    const a = data[i + 3]!;
                    if (a < 128) {
                        continue;
                    }
                    allCount += 1;
                    allR += r;
                    allG += g;
                    allB += b;
                    // 近灰像素不入簇，避免灰白黑底主导取色。
                    const { l, c, h } = srgbToOklch(r, g, b);
                    if (c < 0.02) {
                        continue;
                    }
                    const hueDeg = ((h * 180) / Math.PI + 360) % 360;
                    const key = `${Math.floor(l / 0.1)}|${Math.floor(c / 0.05)}|${Math.floor(hueDeg / 30)}`;
                    const cluster = clusters.get(key) ?? { count: 0, sumL: 0, sumA: 0, sumB: 0 };
                    cluster.count += 1;
                    cluster.sumL += l;
                    cluster.sumA += c * Math.cos(h);
                    cluster.sumB += c * Math.sin(h);
                    clusters.set(key, cluster);
                }
                let best: Cluster | null = null;
                for (const cluster of clusters.values()) {
                    if (!best || cluster.count > best.count) {
                        best = cluster;
                    }
                }
                if (best) {
                    const meanL = best.sumL / best.count;
                    const meanA = best.sumA / best.count;
                    const meanB = best.sumB / best.count;
                    const meanC = Math.hypot(meanA, meanB);
                    if (meanC >= 0.03) {
                        // 面积最大簇的均色：明度与色度钳制后输出，
                        // 深色封面不再取到近黑、艳色封面不再取到刺眼。
                        finish(
                            oklchToHex(
                                clamp(meanL, 0.45, 0.72),
                                clamp(meanC, 0.05, 0.2),
                                Math.atan2(meanB, meanA)
                            )
                        );
                        return;
                    }
                }
                // 无可用色簇（全灰封面等）：回落整图均色，不编新色。
                if (allCount === 0) {
                    finish(null);
                    return;
                }
                const toHex = (v: number): string =>
                    Math.round(v).toString(16).padStart(2, '0');
                finish(
                    `#${toHex(allR / allCount)}${toHex(allG / allCount)}${toHex(allB / allCount)}`
                );
            } catch {
                finish(null);
            }
        };
        img.onerror = () => {
            window.clearTimeout(timer);
            finish(null);
        };
        img.src = url;
    });
}
