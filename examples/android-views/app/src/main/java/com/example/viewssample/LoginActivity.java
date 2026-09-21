// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// LoginActivity — inflates login_screen.xml which exercises:
//   • TXSensitiveView container around password + OTP fields
//   • android:inputType="textPassword" auto-detect
package com.example.viewssample;

import android.os.Bundle;
import android.widget.Button;

import androidx.appcompat.app.AppCompatActivity;

import com.traceitx.TraceItX;
import com.traceitx.config.ReportResult;

public class LoginActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.login_screen);

        Button btn = findViewById(R.id.openReporter);
        btn.setOnClickListener(v -> {
            TraceItX.report.openAsync(new TraceItX.Callback<ReportResult>() {
                @Override public void onResult(ReportResult value) { finish(); }
                @Override public void onError(Throwable error) { error.printStackTrace(); }
            });
        });

        // Plan 05-09: disable the trigger while the reporter is presenting.
        // Mirrors MainActivity.java line 77 — observe TraceItX.report.isPresenting
        // via the lifecycle-scoped helper so the button greys out during the modal.
        PresentingObserver.observe(this, btn);
    }
}
