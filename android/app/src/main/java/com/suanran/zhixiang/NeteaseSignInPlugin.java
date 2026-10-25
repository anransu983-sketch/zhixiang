package com.suanran.zhixiang;

import android.app.Activity;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 网易云网页登录插件（全新写，与 YtmSignInPlugin 同款）：起
 * NeteaseSignInActivity，等用户登录完（或取消）后带回 Cookie。
 * 取消与无凭证一律 resolve 成 ok:false，不是抛错，调用方按取消处理。
 */
@CapacitorPlugin(name = "NeteaseSignIn")
public class NeteaseSignInPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        Intent intent = new Intent(getActivity(), NeteaseSignInActivity.class);
        startActivityForResult(call, intent, "onSignInResult");
    }

    @ActivityCallback
    private void onSignInResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            String cookie = result.getData().getStringExtra(NeteaseSignInActivity.EXTRA_COOKIE);
            if (cookie != null && !cookie.isEmpty()) {
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("cookie", cookie);
                call.resolve(ret);
                return;
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", false);
        call.resolve(ret);
    }
}
