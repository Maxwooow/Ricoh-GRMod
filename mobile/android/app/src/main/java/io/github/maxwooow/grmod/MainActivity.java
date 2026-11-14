package io.github.maxwooow.grmod;

import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.WebViewListener;

import io.github.maxwooow.grmod.push.GrCameraPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GrCameraPlugin.class);
        super.onCreate(savedInstanceState);

        // Back goes to the page (it closes what is open, then returns to the first tab, then leaves the app as
        // Home does). The WebView never goes back in its own history.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                PluginHandle h = getBridge() == null ? null : getBridge().getPlugin("GrCamera");
                if (h != null && h.getInstance() instanceof GrCameraPlugin && ((GrCameraPlugin) h.getInstance()).back()) return;
                moveTaskToBack(true);
            }
        });

        // If the page's process dies (out of memory in the background, a crash), start the page again instead of
        // leaving an empty window.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                Log.w("GRMod", "WebView render process gone, crashed=" + detail.didCrash());
                runOnUiThread(MainActivity.this::recreate);
                return true;
            }
        });
    }
}
