import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

// No waitForIdle: animations must not block hierarchy inspection.
public class Dump {
  static final String SOCKET = "adrive";
  static HandlerThread thread;
  static UiAutomation ua;
  static boolean connected;
  static long lastRequest;

  public static void main(String[] args) {
    List<String> flags = Arrays.asList(args);
    int status = 0;
    try {
      // Android 17's accessibility client builds a Handler on the main looper.
      if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
      if (flags.contains("--serve")) {
        serve(args[1], Long.parseLong(args[2]) * 1000);
      } else {
        connect();
        System.out.println(snapshot(flags.contains("--all"), flags.contains("--windows")));
      }
    } catch (Throwable e) {
      System.err.println("adrive helper failed (Android " + android.os.Build.VERSION.RELEASE
          + "): " + cause(e) + ". Check device compatibility and that no other UI automation session is active.");
      status = 2;
    } finally {
      disconnect();
    }
    // app_process can retain Binder threads after the handler thread has stopped.
    System.exit(status);
  }

  static Throwable cause(Throwable e) {
    while (e instanceof InvocationTargetException && e.getCause() != null) e = e.getCause();
    return e;
  }

  static void connect() throws Exception {
    thread = new HandlerThread("adrive");
    thread.start();
    // Hidden shell entry point, isolated here. Unlike the legacy wrapper's connect(),
    // connect(flags) preserves TalkBack and other running accessibility services.
    Class<?> connection = Class.forName("android.app.IUiAutomationConnection");
    Object binder = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
    ua = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, connection)
        .newInstance(thread.getLooper(), binder);
    UiAutomation.class.getMethod("connect", int.class).invoke(ua,
        UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    connected = true;
  }

  static synchronized void disconnect() {
    try {
      if (connected) UiAutomation.class.getMethod("disconnect").invoke(ua);
    } catch (Throwable ignored) {
    } finally {
      connected = false;
      if (thread != null) thread.quitSafely();
    }
  }

  // One JSON request line and one JSON reply line per connection.
  static void serve(String hash, long idleMs) throws Exception {
    LocalServerSocket server = bind();
    connect();
    lastRequest = SystemClock.elapsedRealtime();
    Thread watchdog = new Thread(() -> {
      while (true) {
        SystemClock.sleep(500);
        synchronized (Dump.class) {
          if (SystemClock.elapsedRealtime() - lastRequest < idleMs) continue;
          // A live session blocks other automation tools, so it must not outlive its use.
          disconnect();
          System.exit(0);
        }
      }
    });
    watchdog.setDaemon(true);
    watchdog.start();
    while (true) {
      LocalSocket client = server.accept();
      try {
        // adbd forwards as shell; apps on the device must not read the tree through this socket.
        int uid = client.getPeerCredentials().getUid();
        if (uid != 0 && uid != 2000) continue;
        String line = new BufferedReader(new InputStreamReader(client.getInputStream(), "UTF-8")).readLine();
        if (line == null) continue;
        JSONObject request = new JSONObject(line);
        String cmd = request.optString("cmd", "dump");
        String reply;
        boolean exit = false;
        synchronized (Dump.class) {
          if (cmd.equals("stop")) {
            reply = new JSONObject().put("ok", true).toString();
            exit = true;
          } else if (cmd.equals("status")) {
            reply = new JSONObject().put("ok", true).put("pid", android.os.Process.myPid())
                .put("idleSeconds", idleMs / 1000).toString();
          } else if (!hash.equals(request.optString("hash"))) {
            reply = new JSONObject().put("error", "stale").toString();
            exit = true;
          } else {
            try {
              reply = snapshot(request.optBoolean("all"), request.optBoolean("windows"));
            } catch (Throwable e) {
              reply = new JSONObject().put("error", String.valueOf(cause(e))).toString();
            }
            lastRequest = SystemClock.elapsedRealtime();
          }
        }
        OutputStream out = client.getOutputStream();
        out.write((reply + "\n").getBytes("UTF-8"));
        out.flush();
        if (exit) return;
      } catch (IOException | org.json.JSONException ignored) {
      } finally {
        client.close();
      }
    }
  }

  // A replaced helper can still hold the name for a moment while it exits.
  static LocalServerSocket bind() throws Exception {
    for (int i = 0; ; i++) {
      try {
        return new LocalServerSocket(SOCKET);
      } catch (IOException e) {
        if (i == 20) throw e;
        Thread.sleep(100);
      }
    }
  }

  static String snapshot(boolean all, boolean windows) throws Exception {
    clearCache();
    AccessibilityServiceInfo info = ua.getServiceInfo();
    info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
    if (windows) info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    else info.flags &= ~AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    ua.setServiceInfo(info);
    JSONArray result = new JSONArray();
    for (int i = 0; i < 30 && result.length() == 0; i++) {
      if (windows) {
        // Android returns interactive windows in descending Z-order.
        for (AccessibilityWindowInfo window : ua.getWindows()) {
          try {
            AccessibilityNodeInfo root = window.getRoot();
            if (root != null) result.put(window(root, all, window.getId(), window.getType(), window.getLayer()));
          } finally { window.recycle(); }
        }
      } else {
        AccessibilityNodeInfo root = ua.getRootInActiveWindow();
        if (root != null) result.put(window(root, all, root.getWindowId(), -1, 0));
      }
      if (result.length() == 0) Thread.sleep(100);
    }
    if (result.length() == 0) throw new IllegalStateException("no accessible active window");
    return new JSONObject().put("version", 1).put("windows", result).toString();
  }

  // A long-lived connection caches nodes; a snapshot must reflect the screen as it is now.
  static void clearCache() {
    try {
      UiAutomation.class.getMethod("clearCache").invoke(ua);
      return;
    } catch (Throwable ignored) {
    }
    try {
      Class<?> client = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
      client.getMethod("clearCache").invoke(client.getMethod("getInstance").invoke(null));
    } catch (Throwable ignored) {
    }
  }

  static JSONObject window(AccessibilityNodeInfo root, boolean all, int id, int type, int layer) throws Exception {
    String pkg = str(root.getPackageName());
    JSONArray nodes = new JSONArray();
    walk(root, all, nodes);
    return new JSONObject().put("id", id).put("type", type).put("layer", layer)
        .put("package", pkg).put("nodes", nodes);
  }

  static void walk(AccessibilityNodeInfo node, boolean all, JSONArray out) throws Exception {
    if (node == null) return;
    try {
      String text = str(node.getText());
      String desc = str(node.getContentDescription());
      String id = str(node.getViewIdResourceName());
      boolean actionable = node.isClickable() || node.isLongClickable() || node.isScrollable()
          || node.isCheckable() || node.isEditable();
      if (node.isVisibleToUser() && (all || actionable || !text.isEmpty() || !desc.isEmpty() || !id.isEmpty())) {
        Rect r = new Rect();
        node.getBoundsInScreen(r);
        out.put(new JSONObject().put("class", str(node.getClassName()))
            .put("text", text).put("desc", desc).put("id", id)
            .put("clickable", node.isClickable()).put("longClickable", node.isLongClickable())
            .put("scrollable", node.isScrollable()).put("editable", node.isEditable())
            .put("checkable", node.isCheckable()).put("checked", node.isChecked())
            .put("selected", node.isSelected()).put("enabled", node.isEnabled())
            .put("x", r.centerX()).put("y", r.centerY())
            .put("left", r.left).put("top", r.top).put("right", r.right).put("bottom", r.bottom));
      }
      // A container can be invisible while exposing visible descendants.
      for (int i = 0; i < node.getChildCount(); i++) walk(node.getChild(i), all, out);
    } finally { node.recycle(); }
  }

  static String str(CharSequence s) { return s == null ? "" : s.toString(); }
}
