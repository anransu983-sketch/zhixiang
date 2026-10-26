package com.suanran.zhixiang;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.CookieHandler;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Handshake;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 通用原生 HTTP 桥：给 Web 层提供一个不受 WebView CORS 限制的请求通道。
 *
 * 本插件不针对任何音源：调用方只传 url / method / headers / body，
 * 插件只负责执行请求并原样回传状态码与响应文本，响应体的解析由调用方做。
 *
 * 约定（与旧版 HttpURLConnection 实现一致，JS 侧无需任何改动）：
 * - 只要服务器回了 HTTP 响应（包括非 2xx），一律 resolve 成 {status, body, setCookies}，
 *   由调用方按 status 判断成败；这样调用方能拿到服务端的错误体。
 * - 只有没拿到 HTTP 响应时才 reject，且一定带中文 message 与 code，
 *   不抛裸错：URL_REQUIRED（缺地址）、INVALID_URL（地址非法）、
 *   TIMEOUT（连接或读取超时）、NETWORK_FAILED（断网等 IO 异常）、
 *   RESPONSE_TOO_LARGE（响应体超过上限）。
 *
 * 传输层说明（2026-10-25 定案）：
 * - 旧版用 HttpURLConnection：同机同出口（圣何塞 38.59.249.99）下，
 *   App 的扫码 key 约 20 秒过期，而同机 Termux Node（全新设备、同款 eapi
 *   请求）跑满 240 秒仍未过期；Folia（OkHttp）同机也能扫。请求内容逐字节
 *   对过全一样，差的只剩发送层，故本桥改用 OkHttp（与 Folia 同栈）。
 * - 本桥不配 CookieJar、不读 WebView cookie：OkHttp 默认无 jar，
 *   调用方显式传的 Cookie 头就是唯一出网的 Cookie，与旧版行为一致。
 * - 请求不在桥线程上同步等：用 enqueue + setKeepAlive，回调里再 resolve /
 *   reject，避免长请求占住桥线程拖垮其它插件调用（Folia 同款教训）。
 *
 * 注册方式：与 LocalMusicPlugin 一致，本插件直接放在应用源码里，
 * 不属于任何 npm 包，cap sync 的插件清单覆盖不到它，
 * 因此由 MainActivity 在桥接创建前显式注册（见 MainActivity）。
 */
@CapacitorPlugin(name = "HttpBridge")
public class HttpBridgePlugin extends Plugin {

    @Override
    public void load() {
        super.load();
        // 防御性清理：OkHttp 根本不走 java.net CookieHandler（且本桥不配 jar），
        // 这行对本桥是空操作；留着只是防止其它仍走 HttpURLConnection 的组件
        // 被某个全局 handler 干扰。即使当前根本没有默认 handler，也是无害的。
        CookieHandler.setDefault(null);
    }

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 20000;
    // YTM 榜单响应实测约 6.3MB 字符，旧 2MB 上限会把榜单主动中断；
    // 提到 10MB 后榜单能完整回来，单次响应占内存约 20MB 尚可接受。
    private static final int MAX_BODY_CHARS = 10 * 1024 * 1024;

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .readTimeout(READ_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build();

    private static final char[] HEADER_HEX = "0123456789ABCDEF".toCharArray();

    @PluginMethod
    public void request(PluginCall call) {
        String urlText = call.getString("url");
        if (urlText == null || urlText.isEmpty()) {
            call.reject("缺少请求地址", "URL_REQUIRED");
            return;
        }
        String method = call.getString("method");
        if (method == null || method.isEmpty()) {
            method = "GET";
        }
        method = method.toUpperCase();
        String body = call.getString("body");
        JSObject headers = call.getObject("headers");

        // 纵深防御：load() 里清过一次，但若有别的组件在其后又装了默认
        // handler，每次请求前再清一次（对 OkHttp 本身是空操作）。
        CookieHandler.setDefault(null);

        try {
            Request.Builder builder = new Request.Builder().url(urlText);
            String contentType = null;
            if (headers != null) {
                // 发头顺序与 Folia 桥一致：头顺序是 YouTube 可见的指纹之一，
                // 之前桥按 JSObject 键序发，与 Folia（UA、Name、Version、Content-Type）
                // 不一致；这里按固定顺序先发已知头，其余按原键序补发。
                String[] orderedNames = {
                    "User-Agent", "X-YouTube-Client-Name", "X-YouTube-Client-Version",
                    "Content-Type", "Cookie", "Authorization", "X-Goog-AuthUser"
                };
                java.util.Set<String> emitted = new java.util.HashSet<>();
                for (String ordered : orderedNames) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String name = keys.next();
                        if (!name.equalsIgnoreCase(ordered) || emitted.contains(name)) {
                            continue;
                        }
                        String value = headers.optString(name, null);
                        if (value != null) {
                            builder.header(name, sanitizeHeaderValue(value));
                            if (name.equalsIgnoreCase("Content-Type")) {
                                contentType = value;
                            }
                            emitted.add(name);
                        }
                        break;
                    }
                }
                Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    if (emitted.contains(name)) {
                        continue;
                    }
                    String value = headers.optString(name, null);
                    if (value != null) {
                        builder.header(name, sanitizeHeaderValue(value));
                        if (name.equalsIgnoreCase("Content-Type")) {
                            contentType = value;
                        }
                    }
                }
            }

            RequestBody requestBody = null;
            if (method.equals("POST") || method.equals("PUT") || method.equals("PATCH")) {
                // OkHttp 不给 POST/PUT/PATCH 发空 body（会直接抛），
                // 调用方没给 body 时补一个长度为 0 的 body，与旧版行为一致。
                byte[] bytes = (body == null || body.isEmpty())
                        ? new byte[0]
                        : body.getBytes(StandardCharsets.UTF_8);
                MediaType mediaType = null;
                if (contentType != null && !contentType.isEmpty()) {
                    mediaType = MediaType.parse(contentType);
                }
                requestBody = RequestBody.create(mediaType, bytes);
            }
            builder.method(method, requestBody);

            call.setKeepAlive(true);
            CLIENT.newCall(builder.build()).enqueue(new Callback() {
                @Override
                public void onFailure(Call httpCall, IOException error) {
                    if (error instanceof SocketTimeoutException) {
                        call.reject("请求超时，请检查网络后重试", "TIMEOUT", error);
                    } else {
                        call.reject("网络请求失败，请检查网络后重试", "NETWORK_FAILED", error);
                    }
                }

                @Override
                public void onResponse(Call httpCall, Response response) {
                    try (Response res = response) {
                        int status = res.code();
                        ResponseBody responseBody = res.body();
                        InputStream stream = responseBody == null ? null : responseBody.byteStream();
                        String text = stream == null ? "" : readAll(stream);

                        // 登录流程需要响应里的 Set-Cookie（扫码成功时 body 里也可能带凭证，
                        // 这里只是兜底一并回传；不做任何 Cookie 存取，调用方自己决定用哪份）。
                        // OkHttp 的 headers() 按名查找忽略大小写，重复的 Set-Cookie 全量回传。
                        List<String> setCookies = new ArrayList<>(res.headers().values("Set-Cookie"));

                        JSObject result = new JSObject();
                        result.put("status", status);
                        result.put("body", text);
                        result.put("setCookies", setCookies);
                        // 网络实情（只记协议/TLS/头名，不记任何头值与正文）：
                        // 源码对不上的差只能在线上看，下一版照着实情改。
                        result.put("networkProtocol", res.protocol().toString());
                        Handshake handshake = res.handshake();
                        if (handshake != null) {
                            result.put("tlsVersion", handshake.tlsVersion().toString());
                            result.put("tlsCipher", handshake.cipherSuite().toString());
                        }
                        result.put("requestHeaderNames", new ArrayList<>(res.request().headers().names()));
                        result.put("responseHeaderNames", new ArrayList<>(res.headers().names()));
                        call.resolve(result);
                    } catch (ResponseTooLargeException e) {
                        call.reject("响应体过大，请求被中断", "RESPONSE_TOO_LARGE", e);
                    } catch (IOException e) {
                        call.reject("网络请求失败，请检查网络后重试", "NETWORK_FAILED", e);
                    } catch (Exception e) {
                        call.reject("网络请求失败，请检查网络后重试", "NETWORK_FAILED", e);
                    }
                }
            });
        } catch (IllegalArgumentException e) {
            call.reject("请求地址不合法", "INVALID_URL", e);
        } catch (Exception e) {
            call.reject("网络请求失败，请检查网络后重试", "NETWORK_FAILED", e);
        }
    }

    private String readAll(InputStream stream) throws IOException {
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[8192];
            int read;
            while ((read = reader.read(buffer)) != -1) {
                builder.append(buffer, 0, read);
                if (builder.length() > MAX_BODY_CHARS) {
                    throw new IOException("response too large");
                }
            }
        } catch (IOException e) {
            if ("response too large".equals(e.getMessage())) {
                throw new ResponseTooLargeException();
            }
            throw e;
        }
        return builder.toString();
    }

    private static class ResponseTooLargeException extends IOException {
        ResponseTooLargeException() {
            super("response too large");
        }
    }

    /**
     * 头的值必须是可见 ASCII，否则 OkHttp 当场抛。非可见字符（含 emoji 等
     * 代理对）按 UTF-8 字节逐字节百分号编码，与 Folia 的 sanitize 行为一致。
     * 本桥现有的头（Content-Type、UA、URL 编码后的 Cookie）本就是 ASCII，
     * 这里只是纵深防御，正常情况下是原样返回。
     */
    private static String sanitizeHeaderValue(String value) {
        if (value == null || value.isEmpty()) return value;
        StringBuilder out = null;
        int i = 0;
        while (i < value.length()) {
            int codePoint = value.codePointAt(i);
            int width = Character.charCount(codePoint);
            if (codePoint >= 0x20 && codePoint <= 0x7E) {
                if (out != null) out.append((char) codePoint);
            } else {
                if (out == null) {
                    out = new StringBuilder(value.length() + 16);
                    out.append(value, 0, i);
                }
                // 代理对（emoji 之类）要整块编码，拆成两个 char 各编一半是错的。
                byte[] bytes = new String(Character.toChars(codePoint)).getBytes(StandardCharsets.UTF_8);
                for (byte raw : bytes) {
                    out.append('%')
                            .append(HEADER_HEX[(raw >> 4) & 0xF])
                            .append(HEADER_HEX[raw & 0xF]);
                }
            }
            i += width;
        }
        return out == null ? value : out.toString();
    }
}
