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
 * YTM 登录页（全新写）：单独一座 Activity 装 WebView，让用户真的登录一次 YouTube，
 * 然后把 Cookie 交回给主界面。YouTube 不给 YTM 的 OAuth，凭据只能是 cookie；
 * 而 cookie 只能从用户真的登录过的那个 WebView 里读 —— 主界面 WebView 不能直接
 * 导航到 accounts.google.com（会把应用页面换掉），Chrome Custom Tab 的 cookie 又
 * 落进 Chrome 自己的罐里，所以单独开一座 Activity。
 *
 * 交接条件（自动）：当前页在 youtube 域名下（accounts.google.com 上即使已有
 * SAPISID 也不算，流程可能还没走完），且 Cookie 里已有 SAPISID；整页加载事件与
 * 2 秒轮询双触发，轮询要求连续两次命中才交接，防 SAPISID 刚落下、页面还没稳住。
 * 手动：顶栏「完成」只在已有 SAPISID 时交接，否则只提示、不结束；「取消」与返回键
 * 直接取消。结果只交一次。
 */
public class YtmSignInActivity extends Activity {

    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_USER_AGENT = "userAgent";

    private static final String START_URL = "https://music.youtube.com/";
    private static final String[] COOKIE_URLS = {
            "https://www.youtube.com/",
            "https://music.youtube.com/"
    };
    private static final String SIGNED_IN_MARKER = "SAPISID";
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
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // 整页加载这条快路先行：条件一到立刻交接，不等轮询。
                if (autoReady()) {
                    finishWithCookies();
                }
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
        // 首轮同样延后一个间隔，让整页加载的快路先行，轮询只做兜底。
        handler.postDelayed(pollTask, POLL_INTERVAL_MS);

        webView.loadUrl(START_URL);
    }

    @Override
    public void onBackPressed() {
        cancel();
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

    // 自动交接的完整条件：人在 YouTube 自己的页面上，且 Cookie 里已有登录标记。
    // 只看 Cookie 不够：登录走完前也可能在 accounts.google.com 上先种下 SAPISID，
    // 那时流程还没走完，不能算登完。
    private boolean autoReady() {
        if (webView == null || webView.getUrl() == null) {
            return false;
        }
        String host = Uri.parse(webView.getUrl()).getHost();
        if (host == null || !(host.equals("youtube.com") || host.endsWith(".youtube.com"))) {
            return false;
        }
        return hasSignedInCookie();
    }

    private boolean hasSignedInCookie() {
        return collectCookies().contains(SIGNED_IN_MARKER + "=");
    }

    // 两域的 Cookie 拼成一条 Cookie 头，同名只留一个。
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
        String userAgent = webView.getSettings().getUserAgentString();
        Intent data = new Intent();
        data.putExtra(EXTRA_COOKIE, collectCookies());
        data.putExtra(EXTRA_USER_AGENT, userAgent == null ? "" : userAgent);
        setResult(RESULT_OK, data);
        finish();
    }
}
