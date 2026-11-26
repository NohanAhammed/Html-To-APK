
package com.htmlapk.converter;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.ArrayList;

public class MainActivity extends Activity {

    private WebView webView;

    private static final int FILE_CHOOSER_REQUEST = 1001;

    private ValueCallback<Uri[]> fileUploadCallback;

    private boolean allowStorage = false;
    private boolean fullscreen = false;
    private boolean allowScreenshots = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        fullscreen = getIntent().getBooleanExtra("fullscreen", false);
        allowScreenshots = getIntent().getBooleanExtra(
                "allow_screenshots", true
        );
        allowStorage = getIntent().getBooleanExtra(
                "allow_storage", false
        );

        if (fullscreen) {
            getWindow().setFlags(
                    WindowManager.LayoutParams.FLAG_FULLSCREEN,
                    WindowManager.LayoutParams.FLAG_FULLSCREEN
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
        settings.setDatabaseEnabled(true);

        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);

        settings.setLoadsImagesAutomatically(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebViewClient(new WebViewClient() {

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view,
                    WebResourceRequest request
            ) {
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {

                // Cancel any previous file selection.
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }

                fileUploadCallback = filePathCallback;

                try {
                    Intent intent;

                    // Use Android's file picker.
                    try {
                        intent = fileChooserParams.createIntent();
                    } catch (Exception e) {
                        intent = new Intent(Intent.ACTION_GET_CONTENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("*/*");
                    }

                    // Make sure the picker can select files.
                    if (intent.getType() == null) {
                        intent.setType("*/*");
                    }

                    startActivityForResult(
                            intent,
                            FILE_CHOOSER_REQUEST
                    );

                    return true;

                } catch (ActivityNotFoundException e) {

                    fileUploadCallback.onReceiveValue(null);
                    fileUploadCallback = null;

                    Toast.makeText(
                            MainActivity.this,
                            "No file picker available.",
                            Toast.LENGTH_SHORT
                    ).show();

                    return true;

                } catch (Exception e) {

                    fileUploadCallback.onReceiveValue(null);
                    fileUploadCallback = null;

                    Toast.makeText(
                            MainActivity.this,
                            "Unable to open file picker.",
                            Toast.LENGTH_SHORT
                    ).show();

                    return true;
                }
            }
        });

        // Handle downloads.
        webView.setDownloadListener(
                new DownloadListener() {

                    @Override
                    public void onDownloadStart(
                            String url,
                            String userAgent,
                            String contentDisposition,
                            String mimeType,
                            long contentLength
                    ) {

                        if (!allowStorage) {
                            Toast.makeText(
                                    MainActivity.this,
                                    "Downloads are disabled for this app.",
                                    Toast.LENGTH_SHORT
                            ).show();
                            return;
                        }

                        try {
                            DownloadManager.Request request =
                                    new DownloadManager.Request(
                                            Uri.parse(url)
                                    );

                            request.setMimeType(mimeType);

                            request.addRequestHeader(
                                    "User-Agent",
                                    userAgent
                            );

                            request.setNotificationVisibility(
                                    DownloadManager.Request
                                            .VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                            );

                            request.setDestinationInExternalFilesDir(
                                    MainActivity.this,
                                    Environment.DIRECTORY_DOWNLOADS,
                                    Uri.parse(url).getLastPathSegment()
                            );

                            DownloadManager manager =
                                    (DownloadManager) getSystemService(
                                            DOWNLOAD_SERVICE
                                    );

                            if (manager != null) {
                                manager.enqueue(request);

                                Toast.makeText(
                                        MainActivity.this,
                                        "Download started.",
                                        Toast.LENGTH_SHORT
                                ).show();
                            }

                        } catch (Exception e) {
                            Toast.makeText(
                                    MainActivity.this,
                                    "Download failed.",
                                    Toast.LENGTH_SHORT
                            ).show();
                        }
                    }
                }
        );

        // Load the APK's website.
        String startUrl = getIntent().getStringExtra("website_url");

        if (startUrl != null && !startUrl.trim().isEmpty()) {
            webView.loadUrl(startUrl);
        } else {
            webView.loadUrl("file:///android_asset/index.html");
        }
    }

    @Override
    protected void onActivityResult(
            int requestCode,
            int resultCode,
            Intent data
    ) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST) {

            if (fileUploadCallback == null) {
                return;
            }

            Uri[] results = null;

            if (resultCode == Activity.RESULT_OK && data != null) {

                // Support selecting multiple files.
                if (data.getClipData() != null) {

                    int count = data.getClipData().getItemCount();
                    ArrayList<Uri> uris = new ArrayList<>();

                    for (int i = 0; i < count; i++) {
                        Uri uri = data.getClipData()
                                .getItemAt(i)
                                .getUri();

                        if (uri != null) {
                            uris.add(uri);
                        }
                    }

                    results = uris.toArray(new Uri[0]);

                } else if (data.getData() != null) {

                    // Support selecting one file.
                    results = new Uri[]{
                            data.getData()
                    };
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
