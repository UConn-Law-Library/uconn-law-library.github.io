package edu.uconn.law.ctstatutes;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_ORIGIN = "https://" + APP_HOST;
    private static final String ASSET_PREFIX = "/assets/";
    private static final String START_URL = APP_ORIGIN + ASSET_PREFIX + "index.html";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.rgb(30, 58, 138));
        getWindow().setNavigationBarColor(Color.rgb(15, 23, 42));

        webView = new WebView(this);
        configureWebView(webView);
        applySystemBarInsets(webView);
        setContentView(webView);

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView ignored,
                    WebResourceRequest request
            ) {
                return loadAsset(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView ignored,
                    WebResourceRequest request
            ) {
                Uri uri = request.getUrl();
                if (isAppAsset(uri)) {
                    return false;
                }
                openExternal(uri);
                return true;
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void applySystemBarInsets(WebView view) {
        view.setOnApplyWindowInsetsListener((target, insets) -> {
            target.setPadding(
                    insets.getSystemWindowInsetLeft(),
                    insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(),
                    insets.getSystemWindowInsetBottom()
            );
            return insets;
        });
    }

    private WebResourceResponse loadAsset(Uri uri) {
        if (!isAppAsset(uri)) {
            return null;
        }

        String path = uri.getPath();
        if (path == null || !path.startsWith(ASSET_PREFIX)) {
            return notFound();
        }

        String assetPath = path.substring(ASSET_PREFIX.length());
        if (assetPath.isEmpty()) {
            assetPath = "index.html";
        }
        if (assetPath.contains("..") || assetPath.startsWith("/")) {
            return notFound();
        }

        try {
            InputStream stream = getAssets().open(assetPath);
            return new WebResourceResponse(mimeType(assetPath), "UTF-8", stream);
        } catch (IOException exception) {
            return notFound();
        }
    }

    private boolean isAppAsset(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
                && APP_HOST.equalsIgnoreCase(uri.getHost())
                && uri.getPath() != null
                && uri.getPath().startsWith(ASSET_PREFIX);
    }

    private WebResourceResponse notFound() {
        InputStream body = new ByteArrayInputStream(
                "Not Found".getBytes(StandardCharsets.UTF_8)
        );
        return new WebResourceResponse(
                "text/plain",
                "UTF-8",
                404,
                "Not Found",
                Collections.emptyMap(),
                body
        );
    }

    private String mimeType(String path) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(path);
        String detected = MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));
        if (detected != null) {
            return detected;
        }
        if ("webmanifest".equals(extension)) {
            return "application/manifest+json";
        }
        return "application/octet-stream";
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null
                || !(scheme.equalsIgnoreCase("http")
                || scheme.equalsIgnoreCase("https")
                || scheme.equalsIgnoreCase("mailto")
                || scheme.equalsIgnoreCase("tel"))) {
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException exception) {
            Toast.makeText(this, R.string.no_external_app, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
