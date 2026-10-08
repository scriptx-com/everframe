// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.qualification;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.system.Os;
import android.util.Log;
import android.widget.TextView;
import java.io.File;
public final class MainActivity extends Activity {
  static { System.loadLibrary("everframe_qualification_client"); }
  private static native String nativeStatus();
  private static native String nativeArm(String directory,String libraries,int failureMode);
  private static native String nativeRevoke();
  private static native void nativeFault(boolean abort);
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);if((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0)throw new IllegalStateException("debuggable host is not qualified");Log.i("EVNativeQualification","EV_RELEASE nondebuggable=1 uid="+android.os.Process.myUid());TextView view=new TextView(this);setContentView(view);
    String requested=getIntent().getStringExtra("case");
    if(requested==null){view.setText(nativeStatus());return;}
    if(!requested.equals("off")&&!requested.equals("ready-fail")&&!requested.equals("extra-fd")&&!requested.equals("segv")&&!requested.equals("abort")&&!requested.equals("revoke")){view.setText("unknown qualification case");return;}
    File directory=new File(getFilesDir(),"qualification");directory.mkdir();
    try {Os.chmod(directory.getPath(),0700);}catch(Exception error){throw new RuntimeException(error);}
    String status=requested.equals("off")?nativeStatus():nativeArm(directory.getPath(),getApplicationInfo().nativeLibraryDir,requested.equals("ready-fail")?1:requested.equals("extra-fd")?2:0);
    view.setText(status);if(requested.equals("revoke"))view.setText(nativeRevoke());
    new Handler(Looper.getMainLooper()).postDelayed(()->{Log.i("EVNativeQualification","EV_FAULT "+requested+" client="+android.os.Process.myPid());nativeFault(requested.equals("abort"));},1500);
  }
}
