package com.htmlapk.converter;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.webkit.WebResourceRequest;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

public class MainActivity extends Activity {

    private WebView webView;

    private static final int FILE_CHOOSER_REQUEST = 1001;

    private android.webkit.ValueCallback<Uri[]> fileUploadCallback;

    private boolean allowStorage = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String websiteUrl = getIntent().getStringExtra("website_url");

        boolean fullscreen =
                getIntent().getBooleanExtra("fullscreen", false);

        boolean allowScreenshots =
                getIntent().getBooleanExtra("allow_screenshots", true);

        allowStorage =
                getIntent().getBooleanExtra("allow_storage", false);

        if (fullscreen) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        }

        if (!allowScreenshots) {
            getWindow().setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE
            );
        }

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {

                Uri uri = request.getUrl();

                if ("http".equalsIgnoreCase(uri.getScheme())
                        || "https".equalsIgnoreCase(uri.getScheme())) {
                    return false;
                }

                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {

            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    android.webkit.ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {

                if (!allowStorage) {
                    Toast.makeText(
                            MainActivity.this,
                            "Storage access is disabled.",
                            Toast.LENGTH_SHORT
                    ).show();

                    return false;
                }

                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }

                fileUploadCallback = filePathCallback;

                try {
                    Intent intent = fileChooserParams.createIntent();
                    startActivityForResult(
                            intent,
                            FILE_CHOOSER_REQUEST
                    );
                } catch (Exception e) {
                    fileUploadCallback = null;
                    Toast.makeText(
                            MainActivity.this,
                            "Unable to open file picker.",
                            Toast.LENGTH_SHORT
                    ).show();

                    return false;
                }

                return true;
            }
        });

        if (allowStorage) {
            webView.setDownloadListener(new DownloadListener() {
                @Override
                public void onDownloadStart(
                        String url,
                        String userAgent,
                        String contentDisposition,
                        String mimeType,
                        long contentLength) {

                    try {
                        String fileName = URLUtil.guessFileName(
                                url,
                                contentDisposition,
                                mimeType
                        );

                        DownloadManager.Request request =
                                new DownloadManager.Request(Uri.parse(url));

                        String cookies =
                                CookieManager.getInstance().getCookie(url);

                        if (cookies != null) {
                            request.addRequestHeader("Cookie", cookies);
                        }

                        request.addRequestHeader(
                                "User-Agent",
                                userAgent
                        );

                        request.setTitle(fileName);
                        request.setDescription("Downloading file...");
                        request.setMimeType(mimeType);

                        request.setNotificationVisibility(
                                DownloadManager.Request
                                        .VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                        );

                        request.setDestinationInExternalFilesDir(
                                MainActivity.this,
                                Environment.DIRECTORY_DOWNLOADS,
                                fileName
                        );

                        DownloadManager manager =
                                (DownloadManager) getSystemService(
                                        DOWNLOAD_SERVICE
                                );

                        manager.enqueue(request);

                        Toast.makeText(
                                MainActivity.this,
                                "Download started.",
                                Toast.LENGTH_SHORT
                        ).show();

                    } catch (Exception e) {
                        Toast.makeText(
                                MainActivity.this,
                                "Download failed.",
                                Toast.LENGTH_SHORT
                        ).show();
                    }
                }
            });
        }

        if (websiteUrl != null && !websiteUrl.trim().isEmpty()
                && (websiteUrl.startsWith("https://")
                || websiteUrl.startsWith("http://"))) {

            webView.loadUrl(websiteUrl);

        } else {
            webView.loadUrl("file:///android_asset/index.html");
        }
    }

    @Override
    protected void onActivityResult(
            int requestCode,
            int resultCode,
            Intent data) {

        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST) {

            if (fileUploadCallback == null) {
                return;
            }

            Uri[] results = null;

            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];

                    for (int i = 0; i < count; i++) {
                        results[i] =
                                data.getClipData().getItemAt(i).getUri();
                    }

                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }

            fileUploadCallback.onReceiveValue(results);
            fileUploadCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (fileUploadCallback != null) {
            fileUploadCallback.onReceiveValue(null);
            fileUploadCallback = null;
        }

        if (webView != null) {
            webView.destroy();
            webView = null;
        }

        super.onDestroy();
    }
}
