package com.suanran.zhixiang;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * YTM 登录插件（全新写）：起 YtmSignInActivity，等用户登录完（或取消）后带回
 * Cookie 与那个 WebView 的 UA。取消与无凭证一律 resolve 成 ok:false，不是抛错，
 * 调用方按取消处理，不当成网络失败。
 */
@CapacitorPlugin(name = "YtmSignIn")
public class YtmSignInPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        Intent intent = new Intent(getActivity(), YtmSignInActivity.class);
        startActivityForResult(call, intent, "onSignInResult");
    }

    // 登录门探针（0.1.126，Claude 简报回复的区分实验）：撞 LOGIN_REQUIRED 时，
    // 用 App 自己的 WebView（与登录同一个 Cookie 罐）打开该视频的真实 watch
    // 页，轮询 ytInitialPlayerResponse，把页面侧的 playability、streamingData
    // 有无、音频直链条数与页面自己的 visitorData 带回给 Web 层打日志判定。
    // 只观察、不改播放路径；WebView 挂在屏幕外，查完即销毁。
    private static final String PROBE_JS =
        "(function(){try{" +
        "var r=window.ytInitialPlayerResponse;" +
        "if(!r||!r.playabilityStatus){return JSON.stringify({ok:false,err:'no-player-yet'});}" +
        "var ps=r.playabilityStatus;var sd=r.streamingData;" +
        "var fmts=(sd&&sd.adaptiveFormats)||[];var audio=0,direct=0;" +
        "for(var i=0;i<fmts.length;i++){var m=fmts[i].mimeType||'';" +
        "if(m.indexOf('audio')===0){audio++;if(fmts[i].url){direct++;}}}" +
        "return JSON.stringify({ok:true,status:String(ps.status||'')," +
        "reason:String(ps.reason||''),hasStreaming:!!sd,audioCount:audio," +
        "directCount:direct,visitorData:(r.responseContext&&r.responseContext.visitorData)||''});" +
        "}catch(e){return JSON.stringify({ok:false,err:String(e)});}})()";

    @PluginMethod
    public void probeWatchPage(PluginCall call) {
        String videoId = call.getString("videoId", "");
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId 为空");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("无 Activity");
            return;
        }
        final Handler handler = new Handler(Looper.getMainLooper());
        final AtomicBoolean done = new AtomicBoolean(false);
        activity.runOnUiThread(() -> {
            final WebView web = new WebView(activity);
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            web.setLayoutParams(new FrameLayout.LayoutParams(720, 1280));
            web.setVisibility(View.INVISIBLE);
            web.setTranslationX(-4000);
            final ViewGroup parent = (ViewGroup) activity.findViewById(android.R.id.content);
            parent.addView(web);
            final Runnable[] poll = new Runnable[1];
            final long deadline = System.currentTimeMillis() + 20000;
            final Runnable finish = () -> {
                if (!done.compareAndSet(false, true)) {
                    return;
                }
                handler.removeCallbacks(poll[0]);
                parent.removeView(web);
                web.destroy();
            };
            poll[0] = () -> {
                if (done.get()) {
                    return;
                }
                web.evaluateJavascript(PROBE_JS, value -> {
                    if (done.get()) {
                        return;
                    }
                    boolean ready = value != null && value.contains("\\\"ok\\\":true");
                    if (ready || System.currentTimeMillis() > deadline) {
                        JSObject ret = new JSObject();
                        ret.put("raw", value == null ? "" : value);
                        finish.run();
                        call.resolve(ret);
                        return;
                    }
                    handler.postDelayed(poll[0], 1500);
                });
            };
            web.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    handler.postDelayed(poll[0], 800);
                }
            });
            // 兜底：页面迟迟不 finished 时，到期也收尾（poll 内部按 deadline 结束）。
            handler.postDelayed(poll[0], 6000);
            web.loadUrl("https://www.youtube.com/watch?v=" + videoId);
        });
    }

    // 页面抽取兜底（0.1.127）：0.1.126 探针实证撞门时真实 watch 页
    // playability=OK、streamingData 在，但格式全是 signatureCipher（直链
    // 0 条）、responseContext 无 visitorData。本方法在同一 WebView 会话里
    // 让页面自己的播放器真的起播，拦截它发往 googlevideo 的音频请求——
    // 那条地址是页面播放器自己解签＋去 n 限速后的成品，App 直接拿来播，
    // 不需要自己解签。同时带回 ytcfg 的 VISITOR_DATA 供 B 路重试。
    // 抽到的地址只回 Web 层内存，绝不打日志（地址含出口 IP 与签名）。
    private static final String EXTRACT_JS =
        "(function(){try{" +
        "var r=window.ytInitialPlayerResponse;" +
        "if(!r||!r.playabilityStatus){return JSON.stringify({ok:false,err:'no-player-yet'});}" +
        "var ps=r.playabilityStatus;var sd=r.streamingData;" +
        "var fmts=(sd&&sd.adaptiveFormats)||[];var audio=0,direct=0;" +
        "for(var i=0;i<fmts.length;i++){var m=fmts[i].mimeType||'';" +
        "if(m.indexOf('audio')===0){audio++;if(fmts[i].url){direct++;}}}" +
        "var vd='';try{vd=(window.ytcfg&&ytcfg.data_&&ytcfg.data_.VISITOR_DATA)||'';}catch(e){}" +
        "if(!vd){vd=(r.responseContext&&r.responseContext.visitorData)||'';}" +
        "return JSON.stringify({ok:true,status:String(ps.status||'')," +
        "reason:String(ps.reason||''),hasStreaming:!!sd,audioCount:audio," +
        "directCount:direct,visitorData:vd});" +
        "}catch(e){return JSON.stringify({ok:false,err:String(e)});}})()";

    private static final String NUDGE_JS =
        "(function(){try{" +
        "var mp=document.getElementById('movie_player');" +
        "if(mp&&mp.playVideo){mp.playVideo();}" +
        "var v=document.querySelector('video');" +
        "if(v){v.muted=true;var p=v.play();if(p&&p.catch){p.catch(function(){});}}" +
        "var b=document.querySelector('.ytp-large-play-button,.html5-large-play-button');" +
        "if(b){b.click();}return 'nudged';}catch(e){return 'err';}})()";

    @PluginMethod
    public void extractViaPage(PluginCall call) {
        String videoId = call.getString("videoId", "");
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId 为空");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("无 Activity");
            return;
        }
        final Handler handler = new Handler(Looper.getMainLooper());
        final AtomicBoolean done = new AtomicBoolean(false);
        final AtomicReference<String> audioUrl = new AtomicReference<>("");
        final AtomicReference<String> audioMime = new AtomicReference<>("");
        activity.runOnUiThread(() -> {
            final WebView web = new WebView(activity);
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            web.setLayoutParams(new FrameLayout.LayoutParams(720, 1280));
            // VISIBLE＋透明＋移出屏幕：INVISIBLE 会让页面以为自己被隐藏，
            // 播放器可能不起播；这里要的是它真起播、真发媒体请求。
            web.setVisibility(View.VISIBLE);
            web.setAlpha(0f);
            web.setTranslationX(-4000);
            final ViewGroup parent = (ViewGroup) activity.findViewById(android.R.id.content);
            parent.addView(web);
            final Runnable[] poll = new Runnable[1];
            final long deadline = System.currentTimeMillis() + 35000;
            final String[] lastRaw = {""};
            final int[] gatedPolls = {0};
            final Runnable finish = () -> {
                if (!done.compareAndSet(false, true)) {
                    return;
                }
                handler.removeCallbacks(poll[0]);
                JSObject ret = new JSObject();
                ret.put("raw", lastRaw[0]);
                ret.put("audioUrl", audioUrl.get());
                ret.put("audioMime", audioMime.get());
                parent.removeView(web);
                web.destroy();
                call.resolve(ret);
            };
            poll[0] = () -> {
                if (done.get()) {
                    return;
                }
                if (!audioUrl.get().isEmpty() || System.currentTimeMillis() > deadline) {
                    finish.run();
                    return;
                }
                web.evaluateJavascript(EXTRACT_JS, value -> {
                    if (done.get()) {
                        return;
                    }
                    if (value != null && value.contains("\\\"ok\\\":true")) {
                        lastRaw[0] = value;
                        boolean pageOk = value.contains("\\\"status\\\":\\\"OK\\\"");
                        if (!pageOk) {
                            // 页面也被挡：连数两次就收尾，别空等 35 秒。
                            gatedPolls[0]++;
                            if (gatedPolls[0] >= 2) {
                                finish.run();
                                return;
                            }
                        }
                    }
                    if (!audioUrl.get().isEmpty()) {
                        finish.run();
                        return;
                    }
                    web.evaluateJavascript(NUDGE_JS, null);
                    handler.postDelayed(poll[0], 1200);
                });
            };
            web.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    try {
                        String url = request.getUrl().toString();
                        if (url.contains("googlevideo.com/videoplayback") && audioUrl.get().isEmpty()) {
                            String mime = request.getUrl().getQueryParameter("mime");
                            if (mime != null && mime.startsWith("audio")) {
                                audioMime.set(mime);
                                audioUrl.set(url);
                            }
                        }
                    } catch (Exception ignored) {
                        // 拦截观察只许帮忙、不许把页面请求弄崩。
                    }
                    return null;
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    handler.postDelayed(poll[0], 800);
                }
            });
            handler.postDelayed(poll[0], 6000);
            web.loadUrl("https://www.youtube.com/watch?v=" + videoId);
        });
    }

    @ActivityCallback
    private void onSignInResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            String cookie = result.getData().getStringExtra(YtmSignInActivity.EXTRA_COOKIE);
            String userAgent = result.getData().getStringExtra(YtmSignInActivity.EXTRA_USER_AGENT);
            if (cookie != null && !cookie.isEmpty()) {
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("cookie", cookie);
                ret.put("userAgent", userAgent == null ? "" : userAgent);
                call.resolve(ret);
                return;
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", false);
        call.resolve(ret);
    }
}
