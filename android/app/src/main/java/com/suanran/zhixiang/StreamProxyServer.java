package com.suanran.zhixiang;

import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 本机小 HTTP 代理：ServerSocket 接元素请求，上游走 OkHttp（与桥同栈）。
 *
 * 存在的唯一理由：googlevideo 自 2026-08 起拒绝无界 Range（会 403）。
 * audio 元素播流时常发 Range: bytes=0- 这类无界请求，直连必被拦；
 * 代理把每个上游请求翻成 1MiB 有界窗口，分段回 206，audio 元素按正常
 * Range 流程续播、快进，无需 Web 层自己做分块加载。
 *
 * 约定：
 * - 只监听 127.0.0.1，不对外暴露；只接受 GET /proxy?u=<编码后目标>。
 * - 目标只放行 http / https；其它 scheme 一律 400，不做开放代理。
 * - 上游请求只带翻译后的 Range 与一个 User-Agent，不转发 Cookie /
 *   Authorization 等凭证头。UA 优先级：?ua= 参数（铸链时实际发出的 UA，
 *   Web 层从取链处带来）> 元素发来的 UA > 默认串。googlevideo 按铸链时
 *   的请求形态认人，UA 不对只回空包、元素 instant Format error
 *   （Folia 0.7.22.8 同款教训），所以铸链 UA 必须复用，不能只转元素 UA。
 * - 响应一律带 Access-Control-Allow-Origin: *，且保留上游 Content-Type、
 *   Content-Range、Content-Length、Accept-Ranges，让 Web Audio 图读到
 *   的数据不被跨域污染（AnalyserNode 才能出频谱）。
 * - Range 翻译规则：无 Range → 请求 0..1MiB-1；bytes=N-（无界）→
 *   N..N+1MiB-1；bytes=N-M（已有界）→ 原样；bytes=-S（后缀）→ 原样；
 *   格式非法 → 按无 Range 处理。206 按上游回的 Content-Range 原样转发。
 * - 上游不支持 Range 回 200 时，原样转发整段 200（不改写成 206）。
 * - 上游出错（4xx/5xx）时原样转发状态码与响应体，Web 层按播放失败处理。
 * - GET /last 返回最近一次上游取流的诊断（状态/类型/长度/Range/UA 来源），
 *   供 Web 层失败时拉取记日志；绝不记录目标地址：它可能带时效签名，
 *   日志里只留状态与错误种类。
 */
public class StreamProxyServer {

    private static final int CHUNK_BYTES = 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int BUFFER_BYTES = 32 * 1024;
    private static final int MAX_HEADER_LINES = 64;

    private static final String TAG = "ZxProxy";

    // 上游与桥同栈：不设代理、跟设备网络栈走；跳转（含跨协议）全跟，
    // 取链与取流同出口，链绑定的 IP 才不会在取流时变掉。
    private static final OkHttpClient UPSTREAM = new OkHttpClient.Builder()
            .followRedirects(true)
            .followSslRedirects(true)
            .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build();

    // 最近一次上游取流的诊断（/last 用；不含目标地址）。
    private volatile int lastStatus = -1;
    private volatile String lastType = "";
    private volatile long lastLength = -1;
    private volatile String lastRange = "";
    private volatile String lastUaSrc = "";

    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running;

    public synchronized int start() throws IOException {
        if (running && serverSocket != null && !serverSocket.isClosed()) {
            return serverSocket.getLocalPort();
        }
        stopLocked();
        serverSocket = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        running = true;
        final ServerSocket socket = serverSocket;
        acceptThread = new Thread(() -> acceptLoop(socket), "zhixiang-proxy");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return serverSocket.getLocalPort();
    }

    public synchronized void stop() {
        stopLocked();
    }

    public synchronized boolean isRunning() {
        return running && serverSocket != null && !serverSocket.isClosed();
    }

    private void stopLocked() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException e) {
                // 关闭时异常可忽略。
            }
            serverSocket = null;
        }
        acceptThread = null;
    }

    private void acceptLoop(ServerSocket socket) {
        while (running) {
            try {
                Socket client = socket.accept();
                Thread worker = new Thread(() -> handle(client), "zhixiang-proxy-conn");
                worker.setDaemon(true);
                worker.start();
            } catch (SocketException e) {
                // 服务停止时 accept 被打断，属正常退出。
                break;
            } catch (IOException e) {
                if (!running) {
                    break;
                }
            }
        }
    }

    private void handle(Socket client) {
        Response upstream = null;
        boolean responseStarted = false;
        try {
            client.setSoTimeout(READ_TIMEOUT_MS);
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2 || !"GET".equalsIgnoreCase(parts[0])) {
                writeSimple(client, 405, "Method Not Allowed");
                return;
            }
            String rawPath = parts[1];
            int qmark = rawPath.indexOf('?');
            String pathOnly = qmark < 0 ? rawPath : rawPath.substring(0, qmark);
            if ("/last".equals(pathOnly)) {
                writeLast(client);
                return;
            }
            Map<String, String> headers = new HashMap<>();
            for (int i = 0; i < MAX_HEADER_LINES; i++) {
                String line = reader.readLine();
                if (line == null || line.isEmpty()) {
                    break;
                }
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(
                            line.substring(0, colon).trim().toLowerCase(Locale.US),
                            line.substring(colon + 1).trim());
                }
            }
            String rawTarget = queryParam(parts[1], "u");
            if (rawTarget == null || rawTarget.isEmpty()) {
                writeSimple(client, 400, "Bad Request");
                return;
            }
            // 铸链 UA（Web 层从取链处带来）；没有时回落到元素 UA。
            String uaParam = queryParam(parts[1], "ua");
            URL target;
            try {
                target = new URL(rawTarget);
            } catch (Exception e) {
                writeSimple(client, 400, "Bad Request");
                return;
            }
            String protocol = target.getProtocol();
            if (!"http".equalsIgnoreCase(protocol) && !"https".equalsIgnoreCase(protocol)) {
                writeSimple(client, 400, "Bad Request");
                return;
            }
            String sentRange = translateRange(headers.get("range"));
            String elementUa = headers.get("user-agent");
            String userAgent;
            String uaSrc;
            if (uaParam != null && !uaParam.isEmpty()) {
                userAgent = uaParam;
                uaSrc = "param";
            } else if (elementUa != null && !elementUa.isEmpty()) {
                userAgent = elementUa;
                uaSrc = "element";
            } else {
                userAgent = "Mozilla/5.0";
                uaSrc = "default";
            }
            Request request = new Request.Builder()
                    .url(rawTarget)
                    .header("Range", sentRange)
                    .header("User-Agent", userAgent)
                    .build();
            upstream = UPSTREAM.newCall(request).execute();
            int status = upstream.code();
            String contentType = upstream.header("Content-Type");
            String contentRange = upstream.header("Content-Range");
            ResponseBody responseBody = upstream.body();
            long contentLength = responseBody != null ? responseBody.contentLength() : -1;
            lastStatus = status;
            lastType = contentType != null ? contentType : "";
            lastLength = contentLength;
            lastRange = sentRange;
            lastUaSrc = uaSrc;
            Log.i(TAG, "fetch status=" + status + " type=" + lastType
                    + " len=" + contentLength + " range=" + sentRange + " uaSrc=" + uaSrc);

            OutputStream out = client.getOutputStream();
            StringBuilder response = new StringBuilder();
            response.append("HTTP/1.1 ").append(status).append(' ')
                    .append(statusText(status)).append("\r\n");
            response.append("Access-Control-Allow-Origin: *\r\n");
            response.append("Accept-Ranges: bytes\r\n");
            if (contentType != null && !contentType.isEmpty()) {
                response.append("Content-Type: ").append(contentType).append("\r\n");
            }
            if (status == 206 && contentRange != null && !contentRange.isEmpty()) {
                response.append("Content-Range: ").append(contentRange).append("\r\n");
            }
            if (contentLength >= 0) {
                response.append("Content-Length: ").append(contentLength).append("\r\n");
            }
            response.append("Connection: close\r\n");
            response.append("\r\n");
            responseStarted = true;
            out.write(response.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();

            // OkHttp 不分输入/错误流：错误体也在 body 里，原样透传。
            InputStream body = responseBody != null ? responseBody.byteStream() : null;
            if (body != null) {
                byte[] buffer = new byte[BUFFER_BYTES];
                int read;
                while ((read = body.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                out.flush();
            }
        } catch (Exception e) {
            // 客户端断开、上游超时等：安静关闭连接，不记目标地址。
            // 响应头已发出时不再补写错误头，避免污染已开始的流。
            if (!responseStarted) {
                try {
                    writeSimple(client, 502, "Bad Gateway");
                } catch (Exception ignored) {
                    // 连接已死，无法回写。
                }
            }
        } finally {
            if (upstream != null) {
                upstream.close();
            }
            try {
                client.close();
            } catch (IOException ignored) {
                // 关闭失败可忽略。
            }
        }
    }

    private String queryParam(String rawPath, String name) {
        int question = rawPath.indexOf('?');
        if (question < 0) {
            return null;
        }
        String query = rawPath.substring(question + 1);
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            if (equals <= 0) {
                continue;
            }
            if (!name.equals(pair.substring(0, equals))) {
                continue;
            }
            try {
                return URLDecoder.decode(pair.substring(equals + 1), StandardCharsets.UTF_8.name());
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    // /last：最近一次上游取流的诊断，不含目标地址；Web 层失败时拉取记日志。
    private void writeLast(Socket client) throws IOException {
        String text;
        if (lastStatus < 0) {
            text = "none";
        } else {
            text = "status=" + lastStatus + " type=" + lastType + " len=" + lastLength
                    + " range=" + lastRange + " uaSrc=" + lastUaSrc;
        }
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String response = "HTTP/1.1 200 OK\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Content-Type: text/plain\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        OutputStream out = client.getOutputStream();
        out.write(response.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private String translateRange(String clientRange) {
        if (clientRange == null || clientRange.isEmpty()) {
            return "bytes=0-" + (CHUNK_BYTES - 1);
        }
        String range = clientRange.trim();
        if (!range.toLowerCase(Locale.US).startsWith("bytes=")) {
            return "bytes=0-" + (CHUNK_BYTES - 1);
        }
        String spec = range.substring("bytes=".length()).trim();
        if (spec.startsWith("-")) {
            // 后缀请求本身已有界，原样转发。
            return range;
        }
        int dash = spec.indexOf('-');
        if (dash < 0) {
            return "bytes=0-" + (CHUNK_BYTES - 1);
        }
        String startText = spec.substring(0, dash).trim();
        String endText = spec.substring(dash + 1).trim();
        if (!endText.isEmpty()) {
            // 已有界，原样转发。
            return range;
        }
        long start;
        try {
            start = Long.parseLong(startText);
        } catch (NumberFormatException e) {
            return "bytes=0-" + (CHUNK_BYTES - 1);
        }
        if (start < 0) {
            return "bytes=0-" + (CHUNK_BYTES - 1);
        }
        return "bytes=" + start + "-" + (start + CHUNK_BYTES - 1);
    }

    private String statusText(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 206:
                return "Partial Content";
            case 400:
                return "Bad Request";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 416:
                return "Range Not Satisfiable";
            default:
                return "Status";
        }
    }

    private void writeSimple(Socket client, int status, String text) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String response = "HTTP/1.1 " + status + " " + statusText(status) + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Content-Type: text/plain\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        OutputStream out = client.getOutputStream();
        out.write(response.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }
}
