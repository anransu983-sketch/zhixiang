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
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * 通用原生 HTTP 桥：给 Web 层提供一个不受 WebView CORS 限制的请求通道。
 *
 * 本插件不针对任何音源：调用方只传 url / method / headers / body，
 * 插件只负责执行请求并原样回传状态码与响应文本，响应体的解析由调用方做。
 *
 * 约定：
 * - 只要服务器回了 HTTP 响应（包括非 2xx），一律 resolve 成 {status, body}，
 *   由调用方按 status 判断成败；这样调用方能拿到服务端的错误体。
 * - 只有没拿到 HTTP 响应时才 reject，且一定带中文 message 与 code，
 *   不抛裸错：URL_REQUIRED（缺地址）、INVALID_URL（地址非法）、
 *   TIMEOUT（连接或读取超时）、NETWORK_FAILED（断网等 IO 异常）、
 *   RESPONSE_TOO_LARGE（响应体超过上限）。
 *
 * 注册方式：与 LocalMusicPlugin 一致，本插件直接放在应用源码里，
 * 不属于任何 npm 包，cap sync 的插件清单覆盖不到它，
 * 因此由 MainActivity 在桥接创建前显式注册（见 MainActivity）。
 */
@CapacitorPlugin(name = "HttpBridge")
public class HttpBridgePlugin extends Plugin {

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 20000;
    private static final int MAX_BODY_CHARS = 2 * 1024 * 1024;

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

        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlText);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestMethod(method);
            connection.setUseCaches(false);
            if (headers != null) {
                Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    String value = headers.optString(name, null);
                    if (value != null) {
                        connection.setRequestProperty(name, value);
                    }
                }
            }
            if (body != null && !body.isEmpty()
                    && (method.equals("POST") || method.equals("PUT") || method.equals("PATCH"))) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String text = stream == null ? "" : readAll(stream);

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("body", text);
            call.resolve(result);
        } catch (SocketTimeoutException e) {
            call.reject("请求超时，请检查网络后重试", "TIMEOUT", e);
        } catch (ResponseTooLargeException e) {
            call.reject("响应体过大，请求被中断", "RESPONSE_TOO_LARGE", e);
        } catch (IOException e) {
            call.reject("网络请求失败，请检查网络后重试", "NETWORK_FAILED", e);
        } catch (IllegalArgumentException e) {
            call.reject("请求地址不合法", "INVALID_URL", e);
        } catch (Exception e) {
            call.reject("网络请求失败，请检查网络后重试", "NETWORK_FAILED", e);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
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
}
