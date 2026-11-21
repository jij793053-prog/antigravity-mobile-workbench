package com.antigravity.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Camera;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.io.InputStream;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Ultra-compatible native Android QR Scanner (SurfaceView + Camera NV21 + ZXing offline decoder).
 * Avoids Camera2 multi-surface OEM HAL quirks on Android 8-16 (ColorOS, OriginOS, HyperOS, Pixel)
 * and includes full Throwable protection, torch toggle, tap-to-focus, and gallery QR decoding.
 */
@SuppressWarnings("deprecation")
public class QrScannerActivity extends Activity {

    public static final String EXTRA_QR_TEXT = "qr_text";
    public static final String EXTRA_QR_ERROR = "qr_error";
    private static final int REQ_PICK_IMAGE = 3001;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object cameraLock = new Object();
    private final AtomicBoolean resultDelivered = new AtomicBoolean(false);
    private final AtomicBoolean decodingFrame = new AtomicBoolean(false);
    private final AtomicBoolean isResumed = new AtomicBoolean(false);

    private FrameLayout rootLayout;
    private SurfaceView surfaceView;
    private ScannerOverlayView overlayView;
    private LinearLayout topBar;
    private LinearLayout bottomBar;
    private TextView torchBtn;
    private TextView statusBanner;

    private SurfaceHolder activeHolder;
    private Camera camera;
    private int previewW = 1280;
    private int previewH = 720;
    private int cameraDisplayOrientation = 90;
    private boolean hasTorch = false;
    private volatile boolean torchOn = false;

    private HandlerThread workerThread;
    private Handler workerHandler;
    private HandlerThread decodeThread;
    private Handler decodeHandler;

    private QRCodeReader qrReader;
    private Map<DecodeHintType, Object> decodeHints;
    private int frameCounter = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            setupEdgeToEdgeWindow();
            initQrDecoder();
            buildUi();
            setContentView(rootLayout);
            applyDarkSystemBars();
            setupInsets();
        } catch (Throwable t) {
            failGracefully("初始化扫码页面失败: " + t.getClass().getSimpleName() + " " + t.getMessage());
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        isResumed.set(true);
        torchOn = false;
        updateTorchButtonStyle();
        try {
            startThreads();
            if (activeHolder != null && activeHolder.getSurface() != null && activeHolder.getSurface().isValid()) {
                scheduleOpenCamera(activeHolder);
            }
        } catch (Throwable t) {
            showInlineStatus("启动相机失败: " + t.getMessage() + "（可使用下方相册选图）");
        }
    }

    @Override
    protected void onPause() {
        isResumed.set(false);
        torchOn = false;
        updateTorchButtonStyle();
        releaseCameraSync();
        stopThreads();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        releaseCameraSync();
        stopThreads();
        super.onDestroy();
    }

    private void initQrDecoder() {
        qrReader = new QRCodeReader();
        decodeHints = new EnumMap<>(DecodeHintType.class);
        decodeHints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        decodeHints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        decodeHints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    }

    private void setupEdgeToEdgeWindow() {
        Window window = getWindow();
        if (window == null) {
            return;
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
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
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    private void applyDarkSystemBars() {
        try {
            Window window = getWindow();
            if (window == null) {
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                View decor = window.getDecorView();
                if (decor != null) {
                    decor.post(new ApplyDarkBarsRunnable(window));
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static final class ApplyDarkBarsRunnable implements Runnable {
        private final Window window;

        ApplyDarkBarsRunnable(Window window) {
            this.window = window;
        }

        @Override
        public void run() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController c = window.getInsetsController();
                    if (c != null) {
                        int lightMask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        c.setSystemBarsAppearance(0, lightMask);
                    }
                }
            } catch (Throwable ignored) {
            }
        }
    }

    private void buildUi() {
        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.BLACK);
        rootLayout.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        surfaceView = new SurfaceView(this);
        surfaceView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER));
        surfaceView.getHolder().addCallback(new PreviewHolderCallback(this));
        surfaceView.setOnClickListener(new TapFocusClickListener(this));
        rootLayout.addView(surfaceView);

        overlayView = new ScannerOverlayView(this);
        overlayView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        rootLayout.addView(overlayView);

        // Top Bar
        topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setPadding(dp(16), dp(36), dp(16), dp(10));
        topBar.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));

        TextView closeBtn = makePillButton("← 返回", 0xB81E1F20, 0xFFE3E3E3, 0x44FFFFFF);
        closeBtn.setOnClickListener(new CloseClickListener(this));
        topBar.addView(closeBtn);

        TextView titleView = new TextView(this);
        titleView.setText("扫描配对二维码");
        titleView.setTextColor(0xFFFFFFFF);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f);
        titleView.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        titleView.setGravity(Gravity.CENTER);
        titleView.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        topBar.addView(titleView);

        torchBtn = makePillButton("手电筒", 0xB81E1F20, 0xFFE3E3E3, 0x44FFFFFF);
        torchBtn.setVisibility(View.INVISIBLE);
        torchBtn.setOnClickListener(new TorchClickListener(this));
        topBar.addView(torchBtn);

        rootLayout.addView(topBar);

        // Bottom Bar
        bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.VERTICAL);
        bottomBar.setGravity(Gravity.CENTER_HORIZONTAL);
        bottomBar.setPadding(dp(24), dp(12), dp(24), dp(36));
        bottomBar.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM));

        statusBanner = new TextView(this);
        statusBanner.setTextColor(0xFFFDE293);
        statusBanner.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        statusBanner.setGravity(Gravity.CENTER);
        statusBanner.setVisibility(View.GONE);
        LinearLayout.LayoutParams stLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stLp.bottomMargin = dp(10);
        statusBanner.setLayoutParams(stLp);
        bottomBar.addView(statusBanner);

        TextView hintView = new TextView(this);
        hintView.setText("对准电脑 /pair 页面的二维码即可自动连接");
        hintView.setTextColor(0xE6E3E3E3);
        hintView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        hintView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.bottomMargin = dp(16);
        hintView.setLayoutParams(hintLp);
        bottomBar.addView(hintView);

        TextView galleryBtn = makePillButton("从相册选择二维码", 0xEB282A2C, 0xFFA8C7FA, 0x55A8C7FA);
        galleryBtn.setPadding(dp(22), dp(12), dp(22), dp(12));
        galleryBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        galleryBtn.setOnClickListener(new GalleryClickListener(this));
        bottomBar.addView(galleryBtn);

        rootLayout.addView(bottomBar);
    }

    private TextView makePillButton(String text, int bgColor, int fgColor, int strokeColor) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(fgColor);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        tv.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        tv.setPadding(dp(14), dp(8), dp(14), dp(8));
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setCornerRadius(dp(999));
        bg.setColor(bgColor);
        bg.setStroke(dp(1), strokeColor);
        tv.setBackground(bg);
        return tv;
    }

    private void setupInsets() {
        rootLayout.setOnApplyWindowInsetsListener(new InsetsListener(this));
        rootLayout.requestApplyInsets();
    }

    private static final class InsetsListener implements View.OnApplyWindowInsetsListener {
        private final QrScannerActivity activity;

        InsetsListener(QrScannerActivity activity) {
            this.activity = activity;
        }

        @Override
        public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
            try {
                int topPx;
                int botPx;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    topPx = insets.getInsets(
                            WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout()).top;
                    botPx = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
                } else {
                    topPx = insets.getSystemWindowInsetTop();
                    botPx = insets.getSystemWindowInsetBottom();
                }
                activity.topBar.setPadding(activity.dp(16), topPx + activity.dp(12), activity.dp(16), activity.dp(10));
                activity.bottomBar.setPadding(activity.dp(24), activity.dp(12), activity.dp(24), botPx + activity.dp(28));
            } catch (Throwable ignored) {
            }
            return insets;
        }
    }

    private static final class CloseClickListener implements View.OnClickListener {
        private final QrScannerActivity activity;

        CloseClickListener(QrScannerActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onClick(View v) {
            activity.setResult(Activity.RESULT_CANCELED);
            activity.finish();
        }
    }

    private static final class TorchClickListener implements View.OnClickListener {
        private final QrScannerActivity activity;

        TorchClickListener(QrScannerActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onClick(View v) {
            activity.toggleTorch();
        }
    }

    private static final class GalleryClickListener implements View.OnClickListener {
        private final QrScannerActivity activity;

        GalleryClickListener(QrScannerActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onClick(View v) {
            activity.openGalleryPicker();
        }
    }

    private static final class TapFocusClickListener implements View.OnClickListener {
        private final QrScannerActivity activity;

        TapFocusClickListener(QrScannerActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onClick(View v) {
            activity.triggerAutoFocus();
        }
    }

    private static final class PreviewHolderCallback implements SurfaceHolder.Callback {
        private final QrScannerActivity activity;

        PreviewHolderCallback(QrScannerActivity activity) {
            this.activity = activity;
        }

        @Override
        public void surfaceCreated(SurfaceHolder holder) {
            activity.activeHolder = holder;
            if (activity.isResumed.get()) {
                activity.scheduleOpenCamera(holder);
            }
        }

        @Override
        public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            activity.activeHolder = holder;
        }

        @Override
        public void surfaceDestroyed(SurfaceHolder holder) {
            activity.activeHolder = null;
            activity.releaseCameraSync();
        }
    }

    private void startThreads() {
        if (workerThread == null) {
            workerThread = new HandlerThread("AgyCamWorker");
            workerThread.start();
            workerHandler = new Handler(workerThread.getLooper());
        }
        if (decodeThread == null) {
            decodeThread = new HandlerThread("AgyQrDecode");
            decodeThread.start();
            decodeHandler = new Handler(decodeThread.getLooper());
        }
    }

    private void stopThreads() {
        if (workerThread != null) {
            workerThread.quitSafely();
            try {
                workerThread.join(400);
            } catch (InterruptedException ignored) {
            }
            workerThread = null;
            workerHandler = null;
        }
        if (decodeThread != null) {
            decodeThread.quitSafely();
            try {
                decodeThread.join(400);
            } catch (InterruptedException ignored) {
            }
            decodeThread = null;
            decodeHandler = null;
        }
    }

    private void scheduleOpenCamera(SurfaceHolder holder) {
        if (workerHandler == null) {
            startThreads();
        }
        if (workerHandler != null) {
            workerHandler.post(new OpenCameraRunnable(this, holder));
        }
    }

    private static final class OpenCameraRunnable implements Runnable {
        private final QrScannerActivity activity;
        private final SurfaceHolder holder;

        OpenCameraRunnable(QrScannerActivity activity, SurfaceHolder holder) {
            this.activity = activity;
            this.holder = holder;
        }

        @Override
        public void run() {
            activity.openAndStartPreview(holder);
        }
    }

    private void openAndStartPreview(SurfaceHolder holder) {
        if (!isResumed.get() || resultDelivered.get() || holder == null) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            showInlineStatus("未获得相机权限，可使用下方「从相册选择二维码」");
            return;
        }

        synchronized (cameraLock) {
            if (camera != null) {
                return;
            }
            try {
                int camCount = Camera.getNumberOfCameras();
                if (camCount <= 0) {
                    showInlineStatus("设备未检测到摄像头，请从相册选择二维码");
                    return;
                }
                int chosenId = 0;
                Camera.CameraInfo chosenInfo = new Camera.CameraInfo();
                for (int i = 0; i < camCount; i++) {
                    Camera.CameraInfo info = new Camera.CameraInfo();
                    Camera.getCameraInfo(i, info);
                    if (i == 0) {
                        chosenInfo = info;
                    }
                    if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                        chosenId = i;
                        chosenInfo = info;
                        break;
                    }
                }

                Camera cam = Camera.open(chosenId);
                if (cam == null) {
                    showInlineStatus("无法打开后置摄像头，请稍后重试或从相册选图");
                    return;
                }

                if (!isResumed.get()) {
                    try {
                        cam.release();
                    } catch (Throwable ignored) {
                    }
                    return;
                }

                cameraDisplayOrientation = computeDisplayOrientation(chosenInfo);
                cam.setDisplayOrientation(cameraDisplayOrientation);

                Camera.Parameters params = cam.getParameters();
                List<Camera.Size> sizes = params.getSupportedPreviewSizes();
                Camera.Size best = chooseBestPreviewSize(sizes);
                if (best != null) {
                    previewW = best.width;
                    previewH = best.height;
                    params.setPreviewSize(previewW, previewH);
                } else {
                    Camera.Size cur = params.getPreviewSize();
                    if (cur != null) {
                        previewW = cur.width;
                        previewH = cur.height;
                    }
                }

                List<Integer> formats = params.getSupportedPreviewFormats();
                if (formats != null && formats.contains(ImageFormat.NV21)) {
                    params.setPreviewFormat(ImageFormat.NV21);
                }

                List<String> focusModes = params.getSupportedFocusModes();
                if (focusModes != null) {
                    if (focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                        params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
                    } else if (focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO)) {
                        params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO);
                    } else if (focusModes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                        params.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
                    }
                }

                List<String> flashModes = params.getSupportedFlashModes();
                hasTorch = flashModes != null && flashModes.contains(Camera.Parameters.FLASH_MODE_TORCH);
                torchOn = false;

                try {
                    cam.setParameters(params);
                } catch (Throwable ignored) {
                    // Some OEMs reject combined parameter sets; keep default preview size safely
                    Camera.Size cur = cam.getParameters().getPreviewSize();
                    if (cur != null) {
                        previewW = cur.width;
                        previewH = cur.height;
                    }
                }

                int bufSize = previewW * previewH * ImageFormat.getBitsPerPixel(ImageFormat.NV21) / 8;
                if (bufSize <= 0) {
                    bufSize = previewW * previewH * 3 / 2;
                }
                cam.addCallbackBuffer(new byte[bufSize]);
                cam.addCallbackBuffer(new byte[bufSize]);
                cam.setPreviewCallbackWithBuffer(new FramePreviewCallback(this));

                cam.setPreviewDisplay(holder);
                cam.startPreview();
                camera = cam;

                final boolean showTorch = hasTorch;
                final int pw = previewW;
                final int ph = previewH;
                final int orient = cameraDisplayOrientation;
                mainHandler.post(new PreviewReadyUiRunnable(this, showTorch, pw, ph, orient));
            } catch (Throwable t) {
                releaseCameraLocked();
                showInlineStatus("相机启动受限: " + t.getClass().getSimpleName() + "（可用下方相册选图）");
            }
        }
    }

    private static final class PreviewReadyUiRunnable implements Runnable {
        private final QrScannerActivity activity;
        private final boolean showTorch;
        private final int pw;
        private final int ph;
        private final int orient;

        PreviewReadyUiRunnable(QrScannerActivity activity, boolean showTorch, int pw, int ph, int orient) {
            this.activity = activity;
            this.showTorch = showTorch;
            this.pw = pw;
            this.ph = ph;
            this.orient = orient;
        }

        @Override
        public void run() {
            try {
                if (activity.torchBtn != null) {
                    activity.torchBtn.setVisibility(showTorch ? View.VISIBLE : View.INVISIBLE);
                    activity.updateTorchButtonStyle();
                }
                if (activity.statusBanner != null) {
                    activity.statusBanner.setVisibility(View.GONE);
                }
                activity.adjustSurfaceAspectRatio(pw, ph, orient);
            } catch (Throwable ignored) {
            }
        }
    }

    private void adjustSurfaceAspectRatio(int pw, int ph, int orient) {
        if (rootLayout == null || surfaceView == null || pw <= 0 || ph <= 0) {
            return;
        }
        int rootW = rootLayout.getWidth();
        int rootH = rootLayout.getHeight();
        if (rootW <= 0 || rootH <= 0) {
            return;
        }
        boolean swapped = (orient == 90 || orient == 270);
        float uprightW = swapped ? ph : pw;
        float uprightH = swapped ? pw : ph;
        float previewRatio = uprightW / uprightH;
        float viewRatio = (float) rootW / (float) rootH;

        int targetW;
        int targetH;
        if (viewRatio < previewRatio) {
            // Screen is taller than preview -> fill height, widen width (center-crop)
            targetH = rootH;
            targetW = Math.round(rootH * previewRatio);
        } else {
            targetW = rootW;
            targetH = Math.round(rootW / previewRatio);
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(targetW, targetH, Gravity.CENTER);
        surfaceView.setLayoutParams(lp);
    }

    private int computeDisplayOrientation(Camera.CameraInfo info) {
        int rotation = 0;
        try {
            if (getWindowManager() != null && getWindowManager().getDefaultDisplay() != null) {
                rotation = getWindowManager().getDefaultDisplay().getRotation();
            }
        } catch (Throwable ignored) {
        }
        int degrees = 0;
        switch (rotation) {
            case Surface.ROTATION_90:
                degrees = 90;
                break;
            case Surface.ROTATION_180:
                degrees = 180;
                break;
            case Surface.ROTATION_270:
                degrees = 270;
                break;
            default:
                degrees = 0;
                break;
        }
        if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
            int res = (info.orientation + degrees) % 360;
            return (360 - res) % 360;
        }
        return (info.orientation - degrees + 360) % 360;
    }

    private Camera.Size chooseBestPreviewSize(List<Camera.Size> sizes) {
        if (sizes == null || sizes.isEmpty()) {
            return null;
        }
        Camera.Size best = null;
        long bestDiff = Long.MAX_VALUE;
        long targetArea = 1280L * 720L;
        for (Camera.Size s : sizes) {
            int maxD = Math.max(s.width, s.height);
            int minD = Math.min(s.width, s.height);
            if (maxD > 1600 || minD < 480) {
                continue;
            }
            long diff = Math.abs((long) s.width * s.height - targetArea);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = s;
            }
        }
        return best != null ? best : sizes.get(0);
    }

    private void releaseCameraSync() {
        synchronized (cameraLock) {
            releaseCameraLocked();
        }
    }

    private void releaseCameraLocked() {
        if (camera != null) {
            try {
                camera.setPreviewCallbackWithBuffer(null);
            } catch (Throwable ignored) {
            }
            try {
                camera.stopPreview();
            } catch (Throwable ignored) {
            }
            try {
                camera.release();
            } catch (Throwable ignored) {
            }
            camera = null;
        }
    }

    private void toggleTorch() {
        if (!hasTorch) {
            return;
        }
        synchronized (cameraLock) {
            if (camera == null) {
                return;
            }
            try {
                Camera.Parameters p = camera.getParameters();
                torchOn = !torchOn;
                p.setFlashMode(torchOn ? Camera.Parameters.FLASH_MODE_TORCH : Camera.Parameters.FLASH_MODE_OFF);
                camera.setParameters(p);
                updateTorchButtonStyle();
            } catch (Throwable ignored) {
                torchOn = !torchOn;
            }
        }
    }

    private void triggerAutoFocus() {
        synchronized (cameraLock) {
            if (camera == null) {
                return;
            }
            try {
                camera.autoFocus(null);
            } catch (Throwable ignored) {
            }
        }
    }

    private void updateTorchButtonStyle() {
        if (torchBtn == null) {
            return;
        }
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setCornerRadius(dp(999));
        if (torchOn) {
            bg.setColor(0xFFD3E3FD);
            bg.setStroke(dp(1), 0xFFA8C7FA);
            torchBtn.setTextColor(0xFF041E49);
            torchBtn.setText("手电筒 开");
        } else {
            bg.setColor(0xB81E1F20);
            bg.setStroke(dp(1), 0x44FFFFFF);
            torchBtn.setTextColor(0xFFE3E3E3);
            torchBtn.setText("手电筒");
        }
        torchBtn.setBackground(bg);
    }

    private static final class FramePreviewCallback implements Camera.PreviewCallback {
        private final QrScannerActivity activity;

        FramePreviewCallback(QrScannerActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onPreviewFrame(byte[] data, Camera cam) {
            if (data == null || cam == null) {
                return;
            }
            if (activity.resultDelivered.get() || !activity.decodingFrame.compareAndSet(false, true)) {
                try {
                    cam.addCallbackBuffer(data);
                } catch (Throwable ignored) {
                }
                return;
            }
            Handler dh = activity.decodeHandler;
            if (dh == null) {
                activity.decodingFrame.set(false);
                try {
                    cam.addCallbackBuffer(data);
                } catch (Throwable ignored) {
                }
                return;
            }
            dh.post(new DecodeFrameRunnable(activity, data, cam, activity.previewW, activity.previewH));
        }
    }

    private static final class DecodeFrameRunnable implements Runnable {
        private final QrScannerActivity activity;
        private final byte[] data;
        private final Camera cam;
        private final int w;
        private final int h;

        DecodeFrameRunnable(QrScannerActivity activity, byte[] data, Camera cam, int w, int h) {
            this.activity = activity;
            this.data = data;
            this.cam = cam;
            this.w = w;
            this.h = h;
        }

        @Override
        public void run() {
            try {
                if (!activity.resultDelivered.get()) {
                    String decoded = activity.decodeNv21(data, w, h);
                    if (decoded != null && !decoded.trim().isEmpty()) {
                        activity.deliverQrResult(decoded.trim());
                    }
                }
            } catch (Throwable ignored) {
            } finally {
                activity.decodingFrame.set(false);
                synchronized (activity.cameraLock) {
                    if (activity.camera == cam) {
                        try {
                            cam.addCallbackBuffer(data);
                        } catch (Throwable ignored) {
                        }
                    }
                }
            }
        }
    }

    private String decodeNv21(byte[] data, int w, int h) {
        if (data == null || w <= 0 || h <= 0 || data.length < w * h) {
            return null;
        }
        int step = frameCounter++;
        int mode = step & 3;
        PlanarYUVLuminanceSource source;
        if (mode == 0 || mode == 2) {
            int side = (int) (Math.min(w, h) * 0.78f);
            int left = Math.max(0, (w - side) / 2);
            int top = Math.max(0, (h - side) / 2);
            source = new PlanarYUVLuminanceSource(data, w, h, left, top, side, side, false);
        } else {
            source = new PlanarYUVLuminanceSource(data, w, h, 0, 0, w, h, false);
        }

        String text = tryDecodeSource(source, mode == 3);
        if (text != null) {
            return text;
        }
        if (mode == 3) {
            return tryDecodeSource(source.invert(), false);
        }
        return null;
    }

    private String tryDecodeSource(LuminanceSource source, boolean useGlobal) {
        try {
            BinaryBitmap bmp = new BinaryBitmap(
                    useGlobal ? new GlobalHistogramBinarizer(source) : new HybridBinarizer(source));
            Result r = qrReader.decode(bmp, decodeHints);
            if (r != null && r.getText() != null) {
                return r.getText();
            }
        } catch (Throwable ignored) {
        } finally {
            try {
                qrReader.reset();
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    private void openGalleryPicker() {
        try {
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("image/*");
            startActivityForResult(Intent.createChooser(intent, "选择包含二维码的图片"), REQ_PICK_IMAGE);
        } catch (Throwable e) {
            Toast.makeText(this, "无法打开相册", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_IMAGE) {
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                final Uri uri = data.getData();
                new Thread(new GalleryDecodeRunnable(this, uri), "AgyGalleryQr").start();
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private static final class GalleryDecodeRunnable implements Runnable {
        private final QrScannerActivity activity;
        private final Uri uri;

        GalleryDecodeRunnable(QrScannerActivity activity, Uri uri) {
            this.activity = activity;
            this.uri = uri;
        }

        @Override
        public void run() {
            activity.decodeGalleryImage(uri);
        }
    }

    private void decodeGalleryImage(Uri uri) {
        Bitmap bmp = null;
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream is = getContentResolver().openInputStream(uri)) {
                if (is != null) {
                    BitmapFactory.decodeStream(is, null, bounds);
                }
            }
            int maxDim = Math.max(bounds.outWidth, bounds.outHeight);
            int sample = 1;
            while (maxDim / sample > 1600) {
                sample *= 2;
            }

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
            try (InputStream is = getContentResolver().openInputStream(uri)) {
                if (is != null) {
                    bmp = BitmapFactory.decodeStream(is, null, opts);
                }
            }
            if (bmp == null) {
                postToast("无法读取所选图片");
                return;
            }

            int bw = bmp.getWidth();
            int bh = bmp.getHeight();
            int[] pixels = new int[bw * bh];
            bmp.getPixels(pixels, 0, bw, 0, 0, bw, bh);
            RGBLuminanceSource src = new RGBLuminanceSource(bw, bh, pixels);

            QRCodeReader reader = new QRCodeReader();
            String found = null;
            BinaryBitmap[] candidates = new BinaryBitmap[]{
                    new BinaryBitmap(new HybridBinarizer(src)),
                    new BinaryBitmap(new GlobalHistogramBinarizer(src)),
                    new BinaryBitmap(new HybridBinarizer(src.invert()))
            };
            for (BinaryBitmap candidate : candidates) {
                try {
                    Result r = reader.decode(candidate, decodeHints);
                    if (r != null && r.getText() != null && !r.getText().trim().isEmpty()) {
                        found = r.getText().trim();
                        break;
                    }
                } catch (Throwable ignored) {
                } finally {
                    try {
                        reader.reset();
                    } catch (Throwable ignored) {
                    }
                }
            }

            if (found != null) {
                deliverQrResult(found);
            } else {
                postToast("图片中未识别到二维码");
            }
        } catch (Throwable e) {
            postToast("识别图片失败");
        } finally {
            if (bmp != null && !bmp.isRecycled()) {
                bmp.recycle();
            }
        }
    }

    private void deliverQrResult(String text) {
        if (!resultDelivered.compareAndSet(false, true)) {
            return;
        }
        mainHandler.post(new DeliverResultRunnable(this, text));
    }

    private static final class DeliverResultRunnable implements Runnable {
        private final QrScannerActivity activity;
        private final String text;

        DeliverResultRunnable(QrScannerActivity activity, String text) {
            this.activity = activity;
            this.text = text;
        }

        @Override
        public void run() {
            try {
                Vibrator v;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    VibratorManager vm = (VibratorManager) activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    v = vm != null ? vm.getDefaultVibrator() : null;
                } else {
                    v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
                }
                if (v != null && v.hasVibrator()) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        v.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK));
                    } else {
                        v.vibrate(VibrationEffect.createOneShot(24, 150));
                    }
                }
            } catch (Throwable ignored) {
            }

            Intent out = new Intent();
            out.putExtra(EXTRA_QR_TEXT, text);
            activity.setResult(Activity.RESULT_OK, out);
            activity.finish();
        }
    }

    private void showInlineStatus(String msg) {
        mainHandler.post(new StatusBannerRunnable(this, msg));
    }

    private static final class StatusBannerRunnable implements Runnable {
        private final QrScannerActivity activity;
        private final String msg;

        StatusBannerRunnable(QrScannerActivity activity, String msg) {
            this.activity = activity;
            this.msg = msg;
        }

        @Override
        public void run() {
            if (activity.statusBanner != null) {
                activity.statusBanner.setText(msg);
                activity.statusBanner.setVisibility(View.VISIBLE);
            }
        }
    }

    private void postToast(String msg) {
        mainHandler.post(new ToastRunnable(this, msg));
    }

    private static final class ToastRunnable implements Runnable {
        private final Context ctx;
        private final String msg;

        ToastRunnable(Context ctx, String msg) {
            this.ctx = ctx;
            this.msg = msg;
        }

        @Override
        public void run() {
            Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show();
        }
    }

    private void failGracefully(String err) {
        try {
            Intent out = new Intent();
            out.putExtra(EXTRA_QR_ERROR, err);
            setResult(Activity.RESULT_CANCELED, out);
        } catch (Throwable ignored) {
        }
        finish();
    }

    private int dp(int val) {
        return Math.round(val * getResources().getDisplayMetrics().density);
    }

    /**
     * Material 3 viewfinder scrim using safe 4-quadrant rects + rounded Google-blue corners
     * and animated Google prism scan beam (zero clipOutPath GPU hazards).
     */
    private static final class ScannerOverlayView extends View {
        private final Paint scrimPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint cornerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint beamPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF boxRect = new RectF();
        private final float density;
        private float scanProgress = 0f;
        private long lastFrameNs = 0L;

        ScannerOverlayView(Context context) {
            super(context);
            density = context.getResources().getDisplayMetrics().density;

            scrimPaint.setColor(0x96000000);
            scrimPaint.setStyle(Paint.Style.FILL);

            borderPaint.setColor(0x4DFFFFFF);
            borderPaint.setStyle(Paint.Style.STROKE);
            borderPaint.setStrokeWidth(1.2f * density);

            cornerPaint.setColor(0xFFA8C7FA);
            cornerPaint.setStyle(Paint.Style.STROKE);
            cornerPaint.setStrokeWidth(3.5f * density);
            cornerPaint.setStrokeCap(Paint.Cap.ROUND);

            beamPaint.setStyle(Paint.Style.FILL);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            try {
                int w = getWidth();
                int h = getHeight();
                if (w <= 0 || h <= 0) {
                    return;
                }

                float side = Math.min(w * 0.72f, 272f * density);
                float cx = w * 0.5f;
                float cy = h * 0.45f;
                float r = 22f * density;
                boxRect.set(cx - side / 2f, cy - side / 2f, cx + side / 2f, cy + side / 2f);

                // Safe 4-band scrim around the viewfinder (100% GPU safe on all OEM ROMs)
                canvas.drawRect(0, 0, w, boxRect.top, scrimPaint);
                canvas.drawRect(0, boxRect.bottom, w, h, scrimPaint);
                canvas.drawRect(0, boxRect.top, boxRect.left, boxRect.bottom, scrimPaint);
                canvas.drawRect(boxRect.right, boxRect.top, w, boxRect.bottom, scrimPaint);

                canvas.drawRoundRect(boxRect, r, r, borderPaint);

                float arm = 22f * density;
                float d = r * 2f;
                canvas.drawArc(boxRect.left, boxRect.top, boxRect.left + d, boxRect.top + d, 180, 90, false, cornerPaint);
                canvas.drawLine(boxRect.left + r, boxRect.top, boxRect.left + r + arm, boxRect.top, cornerPaint);
                canvas.drawLine(boxRect.left, boxRect.top + r, boxRect.left, boxRect.top + r + arm, cornerPaint);

                canvas.drawArc(boxRect.right - d, boxRect.top, boxRect.right, boxRect.top + d, 270, 90, false, cornerPaint);
                canvas.drawLine(boxRect.right - r - arm, boxRect.top, boxRect.right - r, boxRect.top, cornerPaint);
                canvas.drawLine(boxRect.right, boxRect.top + r, boxRect.right, boxRect.top + r + arm, cornerPaint);

                canvas.drawArc(boxRect.left, boxRect.bottom - d, boxRect.left + d, boxRect.bottom, 90, 90, false, cornerPaint);
                canvas.drawLine(boxRect.left + r, boxRect.bottom, boxRect.left + r + arm, boxRect.bottom, cornerPaint);
                canvas.drawLine(boxRect.left, boxRect.bottom - r - arm, boxRect.left, boxRect.bottom - r, cornerPaint);

                canvas.drawArc(boxRect.right - d, boxRect.bottom - d, boxRect.right, boxRect.bottom, 0, 90, false, cornerPaint);
                canvas.drawLine(boxRect.right - r - arm, boxRect.bottom, boxRect.right - r, boxRect.bottom, cornerPaint);
                canvas.drawLine(boxRect.right, boxRect.bottom - r - arm, boxRect.right, boxRect.bottom - r, cornerPaint);

                long now = System.nanoTime();
                if (lastFrameNs != 0L) {
                    float dt = Math.min(0.05f, (now - lastFrameNs) / 1_000_000_000f);
                    scanProgress = (scanProgress + dt * 0.45f) % 1f;
                }
                lastFrameNs = now;

                float pad = 16f * density;
                float y = boxRect.top + pad + scanProgress * (boxRect.height() - pad * 2f);
                float beamH = 2.6f * density;
                beamPaint.setShader(new LinearGradient(
                        boxRect.left + pad, y, boxRect.right - pad, y,
                        new int[]{0x004285F4, 0xFF4285F4, 0xFF9B6BFF, 0xFF34A853, 0xFFFBBC05, 0x00FBBC05},
                        new float[]{0f, 0.18f, 0.45f, 0.72f, 0.88f, 1f},
                        Shader.TileMode.CLAMP));
                canvas.drawRoundRect(
                        boxRect.left + pad, y - beamH / 2f,
                        boxRect.right - pad, y + beamH / 2f,
                        beamH, beamH, beamPaint);

                postInvalidateOnAnimation();
            } catch (Throwable ignored) {
            }
        }
    }
}
