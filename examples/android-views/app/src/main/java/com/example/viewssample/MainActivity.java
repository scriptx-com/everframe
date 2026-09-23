// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MainActivity (Java) — exercises the @JvmStatic public surface of Everframe
// from a pure-Java consumer, including the report.openAsync(Callback) shim
// and the report.isPresenting StateFlow added in Plan 05.1-02.
package com.example.viewssample;

import android.os.Bundle;
import android.widget.Button;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import dev.everframe.Everframe;
import dev.everframe.config.CaptureConfig;
import dev.everframe.config.Environment;
import dev.everframe.config.ReportResult;
import dev.everframe.config.EverframeConfig;

public class MainActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Everframe.start — the @JvmStatic surface lets Java callers omit the .Companion shim.
        // Plan 05.1-02 collapsed BubbleConfig + TriggerConfig away — the constructor now
        // takes the smaller arg list below.
        Everframe.start(
            this,
            new EverframeConfig(
                "views-sample",                                  // appId
                "http://10.0.2.2:8787/api/ingest",               // endpoint
                BuildConfig.EVERFRAME_SDK_KEY,                    // sdkKey
                Environment.development,                          // environment
                /* release */ null,
                CaptureConfig.defaults,
                /* bubble (host-installed hint) */ true,
                /* useDynamicColor */ false,
                /* uiTreeMaxDepth */ 50,
                /* uiTreeMaxNodes */ 2000
            )
        );

        setContentView(R.layout.activity_main);

        Button openLogin = findViewById(R.id.openLogin);
        openLogin.setOnClickListener(v -> {
            startActivity(new android.content.Intent(this, LoginActivity.class));
        });

        Button openReporter = findViewById(R.id.openReporter);
        TextView result = findViewById(R.id.openResult);
        openReporter.setOnClickListener(v -> {
            // report.openAsync(...) — the Java callback shim around the suspend fun open().
            // Demonstrates the Callback<ReportResult> surface reaches Java without
            // a Companion / Continuation hop.
            Everframe.report.openAsync(new Everframe.Callback<ReportResult>() {
                @Override
                public void onResult(ReportResult value) {
                    result.setText("openAsync result: " + value);
                }

                @Override
                public void onError(Throwable error) {
                    result.setText("openAsync error: " + error.getMessage());
                }
            });
        });

        // Plan 05.1-02: disable the trigger button while the reporter is presenting.
        // The Java sample delegates to a tiny Kotlin helper (`PresentingObserver.kt`)
        // that hides the kotlinx.coroutines suspend-collect interop boilerplate. The
        // helper uses `androidx.lifecycle.lifecycleScope` (NOT `GlobalScope.launch`,
        // per plan-checker W2) so the collect coroutine cancels with the Activity.
        PresentingObserver.observe(this, openReporter);
    }
}
