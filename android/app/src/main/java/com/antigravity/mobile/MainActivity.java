package com.antigravity.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.MediaStore;
import android.util.Size;
import android.util.TypedValue;
import android.view.ActionMode;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String PREFS_NAME = "antigravity_mobile_prefs";
    private static final String KEY_CONFIG_JSON = "config_json";
    private static final String VIRTUAL_APP_SCHEME = "http";
    private static final String VIRTUAL_APP_HOST = "appassets.local";
    private static final String VIRTUAL_APP_ORIGIN = VIRTUAL_APP_SCHEME + "://" + VIRTUAL_APP_HOST;
    private static final String LOCAL_ENTRY_URL = VIRTUAL_APP_ORIGIN + "/www/index.html";
    private static final String MEDIA_THUMB_PATH = "/media-thumb";
    private static final String OFFICIAL_WEB_URL = "https://antigravity.google";
    private static final String APP_VERSION_NAME = "1.7.5";
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int QR_SCAN_REQUEST_CODE = 1002;
    private static final int SAVE_FILE_REQUEST_CODE = 1003;
    private static final int CAMERA_PERMISSION_REQUEST_CODE = 2001;
    private static final int MEDIA_PERMISSION_REQUEST_CODE = 2002;

    private volatile String pendingSaveUrl = null;
    private volatile String pendingSaveFilename = null;

    private static final int COLOR_LIGHT_BG = 0xFFFFFFFF;
    private static final int COLOR_DARK_BG = 0xFF131314;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private FrameLayout rootLayout;
    private WebView webView;
    private WebView officialWebView;
    private TextView backToLocalPill;

    private ValueCallback<Uri[]> filePathCallback;

    private volatile String pendingPairUri = null;
    private volatile boolean inOfficialWebMode = false;
    private volatile boolean localOriginActive = false;
    private volatile boolean localPageLoaded = false;
    private boolean currentIsDark = false;
    private boolean themeSetByWeb = false;

    private static final int MEDIA_THUMB_CACHE_MAX_BYTES = 4 * 1024 * 1024;
    private final MediaThumbCache mediaThumbCache = new MediaThumbCache(MEDIA_THUMB_CACHE_MAX_BYTES);
    private Vibrator cachedVibrator = null;
    private boolean vibratorResolved = false;

    private static final class MediaThumbCache {
        private final int maxBytes;
        private int currentBytes = 0;
        private final LinkedHashMap<Long, byte[]> map = new LinkedHashMap<>(64, 0.75f, true);

        MediaThumbCache(int maxBytes) {
            this.maxBytes = maxBytes;
        }

        synchronized byte[] get(long key) {
            return map.get(key);
        }

        synchronized void put(long key, byte[] value) {
            if (value == null || value.length == 0 || value.length > maxBytes / 4) {
                return;
            }
            byte[] prev = map.put(key, value);
            if (prev != null) {
                currentBytes -= prev.length;
            }
            currentBytes += value.length;
            Iterator<Map.Entry<Long, byte[]>> it = map.entrySet().iterator();
            while (currentBytes > maxBytes && it.hasNext()) {
                Map.Entry<Long, byte[]> oldest = it.next();
                byte[] v = oldest.getValue();
                if (v != null) {
                    currentBytes -= v.length;
                }
                it.remove();
            }
        }

        synchronized void evictAll() {
            map.clear();
            currentBytes = 0;
        }
    }

    private int lastTopPx = 0;
    private int lastNavBottomPx = 0;
    private int lastImeBottomPx = 0;

    private int lastSentTopCss = -1;
    private int lastSentBottomCss = -1;
    private int lastSentImeCss = -1;

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        currentIsDark = isSystemNightMode();
        setupEdgeToEdgeWindow();

        rootLayout = new FrameLayout(this);
        rootLayout.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        rootLayout.setBackgroundColor(currentIsDark ? COLOR_DARK_BG : COLOR_LIGHT_BG);

        webView = new SafeAreaWebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(currentIsDark ? COLOR_DARK_BG : COLOR_LIGHT_BG);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        configureLocalWebView(webView);
        rootLayout.addView(webView);

        backToLocalPill = buildBackToLocalPill();
        rootLayout.addView(backToLocalPill);

        setContentView(rootLayout);

        applySystemBarTheme(currentIsDark);
        setupWindowInsets();

        handlePairIntent(getIntent());
        localOriginActive = true;
        webView.loadUrl(LOCAL_ENTRY_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handlePairIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (inOfficialWebMode) {
            if (officialWebView != null) {
                officialWebView.onResume();
            }
        } else if (webView != null) {
            webView.onResume();
            if (localPageLoaded) {
                webView.evaluateJavascript("window.__onAndroidResume && window.__onAndroidResume()", null);
            }
        }
        if (rootLayout != null) {
            rootLayout.requestApplyInsets();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        if (officialWebView != null) {
            officialWebView.onPause();
        }
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (!themeSetByWeb) {
            boolean night = (newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK)
                    == Configuration.UI_MODE_NIGHT_YES;
            applySystemBarTheme(night);
        }
        if (rootLayout != null) {
            rootLayout.requestApplyInsets();
        }
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= TRIM_MEMORY_RUNNING_LOW) {
            mediaThumbCache.evictAll();
        }
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        mediaThumbCache.evictAll();
    }

    @Override
    protected void onDestroy() {
        mediaThumbCache.evictAll();
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (officialWebView != null) {
            officialWebView.stopLoading();
            officialWebView.setWebChromeClient(null);
            officialWebView.setWebViewClient(new WebViewClient());
            if (rootLayout != null) {
                rootLayout.removeView(officialWebView);
            }
            officialWebView.destroy();
            officialWebView = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.removeJavascriptInterface("AndroidBridge");
            webView.setWebChromeClient(null);
            webView.setWebViewClient(new WebViewClient());
            if (rootLayout != null) {
                rootLayout.removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private boolean isSystemNightMode() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    @SuppressWarnings("deprecation")
    private void setupEdgeToEdgeWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        } else {
            View decor = window.getDecorView();
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @SuppressWarnings("deprecation")
    private void applySystemBarTheme(boolean isDark) {
        currentIsDark = isDark;
        int bgColor = isDark ? COLOR_DARK_BG : COLOR_LIGHT_BG;

        if (rootLayout != null) {
            rootLayout.setBackgroundColor(bgColor);
        }
        if (webView != null) {
            webView.setBackgroundColor(bgColor);
        }
        if (officialWebView != null) {
            officialWebView.setBackgroundColor(bgColor);
        }
        styleBackToLocalPill(isDark);

        Window window = getWindow();
        if (window == null) {
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int lightMask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(isDark ? 0 : lightMask, lightMask);
            } else {
                View decor = window.getDecorView();
                if (decor != null) {
                    decor.post(() -> {
                        WindowInsetsController c = window.getInsetsController();
                        if (c != null) {
                            int lightMask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                            c.setSystemBarsAppearance(currentIsDark ? 0 : lightMask, lightMask);
                        }
                    });
                }
            }
        } else {
            View decor = window.getDecorView();
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (!isDark) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            decor.setSystemUiVisibility(flags);
        }
    }

    @SuppressWarnings("deprecation")
    private void setupWindowInsets() {
        rootLayout.setOnApplyWindowInsetsListener((v, insets) -> {
            updateInsetsFromWindowInsets(insets);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return WindowInsets.CONSUMED;
            }
            return insets.consumeSystemWindowInsets();
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            setupInsetsAnimationApi30();
        }

        rootLayout.requestApplyInsets();
    }

    private void setupInsetsAnimationApi30() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return;
        }
        rootLayout.setWindowInsetsAnimationCallback(new InsetsAnimationCallback(this));
    }

    private static final class InsetsAnimationCallback extends WindowInsetsAnimation.Callback {
        private final MainActivity activity;

        InsetsAnimationCallback(MainActivity activity) {
            super(WindowInsetsAnimation.Callback.DISPATCH_MODE_STOP);
            this.activity = activity;
        }

        @Override
        public WindowInsets onProgress(
                WindowInsets insets,
                List<WindowInsetsAnimation> runningAnimations) {
            // Avoid per-frame WebView evaluateJavascript / :root CSS layout storms at 120-185Hz.
            // Target insets are already applied once via OnApplyWindowInsetsListener, and onEnd()
            // reconciles the final root insets cleanly if an OEM ROM defers reporting them.
            return insets;
        }

        @Override
        public void onEnd(WindowInsetsAnimation animation) {
            activity.syncInsetsFromRoot();
        }
    }

    private void syncInsetsFromRoot() {
        if (rootLayout == null) {
            return;
        }
        WindowInsets rootInsets = rootLayout.getRootWindowInsets();
        if (rootInsets != null) {
            updateInsetsFromWindowInsets(rootInsets);
        }
    }

    @SuppressWarnings("deprecation")
    private void updateInsetsFromWindowInsets(WindowInsets insets) {
        if (insets == null) {
            return;
        }
        int topPx;
        int navBottomPx;
        int imeBottomPx;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Insets topInsets = insets.getInsets(
                    WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout());
            Insets navInsets = insets.getInsets(WindowInsets.Type.navigationBars());
            Insets imeInsets = insets.getInsets(WindowInsets.Type.ime());

            topPx = topInsets.top;
            navBottomPx = navInsets.bottom;
            imeBottomPx = insets.isVisible(WindowInsets.Type.ime()) ? imeInsets.bottom : 0;
        } else {
            topPx = insets.getSystemWindowInsetTop();
            int totalBottom = insets.getSystemWindowInsetBottom();
            int stableBottom = insets.getStableInsetBottom();
            navBottomPx = stableBottom;
            imeBottomPx = totalBottom > stableBottom + dpToPx(80) ? totalBottom : 0;
        }

        lastTopPx = Math.max(0, topPx);
        lastNavBottomPx = Math.max(0, navBottomPx);
        lastImeBottomPx = Math.max(0, imeBottomPx);

        updatePillPositionForInsets();
        applyWebViewInsetsOrPadding(false);
    }

    private void applyWebViewInsetsOrPadding(boolean forceInject) {
        if (inOfficialWebMode) {
            if (officialWebView != null) {
                int bottomPad = Math.max(lastNavBottomPx, lastImeBottomPx);
                if (officialWebView.getPaddingTop() != lastTopPx
                        || officialWebView.getPaddingBottom() != bottomPad) {
                    officialWebView.setPadding(0, lastTopPx, 0, bottomPad);
                }
            }
            return;
        }
        if (webView == null) {
            return;
        }

        if (webView.getPaddingTop() != 0 || webView.getPaddingBottom() != 0) {
            webView.setPadding(0, 0, 0, 0);
        }

        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) {
            density = 1f;
        }

        int topCss = Math.round(lastTopPx / density);
        int bottomCss = Math.round(lastNavBottomPx / density);
        int imeCss = lastImeBottomPx > 0 ? Math.round(lastImeBottomPx / density) : 0;

        if (!forceInject
                && topCss == lastSentTopCss
                && bottomCss == lastSentBottomCss
                && imeCss == lastSentImeCss) {
            return;
        }

        lastSentTopCss = topCss;
        lastSentBottomCss = bottomCss;
        lastSentImeCss = imeCss;

        if (localPageLoaded) {
            injectInsetsToWeb(topCss, bottomCss, imeCss);
        }
    }

    private void injectInsetsToWeb(int topCss, int bottomCss, int imeCss) {
        if (webView == null || inOfficialWebMode) {
            return;
        }
        String js = "if (typeof window.__setAndroidInsets === 'function') {"
                + "window.__setAndroidInsets(" + topCss + "," + bottomCss + "," + imeCss + ");"
                + "}";
        webView.evaluateJavascript(js, null);
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @SuppressWarnings("deprecation")
    private void configureLocalWebView(WebView wv) {
        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setNeedInitialFocus(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(wv, false);

        wv.addJavascriptInterface(new AndroidBridge(this), "AndroidBridge");

        wv.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (!isBridgeCallAllowed() || !isPairedHostOrigin(url)) {
                return;
            }
            String guessed = URLUtil.guessFileName(url, contentDisposition, mimetype);
            enqueueDownload(url, guessed);
        });

        wv.setWebViewClient(new MainWebViewClient(this));
        wv.setWebChromeClient(new MainWebChromeClient(this));
    }

    @SuppressLint("SetJavaScriptEnabled")
    @SuppressWarnings("deprecation")
    private WebView ensureOfficialWebView() {
        if (officialWebView != null) {
            return officialWebView;
        }
        WebView wv = new WebView(this);
        wv.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        wv.setBackgroundColor(currentIsDark ? COLOR_DARK_BG : COLOR_LIGHT_BG);
        wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        wv.setVerticalScrollBarEnabled(false);
        wv.setHorizontalScrollBarEnabled(false);
        wv.setVisibility(View.GONE);

        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setNeedInitialFocus(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }

        String ua = settings.getUserAgentString();
        if (ua != null) {
            ua = ua.replace("; wv)", ")")
                    .replace(" wv)", ")")
                    .replaceAll("Version/\\d+\\.\\d+\\s*", "");
            settings.setUserAgentString(ua);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(wv, true);

        // SECURITY: NEVER attach AndroidBridge to officialWebView.
        wv.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url == null || !url.toLowerCase().startsWith("https://")) {
                return;
            }
            String guessed = URLUtil.guessFileName(url, contentDisposition, mimetype);
            enqueueDownload(url, guessed);
        });

        wv.setWebViewClient(new OfficialWebViewClient(this));
        wv.setWebChromeClient(new MainWebChromeClient(this));

        int pillIdx = rootLayout != null && backToLocalPill != null
                ? rootLayout.indexOfChild(backToLocalPill)
                : -1;
        if (rootLayout != null) {
            if (pillIdx >= 0) {
                rootLayout.addView(wv, pillIdx);
            } else {
                rootLayout.addView(wv);
            }
        }
        officialWebView = wv;
        return officialWebView;
    }

    private static boolean isLocalAppUrl(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        Uri uri = Uri.parse(url);
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        String path = uri.getPath();
        return VIRTUAL_APP_SCHEME.equalsIgnoreCase(scheme)
                && VIRTUAL_APP_HOST.equalsIgnoreCase(host)
                && path != null
                && (path.equals("/www") || path.equals("/www/") || path.startsWith("/www/"));
    }

    private static WebResourceResponse makeStatusResponse(int statusCode, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse(
                "text/plain",
                "utf-8",
                statusCode,
                reason,
                headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private WebResourceResponse serveVirtualAppRequest(Uri uri) {
        if (uri == null || !VIRTUAL_APP_SCHEME.equalsIgnoreCase(uri.getScheme())) {
            return makeStatusResponse(403, "Forbidden");
        }
        String path = uri.getPath();
        if (path == null || path.isEmpty()) {
            return makeStatusResponse(404, "Not Found");
        }
        if (MEDIA_THUMB_PATH.equals(path)) {
            return serveMediaThumbnail(uri);
        }
        if ("/favicon.ico".equals(path)) {
            return serveLocalAsset("www/favicon.ico");
        }
        if (path.equals("/www") || path.equals("/www/") || path.startsWith("/www/")) {
            String rel = path.substring(1);
            if ("www".equals(rel) || "www/".equals(rel)) {
                rel = "www/index.html";
            }
            return serveLocalAsset(rel);
        }
        return makeStatusResponse(404, "Not Found");
    }

    private WebResourceResponse serveLocalAsset(String relPath) {
        if (relPath == null || relPath.isEmpty()
                || relPath.contains("..")
                || relPath.contains("\\")
                || relPath.indexOf('\0') >= 0
                || !relPath.startsWith("www/")) {
            return makeStatusResponse(403, "Forbidden");
        }
        String[] parts = relPath.split("/");
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) {
                return makeStatusResponse(403, "Forbidden");
            }
        }
        try {
            InputStream in = getAssets().open(relPath);
            String mime = guessAssetMimeType(relPath);
            String encoding = isTextMime(mime) ? "utf-8" : null;
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("X-Content-Type-Options", "nosniff");
            return new WebResourceResponse(mime, encoding, 200, "OK", headers, in);
        } catch (IOException ignored) {
            return makeStatusResponse(404, "Not Found");
        }
    }

    private String guessAssetMimeType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            return "text/html";
        }
        if (lower.endsWith(".css")) {
            return "text/css";
        }
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
            return "application/javascript";
        }
        if (lower.endsWith(".json") || lower.endsWith(".webmanifest")) {
            return "application/json";
        }
        if (lower.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (lower.endsWith(".png")) {
            return "image/png";
        }
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (lower.endsWith(".webp")) {
            return "image/webp";
        }
        if (lower.endsWith(".gif")) {
            return "image/gif";
        }
        if (lower.endsWith(".ico")) {
            return "image/x-icon";
        }
        if (lower.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (lower.endsWith(".woff")) {
            return "font/woff";
        }
        if (lower.endsWith(".ttf")) {
            return "font/ttf";
        }
        return guessMimeType(path);
    }

    private static boolean isTextMime(String mime) {
        return mime != null && (mime.startsWith("text/")
                || "application/javascript".equals(mime)
                || "application/json".equals(mime)
                || "image/svg+xml".equals(mime));
    }

    private static final class MainWebViewClient extends WebViewClient {
        private final MainActivity activity;

        MainWebViewClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request != null ? request.getUrl() : null;
            if (uri != null && VIRTUAL_APP_HOST.equalsIgnoreCase(uri.getHost())) {
                return activity.serveVirtualAppRequest(uri);
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request != null ? request.getUrl() : null;
            if (uri == null) {
                return true;
            }
            return activity.handleLocalNavigationUri(uri);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            if (!isLocalAppUrl(url)) {
                activity.localOriginActive = false;
                view.stopLoading();
                view.loadUrl(LOCAL_ENTRY_URL);
                return;
            }
            activity.localOriginActive = true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (isLocalAppUrl(url)) {
                activity.localOriginActive = true;
                activity.localPageLoaded = true;
                activity.applyWebViewInsetsOrPadding(true);

                activity.mainHandler.postDelayed(() -> {
                    String uriStr = activity.consumePendingPairUri();
                    if (uriStr != null && !uriStr.isEmpty()
                            && activity.localPageLoaded && !activity.inOfficialWebMode) {
                        activity.deliverPairUriToWeb(uriStr);
                    }
                }, 150);
            }
        }
    }

    private static final class OfficialWebViewClient extends WebViewClient {
        private final MainActivity activity;

        OfficialWebViewClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request != null ? request.getUrl() : null;
            if (uri != null && VIRTUAL_APP_HOST.equalsIgnoreCase(uri.getHost())) {
                return makeStatusResponse(403, "Forbidden");
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request != null ? request.getUrl() : null;
            if (uri == null) {
                return true;
            }
            return activity.handleOfficialNavigationUri(uri);
        }
    }

    private static final class MainWebChromeClient extends WebChromeClient {
        private final MainActivity activity;

        MainWebChromeClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> callback,
                FileChooserParams params) {
            if (activity.filePathCallback != null) {
                activity.filePathCallback.onReceiveValue(null);
                activity.filePathCallback = null;
            }
            activity.filePathCallback = callback;

            boolean allowMultiple = true;
            boolean imageOnly = false;
            List<String> validTypes = new ArrayList<>();
            if (params != null) {
                allowMultiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE
                        || params.getMode() == FileChooserParams.MODE_OPEN;
                String[] acceptTypes = params.getAcceptTypes();
                if (acceptTypes != null && acceptTypes.length > 0) {
                    for (String raw : acceptTypes) {
                        if (raw != null) {
                            String t = raw.trim().toLowerCase();
                            if (!t.isEmpty() && t.contains("/")) {
                                validTypes.add(t);
                            }
                        }
                    }
                    if (!validTypes.isEmpty()) {
                        imageOnly = true;
                        for (String t : validTypes) {
                            if (!t.startsWith("image/")) {
                                imageOnly = false;
                                break;
                            }
                        }
                    }
                }
            }

            // System Photo Album / Gallery Picker (for "相册" button)
            if (imageOnly) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    try {
                        Intent pickImages = new Intent(MediaStore.ACTION_PICK_IMAGES);
                        pickImages.setType("image/*");
                        if (allowMultiple) {
                            int maxPick = Math.min(20, MediaStore.getPickImagesMaxLimit());
                            if (maxPick >= 2) {
                                pickImages.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, maxPick);
                            }
                        }
                        activity.startActivityForResult(pickImages, FILE_CHOOSER_REQUEST_CODE);
                        return true;
                    } catch (Exception ignored) {
                        // Fall through to ACTION_PICK below
                    }
                }
                try {
                    Intent albumIntent = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
                    albumIntent.setType("image/*");
                    albumIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);
                    activity.startActivityForResult(albumIntent, FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception ignored) {
                    // Fall through to ACTION_GET_CONTENT below
                }
            }

            // System File / Folder Manager (for "打开文件夹" button)
            if (!imageOnly && validTypes.isEmpty()) {
                try {
                    Intent docIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    docIntent.addCategory(Intent.CATEGORY_OPENABLE);
                    docIntent.setType("*/*");
                    docIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);
                    activity.startActivityForResult(docIntent, FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception ignored) {
                    // Fall through to ACTION_GET_CONTENT below
                }
            }

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            if (validTypes.size() == 1) {
                intent.setType(validTypes.get(0));
            } else if (validTypes.size() > 1) {
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, validTypes.toArray(new String[0]));
            } else {
                intent.setType("*/*");
            }
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);

            try {
                activity.startActivityForResult(
                        Intent.createChooser(intent, imageOnly ? "选择相册图片" : "打开文件夹选择文件"),
                        FILE_CHOOSER_REQUEST_CODE);
                return true;
            } catch (ActivityNotFoundException e) {
                if (activity.filePathCallback != null) {
                    activity.filePathCallback.onReceiveValue(null);
                    activity.filePathCallback = null;
                }
                Toast.makeText(activity, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                return false;
            }
        }
    }

    private boolean handleLocalNavigationUri(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) {
            return true;
        }
        String lower = scheme.toLowerCase();
        if ("agylink".equals(lower) && "pair".equalsIgnoreCase(uri.getHost())) {
            handlePairUri(uri.toString());
            return true;
        }
        if (VIRTUAL_APP_SCHEME.equals(lower) && VIRTUAL_APP_HOST.equalsIgnoreCase(uri.getHost())) {
            String path = uri.getPath();
            if (path != null && (path.equals("/www") || path.equals("/www/") || path.startsWith("/www/"))) {
                return false;
            }
            return true;
        }
        // Block non-app local/data/blob/script navigations in the privileged local WebView.
        if ("file".equals(lower) || "data".equals(lower) || "blob".equals(lower)
                || "content".equals(lower) || "about".equals(lower) || "javascript".equals(lower)) {
            return true;
        }
        // Open ALL external http/https and app-scheme links externally; NEVER load third-party sites here.
        try {
            Intent external = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(external);
            return true;
        } catch (Exception ignored) {
            return true;
        }
    }

    private boolean handleOfficialNavigationUri(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) {
            return true;
        }
        String lower = scheme.toLowerCase();
        if ("agylink".equals(lower) && "pair".equalsIgnoreCase(uri.getHost())) {
            handlePairUri(uri.toString());
            return true;
        }
        if ("https".equals(lower)) {
            return false;
        }
        if ("file".equals(lower) || "data".equals(lower) || "blob".equals(lower)
                || "content".equals(lower) || "about".equals(lower) || "javascript".equals(lower)) {
            return true;
        }
        // Open http:// and external schemes via system browser (keep Official WebView HTTPS-only).
        try {
            Intent external = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(external);
            return true;
        } catch (Exception ignored) {
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == QR_SCAN_REQUEST_CODE) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                String qrText = data.getStringExtra(QrScannerActivity.EXTRA_QR_TEXT);
                if (qrText != null && !qrText.trim().isEmpty()) {
                    performHaptic("success");
                    handlePairUri(qrText.trim());
                }
            } else if (data != null) {
                String err = data.getStringExtra(QrScannerActivity.EXTRA_QR_ERROR);
                if (err != null && !err.trim().isEmpty()) {
                    Toast.makeText(this, err, Toast.LENGTH_LONG).show();
                }
            }
            return;
        }
        if (requestCode == SAVE_FILE_REQUEST_CODE) {
            String srcUrl = pendingSaveUrl;
            String fname = pendingSaveFilename;
            pendingSaveUrl = null;
            pendingSaveFilename = null;
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null && srcUrl != null) {
                Uri destUri = data.getData();
                Toast.makeText(this, "正在保存：" + (fname != null ? fname : "文件"), Toast.LENGTH_SHORT).show();
                new Thread(new SaveFileWorker(this, srcUrl, destUri, fname != null ? fname : "download"), "AgySaveFile").start();
            }
            return;
        }
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback == null) {
                return;
            }
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clipData = data.getClipData();
                if (clipData != null && clipData.getItemCount() > 0) {
                    int count = clipData.getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = clipData.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == CAMERA_PERMISSION_REQUEST_CODE) {
            if (grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                mainHandler.postDelayed(this::startQrScannerActivity, 120);
            } else {
                Toast.makeText(this, "需要相机权限才能扫码，可在系统设置中开启，或先用 6 位配对码连接", Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (requestCode == MEDIA_PERMISSION_REQUEST_CODE) {
            boolean granted = hasAnyMediaPermission();
            boolean partial = granted && !hasFullMediaPermission();
            if (webView != null && localPageLoaded && !inOfficialWebMode) {
                String js = "if (typeof window.__onAndroidMediaPermissionResult === 'function') {"
                        + "window.__onAndroidMediaPermissionResult(" + granted + "," + partial + ");"
                        + "}";
                webView.evaluateJavascript(js, null);
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private boolean hasFullMediaPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAnyMediaPermission() {
        if (hasFullMediaPermission()) {
            return true;
        }
        if (Build.VERSION.SDK_INT >= 34) {
            return checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return false;
    }

    private void requestMediaImagesPermission() {
        if (Build.VERSION.SDK_INT >= 34) {
            requestPermissions(
                    new String[]{
                            Manifest.permission.READ_MEDIA_IMAGES,
                            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
                    },
                    MEDIA_PERMISSION_REQUEST_CODE);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(
                    new String[]{Manifest.permission.READ_MEDIA_IMAGES},
                    MEDIA_PERMISSION_REQUEST_CODE);
        } else {
            requestPermissions(
                    new String[]{Manifest.permission.READ_EXTERNAL_STORAGE},
                    MEDIA_PERMISSION_REQUEST_CODE);
        }
    }

    private String queryRecentPhotosJson(int maxCount) {
        JSONObject out = new JSONObject();
        try {
            boolean granted = hasAnyMediaPermission();
            boolean partial = granted && !hasFullMediaPermission();
            out.put("granted", granted);
            out.put("partial", partial);
            JSONArray items = new JSONArray();
            if (!granted) {
                out.put("items", items);
                return out.toString();
            }

            int limit = Math.max(1, Math.min(100, maxCount <= 0 ? 60 : maxCount));
            Uri collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            String[] projection = new String[]{
                    MediaStore.Images.Media._ID,
                    MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.WIDTH,
                    MediaStore.Images.Media.HEIGHT,
                    MediaStore.Images.Media.ORIENTATION,
                    MediaStore.Images.Media.SIZE,
                    MediaStore.Images.Media.MIME_TYPE,
                    MediaStore.Images.Media.DATE_ADDED,
                    MediaStore.Images.Media.DATE_MODIFIED
            };

            Cursor cursor = null;
            try {
                ContentResolver cr = getContentResolver();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // AOSP QUERY_ARG_SORT_COLUMNS with 2+ columns builds "col1, col2 DESC"
                    // (which sorts col1 ASC in SQLite!). Use explicit QUERY_ARG_SQL_SORT_ORDER
                    // so every column sorts DESC (newest first), with single-column fallback.
                    try {
                        Bundle queryArgs = new Bundle();
                        queryArgs.putString(
                                ContentResolver.QUERY_ARG_SQL_SORT_ORDER,
                                MediaStore.Images.Media.DATE_ADDED + " DESC, "
                                        + MediaStore.Images.Media.DATE_MODIFIED + " DESC, "
                                        + MediaStore.Images.Media._ID + " DESC");
                        queryArgs.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
                        cursor = cr.query(collection, projection, queryArgs, null);
                    } catch (Exception ignored) {
                        Bundle fallbackArgs = new Bundle();
                        fallbackArgs.putStringArray(
                                ContentResolver.QUERY_ARG_SORT_COLUMNS,
                                new String[]{MediaStore.Images.Media.DATE_ADDED});
                        fallbackArgs.putInt(
                                ContentResolver.QUERY_ARG_SORT_DIRECTION,
                                ContentResolver.QUERY_SORT_DIRECTION_DESCENDING);
                        fallbackArgs.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
                        cursor = cr.query(collection, projection, fallbackArgs, null);
                    }
                } else {
                    String sortOrder = MediaStore.Images.Media.DATE_ADDED + " DESC, "
                            + MediaStore.Images.Media.DATE_MODIFIED + " DESC, "
                            + MediaStore.Images.Media._ID + " DESC";
                    cursor = cr.query(collection, projection, null, null, sortOrder);
                }

                if (cursor != null) {
                    int colId = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                    int colName = cursor.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME);
                    int colW = cursor.getColumnIndex(MediaStore.Images.Media.WIDTH);
                    int colH = cursor.getColumnIndex(MediaStore.Images.Media.HEIGHT);
                    int colOrient = cursor.getColumnIndex(MediaStore.Images.Media.ORIENTATION);
                    int colSize = cursor.getColumnIndex(MediaStore.Images.Media.SIZE);
                    int colMime = cursor.getColumnIndex(MediaStore.Images.Media.MIME_TYPE);

                    int count = 0;
                    while (cursor.moveToNext() && count < limit) {
                        long id = cursor.getLong(colId);
                        long size = colSize >= 0 ? cursor.getLong(colSize) : 0L;
                        if (size <= 0L) {
                            continue;
                        }
                        String name = colName >= 0 ? cursor.getString(colName) : null;
                        if (name == null || name.trim().isEmpty()) {
                            name = "IMG_" + id + ".jpg";
                        }
                        int w = colW >= 0 ? cursor.getInt(colW) : 0;
                        int h = colH >= 0 ? cursor.getInt(colH) : 0;
                        int orient = colOrient >= 0 ? cursor.getInt(colOrient) : 0;
                        if (orient == 90 || orient == 270) {
                            int tmp = w;
                            w = h;
                            h = tmp;
                        }
                        String mime = colMime >= 0 ? cursor.getString(colMime) : null;
                        if (mime == null || mime.trim().isEmpty()) {
                            mime = "image/jpeg";
                        }

                        JSONObject item = new JSONObject();
                        item.put("id", id);
                        item.put("name", name);
                        item.put("width", w);
                        item.put("height", h);
                        item.put("size", size);
                        item.put("mime", mime);
                        item.put("thumbUrl", VIRTUAL_APP_ORIGIN + MEDIA_THUMB_PATH + "?id=" + id);
                        items.put(item);
                        count++;
                    }
                }
            } finally {
                if (cursor != null) {
                    cursor.close();
                }
            }
            out.put("items", items);
        } catch (Throwable t) {
            try {
                out.put("error", t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName());
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    @SuppressWarnings("deprecation")
    private WebResourceResponse serveMediaThumbnail(Uri uri) {
        if (inOfficialWebMode || !localOriginActive) {
            return makeStatusResponse(403, "Forbidden");
        }
        try {
            String idStr = uri.getQueryParameter("id");
            if (idStr == null || idStr.isEmpty()) {
                return makeStatusResponse(404, "Not Found");
            }
            long id = Long.parseLong(idStr.trim());
            if (id < 0L) {
                return makeStatusResponse(404, "Not Found");
            }
            byte[] cachedBytes = mediaThumbCache.get(id);
            if (cachedBytes != null) {
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "private, max-age=60");
                headers.put("X-Content-Type-Options", "nosniff");
                return new WebResourceResponse(
                        "image/jpeg", null, 200, "OK", headers, new ByteArrayInputStream(cachedBytes));
            }
            Uri contentUri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
            Bitmap bmp = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    bmp = getContentResolver().loadThumbnail(contentUri, new Size(360, 480), null);
                } catch (Exception ignored) {
                    bmp = null;
                }
            }
            if (bmp == null) {
                try {
                    bmp = MediaStore.Images.Thumbnails.getThumbnail(
                            getContentResolver(),
                            id,
                            MediaStore.Images.Thumbnails.MINI_KIND,
                            null);
                } catch (Exception ignored) {
                    bmp = null;
                }
            }
            if (bmp == null) {
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inJustDecodeBounds = true;
                try (InputStream is = getContentResolver().openInputStream(contentUri)) {
                    if (is != null) {
                        BitmapFactory.decodeStream(is, null, opts);
                    }
                }
                int sample = 1;
                while ((opts.outWidth / sample) > 720 || (opts.outHeight / sample) > 960) {
                    sample *= 2;
                }
                opts.inJustDecodeBounds = false;
                opts.inSampleSize = sample;
                try (InputStream is = getContentResolver().openInputStream(contentUri)) {
                    if (is != null) {
                        bmp = BitmapFactory.decodeStream(is, null, opts);
                    }
                }
            }
            if (bmp == null) {
                return makeStatusResponse(404, "Not Found");
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 82, baos);
            bmp.recycle();
            byte[] bytes = baos.toByteArray();
            if (bytes.length > 0 && bytes.length <= MEDIA_THUMB_CACHE_MAX_BYTES / 4) {
                mediaThumbCache.put(id, bytes);
            }
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "private, max-age=60");
            headers.put("X-Content-Type-Options", "nosniff");
            return new WebResourceResponse(
                    "image/jpeg", null, 200, "OK", headers, new ByteArrayInputStream(bytes));
        } catch (Throwable ignored) {
            return makeStatusResponse(404, "Not Found");
        }
    }

    private void uploadMediaImageAsync(
            long mediaId,
            String filename,
            String uploadUrl,
            String token,
            String cbId) {
        new Thread(new MediaUploadWorker(this, mediaId, filename, uploadUrl, token, cbId), "AgyUploadMedia").start();
    }

    private void deliverNativeUploadDone(String cbId, String responseJson, String errorMsg) {
        mainHandler.post(() -> {
            if (webView == null || inOfficialWebMode) {
                return;
            }
            String js = "if (typeof window.__onNativeUploadDone === 'function') {"
                    + "window.__onNativeUploadDone("
                    + JSONObject.quote(cbId != null ? cbId : "") + ","
                    + JSONObject.quote(responseJson != null ? responseJson : "") + ","
                    + JSONObject.quote(errorMsg != null ? errorMsg : "")
                    + ");}";
            webView.evaluateJavascript(js, null);
        });
    }

    private static final class MediaUploadWorker implements Runnable {
        private final MainActivity activity;
        private final long mediaId;
        private final String filename;
        private final String uploadUrl;
        private final String token;
        private final String cbId;

        MediaUploadWorker(
                MainActivity activity,
                long mediaId,
                String filename,
                String uploadUrl,
                String token,
                String cbId) {
            this.activity = activity;
            this.mediaId = mediaId;
            this.filename = filename;
            this.uploadUrl = uploadUrl;
            this.token = token;
            this.cbId = cbId;
        }

        @Override
        public void run() {
            HttpURLConnection conn = null;
            try {
                Uri contentUri = ContentUris.withAppendedId(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, mediaId);
                String safeName = (filename == null || filename.trim().isEmpty())
                        ? ("IMG_" + mediaId + ".jpg")
                        : filename.trim().replace("\"", "_").replace("\r", "").replace("\n", "");
                String mime = activity.getContentResolver().getType(contentUri);
                if (mime == null || mime.trim().isEmpty()) {
                    mime = activity.guessMimeType(safeName);
                }

                String boundary = "----AgyMobileBoundary" + System.currentTimeMillis();
                byte[] headerBytes = (
                        "--" + boundary + "\r\n"
                                + "Content-Disposition: form-data; name=\"file\"; filename=\"" + safeName + "\"\r\n"
                                + "Content-Type: " + mime + "\r\n\r\n"
                ).getBytes(StandardCharsets.UTF_8);
                byte[] footerBytes = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);

                conn = (HttpURLConnection) new URL(uploadUrl).openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(120000);
                conn.setChunkedStreamingMode(65536);
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                if (token != null && !token.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                }

                try (InputStream in = activity.getContentResolver().openInputStream(contentUri);
                     OutputStream out = conn.getOutputStream()) {
                    if (in == null) {
                        throw new RuntimeException("无法读取原图文件");
                    }
                    out.write(headerBytes);
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                    out.write(footerBytes);
                    out.flush();
                }

                int code = conn.getResponseCode();
                InputStream respIn = (code >= 200 && code < 300)
                        ? conn.getInputStream()
                        : conn.getErrorStream();
                ByteArrayOutputStream respBuf = new ByteArrayOutputStream();
                if (respIn != null) {
                    try (InputStream rin = respIn) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = rin.read(buf)) != -1) {
                            respBuf.write(buf, 0, n);
                        }
                    }
                }
                String body = respBuf.toString("UTF-8");
                if (code < 200 || code >= 300) {
                    activity.deliverNativeUploadDone(cbId, "", "HTTP " + code + (body.isEmpty() ? "" : (": " + body)));
                    return;
                }
                activity.deliverNativeUploadDone(cbId, body, "");
            } catch (Throwable t) {
                String msg = t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
                activity.deliverNativeUploadDone(cbId, "", msg);
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
    }

    private void launchQrScannerWithPermission() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startQrScannerActivity();
        } else {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST_CODE);
        }
    }

    private void startQrScannerActivity() {
        try {
            Intent intent = new Intent(this, QrScannerActivity.class);
            startActivityForResult(intent, QR_SCAN_REQUEST_CODE);
        } catch (Exception e) {
            Toast.makeText(this, "无法启动扫码器：" + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private void handlePairIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri uri = intent.getData();
        if (uri == null) {
            return;
        }
        if ("agylink".equalsIgnoreCase(uri.getScheme())
                && "pair".equalsIgnoreCase(uri.getHost())) {
            handlePairUri(uri.toString());
        }
    }

    private void handlePairUri(String uriStr) {
        if (uriStr == null || uriStr.isEmpty()) {
            return;
        }
        synchronized (this) {
            pendingPairUri = uriStr;
        }
        mainHandler.post(() -> {
            if (inOfficialWebMode) {
                exitOfficialWeb();
                return;
            }
            if (localPageLoaded && webView != null) {
                String consumed = consumePendingPairUri();
                if (consumed != null && !consumed.isEmpty()) {
                    deliverPairUriToWeb(consumed);
                }
            }
        });
    }

    private synchronized String consumePendingPairUri() {
        String uri = pendingPairUri;
        pendingPairUri = null;
        return uri;
    }

    private void deliverPairUriToWeb(String uriStr) {
        if (webView == null || uriStr == null || uriStr.isEmpty()) {
            return;
        }
        String quoted = JSONObject.quote(uriStr);
        String js = "if (typeof window.__onAndroidPairUri === 'function') {"
                + "window.__onAndroidPairUri(" + quoted + ");"
                + "}";
        webView.evaluateJavascript(js, null);
    }

    @SuppressLint("ClickableViewAccessibility")
    private TextView buildBackToLocalPill() {
        TextView pill = new TextView(this);
        pill.setText(getString(R.string.back_to_local));
        pill.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        pill.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        pill.setPadding(dpToPx(14), dpToPx(8), dpToPx(14), dpToPx(8));
        pill.setElevation(dpToPx(6));
        pill.setVisibility(View.GONE);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.END);
        lp.topMargin = dpToPx(42);
        lp.rightMargin = dpToPx(12);
        pill.setLayoutParams(lp);

        final float dragThresholdPx = dpToPx(8);
        pill.setOnTouchListener(new PillDragTouchListener(this, dragThresholdPx));

        return pill;
    }

    private static final class PillDragTouchListener implements View.OnTouchListener {
        private final MainActivity activity;
        private final float dragThresholdPx;
        private float downRawX;
        private float downRawY;
        private float startTx;
        private float startTy;
        private boolean dragged;

        PillDragTouchListener(MainActivity activity, float dragThresholdPx) {
            this.activity = activity;
            this.dragThresholdPx = dragThresholdPx;
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouch(View v, MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downRawX = event.getRawX();
                    downRawY = event.getRawY();
                    startTx = v.getTranslationX();
                    startTy = v.getTranslationY();
                    dragged = false;
                    v.setAlpha(0.82f);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = event.getRawX() - downRawX;
                    float dy = event.getRawY() - downRawY;
                    if (Math.hypot(dx, dy) > dragThresholdPx) {
                        dragged = true;
                    }
                    if (dragged) {
                        v.setTranslationX(startTx + dx);
                        v.setTranslationY(startTy + dy);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    v.setAlpha(1f);
                    if (!dragged) {
                        activity.performHaptic("light");
                        activity.exitOfficialWeb();
                    }
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    v.setAlpha(1f);
                    return true;
                default:
                    return false;
            }
        }
    }

    private void styleBackToLocalPill(boolean isDark) {
        if (backToLocalPill == null) {
            return;
        }
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setCornerRadius(dpToPx(999));
        if (isDark) {
            bg.setColor(0xF21E1F20);
            bg.setStroke(dpToPx(1), 0xFF3C4043);
            backToLocalPill.setTextColor(0xFFA8C7FA);
        } else {
            bg.setColor(0xF2F0F4F9);
            bg.setStroke(dpToPx(1), 0xFFDFE3EB);
            backToLocalPill.setTextColor(0xFF0B57D0);
        }
        backToLocalPill.setBackground(bg);
    }

    private void updatePillPositionForInsets() {
        if (backToLocalPill == null) {
            return;
        }
        ViewGroup.LayoutParams rawLp = backToLocalPill.getLayoutParams();
        if (rawLp instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) rawLp;
            int desiredTop = lastTopPx + dpToPx(10);
            if (lp.topMargin != desiredTop) {
                lp.topMargin = desiredTop;
                backToLocalPill.setLayoutParams(lp);
            }
        }
    }

    private void enterOfficialWeb() {
        if (webView == null) {
            return;
        }
        WebView official = ensureOfficialWebView();
        inOfficialWebMode = true;

        webView.setVisibility(View.GONE);
        webView.onPause();

        official.setVisibility(View.VISIBLE);
        official.onResume();
        applyWebViewInsetsOrPadding(false);

        if (backToLocalPill != null) {
            backToLocalPill.setTranslationX(0f);
            backToLocalPill.setTranslationY(0f);
            updatePillPositionForInsets();
            backToLocalPill.setAlpha(0f);
            backToLocalPill.setVisibility(View.VISIBLE);
            backToLocalPill.animate().alpha(1f).setDuration(200).start();
        }
        String currentUrl = official.getUrl();
        if (currentUrl == null || currentUrl.isEmpty() || !currentUrl.toLowerCase().startsWith("https://")) {
            official.loadUrl(OFFICIAL_WEB_URL);
        }
    }

    private void exitOfficialWeb() {
        if (webView == null) {
            return;
        }
        inOfficialWebMode = false;

        if (backToLocalPill != null) {
            backToLocalPill.setVisibility(View.GONE);
        }
        if (officialWebView != null) {
            officialWebView.setVisibility(View.GONE);
            officialWebView.onPause();
        }

        webView.setVisibility(View.VISIBLE);
        webView.onResume();
        applyWebViewInsetsOrPadding(true);

        if (localPageLoaded) {
            String pending = consumePendingPairUri();
            if (pending != null && !pending.isEmpty()) {
                deliverPairUriToWeb(pending);
            }
        }
    }

    @SuppressWarnings("deprecation")
    private void performHaptic(String kind) {
        try {
            if (!vibratorResolved) {
                vibratorResolved = true;
                Vibrator v;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    v = vm != null ? vm.getDefaultVibrator() : null;
                } else {
                    v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                }
                cachedVibrator = (v != null && v.hasVibrator()) ? v : null;
            }
            Vibrator vibrator = cachedVibrator;
            if (vibrator == null) {
                return;
            }

            String k = kind == null ? "light" : kind.trim().toLowerCase();
            if ("success".equals(k)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    vibrator.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK));
                } else {
                    vibrator.vibrate(VibrationEffect.createWaveform(
                            new long[]{0, 14, 38, 22},
                            new int[]{0, 100, 0, 170},
                            -1));
                }
            } else if ("error".equals(k)) {
                vibrator.vibrate(VibrationEffect.createWaveform(
                        new long[]{0, 24, 42, 24},
                        new int[]{0, 170, 0, 170},
                        -1));
            } else if ("medium".equals(k) || "heavy".equals(k)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    vibrator.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK));
                } else {
                    vibrator.vibrate(VibrationEffect.createOneShot(18, 120));
                }
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    vibrator.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK));
                } else {
                    vibrator.vibrate(VibrationEffect.createOneShot(10, 60));
                }
            }
        } catch (Exception ignored) {
            // Device may restrict or lack vibration hardware.
        }
    }

    private void enqueueDownload(String url, String filename) {
        enqueueDownloadWithOptions(url, filename, "Antigravity", false);
    }

    private boolean launchSafSave(String url, String safeName) {
        try {
            pendingSaveUrl = url;
            pendingSaveFilename = safeName;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(guessMimeType(safeName));
            intent.putExtra(Intent.EXTRA_TITLE, safeName);
            startActivityForResult(intent, SAVE_FILE_REQUEST_CODE);
            return true;
        } catch (Exception e) {
            pendingSaveUrl = null;
            pendingSaveFilename = null;
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private void enqueueDownloadWithOptions(String url, String filename, String subdir, boolean askFolder) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            Toast.makeText(this, "不支持的下载链接", Toast.LENGTH_SHORT).show();
            return;
        }
        String safeName = sanitizeFilename(filename, url);

        if (askFolder) {
            if (launchSafSave(url, safeName)) {
                return;
            }
            Toast.makeText(this, "无法打开文件夹选择器，改为默认下载", Toast.LENGTH_SHORT).show();
        }

        // On Android 8-9 (API 26-28), DownloadManager.setDestinationInExternalPublicDir requires
        // WRITE_EXTERNAL_STORAGE at runtime. Fall back cleanly to SAF when not granted.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            if (launchSafSave(url, safeName)) {
                return;
            }
            Toast.makeText(this, "缺少存储权限且无法打开系统保存器", Toast.LENGTH_LONG).show();
            return;
        }

        String cleanSub = sanitizeSubdir(subdir);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && !cleanSub.isEmpty()) {
            try {
                File dlRoot = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File targetDir = new File(dlRoot, cleanSub);
                if (!targetDir.exists() && !targetDir.mkdirs()) {
                    cleanSub = cleanSub.replace('/', '_');
                }
            } catch (Exception ignored) {
                cleanSub = cleanSub.replace('/', '_');
            }
        }

        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) {
            if (launchSafSave(url, safeName)) {
                return;
            }
            Toast.makeText(this, "系统下载服务不可用", Toast.LENGTH_SHORT).show();
            return;
        }

        String usedSub = cleanSub;
        String relDest = usedSub.isEmpty() ? safeName : (usedSub + "/" + safeName);
        try {
            enqueueDownloadRequest(dm, url, safeName, relDest);
            String folderDisp = usedSub.isEmpty() ? "Download/" : ("Download/" + usedSub + "/");
            Toast.makeText(this, "开始下载到 " + folderDisp + safeName, Toast.LENGTH_SHORT).show();
        } catch (Exception firstErr) {
            // Some Android 10+ OEM ROMs reject multi-segment subdirs under Downloads; retry flattened.
            if (usedSub.contains("/")) {
                String flatSub = usedSub.replace('/', '_');
                String flatDest = flatSub.isEmpty() ? safeName : (flatSub + "/" + safeName);
                try {
                    enqueueDownloadRequest(dm, url, safeName, flatDest);
                    String folderDisp = flatSub.isEmpty() ? "Download/" : ("Download/" + flatSub + "/");
                    Toast.makeText(this, "开始下载到 " + folderDisp + safeName, Toast.LENGTH_SHORT).show();
                    return;
                } catch (Exception ignored) {
                    // Fall through to SAF fallback below
                }
            }
            if (launchSafSave(url, safeName)) {
                return;
            }
            Toast.makeText(this, "下载失败：" + firstErr.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private void enqueueDownloadRequest(DownloadManager dm, String url, String safeName, String relDest) {
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        req.setTitle(safeName);
        req.setDescription("Antigravity");
        req.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, relDest);

        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null && !cookies.isEmpty()) {
            req.addRequestHeader("Cookie", cookies);
        }
        dm.enqueue(req);
    }

    private String sanitizeSubdir(String raw) {
        if (raw == null) {
            return "";
        }
        String s = raw.trim().replace('\\', '/');
        String[] rawParts = s.split("/");
        StringBuilder sb = new StringBuilder();
        for (String part : rawParts) {
            String clean = part.trim().replaceAll("[<>:\"|?*\\r\\n\\u0000]+", "_");
            while (clean.startsWith(".")) {
                clean = clean.substring(1);
            }
            while (clean.endsWith(".")) {
                clean = clean.substring(0, clean.length() - 1);
            }
            clean = clean.trim();
            if (clean.isEmpty() || ".".equals(clean) || "..".equals(clean)) {
                continue;
            }
            if (clean.length() > 48) {
                clean = clean.substring(0, 48);
            }
            if (sb.length() > 0) {
                sb.append('/');
            }
            sb.append(clean);
        }
        return sb.toString();
    }

    private String guessMimeType(String filename) {
        int dot = filename.lastIndexOf('.');
        if (dot > 0 && dot < filename.length() - 1) {
            String ext = filename.substring(dot + 1).toLowerCase();
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (mime != null && !mime.isEmpty()) {
                return mime;
            }
        }
        return "application/octet-stream";
    }

    private static final class SaveFileWorker implements Runnable {
        private final MainActivity activity;
        private final String srcUrl;
        private final Uri destUri;
        private final String filename;

        SaveFileWorker(MainActivity activity, String srcUrl, Uri destUri, String filename) {
            this.activity = activity;
            this.srcUrl = srcUrl;
            this.destUri = destUri;
            this.filename = filename;
        }

        @Override
        public void run() {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(srcUrl).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(false);
                int code = conn.getResponseCode();
                if (code >= 300 && code < 400) {
                    throw new RuntimeException("已阻止下载重定向 (HTTP " + code + ")");
                }
                if (code < 200 || code >= 300) {
                    throw new RuntimeException("HTTP " + code);
                }
                try (InputStream in = conn.getInputStream();
                     OutputStream out = activity.getContentResolver().openOutputStream(destUri)) {
                    if (out == null) {
                        throw new RuntimeException("无法写入目标文件");
                    }
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                    out.flush();
                }
                activity.mainHandler.post(() -> {
                    activity.performHaptic("success");
                    Toast.makeText(activity, "已保存到所选目录：" + filename, Toast.LENGTH_LONG).show();
                });
            } catch (Throwable t) {
                String msg = t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
                activity.mainHandler.post(() ->
                        Toast.makeText(activity, "保存失败：" + msg, Toast.LENGTH_LONG).show());
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
    }

    private String sanitizeFilename(String filename, String url) {
        String name = filename;
        if (name == null || name.trim().isEmpty()) {
            name = URLUtil.guessFileName(url, null, null);
        }
        if (name == null) {
            name = "download";
        }
        name = name.trim().replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_");
        while (name.startsWith(".")) {
            name = name.substring(1);
        }
        if (name.isEmpty()) {
            name = "download";
        }
        if (name.length() > 120) {
            int dot = name.lastIndexOf('.');
            if (dot > 0 && name.length() - dot <= 16) {
                String ext = name.substring(dot);
                name = name.substring(0, 120 - ext.length()) + ext;
            } else {
                name = name.substring(0, 120);
            }
        }
        return name;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (inOfficialWebMode) {
            if (officialWebView != null && officialWebView.canGoBack()) {
                officialWebView.goBack();
            } else {
                exitOfficialWeb();
            }
            return;
        }
        if (webView == null) {
            super.onBackPressed();
            return;
        }

        webView.evaluateJavascript(
                "(function(){ return typeof window.__handleAndroidBack === 'function' ? !!window.__handleAndroidBack() : false; })()",
                result -> {
                    if ("true".equals(result)) {
                        return;
                    }
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        finish();
                    }
                });
    }

    private void clampFloatingSelectionRect(View view, Rect outRect) {
        if (view == null || outRect == null || inOfficialWebMode) {
            return;
        }
        int viewH = view.getHeight();
        if (viewH <= 0) {
            return;
        }
        if (outRect.left == 0 && outRect.top == 0 && outRect.right == 0 && outRect.bottom == 0) {
            return;
        }
        int safeTop = Math.min(viewH / 2, lastTopPx + dpToPx(64));
        int bottomInset = Math.max(lastNavBottomPx, lastImeBottomPx);
        int safeBottom = Math.max(safeTop, viewH - bottomInset);
        if (outRect.top < safeTop) {
            outRect.top = safeTop;
        }
        if (outRect.bottom > safeBottom) {
            outRect.bottom = safeBottom;
        }
        if (outRect.bottom < outRect.top) {
            outRect.bottom = outRect.top;
        }
    }

    private static final class SafeAreaWebView extends WebView {
        private final MainActivity activity;

        SafeAreaWebView(MainActivity activity) {
            super(activity);
            this.activity = activity;
        }

        @Override
        public ActionMode startActionMode(ActionMode.Callback callback, int type) {
            if (type == ActionMode.TYPE_FLOATING && callback instanceof ActionMode.Callback2) {
                return super.startActionMode(
                        new SafeAreaActionModeCallback2((ActionMode.Callback2) callback, activity),
                        type);
            }
            return super.startActionMode(callback, type);
        }
    }

    private static final class SafeAreaActionModeCallback2 extends ActionMode.Callback2 {
        private final ActionMode.Callback2 delegate;
        private final MainActivity activity;

        SafeAreaActionModeCallback2(ActionMode.Callback2 delegate, MainActivity activity) {
            this.delegate = delegate;
            this.activity = activity;
        }

        @Override
        public boolean onCreateActionMode(ActionMode mode, Menu menu) {
            return delegate.onCreateActionMode(mode, menu);
        }

        @Override
        public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
            return delegate.onPrepareActionMode(mode, menu);
        }

        @Override
        public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
            return delegate.onActionItemClicked(mode, item);
        }

        @Override
        public void onDestroyActionMode(ActionMode mode) {
            delegate.onDestroyActionMode(mode);
        }

        @Override
        public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
            delegate.onGetContentRect(mode, view, outRect);
            activity.clampFloatingSelectionRect(view, outRect);
        }
    }

    private int dpToPx(int dp) {
        return Math.round(dp * getResources().getDisplayMetrics().density);
    }

    private boolean isBridgeCallAllowed() {
        return !inOfficialWebMode && localOriginActive;
    }

    private static String extractOrigin(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            return null;
        }
        try {
            Uri u = Uri.parse(rawUrl.trim());
            if (u == null) {
                return null;
            }
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null || host.isEmpty()) {
                return null;
            }
            String lowerScheme = scheme.toLowerCase();
            if (!"http".equals(lowerScheme) && !"https".equals(lowerScheme)) {
                return null;
            }
            int port = u.getPort();
            if (port == -1) {
                port = "https".equals(lowerScheme) ? 443 : 80;
            }
            return lowerScheme + "://" + host.toLowerCase() + ":" + port;
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean isPairedHostOrigin(String targetUrl) {
        String targetOrigin = extractOrigin(targetUrl);
        if (targetOrigin == null) {
            return false;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_CONFIG_JSON, "");
        if (raw == null || raw.trim().isEmpty()) {
            return false;
        }
        try {
            JSONObject cfg = new JSONObject(raw);
            JSONArray hosts = cfg.optJSONArray("hosts");
            if (hosts != null) {
                for (int i = 0; i < hosts.length(); i++) {
                    JSONObject h = hosts.optJSONObject(i);
                    if (h != null) {
                        String hostOrigin = extractOrigin(h.optString("url", ""));
                        if (targetOrigin.equals(hostOrigin)) {
                            return true;
                        }
                    }
                }
            }
            String legacyUrl = cfg.optString("serverUrl", "");
            if (!legacyUrl.isEmpty() && targetOrigin.equals(extractOrigin(legacyUrl))) {
                return true;
            }
        } catch (Exception ignored) {
            return false;
        }
        return false;
    }

    private static final class AndroidBridge {
        private final MainActivity activity;

        AndroidBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String getConfig() {
            if (!activity.isBridgeCallAllowed()) {
                return "";
            }
            SharedPreferences prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.getString(KEY_CONFIG_JSON, "");
        }

        @JavascriptInterface
        public void saveConfig(String json) {
            if (!activity.isBridgeCallAllowed()) {
                return;
            }
            SharedPreferences prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_CONFIG_JSON, json == null ? "" : json).apply();
        }

        @JavascriptInterface
        public void setSystemBarTheme(boolean isDark) {
            if (!activity.isBridgeCallAllowed()) {
                return;
            }
            activity.mainHandler.post(() -> {
                if (activity.themeSetByWeb && activity.currentIsDark == isDark) {
                    return;
                }
                activity.themeSetByWeb = true;
                activity.applySystemBarTheme(isDark);
            });
        }

        @JavascriptInterface
        public void vibrate(String kind) {
            if (!activity.isBridgeCallAllowed()) {
                return;
            }
            activity.mainHandler.post(() -> activity.performHaptic(kind));
        }

        @JavascriptInterface
        public void copyText(String text) {
            if (!activity.isBridgeCallAllowed()) {
                return;
            }
            activity.mainHandler.post(() -> {
                try {
                    ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText(
                                "Antigravity", text == null ? "" : text));
                    }
                } catch (Exception ignored) {
                    // Clipboard access can be restricted in background.
                }
            });
        }

        @JavascriptInterface
        public void downloadFile(String url, String filename) {
            if (!activity.isBridgeCallAllowed() || !activity.isPairedHostOrigin(url)) {
                return;
            }
            activity.mainHandler.post(() -> activity.enqueueDownload(url, filename));
        }

        @JavascriptInterface
        public void downloadFileWithOptions(String url, String filename, String subdir, boolean askFolder) {
            if (!activity.isBridgeCallAllowed() || !activity.isPairedHostOrigin(url)) {
                return;
            }
            activity.mainHandler.post(() -> activity.enqueueDownloadWithOptions(url, filename, subdir, askFolder));
        }

        @JavascriptInterface
        public void openOfficialWeb() {
            if (!activity.isBridgeCallAllowed()) {
                return;
            }
            activity.mainHandler.post(activity::enterOfficialWeb);
        }

        @JavascriptInterface
        public void openQrScanner() {
            if (!activity.isBridgeCallAllowed()) {
                return;
            }
            activity.mainHandler.post(activity::launchQrScannerWithPermission);
        }

        @JavascriptInterface
        public boolean hasQrScanner() {
            return true;
        }

        @JavascriptInterface
        public String getInitialPairUri() {
            if (!activity.isBridgeCallAllowed()) {
                return "";
            }
            String uri = activity.consumePendingPairUri();
            return uri == null ? "" : uri;
        }

        @JavascriptInterface
        public String getRecentPhotosJson(int limit) {
            if (!activity.isBridgeCallAllowed()) {
                return "{\"granted\":false,\"partial\":false,\"items\":[]}";
            }
            return activity.queryRecentPhotosJson(limit);
        }

        @JavascriptInterface
        public void requestMediaPermission() {
            if (!activity.isBridgeCallAllowed()) {
                return;
            }
            activity.mainHandler.post(activity::requestMediaImagesPermission);
        }

        @JavascriptInterface
        public void uploadMediaImage(long mediaId, String filename, String uploadUrl, String token, String cbId) {
            if (!activity.isBridgeCallAllowed()) {
                activity.deliverNativeUploadDone(cbId, "", "仅允许在本地应用内上传");
                return;
            }
            if (!activity.isPairedHostOrigin(uploadUrl)) {
                activity.deliverNativeUploadDone(cbId, "", "上传目标不在已配对主机列表中");
                return;
            }
            activity.uploadMediaImageAsync(mediaId, filename, uploadUrl, token, cbId);
        }

        @JavascriptInterface
        public String getAppVersion() {
            return APP_VERSION_NAME;
        }

        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }
    }
}
