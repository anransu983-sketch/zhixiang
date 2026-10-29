// 播放引擎（第 5 块）：队列 + 淡入淡出 + 后台保活接线。
//
// 对外契约（保持不变 / 新增最小集）：
// - playTrack(track) 签名不变：点一首即播，内部把它当成单首队列。
// - playQueue(tracks, index)：点一首即把该区当前列表作为队列，从点中的那首起播。
// - next() / previous() / togglePlay() / pause() / stop()：最小队列控制。
// - onTrackChange / onTimeUpdate / getCurrentState：供第 8 块壁纸与视觉订阅状态。
// - getAnalyser()：有 Web Audio 图时返回 AnalyserNode，供第 8 块节奏脉动取频谱；
//   图建不起来（见下）时返回 null，脉动只能降级，调用方必须判空。
//
// 淡入淡出常量（全部集中在这里，改动只改此处）：
// - CROSSFADE_MS = 3000：切歌重叠时长。旧首在这 3 秒内淡出，新首同时淡入，
//   两首重叠 3 秒，不是旧首停干净了新首才起。
// - FADE_IN_MS = 800：首次播放 / 队列自然续播时的短淡入（旧首已播完，无重叠可言）。
// - FADE_OUT_MS = 500：暂停 / 停止时的短淡出，淡完才真正 pause，避免戛然而止。
// - FADE_RESUME_MS = 500：暂停后恢复时的短淡入。
// - FADE_STEP_MS = 50：不用 Web Audio 图时的 volume 渐变步进（见下）。
//
// 淡入淡出实现方式：优先 Web Audio 图。
// 两个 audio 元素轮换（双槽），各接自己的 GainNode，两路 GainNode 都汇入同一个
// AnalyserNode 再到 destination。淡入淡出就是 GainNode 的 linearRamp，与音量
// 属性渐变相比更平滑，且 AnalyserNode 能同时看到混音后的频谱。
// 图建不起来时（浏览器预览里远程直连、或 AudioContext 不可用）退回双 audio
// 元素的 volume 渐变：同一套淡入淡出时序不变，只是没有 AnalyserNode，
// getAnalyser() 返回 null，第 8 块节奏脉动只能降级（例如跟随播放状态做固定
// 呼吸动画，而非跟随真实频谱）。安卓目标路径上一律走图，不走这条退路。
//
// 有界 Range 与跨域（承接第 4 块约束，必做）：
// - 路线选择：原生小 HTTP 代理服务（StreamProxyServer.java），不用 MSE。
//   选代理不选 MSE 的理由：audio 元素原生支持 Range 续播 / 快进与元数据，
//   不用自己实现分块缓冲、解码与 seek 换块；代理只做一件事——把 audio 发来的
//   无界 Range 翻成 1MiB 有界上游请求，改动面最小，出问题也最容易定位。
//   MSE 备选被放弃：要自己管 SourceBuffer 追加、驱逐与 seek，工作量与风险都
//   远大于代理，且对音频并无额外收益。
// - Web 层把远程流地址交给代理：http://127.0.0.1:<端口>/proxy?u=<编码后目标>，
//   audio 元素的 src 只填这条代理地址，googlevideo 地址绝不直出给 audio 元素。
//   代理把每个上游请求限定为 1MiB 窗口分段回 206（见 StreamProxyServer 注释）。
// - 代理响应带 Access-Control-Allow-Origin: *，且代理地址的 audio 元素设
//   crossOrigin="anonymous"，这样 Web Audio 图读到的数据不被跨域污染，
//   AnalyserNode 才能正常出频谱；否则图会静默输出全零。
// - 本地文件仍走 convertFileSrc 直播，不经过代理：本地是同源地址，图可直接读，
//   也不需要有界 Range 转换；本地 audio 元素不设 crossOrigin（同源不需要，
//   设了反而可能因本地服务不回跨域头而失败）。
// - 安卓上远程流（网易云与 YTM）一律走代理：代理起不来就抛错，不直连降级。
//   浏览器预览不是交付目标：YTM 在浏览器里同样抛错（不直出 googlevideo）；
//   网易云在浏览器里允许直连降级（volume 渐变、无 Analyser），只为调试方便。
//
// 保活：播放成功起前台服务（PlaybackPlugin.start，通知只有应用名 + 当前歌名，
// 无控制按钮，点通知回应用）；暂停不断服务（恢复时不用重起）；停止 / 队列播完
// 才停服务与代理。原生侧失败不中断播放（见 playback-plugin.ts 约定）。

import { Capacitor } from '@capacitor/core';
import { getSource } from './sources/index';
import { findBilibiliFallback } from './sources/fallback';
import { NETEASE_MINT_UA } from './sources/netease';
import { eapiRequest } from './sources/netease-eapi';
import { isYtmGateError, resolveYtmStream } from './sources/ytm';
import {
    ensureStreamProxy,
    startPlaybackService,
    stopPlaybackService,
    stopStreamProxy
} from './native/playback-plugin';
import type { Track } from './types';

// ---- 淡入淡出常量（集中一处，见文件头注释） ----
const CROSSFADE_MS = 3000;
const FADE_IN_MS = 800;
const FADE_OUT_MS = 500;
const FADE_RESUME_MS = 500;
const FADE_STEP_MS = 50;

export interface PlaybackState {
    track: Track | null;
    playing: boolean;
    currentTime: number;
    duration: number;
    queue: Track[];
    index: number;
    error: string | null;
}

// 循环模式（播放页底排用，只影响自然播完与队尾手动下一首，不动淡入淡出）：
// off = 不循环，queue = 列表循环，one = 单曲循环。存在 localStorage。
export type RepeatMode = 'off' | 'queue' | 'one';

const REPEAT_KEY = 'zx_repeat_mode_v1';

export function getRepeatMode(): RepeatMode {
    try {
        const raw = localStorage.getItem(REPEAT_KEY);
        if (raw === 'queue' || raw === 'one') {
            return raw;
        }
    } catch {
        // 存取失败时按默认。
    }
    return 'off';
}

export function setRepeatMode(mode: RepeatMode): void {
    try {
        localStorage.setItem(REPEAT_KEY, mode);
    } catch {
        // 存不下只影响下次打开的默认值。
    }
}

type StateListener = (state: PlaybackState) => void;

interface PlayerSlot {
    audio: HTMLAudioElement;
    gain: GainNode | null;
    sourceNode: MediaElementAudioSourceNode | null;
    graphAvailable: boolean;
    fadeTimer: ReturnType<typeof setTimeout> | null;
    volumeTimer: ReturnType<typeof setInterval> | null;
    generation: number;
}

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;

let queue: Track[] = [];
let queueIndex = 0;
let currentTrack: Track | null = null;
let playing = false;
let lastError: string | null = null;
let currentTime = 0;
let currentDuration = 0;

const trackListeners = new Set<StateListener>();
const timeListeners = new Set<StateListener>();

function makeAudio(): HTMLAudioElement {
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    return audio;
}

function makeSlot(): PlayerSlot {
    const slot: PlayerSlot = {
        audio: makeAudio(),
        gain: null,
        sourceNode: null,
        graphAvailable: false,
        fadeTimer: null,
        volumeTimer: null,
        generation: 0
    };
    bindAudioEvents(slot, slot.audio);
    return slot;
}

// 双槽轮换：切歌时旧槽淡出、新槽淡入，两个槽永远不共用同一个 audio 元素。
const slotA = makeSlot();
const slotB = makeSlot();
let activeSlot: PlayerSlot | null = null;

function otherSlot(slot: PlayerSlot | null): PlayerSlot {
    return slot === slotA ? slotB : slotA;
}

function getCurrentState(): PlaybackState {
    return {
        track: currentTrack,
        playing,
        currentTime,
        duration: currentDuration,
        queue: [...queue],
        index: queueIndex,
        error: lastError
    };
}

function emit(listeners: Set<StateListener>): void {
    const state = getCurrentState();
    for (const listener of listeners) {
        try {
            listener(state);
        } catch {
            // 订阅方异常不中断播放。
        }
    }
}

function emitTrackChange(): void {
    emit(trackListeners);
}

function emitTimeUpdate(): void {
    emit(timeListeners);
}

export function onTrackChange(listener: StateListener): () => void {
    trackListeners.add(listener);
    return () => {
        trackListeners.delete(listener);
    };
}

export function onTimeUpdate(listener: StateListener): () => void {
    timeListeners.add(listener);
    return () => {
        timeListeners.delete(listener);
    };
}

export function getAnalyser(): AnalyserNode | null {
    return analyser;
}

function ensureAudioContext(): AudioContext | null {
    if (audioContext) {
        if (audioContext.state === 'suspended') {
            void audioContext.resume();
        }
        return audioContext;
    }
    const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) {
        return null;
    }
    try {
        audioContext = new AudioCtor();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;
        analyser.connect(audioContext.destination);
    } catch {
        audioContext = null;
        analyser = null;
        return null;
    }
    return audioContext;
}

function bindAudioEvents(slot: PlayerSlot, audio: HTMLAudioElement): void {
    audio.addEventListener('timeupdate', () => {
        if (activeSlot !== slot || !currentTrack) {
            return;
        }
        currentTime = audio.currentTime;
        const metaDuration = audio.duration;
        currentDuration =
            Number.isFinite(metaDuration) && metaDuration > 0
                ? metaDuration * 1000
                : (currentTrack.durationMs ?? 0);
        emitTimeUpdate();
    });
    audio.addEventListener('ended', () => {
        // 只有当前槽的自然播完才续播；切歌时被淡出的旧槽不在此列。
        if (activeSlot !== slot || !playing) {
            return;
        }
        void advanceAfterEnded();
    });
    audio.addEventListener('error', () => {
        if (activeSlot !== slot) {
            return;
        }
        console.log(
            `[Playback] audio 元素错误：code=${audio.error?.code ?? 'none'}` +
                (audio.error?.message ? ` ${audio.error.message}` : '')
        );
        playing = false;
        lastError = '播放失败，请换一首试试';
        emitTrackChange();
    });
}

function clearFadeTimers(slot: PlayerSlot): void {
    if (slot.fadeTimer !== null) {
        clearTimeout(slot.fadeTimer);
        slot.fadeTimer = null;
    }
    if (slot.volumeTimer !== null) {
        clearInterval(slot.volumeTimer);
        slot.volumeTimer = null;
    }
    // 世代号递增：已排队的淡出后 pause 一律失效，防止旧槽被复用后误停新歌。
    slot.generation += 1;
}

function fadeGraphGain(slot: PlayerSlot, target: number, durationMs: number): void {
    if (!audioContext || !slot.gain) {
        return;
    }
    const gain = slot.gain.gain;
    const now = audioContext.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + durationMs / 1000);
}

function fadeVolume(slot: PlayerSlot, target: number, durationMs: number): void {
    if (slot.volumeTimer !== null) {
        clearInterval(slot.volumeTimer);
        slot.volumeTimer = null;
    }
    const audio = slot.audio;
    const start = audio.volume;
    if (durationMs <= 0 || start === target) {
        audio.volume = target;
        return;
    }
    const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS));
    let step = 0;
    slot.volumeTimer = setInterval(() => {
        step += 1;
        if (step >= steps) {
            audio.volume = target;
            if (slot.volumeTimer !== null) {
                clearInterval(slot.volumeTimer);
                slot.volumeTimer = null;
            }
            return;
        }
        audio.volume = start + (target - start) * (step / steps);
    }, FADE_STEP_MS);
}

function fadeSlotTo(slot: PlayerSlot, target: number, durationMs: number): void {
    if (slot.graphAvailable && slot.gain) {
        fadeGraphGain(slot, target, durationMs);
    } else {
        fadeVolume(slot, target, durationMs);
    }
}

function fadeOutAndPause(slot: PlayerSlot, durationMs: number): void {
    clearFadeTimers(slot);
    fadeSlotTo(slot, 0, durationMs);
    const generation = slot.generation;
    slot.fadeTimer = setTimeout(() => {
        // 槽已被复用（世代号变了）时不碰它，新歌不受旧淡出牵连。
        if (slot.generation !== generation) {
            return;
        }
        slot.fadeTimer = null;
        slot.audio.pause();
    }, durationMs);
}

// needsGraph 为真时给槽接 Web Audio 图；为假（浏览器直连降级）时，若该槽
// 已接过图则换一个全新 audio 元素——接过图的旧元素无法脱图，直连会因跨域
// 污染而静默无声，换元素是唯一干净的退路。
function ensureSlotGraph(slot: PlayerSlot, needsGraph: boolean): void {
    if (!needsGraph) {
        if (slot.sourceNode !== null) {
            slot.audio.pause();
            slot.audio.removeAttribute('src');
            slot.audio.load();
            if (slot.gain) {
                try {
                    slot.gain.disconnect();
                } catch {
                    // 断开失败不影响新元素。
                }
            }
            if (slot.sourceNode) {
                try {
                    slot.sourceNode.disconnect();
                } catch {
                    // 同上。
                }
            }
            slot.audio = makeAudio();
            bindAudioEvents(slot, slot.audio);
            slot.gain = null;
            slot.sourceNode = null;
        }
        slot.graphAvailable = false;
        return;
    }
    const context = ensureAudioContext();
    if (!context || !analyser) {
        slot.graphAvailable = false;
        return;
    }
    if (slot.sourceNode === null) {
        try {
            const sourceNode = context.createMediaElementSource(slot.audio);
            const gain = context.createGain();
            gain.gain.value = 0;
            sourceNode.connect(gain);
            gain.connect(analyser);
            slot.sourceNode = sourceNode;
            slot.gain = gain;
            slot.graphAvailable = true;
        } catch {
            slot.sourceNode = null;
            slot.gain = null;
            slot.graphAvailable = false;
        }
    } else {
        slot.graphAvailable = true;
    }
}

function setSlotSilent(slot: PlayerSlot): void {
    if (slot.graphAvailable && slot.gain && audioContext) {
        slot.gain.gain.cancelScheduledValues(audioContext.currentTime);
        slot.gain.gain.value = 0;
    } else {
        slot.audio.volume = 0;
    }
}

interface ResolvedPlay {
    url: string;
    needsGraph: boolean;
    viaProxy: boolean;
    // 代理取流时要复用的铸链 UA（仅 YTM 有）；代理端口供失败时拉 /last 诊断用。
    proxyUserAgent?: string;
    proxyPort?: number;
}

// 回环连通探针：只记端口与成败，不记地址。失败时记错误名与 message
//（明文被拦时 WebView 只给 TypeError: Failed to fetch），供日志分流用。
async function probeProxy(port: number): Promise<void> {
    try {
        const probe = new AbortController();
        setTimeout(() => probe.abort(), 2000);
        const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: probe.signal });
        const text = (await res.text()).trim();
        console.log(`[Playback] 代理探针：port=${port} ${text === 'ok' ? 'ok' : `unexpected:${res.status}`}`);
    } catch (error) {
        console.log(
            `[Playback] 代理探针失败：port=${port} ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`
        );
    }
}

async function resolvePlayUrl(track: Track): Promise<ResolvedPlay> {
    if (track.source === 'local') {
        const source = getSource(track.source);
        if (!source) {
            throw new Error('该音源尚未接上');
        }
        // 本地同源直连，不经过代理，也不设 crossOrigin。
        return { url: await source.resolveStream(track), needsGraph: true, viaProxy: false };
    }
    const isAndroid = Capacitor.getPlatform() === 'android';
    if (isAndroid) {
        // 安卓目标路径：远程流一律走本机代理，代理起不来就抛错，绝不直连。
        const port = await ensureStreamProxy();
        // 播歌前先探一次回环：探针失败只记日志不拦播放，留作分流证据
        //（WebView 到不了代理 vs 代理到了但上游拒了）。
        await probeProxy(port);
        let target: string;
        let proxyUserAgent: string | undefined;
        let proxyReferer: string | undefined;
        if (track.source === 'ytm') {
            const stream = await resolveYtmStream(track);
            target = stream.url;
            lastYtmStream = { url: target, userAgent: stream.userAgent };
            // 铸链 UA 交给代理复用：代理上游 UA 与铸链时不一致会被 googlevideo 拒。
            proxyUserAgent = stream.userAgent;
        } else {
            const source = getSource(track.source);
            if (!source) {
                throw new Error('该音源尚未接上');
            }
            target = await source.resolveStream(track);
            if (track.source === 'bilibili') {
                // 0.1.108：B 站音频 CDN（upos）无 Referer 直接 403，带
                // https://www.bilibili.com 则 206（同地址实测 3/3）；
                // 代理上游只带 Range 与 UA，故把 Referer 当参数带给代理。
                proxyReferer = 'https://www.bilibili.com';
            }
            if (track.source === 'netease' && target.includes('authSecret')) {
                // 0.1.75：带签名曲才记为探针目标。当前曲目会随自动跳歌/
                // 循环回到可播曲（如我们的晴天），探针若只认当前曲目，
                // 永远探不到真正失败的带签名地址。
                lastSignedNeteaseTrack = track;
            }
        }
        let proxyUrl = `http://127.0.0.1:${port}/proxy?u=${encodeURIComponent(target)}`;
        if (proxyUserAgent) {
            proxyUrl += `&ua=${encodeURIComponent(proxyUserAgent)}`;
        }
        if (proxyReferer) {
            proxyUrl += `&referer=${encodeURIComponent(proxyReferer)}`;
        }
        return {
            url: proxyUrl,
            needsGraph: true,
            viaProxy: true,
            proxyUserAgent,
            proxyPort: port
        };
    }
    // 浏览器预览（非交付目标）：YTM 仍不直出 googlevideo，直接抛错；
    // 其余远程流允许直连降级（volume 渐变、无 Analyser）。
    if (track.source === 'ytm') {
        throw new Error('YTM 播放请在安卓 App 内打开，浏览器预览播不了');
    }
    const source = getSource(track.source);
    if (!source) {
        throw new Error('该音源尚未接上');
    }
    return { url: await source.resolveStream(track), needsGraph: false, viaProxy: false };
}

// 每次起歌的 load 编号：代理按 lid 记取流记录，失败时只认本 load 的行，
// 连续/并发尝试互相覆盖的 /last 竞态才杀得掉。
let loadCounter = 0;
// 最近一次 YTM 取链结果（目标与铸链 UA），供开发者区原生复现实验用。
let lastYtmStream: { url: string; userAgent?: string } | null = null;
// 最近一次带 authSecret 的网易云曲目（播放时 resolvePlayUrl 记下），
// 供探针用：探针目标必须是它，不能是当前曲目。
let lastSignedNeteaseTrack: Track | null = null;

// 播放意图：每次新起歌（点播／上下首／播完自动推进／停止）都加一。
// 旧的起歌与跳歌循环凭它认出自己已过时，直接退出而不跳歌——2026-10-26
// 四季予你连锁失败的根因：重叠的两次起歌共用同一槽，后一次设地址打断
// 前一次待决的 play()，而前一次的失败又触发跳歌再起新 load，循环打断。
let playIntent = 0;

// 起歌结果：'ok'＝已接管当前槽；'stale'＝取链／播放期间已有更新的起歌，
// 本尝试已过时——调用方不得把它当失败跳歌，也不得动播放状态。
async function startTrack(track: Track, crossfade: boolean): Promise<'ok' | 'stale'> {
    const loadId = ++loadCounter;
    const oldSlot = activeSlot;
    const resolved = await resolvePlayUrl(track);
    // 取链期间已有更新的起歌：连槽都不碰，直接过时退出。
    if (loadId !== loadCounter) {
        console.log(`[Playback] 起歌已过时 lid=${loadId}（取链期间被新起歌取代）`);
        return 'stale';
    }
    // 槽必须在 await 之后才选：await 之前选的槽是旧 activeSlot 的对面，
    // 重叠的两起歌会算出同一个槽，后一次设地址即打断前一次的 play()。
    const newSlot = otherSlot(activeSlot);
    if (resolved.viaProxy) {
        resolved.url += `&lid=${loadId}`;
    }
    console.log(`[Playback] 起歌 lid=${loadId} 槽=${newSlot === slotA ? 'A' : 'B'} ${track.title}`);
    clearFadeTimers(newSlot);
    ensureSlotGraph(newSlot, resolved.needsGraph);
    const audio = newSlot.audio;
    if (resolved.viaProxy) {
        audio.crossOrigin = 'anonymous';
    } else {
        audio.removeAttribute('crossorigin');
    }
    audio.src = resolved.url;
    setSlotSilent(newSlot);
    try {
        await audio.play();
    } catch (error) {
        // 被更新的起歌打断：不是真失败，不拉 /last、不跳歌，让新 load 赢。
        if (loadId !== loadCounter) {
            console.log(`[Playback] 起歌已过时 lid=${loadId}（播放被新 load 打断）`);
            return 'stale';
        }
        // 新歌起不来时旧歌不受影响：旧槽还没淡出，状态保持原样。
        console.log(
            `[Playback] audio.play 失败：${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`
        );
        // 代理取流失败时顺手拉代理的 /last 诊断（只含状态/类型/长度，不含地址），
        // 下次看日志就能分流是代理没被打到、上游拒了，还是回包格式问题。
        if (resolved.viaProxy && resolved.proxyPort) {
            try {
                const probe = new AbortController();
                setTimeout(() => probe.abort(), 2000);
                const res = await fetch(`http://127.0.0.1:${resolved.proxyPort}/last`, {
                    signal: probe.signal
                });
                const text = (await res.text()).trim();
                // 只认本 load 的记录行；没有本 load 行时原样记下，供判断
                // 是本 load 没打到代理、还是记录被后续尝试顶掉。
                const matched = text
                    .split('\n')
                    .filter((line) => line.includes(`lid=${loadId}`));
                if (matched.length > 0) {
                    for (const line of matched) {
                        console.log(`[Playback] 代理上次取流：${line}`);
                    }
                } else if (text) {
                    console.log(`[Playback] 代理上次取流：无 lid=${loadId} 记录，原始：${text}`);
                }
            } catch (probeError) {
                // 0.1.33 曾静默吞掉这里，导致 15 次失败零诊断日志：
                // 诊断拉取本身失败也要记错误名与 message，否则分不了流。
                console.log(
                    `[Playback] 代理诊断拉取失败：${probeError instanceof Error ? `${probeError.name} ${probeError.message}` : String(probeError)}`
                );
            }
        }
        throw new Error('播放失败，请换一首试试');
    }
    // play 成功后又被更新的起歌抢先：不接管 activeSlot，让新 load 赢。
    if (loadId !== loadCounter) {
        console.log(`[Playback] 起歌已过时 lid=${loadId}（play 成功后被新起歌取代）`);
        return 'stale';
    }
    const previousTrack = currentTrack;
    const wasPlaying = playing;
    activeSlot = newSlot;
    currentTrack = track;
    playing = true;
    lastError = null;
    currentTime = 0;
    currentDuration = track.durationMs ?? 0;
    emitTrackChange();
    // 保活：起前台服务失败不中断播放（原生侧降级，见文件头）。
    try {
        await startPlaybackService(track.title, track.artist);
    } catch {
        // 忽略：继续播，只是后台保活可能失效。
    }
    if (oldSlot && oldSlot !== newSlot) {
        if (crossfade && wasPlaying && previousTrack) {
            // 重叠淡入淡出：旧首 3 秒淡出，新首同时 3 秒淡入。
            fadeOutAndPause(oldSlot, CROSSFADE_MS);
            fadeSlotTo(newSlot, 1, CROSSFADE_MS);
        } else {
            oldSlot.audio.pause();
            fadeSlotTo(newSlot, 1, crossfade ? CROSSFADE_MS : FADE_IN_MS);
        }
    } else {
        fadeSlotTo(newSlot, 1, FADE_IN_MS);
    }
    return 'ok';
}

// 队列内跳过失败曲目：从 startIdx 沿 step 方向逐首试 startTrack，直到播出
// 或走完队尾。成功时把 queueIndex 落到播出那首；全部失败时 queueIndex 不动
// （调用方仍可重试），只返回失败数。淡入淡出语义由 startTrack 内部处理，不变。
// 系统性失败（例如取流全被拒）时连跳整单只刷屏不解决问题：连续失败达上限即停。
const MAX_CONSECUTIVE_SKIPS = 3;
async function tryPlayFrom(
    startIdx: number,
    crossfade: boolean,
    step: 1 | -1
): Promise<{ played: boolean; failed: number; stale: boolean }> {
    // 跳歌循环也认意图：循环期间有新起歌，立即停，不再起新 load
    // （否则旧循环的起歌会用 ++loadCounter 杀掉合法那首的 play）。
    const intent = playIntent;
    let failed = 0;
    for (let i = startIdx; step === 1 ? i < queue.length : i >= 0; i += step) {
        if (intent !== playIntent) {
            return { played: false, failed, stale: true };
        }
        const track = queue[i];
        if (!track) {
            continue;
        }
        try {
            const result = await startTrack(track, crossfade);
            if (result === 'stale') {
                return { played: false, failed, stale: true };
            }
            queueIndex = i;
            return { played: true, failed, stale: false };
        } catch (error) {
            // 0.1.105：网易云曲目起不来时，先试 B 站兜底（歌名歌手时长评分）；
            // 兜底成功则把队列里这首换成 B 站版继续播，不计入失败跳歌。
            if (track.source === 'netease' && intent === playIntent) {
                const fallback = await findBilibiliFallback(track);
                if (fallback && intent === playIntent) {
                    try {
                        const fbResult = await startTrack(fallback, crossfade);
                        if (fbResult === 'stale') {
                            return { played: false, failed, stale: true };
                        }
                        queue[i] = fallback;
                        queueIndex = i;
                        return { played: true, failed, stale: false };
                    } catch {
                        // 兜底也失败：按原路计失败、继续跳歌。
                    }
                }
            }
            failed += 1;
            console.log(
                `[Playback] 跳过 ${track.title}：${error instanceof Error ? error.message : '未知原因'}`
            );
            // 登录门：立即停跳，不再连跳整单续门（Claude 第十五轮）。
            if (isYtmGateError(error)) {
                console.log('[Playback] 撞登录门，停止自动跳歌');
                break;
            }
            if (failed >= MAX_CONSECUTIVE_SKIPS) {
                console.log(`[Playback] 连续失败 ${failed} 首，停止自动跳歌`);
                break;
            }
        }
    }
    return { played: false, failed, stale: false };
}

// 全部失败时的提示：单首失败保留旧文案，多首才注明跳过了几首。
function skipAllMessage(failed: number): string {
    if (failed > 0) {
        console.log(`[Playback] 队列全部失败：跳过 ${failed} 首`);
    }
    if (failed <= 1) {
        return '播放失败，请换一首试试';
    }
    return `跳过了 ${failed} 首，还是播不了，请换一首试试`;
}

async function advanceAfterEnded(): Promise<void> {
    ++playIntent;
    const mode = getRepeatMode();
    // 单曲循环：重播当前这首（自然播完，无重叠，短淡入）；重播失败直接停，不往后跳。
    if (mode === 'one' && currentTrack) {
        try {
            const result = await startTrack(currentTrack, false);
            if (result === 'stale') {
                return;
            }
            return;
        } catch {
            playing = false;
            lastError = '播放失败，请换一首试试';
            emitTrackChange();
            try {
                await stopPlaybackService();
            } catch {
                // 忽略。
            }
            try {
                await stopStreamProxy();
            } catch {
                // 忽略。
            }
            return;
        }
    }
    if (queueIndex >= queue.length - 1) {
        // 列表循环：队尾播完回到队首；队首起全播不了时按播完处理并提示。
        if (mode === 'queue' && queue.length > 0) {
            const result = await tryPlayFrom(0, false, 1);
            if (result.stale) {
                return;
            }
            if (result.played) {
                return;
            }
            lastError = skipAllMessage(result.failed);
        }
        // 队列播完：停前台服务与代理，状态回到未播放。
        playing = false;
        emitTrackChange();
        try {
            await stopPlaybackService();
        } catch {
            // 忽略。
        }
        try {
            await stopStreamProxy();
        } catch {
            // 忽略。
        }
        return;
    }
    // 旧首已自然播完，无重叠可言，新首用短淡入；中途失败自动往后跳。
    const result = await tryPlayFrom(queueIndex + 1, false, 1);
    if (result.stale) {
        return;
    }
    if (!result.played) {
        // 剩余曲目全播不了：按播完处理，停前台服务与代理。
        playing = false;
        lastError = skipAllMessage(result.failed);
        emitTrackChange();
        try {
            await stopPlaybackService();
        } catch {
            // 忽略。
        }
        try {
            await stopStreamProxy();
        } catch {
            // 忽略。
        }
    }
}

export async function playTrack(track: Track): Promise<void> {
    await playQueue([track], 0);
}

// 正在进行的点播键（同队列同起点）：移动端连点两次会同时起两个
// playQueue，两个槽各载同一 URL，表现为一首歌两次探针＋两次取链，
// 第二次取流还可能被上游当重放拒掉。同一键在途时后一次直接忽略。
let inFlightPlayKey: string | null = null;

export async function playQueue(tracks: Track[], startIndex: number): Promise<void> {
    if (tracks.length === 0) {
        throw new Error('歌单是空的，播不了');
    }
    const clamped = Math.min(Math.max(0, startIndex), tracks.length - 1);
    const target = tracks[clamped];
    if (!target) {
        throw new Error('歌单是空的，播不了');
    }
    const playKey = tracks.map((t) => `${t.source}:${t.id}`).join(',') + '@' + clamped;
    if (inFlightPlayKey === playKey) {
        console.log('[Playback] 重复点播已忽略（同队列同起点在途）');
        return;
    }
    inFlightPlayKey = playKey;
    try {
        // 意图加一必须在去重之后：被忽略的重 tap 不能杀掉在途那首。
        ++playIntent;
        const crossfade = playing && activeSlot !== null && currentTrack !== null;
        queue = [...tracks];
        queueIndex = clamped;
        // 从起始下标向前逐首试：中途失败自动往后跳，全部失败才抛错。
        const result = await tryPlayFrom(clamped, crossfade, 1);
        if (result.stale) {
            // 已被更新的起歌取代：静默退出，不抛错、不提示。
            return;
        }
        if (!result.played) {
            throw new Error(skipAllMessage(result.failed));
        }
    } finally {
        if (inFlightPlayKey === playKey) {
            inFlightPlayKey = null;
        }
    }
}

// 原生三段复现实验（开发者区按钮触发）：同一 YTM 直链，不经 WebView
// 与 audio 元素，由代理原生依次取 0-1MiB、0-1MiB、1MiB-2MiB。
// 206/206/206=双载伪影，206/403/x=重放被拒，206/206/403=后续窗口被拒。
export async function runYtmUpstreamExperiment(): Promise<void> {
    if (!lastYtmStream) {
        console.log('[Playback] 上游复现实验：还没有 YTM 取链结果，先播一首 YTM 再试');
        return;
    }
    try {
        const port = await ensureStreamProxy();
        const url = `http://127.0.0.1:${port}/experiment?u=${encodeURIComponent(lastYtmStream.url)}` +
            (lastYtmStream.userAgent ? `&ua=${encodeURIComponent(lastYtmStream.userAgent)}` : '');
        const res = await fetch(url);
        const text = (await res.text()).trim();
        for (const line of text.split('\n')) {
            if (line) {
                console.log(`[Playback] 上游复现实验：${line}`);
            }
        }
    } catch (error) {
        console.log(
            `[Playback] 上游复现实验失败：${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`
        );
    }
}

export async function runNeteaseProbe(): Promise<void> {
    // 0.1.75：优先用最近一次带签名曲，当前曲目只作回落。
    // 之前两次探针都撞上我们的晴天，就是因为当前曲目在失败后循环回了
    // 可播曲，探针根本没探到失败类地址。
    const probeTrack = lastSignedNeteaseTrack
        ?? (currentTrack && currentTrack.source === 'netease' ? currentTrack : null);
    if (!probeTrack) {
        console.log('[Playback] 网易云取流探针：还没有带签名网易云曲目记录，先播一首带签名曲（宝船等）让它失败一次再试');
        return;
    }
    console.log(`[Playback] 网易云探针：曲目=${probeTrack.title}${lastSignedNeteaseTrack ? '（最近一次带签名曲）' : '（当前网易云曲目，无签名记录）'}`);
    try {
        // 探针取新链：不经 audio 播放，令牌在 7 臂里第一次被用的是第 1 臂，
        // 第 7 臂复用同一地址，验的就是重放。
        const source = getSource('netease');
        if (!source) {
            console.log('[Playback] 网易云取流探针：网易云音源尚未接上');
            return;
        }
        const httpsUrl = await source.resolveStream(probeTrack);
        const port = await ensureStreamProxy();
        const url = `http://127.0.0.1:${port}/netease-probe?u=${encodeURIComponent(httpsUrl)}` +
            `&mintUa=${encodeURIComponent(NETEASE_MINT_UA)}`;
        const res = await fetch(url);
        const text = (await res.text()).trim();
        for (const line of text.split('\n')) {
            if (line) {
                console.log(`[Playback] 网易云探针：${line}`);
            }
        }
        // 0.1.76 v1 对比：同一首歌用 eapi v1 再取一次链（Folia 同款
        // /api/song/enhance/player/url/v1，level=exhigh, encodeType=flac），
        // 对 v1 地址也跑同一套探针臂。老接口全 403 时，v1 通就是端点问题，
        // v1 也 403 就不是端点问题。只记码/host/协议/长度/参数名，不记地址。
        try {
            const songId = probeTrack.id.startsWith('netease:')
                ? probeTrack.id.slice('netease:'.length)
                : probeTrack.id;
            const v1 = await eapiRequest('/api/song/enhance/player/url/v1', {
                ids: `[${songId}]`,
                level: 'exhigh',
                encodeType: 'flac'
            });
            let v1Url: string | null = null;
            let v1Code: unknown = null;
            try {
                const parsed = JSON.parse(v1.body) as { code?: unknown; data?: unknown };
                v1Code = parsed.code;
                const first = Array.isArray(parsed.data) ? (parsed.data[0] as { url?: unknown } | undefined) : undefined;
                v1Url = typeof first?.url === 'string' && first.url ? first.url : null;
            } catch {
                console.log(`[Playback] 网易云探针 v1：返回不是 JSON，HTTP=${v1.status}`);
            }
            if (v1Url) {
                const origProtocol = v1Url.startsWith('https:') ? 'https:' : v1Url.startsWith('http:') ? 'http:' : '?';
                const v1Https = v1Url.replace(/^http:/, 'https:');
                try {
                    const parsedUrl = new URL(v1Https);
                    const paramNames = [...new URLSearchParams(parsedUrl.search).keys()].join(',');
                    console.log(
                        `[Playback] 网易云探针 v1：取链码=${v1Code} host=${parsedUrl.hostname} 原协议=${origProtocol} 长度=${v1Https.length} 参数=[${paramNames}]`
                    );
                } catch {
                    console.log(`[Playback] 网易云探针 v1：取链码=${v1Code} 地址解析失败`);
                }
                const v1ProbeUrl = `http://127.0.0.1:${port}/netease-probe?u=${encodeURIComponent(v1Https)}` +
                    `&mintUa=${encodeURIComponent(NETEASE_MINT_UA)}`;
                const v1Res = await fetch(v1ProbeUrl);
                const v1Text = (await v1Res.text()).trim();
                for (const line of v1Text.split('\n')) {
                    if (line) {
                        console.log(`[Playback] 网易云探针 v1：${line}`);
                    }
                }
            } else {
                console.log(`[Playback] 网易云探针 v1：取链码=${v1Code} 无地址，HTTP=${v1.status}`);
            }
        } catch (error) {
            console.log(
                `[Playback] 网易云探针 v1 失败：${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`
            );
        }
    } catch (error) {
        console.log(
            `[Playback] 网易云取流探针失败：${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`
        );
    }
}

export async function next(): Promise<void> {
    if (queue.length === 0 || !currentTrack) {
        return;
    }
    ++playIntent;
    if (queueIndex >= queue.length - 1) {
        // 队尾手动下一首：列表循环回队首，单曲循环重播当前，其它模式不动。
        const mode = getRepeatMode();
        if (mode === 'queue') {
            const result = await tryPlayFrom(0, playing, 1);
            if (result.stale) {
                return;
            }
            if (!result.played) {
                playing = false;
                lastError = skipAllMessage(result.failed);
                emitTrackChange();
            }
            return;
        }
        if (mode === 'one') {
            try {
                const result = await startTrack(currentTrack, playing);
                if (result === 'stale') {
                    return;
                }
            } catch {
                playing = false;
                lastError = '播放失败，请换一首试试';
                emitTrackChange();
            }
            return;
        }
        return;
    }
    const result = await tryPlayFrom(queueIndex + 1, playing, 1);
    if (result.stale) {
        return;
    }
    if (!result.played) {
        // 全部失败：下标不前移（仍可重试），只停播放并提示。
        playing = false;
        lastError = skipAllMessage(result.failed);
        emitTrackChange();
    }
}

export async function previous(): Promise<void> {
    if (!activeSlot || !currentTrack) {
        return;
    }
    if (queueIndex <= 0) {
        // 已是第一首：回到开头重播。
        activeSlot.audio.currentTime = 0;
        if (!playing) {
            await resume();
        }
        return;
    }
    ++playIntent;
    const result = await tryPlayFrom(queueIndex - 1, playing, -1);
    if (result.stale) {
        return;
    }
    if (!result.played) {
        // 全部失败：下标不动（仍可重试），只停播放并提示。
        playing = false;
        lastError = skipAllMessage(result.failed);
        emitTrackChange();
    }
}

export function pause(): void {
    if (!activeSlot || !playing) {
        return;
    }
    // 暂停不断前台服务：恢复时不用重起，后台切回也能继续。
    fadeOutAndPause(activeSlot, FADE_OUT_MS);
    playing = false;
    emitTrackChange();
}

// 跳转（0.1.101 歌单架高潮试听用）：只动当前发声槽的 audio.currentTime，
// 进度状态由已有的 timeupdate 回写，不另维护。无正在播的槽、
// 秒数非法或流不支持跳转时静默（保持原位播，不抛错打断试听）。
export function seekTo(seconds: number): void {
    const audio = activeSlot?.audio;
    if (!audio || !Number.isFinite(seconds) || seconds < 0) {
        return;
    }
    try {
        audio.currentTime = seconds;
    } catch {
        // 流不支持跳转时保持原位。
    }
}

// 队尾续推（0.1.101 私人漫游用）：把一批曲目追加到当前队列尾，
// 不动当前播放位置与当前曲；调用方负责去重。队列为空时不追加。
export function appendToQueue(tracks: Track[]): void {
    if (tracks.length === 0 || queue.length === 0) {
        return;
    }
    queue.push(...tracks);
}

export async function resume(): Promise<void> {
    if (!activeSlot || !currentTrack || playing) {
        return;
    }
    // 先清掉暂停时排队的淡出后 pause，避免恢复后被旧计时器误停。
    clearFadeTimers(activeSlot);
    try {
        await activeSlot.audio.play();
    } catch {
        lastError = '播放失败，请换一首试试';
        emitTrackChange();
        return;
    }
    playing = true;
    lastError = null;
    emitTrackChange();
    try {
        await startPlaybackService(currentTrack.title, currentTrack.artist);
    } catch {
        // 忽略，继续播。
    }
    fadeSlotTo(activeSlot, 1, FADE_RESUME_MS);
}

export async function togglePlay(): Promise<void> {
    if (playing) {
        pause();
        return;
    }
    if (currentTrack) {
        await resume();
        return;
    }
    if (queue.length > 0) {
        const target = queue[queueIndex];
        if (target) {
            ++playIntent;
            try {
                const result = await startTrack(target, false);
                if (result === 'stale') {
                    return;
                }
            } catch (error) {
                lastError = error instanceof Error ? error.message : '播放失败，请换一首试试';
                emitTrackChange();
            }
        }
    }
}

export async function stop(): Promise<void> {
    // 停止也是新意图：在途的起歌与跳歌循环凭它过时退出，不再起新 load。
    ++playIntent;
    if (activeSlot) {
        fadeOutAndPause(activeSlot, FADE_OUT_MS);
    }
    playing = false;
    emitTrackChange();
    try {
        await stopPlaybackService();
    } catch {
        // 忽略。
    }
    try {
        await stopStreamProxy();
    } catch {
        // 忽略。
    }
}

export { getCurrentState };
