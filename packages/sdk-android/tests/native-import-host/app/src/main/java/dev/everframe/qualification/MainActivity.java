// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.qualification;
import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.widget.TextView;
public final class MainActivity extends Activity {
  static { System.loadLibrary("everframe_qualification_client"); }
  public static native String nativeArmFrozen(String directory,String libraries,byte[] key,String epoch);
  public static native String nativeRevoke();
  public static native void nativeFault(boolean abort);
  // Qualification-only access to an internal Kotlin type; no SDK API is exposed.
  public static void revokeOwner(Object owner) { ((dev.everframe.outbox.OutboxStore) owner).revokeSync(); }
  public static String[] receiptIdentities(Object owner) {
    dev.everframe.outbox.OutboxStore store=(dev.everframe.outbox.OutboxStore) owner;
    java.util.ArrayList<String> result=new java.util.ArrayList<>();
    for (dev.everframe.outbox.OutboxToken token:store.snapshotTokens(null)) {
      dev.everframe.outbox.PendingEntry pending=store.readIfPresent(token,null);
      if(pending!=null) result.add(pending.getEntry().getReportId()+":"+pending.getEntry().getIdempotencyKey());
    }
    return result.toArray(new String[0]);
  }
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    if((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0)throw new IllegalStateException("qualification app must be nondebuggable");
    TextView view=new TextView(this);view.setText("Durable native import qualification");setContentView(view);
    Log.i("EVNativeImport","EV_IMPORT process="+android.os.Process.myPid()+" uid="+android.os.Process.myUid()+" nondebuggable=1");
    ImportProbe.configure(this,getIntent().getStringExtra("case"));
    new Thread(()->ImportProbe.run(this,getIntent().getStringExtra("case")),"import-qualification").start();
  }
}
