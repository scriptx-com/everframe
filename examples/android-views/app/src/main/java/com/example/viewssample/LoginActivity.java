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

import dev.everframe.Everframe;
import dev.everframe.config.ReportResult;

public class LoginActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.login_screen);

        Button btn = findViewById(R.id.openReporter);
        btn.setOnClickListener(v -> {
            Everframe.report.openAsync(new Everframe.Callback<ReportResult>() {
                @Override public void onResult(ReportResult value) { finish(); }
                @Override public void onError(Throwable error) { error.printStackTrace(); }
            });
        });

        // Plan 05-09: disable the trigger while the reporter is presenting.
        // Mirrors MainActivity.java line 77 — observe Everframe.report.isPresenting
        // via the lifecycle-scoped helper so the button greys out during the modal.
        PresentingObserver.observe(this, btn);
    }
}
