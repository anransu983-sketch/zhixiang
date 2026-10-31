package com.suanran.zhixiang;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
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
