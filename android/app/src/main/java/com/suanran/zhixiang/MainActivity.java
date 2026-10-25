package com.suanran.zhixiang;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 本地插件在应用源码内，不进 cap sync 的插件清单，
        // 必须在桥接创建前注册，否则 Web 层调不到它。
        registerPlugin(LocalMusicPlugin.class);
        registerPlugin(HttpBridgePlugin.class);
        registerPlugin(ExternalOpenPlugin.class);
        registerPlugin(PlaybackPlugin.class);
        registerPlugin(WallpaperPlugin.class);
        registerPlugin(YtmSignInPlugin.class);
        super.onCreate(savedInstanceState);
        // 页面是 https://localhost，流代理与探针是 http://127.0.0.1：
        // WebView 默认混合内容模式会把这类请求直接拦掉（fetch 只给 TypeError，
        // 音频元素表现为格式不支持）。Folia 同款做法：直接放行混合内容。
        // 0.1.34 的回环明文配置已证实打进包仍不够，说明拦的不是明文那一关。
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
    }
}
