import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.lang.reflect.InvocationTargetException;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

// No waitForIdle: animations must not block hierarchy inspection.
public class Dump {
  public static void main(String[] args) {
    int status = 0;
    try {
      run(Arrays.asList(args).contains("--all"), Arrays.asList(args).contains("--windows"));
    } catch (Throwable e) {
      while (e instanceof InvocationTargetException && e.getCause() != null) e = e.getCause();
      System.err.println("adrive helper failed (Android " + android.os.Build.VERSION.RELEASE
          + "): " + e + ". Check device compatibility and that no other UI automation session is active.");
      status = 2;
    }
    // app_process can retain Binder threads after the handler thread has stopped.
    System.exit(status);
  }

  static void run(boolean all, boolean windows) throws Exception {
    HandlerThread thread = new HandlerThread("adrive");
    thread.start();
    UiAutomation ua = null;
    boolean connected = false;
    try {
      // Hidden shell entry point, isolated here. Unlike the legacy wrapper's connect(),
      // connect(flags) preserves TalkBack and other running accessibility services.
      Class<?> connection = Class.forName("android.app.IUiAutomationConnection");
      Object binder = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
      ua = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, connection)
          .newInstance(thread.getLooper(), binder);
      UiAutomation.class.getMethod("connect", int.class).invoke(ua,
          UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
      connected = true;
      AccessibilityServiceInfo info = ua.getServiceInfo();
      info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
          | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      if (windows) info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
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
      System.out.println(new JSONObject().put("version", 1).put("windows", result).toString());
    } finally {
      try {
        if (connected) UiAutomation.class.getMethod("disconnect").invoke(ua);
      } finally {
        thread.quitSafely();
        thread.join(1000);
      }
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
