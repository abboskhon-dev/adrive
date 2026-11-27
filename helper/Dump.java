import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
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
  // Bump with any change to the request or reply lines; adrive.mjs sends the same number.
  static final int PROTOCOL = 2;
  static HandlerThread thread;
  static UiAutomation ua;
  static boolean connected;
  static long lastRequest;
  // Counts accessibility events, so a wait can tell whether the screen changed since its last read.
  static final Object events = new Object();
  static long eventCount;

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
    ua.setOnAccessibilityEventListener(event -> {
      synchronized (events) { eventCount++; events.notifyAll(); }
    });
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
            disconnect();
            reply = new JSONObject().put("ok", true).toString();
            exit = true;
          } else if (cmd.equals("status")) {
            reply = new JSONObject().put("ok", true).put("pid", android.os.Process.myPid())
                .put("idleSeconds", idleMs / 1000).toString();
          } else if (!hash.equals(request.optString("hash")) || request.optInt("protocol") != PROTOCOL) {
            disconnect();
            reply = new JSONObject().put("error", "stale").toString();
            exit = true;
          } else if (cmd.equals("change")) {
            // The idle watchdog must not stop the helper while a wait is pending.
            lastRequest = Math.max(lastRequest, SystemClock.elapsedRealtime() + request.optLong("timeoutMs"));
            reply = null;
          } else {
            // Past this line the CLI must not resend: the input may already have happened.
            if (cmd.equals("tap") || cmd.equals("swipe") || cmd.equals("key")) write(client, new JSONObject().put("accepted", true).toString());
            try {
              if (cmd.equals("dump")) reply = snapshot(request.optBoolean("all"), request.optBoolean("windows"));
              else reply = input(cmd, request);
              lastRequest = SystemClock.elapsedRealtime();
            } catch (IllegalArgumentException | Partial e) {
              reply = new JSONObject().put("error", e.getMessage()).toString();
            } catch (Refused e) {
              reply = new JSONObject().put("ok", false).toString();
            } catch (Throwable e) {
              // The connection may be dead; a fresh helper reconnects instead of failing forever.
              disconnect();
              reply = new JSONObject().put("error", String.valueOf(cause(e))).put("restart", true).toString();
              exit = true;
            }
          }
        }
        if (reply == null) {
          // A pending wait must not block the action that would end it.
          LocalSocket waiter = client;
          client = null;
          new Thread(() -> answerChange(waiter, request)).start();
          continue;
        }
        write(client, reply);
        if (exit) return;
      } catch (IOException | org.json.JSONException ignored) {
      } finally {
        if (client != null) client.close();
      }
    }
  }

  static void answerChange(LocalSocket client, JSONObject request) {
    try {
      write(client, new JSONObject().put("seq", awaitChange(request.optLong("seq"), request.optLong("timeoutMs"))).toString());
    } catch (Exception ignored) {
    } finally {
      synchronized (Dump.class) { lastRequest = Math.max(lastRequest, SystemClock.elapsedRealtime()); }
      try { client.close(); } catch (IOException ignored) {}
    }
  }

  static void write(LocalSocket client, String reply) throws IOException {
    OutputStream out = client.getOutputStream();
    out.write((reply + "\n").getBytes("UTF-8"));
    out.flush();
  }

  // Any other count, including one from a previous helper, means the screen may have changed.
  static long awaitChange(long seq, long timeoutMs) throws InterruptedException {
    long end = SystemClock.uptimeMillis() + timeoutMs;
    synchronized (events) {
      for (long left; eventCount == seq && (left = end - SystemClock.uptimeMillis()) > 0; ) events.wait(left);
      return eventCount;
    }
  }

  static String input(String cmd, JSONObject r) throws Exception {
    switch (cmd) {
      case "tap": swipe(r.getInt("x"), r.getInt("y"), r.getInt("x"), r.getInt("y"), 0); break;
      case "swipe": swipe(r.getInt("x1"), r.getInt("y1"), r.getInt("x2"), r.getInt("y2"), r.getLong("ms")); break;
      case "key": {
        String name = r.getString("key");
        int code = name.matches("\\d+") ? Integer.parseInt(name) : KeyEvent.keyCodeFromString(name);
        if (code <= 0) throw new IllegalArgumentException("unknown key " + name);
        long t = SystemClock.uptimeMillis();
        inject(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
        try {
          inject(new KeyEvent(t, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
        } catch (Refused e) { throw new Partial(); }
        break;
      }
      default: throw new IllegalArgumentException("unknown command " + cmd);
    }
    return new JSONObject().put("ok", true).toString();
  }

  // Moves every 10 ms, like `input swipe`; a zero duration is a tap.
  static void swipe(int x1, int y1, int x2, int y2, long ms) throws Exception {
    long down = SystemClock.uptimeMillis();
    touch(MotionEvent.ACTION_DOWN, down, down, x1, y1);
    try {
      for (long t = 10; t < ms; t += 10) {
        SystemClock.sleep(Math.max(0, down + t - SystemClock.uptimeMillis()));
        touch(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(), x1 + (x2 - x1) * t / ms, y1 + (y2 - y1) * t / ms);
      }
      SystemClock.sleep(Math.max(0, down + ms - SystemClock.uptimeMillis()));
      touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x2, y2);
    } catch (Refused e) {
      try { touch(MotionEvent.ACTION_CANCEL, down, SystemClock.uptimeMillis(), x2, y2); } catch (Refused ignored) {}
      throw new Partial();
    }
  }

  static void touch(int action, long down, long time, float x, float y) {
    MotionEvent e = MotionEvent.obtain(down, time, action, x, y, 0);
    e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    try { inject(e); } finally { e.recycle(); }
  }

  // Android refused the event; the connection is fine and the CLI falls back to `input`.
  static class Refused extends RuntimeException {}

  // Refused after DOWN was delivered: replaying it through `input` would act twice.
  static class Partial extends RuntimeException {
    Partial() { super("Android refused the gesture after it started; it was cancelled"); }
  }

  static void inject(android.view.InputEvent e) {
    if (!ua.injectInputEvent(e, true)) throw new Refused();
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
    long seq;
    synchronized (events) { seq = eventCount; }
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
    // No window yet (launch, keyguard) is a state to wait through, not a failure.
    return new JSONObject().put("version", 1).put("windows", result).put("seq", seq).toString();
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
