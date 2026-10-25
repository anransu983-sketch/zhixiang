package com.suanran.zhixiang;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 网易云网页登录页（全新写，结构与 YtmSignInActivity 同款）：单独一座 Activity
 * 装 WebView，让用户在网易云官网真的登录一次，然后把 Cookie 交回给主界面。
 * 背景：网易云二维码登录路（unikey type=1）已被服务端拒绝，轮询回 8821
 * “请切换其他登录方式或升级新版本再试”，故改走网页登录；登录判定只认 MUSIC_U。
 *
 * 交接条件（自动）：当前页在 music.163.com 域名下，且 Cookie 里已有 MUSIC_U；
 * 整页加载事件与 2 秒轮询双触发，轮询要求连续两次命中才交接。
 * 手动：顶栏「完成」只在已有 MUSIC_U 时交接，否则只提示、不结束；「取消」与
 * 返回键直接取消。结果只交一次。
 */
public class NeteaseSignInActivity extends Activity {

    public static final String EXTRA_COOKIE = "cookie";

    // 桌面版站：移动登录页只有手机号登录，没有扫码入口；桌面首页右上角
    // “登录”弹窗里有扫码登录，用网易云 App 扫官方二维码即可登录（官网自己的
    // 扫码流，不走被 8821 拒绝的那条 API 扫码路）。故用桌面 UA 开桌面首页，
    // 用户点登录 → 切到扫码登录 → 扫码确认，MUSIC_U 一到即自动交接。
    private static final String START_URL = "https://music.163.com/";
    private static final String DESKTOP_USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    private static final String[] COOKIE_URLS = {
            "https://music.163.com/",
            "https://y.music.163.com/"
    };
    private static final String SIGNED_IN_MARKER = "MUSIC_U";
    private static final long POLL_INTERVAL_MS = 2000;
    private static final int POLL_HITS_TO_HAND_OVER = 2;

    private WebView webView;
    private Handler handler;
    private Runnable pollTask;
    private int consecutiveHits;
    private boolean finished;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        Button cancelButton = new Button(this);
        cancelButton.setText("取消");
        cancelButton.setOnClickListener(view -> cancel());
        bar.addView(cancelButton);

        LinearLayout spacer = new LinearLayout(this);
        bar.addView(spacer, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button doneButton = new Button(this);
        doneButton.setText("完成");
        doneButton.setOnClickListener(view -> {
            if (hasSignedInCookie()) {
                finishWithCookies();
            } else {
                Toast.makeText(this, "还没检测到登录，登录完成后再点", Toast.LENGTH_SHORT).show();
            }
        });
        bar.addView(doneButton);

        root.addView(bar);

        webView = new WebView(this);
        webView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0, 1f));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setUserAgentString(DESKTOP_USER_AGENT);
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (autoReady()) {
                    finishWithCookies();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return upgradeCleartext(view, url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                return upgradeCleartext(view, request.getUrl().toString());
            }
        });
        root.addView(webView);

        setContentView(root);

        handler = new Handler(Looper.getMainLooper());
        pollTask = new Runnable() {
            @Override
            public void run() {
                if (finished) {
                    return;
                }
                if (autoReady()) {
                    consecutiveHits++;
                    if (consecutiveHits >= POLL_HITS_TO_HAND_OVER) {
                        finishWithCookies();
                        return;
                    }
                } else {
                    consecutiveHits = 0;
                }
                handler.postDelayed(this, POLL_INTERVAL_MS);
            }
        };
        handler.postDelayed(pollTask, POLL_INTERVAL_MS);

        webView.loadUrl(START_URL);
    }

    @Override
    public void onBackPressed() {
        // 网页内能后退就先退（登录流程里常有跳转页、验证码页），退无可退才取消。
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        cancel();
    }

    // 站内 http 链接（如“下载APP”跳到的 download-new 页）会被系统明文策略拦
    // 掉（ERR_CLEARTEXT_NOT_PERMITTED）：网易云站内一律升 https 再加载，
    // 不改应用的全局明文策略，登录凭证也只走 https。
    private boolean upgradeCleartext(WebView view, String url) {
        if (url == null) {
            return false;
        }
        Uri uri = Uri.parse(url);
        if (!"http".equals(uri.getScheme())) {
            return false;
        }
        String host = uri.getHost();
        if (host == null || !(host.equals("163.com") || host.endsWith(".163.com"))) {
            return false;
        }
        view.loadUrl("https://" + url.substring("http://".length()));
        return true;
    }

    @Override
    protected void onDestroy() {
        stopPoll();
        super.onDestroy();
    }

    private void stopPoll() {
        if (handler != null && pollTask != null) {
            handler.removeCallbacks(pollTask);
        }
    }

    private void cancel() {
        if (finished) {
            return;
        }
        finished = true;
        stopPoll();
        setResult(RESULT_CANCELED);
        finish();
    }

    private boolean autoReady() {
        if (webView == null || webView.getUrl() == null) {
            return false;
        }
        String host = Uri.parse(webView.getUrl()).getHost();
        if (host == null || !(host.equals("music.163.com") || host.endsWith(".music.163.com"))) {
            return false;
        }
        return hasSignedInCookie();
    }

    private boolean hasSignedInCookie() {
        return collectCookies().contains(SIGNED_IN_MARKER + "=");
    }

    private String collectCookies() {
        CookieManager manager = CookieManager.getInstance();
        Map<String, String> merged = new LinkedHashMap<>();
        for (String url : COOKIE_URLS) {
            String raw = manager.getCookie(url);
            if (raw == null) {
                continue;
            }
            for (String part : raw.split(";")) {
                String pair = part.trim();
                if (pair.isEmpty()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                if (eq <= 0) {
                    continue;
                }
                merged.put(pair.substring(0, eq).trim(), pair);
            }
        }
        return TextUtils.join("; ", merged.values());
    }

    private void finishWithCookies() {
        if (finished) {
            return;
        }
        finished = true;
        stopPoll();
        CookieManager.getInstance().flush();
        Intent data = new Intent();
        data.putExtra(EXTRA_COOKIE, collectCookies());
        setResult(RESULT_OK, data);
        finish();
    }
}
