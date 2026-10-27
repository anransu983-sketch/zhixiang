package com.suanran.zhixiang;

import android.util.Log;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;

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
            // 默认 retryOnConnectionFailure=true 会在连接层失败时静默重发一次，
            // 表现为一次无故的重复取流；诊断与去重都要求一次请求只发一次。
            .retryOnConnectionFailure(false)
            .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build();

    // 0.1.74 探针专用：不跟跳转（手动记跳数与最终 host），超时收紧，
    // 与 /proxy 的 UPSTREAM 分开，避免探针改动正常取流行为。
    private static final OkHttpClient PROBE_CLIENT = new OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .connectTimeout(10000, TimeUnit.MILLISECONDS)
            .readTimeout(10000, TimeUnit.MILLISECONDS)
            .build();

    // 上游取流诊断记录（/last 用；不含目标地址）。单条 last 会被并发/连续
    // 尝试互相覆盖，改记最近 16 条并按 Web 层给的 lid 分流，竞态才杀得掉。
    private static final int MAX_RECORDS = 16;
    private final Deque<String> lastRecords = new ArrayDeque<>();
    private long recordSeq = 0;

    // 0.1.72 诊断：上游抛异常时原来不记记录，/last 仍是 none，
    // Web 层无法区分“没打到代理”还是“代理取上游抛了”。异常也记一条。
    private synchronized void addErrorRecord(String lid, String error) {
        recordSeq += 1;
        lastRecords.addLast("lid=" + lid + " seq=" + recordSeq + " error=" + error);
        while (lastRecords.size() > MAX_RECORDS) {
            lastRecords.removeFirst();
        }
    }

    private synchronized void addRecord(String lid, int status, String type, long len,
            String range, long written, boolean aborted) {
        recordSeq += 1;
        lastRecords.addLast("lid=" + lid + " seq=" + recordSeq
                + " status=" + status + " type=" + type + " len=" + len
                + " range=" + range + " written=" + written
                + " aborted=" + (aborted ? 1 : 0));
        while (lastRecords.size() > MAX_RECORDS) {
            lastRecords.removeFirst();
        }
    }

    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running;

    public synchronized int start() throws IOException {
        if (running && serverSocket != null && !serverSocket.isClosed()) {
            return serverSocket.getLocalPort();
        }
        stopLocked();
        // 必须字面绑 127.0.0.1：getLoopbackAddress() 在双栈设备上可能落到 ::1，
        // 而 Web 层连的是 127.0.0.1，地址族一错即拒连，fetch 只给 TypeError。
        // Folia 的 LocalAudioServer 同样字面绑 127.0.0.1。
        serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
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
        // 本次取流的诊断字段：finally 里记一条记录，body 没写完即 aborted。
        String fetchLid = "-";
        String fetchError = null;
        int fetchStatus = -1;
        String fetchType = "";
        long fetchLen = -1;
        String fetchRange = "";
        long fetchWritten = 0;
        boolean fetchAborted = false;
        try {
            client.setSoTimeout(READ_TIMEOUT_MS);
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                return;
            }
            String rawPath = parts[1];
            int qmark = rawPath.indexOf('?');
            String pathOnly = qmark < 0 ? rawPath : rawPath.substring(0, qmark);
            // 预检必须自己答：跨源带 Range 的请求在某些 WebView 上会先发
            // OPTIONS，不答即 CORS 失败（Folia 同款 204 答法）。
            if ("OPTIONS".equalsIgnoreCase(parts[0])) {
                writeOptions(client);
                return;
            }
            if (!"GET".equalsIgnoreCase(parts[0])) {
                writeSimple(client, 405, "Method Not Allowed");
                return;
            }
            // 只记路由标签，不记路径与查询串（查询串里有目标地址与 UA）。
            String route = "/ping".equals(pathOnly) ? "ping"
                    : "/last".equals(pathOnly) ? "last"
                    : "/experiment".equals(pathOnly) ? "experiment"
                    : "/netease-probe".equals(pathOnly) ? "netease-probe" : "proxy";
            Log.i(TAG, "hit route=" + route);
            if ("/ping".equals(pathOnly)) {
                writePing(client);
                return;
            }
            if ("/last".equals(pathOnly)) {
                writeLast(client);
                return;
            }
            if ("/experiment".equals(pathOnly)) {
                writeExperiment(client, parts[1]);
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
            String lidEarly = queryParam(parts[1], "lid");
            if ("/netease-probe".equals(pathOnly)) {
                // 探针要元素 UA：JS fetch 发来的 User-Agent 即 WebView UA，
                // 与 audio 元素同源，基线臂用它，不另传参数。
                writeNeteaseProbe(client, parts[1], headers.get("user-agent"));
                return;
            }
            if (lidEarly != null && !lidEarly.isEmpty()) {
                fetchLid = lidEarly;
            }
            String rawTarget = queryParam(parts[1], "u");
            if (rawTarget == null || rawTarget.isEmpty()) {
                fetchError = "400 missing u";
                writeSimple(client, 400, "Bad Request");
                return;
            }
            // 铸链 UA（Web 层从取链处带来）；没有时回落到元素 UA。
            String uaParam = queryParam(parts[1], "ua");
            URL target;
            try {
                target = new URL(rawTarget);
            } catch (Exception e) {
                fetchError = "400 bad url " + e.getClass().getSimpleName();
                writeSimple(client, 400, "Bad Request");
                return;
            }
            String protocol = target.getProtocol();
            if (!"http".equalsIgnoreCase(protocol) && !"https".equalsIgnoreCase(protocol)) {
                fetchError = "400 bad protocol " + protocol;
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
            String lidParam = queryParam(parts[1], "lid");
            if (lidParam != null && !lidParam.isEmpty()) {
                fetchLid = lidParam;
            }
            upstream = UPSTREAM.newCall(request).execute();
            int status = upstream.code();
            String contentType = upstream.header("Content-Type");
            String contentRange = upstream.header("Content-Range");
            ResponseBody responseBody = upstream.body();
            long contentLength = responseBody != null ? responseBody.contentLength() : -1;
            fetchStatus = status;
            fetchType = contentType != null ? contentType : "";
            fetchLen = contentLength;
            fetchRange = sentRange;
            Log.i(TAG, "fetch lid=" + fetchLid + " status=" + status + " type=" + fetchType
                    + " len=" + contentLength + " range=" + sentRange + " uaSrc=" + uaSrc);

            OutputStream out = client.getOutputStream();
            StringBuilder response = new StringBuilder();
            response.append("HTTP/1.1 ").append(status).append(' ')
                    .append(statusText(status)).append("\r\n");
            response.append("Access-Control-Allow-Origin: *\r\n");
            // Folia 同款：媒体管线与 fetch 都要这两行，缺了可能丢 Content-Range。
            response.append("Access-Control-Allow-Headers: range, content-range, content-length\r\n");
            response.append("Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n");
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
            // 实写字节数单独记：日志里的 len 只是上游报的头，写少了
            // （元素中途断开、写失败）才是 demuxer 读错的真凭据。
            InputStream body = responseBody != null ? responseBody.byteStream() : null;
            if (body != null) {
                byte[] buffer = new byte[BUFFER_BYTES];
                int read;
                while ((read = body.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    fetchWritten += read;
                }
                out.flush();
            }
        } catch (Exception e) {
            // 客户端断开、上游超时等：安静关闭连接，不记目标地址。
            // 响应头已发出时不再补写错误头，避免污染已开始的流。
            // 0.1.72：异常名与前 200 字记进 fetchError，finally 里进 /last，
            // 否则 Web 层看到 none 会误判为没打到代理。
            String msg = e.getMessage() != null ? e.getMessage() : "";
            if (msg.length() > 200) {
                msg = msg.substring(0, 200);
            }
            fetchError = e.getClass().getSimpleName() + ": " + msg;
            if (responseStarted) {
                fetchAborted = true;
            } else {
                try {
                    writeSimple(client, 502, "Bad Gateway");
                } catch (Exception ignored) {
                    // 连接已死，无法回写。
                }
            }
        } finally {
            if (fetchStatus >= 0) {
                addRecord(fetchLid, fetchStatus, fetchType, fetchLen,
                        fetchRange, fetchWritten, fetchAborted);
            } else if (fetchError != null) {
                addErrorRecord(fetchLid, fetchError);
            }
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

    // /ping：回环连通探针，Web 层播歌前拉一次，区分“WebView 到不了代理”
    // 与“代理到了但上游拒了”。只回固定 ok，不含任何地址。
    private void writePing(Socket client) throws IOException {
        byte[] body = "ok".getBytes(StandardCharsets.UTF_8);
        String response = "HTTP/1.1 200 OK\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: range, content-range, content-length\r\n"
                + "Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n"
                + "Content-Type: text/plain\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        OutputStream out = client.getOutputStream();
        out.write(response.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    // 预检：Folia 同款 204 答法，放行 Range 等头。
    private void writeOptions(Socket client) throws IOException {
        String response = "HTTP/1.1 204 No Content\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: range, content-range, content-length, content-type\r\n"
                + "Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n"
                + "Content-Length: 0\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        OutputStream out = client.getOutputStream();
        out.write(response.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    // /last：最近 16 条上游取流诊断（不含目标地址），Web 层按 lid 过滤后记日志。
    private void writeLast(Socket client) throws IOException {
        String text;
        synchronized (this) {
            text = lastRecords.isEmpty() ? "none" : String.join("\n", lastRecords);
        }
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String response = "HTTP/1.1 200 OK\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: range, content-range, content-length\r\n"
                + "Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n"
                + "Content-Type: text/plain\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        OutputStream out = client.getOutputStream();
        out.write(response.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    // 0.1.74 网易云取流探针：同一新取链地址，7 臂每臂只变一个量。
    // 基线 = 现在代理真实送的东西（元素 UA、https、bytes=0-1MiB-1、无 Referer）。
    // 1 基线 2 铸链 UA 3 铸链 UA+Referer 4 基线去 Range 5 基线 bytes=0-1
    // 6 raw Socket http 同头（绕过平台明文检查，不改安全配置）
    // 7 复用第 1 臂地址重放（验一次性令牌；若第 1 臂已耗令牌则全臂受影响，
    //   探针入口取的是新链，播放前未被 audio 用过）。
    // 只记状态/类型/头长度/Server/Via/X-Cache/体前 120 字（去地址）/
    // 跳数/最终 host/地址长度，绝不记完整地址与签名。
    private void writeNeteaseProbe(Socket client, String rawPath, String elementUa) throws IOException {
        String httpsUrl = queryParam(rawPath, "u");
        String mintUa = queryParam(rawPath, "mintUa");
        StringBuilder text = new StringBuilder();
        if (httpsUrl == null || httpsUrl.isEmpty() || mintUa == null || mintUa.isEmpty()) {
            writeSimple(client, 400, "Bad Request");
            return;
        }
        String element = (elementUa != null && !elementUa.isEmpty()) ? elementUa : "Mozilla/5.0";
        String host = "";
        try {
            host = new URL(httpsUrl).getHost();
        } catch (Exception ignored) {
        }
        text.append("开始 urlLen=").append(httpsUrl.length())
                .append(" host=").append(host)
                .append(" elementUaLen=").append(element.length())
                .append(" mintUaLen=").append(mintUa.length()).append("\n");
        String range1m = "bytes=0-" + (CHUNK_BYTES - 1);
        String httpUrl = httpsUrl.replaceFirst("^https:", "http:");
        text.append(probeOkHttpArm(1, "基线", httpsUrl, element, null, range1m)).append("\n");
        text.append(probeOkHttpArm(2, "铸链UA", httpsUrl, mintUa, null, range1m)).append("\n");
        text.append(probeOkHttpArm(3, "铸链UA+Referer", httpsUrl, mintUa, "https://music.163.com/", range1m)).append("\n");
        text.append(probeOkHttpArm(4, "基线去Range", httpsUrl, element, null, null)).append("\n");
        text.append(probeOkHttpArm(5, "基线bytes=0-1", httpsUrl, element, null, "bytes=0-1")).append("\n");
        text.append(probeRawSocketArm(6, "rawSocket-http同头", httpUrl, element, range1m)).append("\n");
        text.append(probeOkHttpArm(7, "复用第1臂地址重放", httpsUrl, element, null, range1m)).append("\n");
        text.append("完成\n");
        byte[] body = text.toString().getBytes(StandardCharsets.UTF_8);
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
        Log.i(TAG, "netease-probe done urlLen=" + httpsUrl.length());
    }

    private String probeOkHttpArm(int arm, String label, String url, String ua, String referer, String range) {
        String current = url;
        int hops = 0;
        try {
            for (int hop = 0; hop <= 5; hop++) {
                Request.Builder builder = new Request.Builder()
                        .url(current)
                        .header("User-Agent", ua);
                if (referer != null) {
                    builder.header("Referer", referer);
                }
                if (range != null) {
                    builder.header("Range", range);
                }
                Response resp = PROBE_CLIENT.newCall(builder.build()).execute();
                try {
                    int status = resp.code();
                    String location = resp.header("Location");
                    String finalHost = "";
                    try {
                        finalHost = new URL(current).getHost();
                    } catch (Exception ignored) {
                    }
                    if ((status == 301 || status == 302 || status == 303 || status == 307 || status == 308)
                            && location != null && !location.isEmpty() && hop < 5) {
                        hops++;
                        current = resolveRedirect(current, location);
                        continue;
                    }
                    String snippet = probeBodySnippet(resp.body());
                    String type = resp.header("Content-Type");
                    String len = resp.header("Content-Length");
                    return "arm" + arm + " " + label + " status=" + status
                            + " type=" + (type != null ? type : "")
                            + " len=" + (len != null ? len : "")
                            + " range=" + (range != null ? range : "-")
                            + " hops=" + hops + " finalHost=" + finalHost
                            + " server=" + headerOrEmpty(resp, "Server")
                            + " via=" + headerOrEmpty(resp, "Via")
                            + " xcache=" + headerOrEmpty(resp, "X-Cache")
                            + " body=" + snippet;
                } finally {
                    resp.close();
                }
            }
            return "arm" + arm + " " + label + " error=tooManyRedirects";
        } catch (Exception e) {
            return "arm" + arm + " " + label + " error=" + e.getClass().getSimpleName()
                    + ":" + shortMsg(e.getMessage());
        }
    }

    private String probeRawSocketArm(int arm, String label, String httpUrl, String ua, String range) {
        try {
            URL target = new URL(httpUrl);
            String path = target.getFile();
            if (path == null || path.isEmpty()) {
                path = "/";
            }
            int port = target.getPort() > 0 ? target.getPort() : 80;
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress(target.getHost(), port), 10000);
            socket.setSoTimeout(10000);
            try {
                String req = "GET " + path + " HTTP/1.1\r\n"
                        + "Host: " + target.getHost() + "\r\n"
                        + "User-Agent: " + ua + "\r\n"
                        + "Range: " + range + "\r\n"
                        + "Accept-Encoding: gzip\r\n"
                        + "Connection: close\r\n\r\n";
                socket.getOutputStream().write(req.getBytes(StandardCharsets.UTF_8));
                socket.getOutputStream().flush();
                byte[] raw = readAllLimited(socket.getInputStream(), 65536);
                String headerEnd = "\r\n\r\n";
                int split = indexOfBytes(raw, headerEnd.getBytes(StandardCharsets.UTF_8));
                if (split < 0) {
                    return "arm" + arm + " " + label + " error=noHeaders";
                }
                String headerText = new String(raw, 0, split, StandardCharsets.UTF_8);
                String[] lines = headerText.split("\r\n");
                int status = -1;
                if (lines.length > 0) {
                    String[] statusParts = lines[0].split(" ");
                    if (statusParts.length >= 2) {
                        try {
                            status = Integer.parseInt(statusParts[1]);
                        } catch (NumberFormatException ignored) {
                        }
                    }
                }
                Map<String, String> headers = new HashMap<>();
                for (int i = 1; i < lines.length; i++) {
                    int colon = lines[i].indexOf(':');
                    if (colon > 0) {
                        headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.US),
                                lines[i].substring(colon + 1).trim());
                    }
                }
                byte[] bodyBytes = new byte[0];
                int bodyStart = split + headerEnd.length();
                if (bodyStart < raw.length) {
                    byte[] rest = new byte[raw.length - bodyStart];
                    System.arraycopy(raw, bodyStart, rest, 0, rest.length);
                    if ("chunked".equalsIgnoreCase(headers.get("transfer-encoding"))) {
                        bodyBytes = dechunk(rest);
                    } else {
                        bodyBytes = rest;
                    }
                    if ("gzip".equalsIgnoreCase(headers.get("content-encoding"))) {
                        try {
                            GZIPInputStream gzip = new GZIPInputStream(
                                    new java.io.ByteArrayInputStream(bodyBytes));
                            bodyBytes = readAllLimited(gzip, 4096);
                        } catch (Exception ignored) {
                        }
                    }
                }
                String snippet = stripUrls(new String(bodyBytes, StandardCharsets.UTF_8));
                if (snippet.length() > 120) {
                    snippet = snippet.substring(0, 120);
                }
                return "arm" + arm + " " + label + " status=" + status
                        + " type=" + headers.getOrDefault("content-type", "")
                        + " len=" + headers.getOrDefault("content-length", "")
                        + " range=" + range
                        + " hops=0 finalHost=" + target.getHost()
                        + " server=" + headers.getOrDefault("server", "")
                        + " via=" + headers.getOrDefault("via", "")
                        + " xcache=" + headers.getOrDefault("x-cache", "")
                        + " body=" + snippet;
            } finally {
                try {
                    socket.close();
                } catch (Exception ignored) {
                }
            }
        } catch (Exception e) {
            return "arm" + arm + " " + label + " error=" + e.getClass().getSimpleName()
                    + ":" + shortMsg(e.getMessage());
        }
    }

    private String probeBodySnippet(ResponseBody body) throws IOException {
        if (body == null) {
            return "";
        }
        InputStream in = body.byteStream();
        byte[] buffer = new byte[512];
        int read = in.read(buffer);
        if (read <= 0) {
            return "";
        }
        String text = new String(buffer, 0, read, StandardCharsets.UTF_8);
        text = stripUrls(text);
        return text.length() > 120 ? text.substring(0, 120) : text;
    }

    private String stripUrls(String text) {
        if (text == null) {
            return "";
        }
        return text.replaceAll("https?://\\S+", "[url]").replaceAll("[\\r\\n]+", " ").trim();
    }

    private String headerOrEmpty(Response resp, String name) {
        String value = resp.header(name);
        return value != null ? value : "";
    }

    private String shortMsg(String msg) {
        if (msg == null) {
            return "";
        }
        String clean = msg.replaceAll("https?://\\S+", "[url]");
        return clean.length() > 120 ? clean.substring(0, 120) : clean;
    }

    private String resolveRedirect(String current, String location) {
        if (location.startsWith("http://") || location.startsWith("https://")) {
            return location;
        }
        try {
            URL base = new URL(current);
            if (location.startsWith("/")) {
                return base.getProtocol() + "://" + base.getHost() + location;
            }
            String path = base.getPath();
            int slash = path.lastIndexOf('/');
            String dir = slash >= 0 ? path.substring(0, slash + 1) : "/";
            return base.getProtocol() + "://" + base.getHost() + dir + location;
        } catch (Exception e) {
            return current;
        }
    }

    private byte[] readAllLimited(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int total = 0;
        int read;
        while (total < limit && (read = in.read(buffer, 0, Math.min(buffer.length, limit - total))) != -1) {
            out.write(buffer, 0, read);
            total += read;
        }
        return out.toByteArray();
    }

    private int indexOfBytes(byte[] data, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= data.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (data[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    private byte[] dechunk(byte[] data) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int pos = 0;
        while (pos < data.length) {
            int lineEnd = -1;
            for (int i = pos; i + 1 < data.length; i++) {
                if (data[i] == '\r' && data[i + 1] == '\n') {
                    lineEnd = i;
                    break;
                }
            }
            if (lineEnd < 0) {
                break;
            }
            String sizeText = new String(data, pos, lineEnd - pos, StandardCharsets.UTF_8).trim();
            int size;
            try {
                size = Integer.parseInt(sizeText, 16);
            } catch (NumberFormatException e) {
                break;
            }
            pos = lineEnd + 2;
            if (size == 0) {
                break;
            }
            int take = Math.min(size, data.length - pos);
            out.write(data, pos, take);
            pos += take + 2;
        }
        return out.toByteArray();
    }

    // /experiment：原生三段复现实验（无 WebView、无 audio 元素）。
    // 同一 URL 依次取 0-1MiB、隔约 1 秒再取 0-1MiB、再取 1MiB-2MiB，
    // 逐段记状态/类型/头长度/实读字节。206/206/206=双载伪影，
    // 206/403/x=重放被拒，206/206/403=后续窗口被拒。
    private void writeExperiment(Socket client, String rawPath) throws IOException {
        String target = queryParam(rawPath, "u");
        String uaParam = queryParam(rawPath, "ua");
        if (target == null || target.isEmpty()) {
            writeSimple(client, 400, "Bad Request");
            return;
        }
        String userAgent = (uaParam != null && !uaParam.isEmpty()) ? uaParam : "Mozilla/5.0";
        String[] ranges = {
                "bytes=0-" + (CHUNK_BYTES - 1),
                "bytes=0-" + (CHUNK_BYTES - 1),
                "bytes=" + CHUNK_BYTES + "-" + (2 * CHUNK_BYTES - 1)};
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < ranges.length; i++) {
            if (i > 0) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
            Response upstream = null;
            try {
                Request request = new Request.Builder()
                        .url(target)
                        .header("Range", ranges[i])
                        .header("User-Agent", userAgent)
                        .build();
                upstream = UPSTREAM.newCall(request).execute();
                ResponseBody body = upstream.body();
                long headerLen = body != null ? body.contentLength() : -1;
                long bytes = 0;
                if (body != null) {
                    byte[] buffer = new byte[BUFFER_BYTES];
                    int read;
                    java.io.InputStream in = body.byteStream();
                    while ((read = in.read(buffer)) != -1) {
                        bytes += read;
                    }
                }
                String type = upstream.header("Content-Type");
                String line = "step" + (i + 1) + " status=" + upstream.code()
                        + " type=" + (type != null ? type : "")
                        + " len=" + headerLen + " bytes=" + bytes
                        + " range=" + ranges[i];
                Log.i(TAG, "experiment " + line);
                text.append(line).append("\n");
            } catch (Exception e) {
                String line = "step" + (i + 1) + " error=" + e.getClass().getSimpleName();
                Log.i(TAG, "experiment " + line);
                text.append(line).append("\n");
            } finally {
                if (upstream != null) {
                    upstream.close();
                }
            }
        }
        byte[] body = text.toString().getBytes(StandardCharsets.UTF_8);
        String response = "HTTP/1.1 200 OK\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: range, content-range, content-length\r\n"
                + "Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n"
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
                + "Access-Control-Allow-Headers: range, content-range, content-length\r\n"
                + "Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n"
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
