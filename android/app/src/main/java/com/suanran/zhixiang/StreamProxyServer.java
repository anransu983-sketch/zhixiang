package com.suanran.zhixiang;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
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

/**
 * 本机小 HTTP 代理：全新写，只用 ServerSocket，不引第三方库。
 *
 * 存在的唯一理由：googlevideo 自 2026-08 起拒绝无界 Range（会 403）。
 * audio 元素播流时常发 Range: bytes=0- 这类无界请求，直连必被拦；
 * 代理把每个上游请求翻成 1MiB 有界窗口，分段回 206，audio 元素按正常
 * Range 流程续播、快进，无需 Web 层自己做分块加载。
 *
 * 约定：
 * - 只监听 127.0.0.1，不对外暴露；只接受 GET /proxy?u=<编码后目标>。
 * - 目标只放行 http / https；其它 scheme 一律 400，不做开放代理。
 * - 上游请求只带翻译后的 Range 与客户端 User-Agent（无则用默认串），
 *   不转发 Cookie / Authorization 等凭证头。
 * - 响应一律带 Access-Control-Allow-Origin: *，且保留上游 Content-Type、
 *   Content-Range、Content-Length、Accept-Ranges，让 Web Audio 图读到
 *   的数据不被跨域污染（AnalyserNode 才能出频谱）。
 * - Range 翻译规则：无 Range → 请求 0..1MiB-1；bytes=N-（无界）→
 *   N..N+1MiB-1；bytes=N-M（已有界）→ 原样；bytes=-S（后缀）→ 原样；
 *   格式非法 → 按无 Range 处理。206 按上游回的 Content-Range 原样转发。
 * - 上游不支持 Range 回 200 时，原样转发整段 200（不改写成 206）。
 * - 上游出错（4xx/5xx）时原样转发状态码与响应体，Web 层按播放失败处理。
 * - 绝不记录目标地址：它可能带时效签名，日志里只留状态与错误种类。
 */
public class StreamProxyServer {

    private static final int CHUNK_BYTES = 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int BUFFER_BYTES = 32 * 1024;
    private static final int MAX_HEADER_LINES = 64;

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
        HttpURLConnection upstream = null;
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
            String rawTarget = parseQueryParam(parts[1]);
            if (rawTarget == null || rawTarget.isEmpty()) {
                writeSimple(client, 400, "Bad Request");
                return;
            }
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
            upstream = (HttpURLConnection) target.openConnection();
            upstream.setConnectTimeout(CONNECT_TIMEOUT_MS);
            upstream.setReadTimeout(READ_TIMEOUT_MS);
            upstream.setInstanceFollowRedirects(true);
            upstream.setUseCaches(false);
            upstream.setRequestProperty("Range", translateRange(headers.get("range")));
            String userAgent = headers.get("user-agent");
            upstream.setRequestProperty(
                    "User-Agent",
                    userAgent == null || userAgent.isEmpty()
                            ? "Mozilla/5.0"
                            : userAgent);

            int status = upstream.getResponseCode();
            String contentType = upstream.getContentType();
            String contentRange = upstream.getHeaderField("Content-Range");
            long contentLength = upstream.getContentLengthLong();

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

            InputStream body = status >= 200 && status < 300
                    ? upstream.getInputStream()
                    : upstream.getErrorStream();
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
                upstream.disconnect();
            }
            try {
                client.close();
            } catch (IOException ignored) {
                // 关闭失败可忽略。
            }
        }
    }

    private String parseQueryParam(String rawPath) {
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
            if (!"u".equals(pair.substring(0, equals))) {
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
