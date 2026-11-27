package dev.adrive.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.os.SystemClock;
import android.view.Choreographer;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.util.Locale;

// A player-like screen: the elapsed label and progress bar change on every frame, forever.
public class MainActivity extends Activity implements Choreographer.FrameCallback {
  static final int ROWS = 40;
  TextView elapsed;
  ProgressBar progress;
  TextView taps;
  int tapCount;
  long start;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER_HORIZONTAL);
    root.setPadding(48, 96, 48, 48);

    elapsed = new TextView(this);
    elapsed.setTextSize(32);
    root.addView(elapsed);

    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setMax(1000);
    root.addView(progress, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 48));

    Button mute = new Button(this);
    mute.setAllCaps(false);
    mute.setText("Mute Bass");
    mute.setOnClickListener(v -> taps.setText("taps " + ++tapCount));
    root.addView(mute);

    taps = new TextView(this);
    taps.setText("taps 0");
    root.addView(taps);

    EditText note = new EditText(this);
    note.setHint("Note");
    note.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
    root.addView(note, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

    // Enough labelled nodes that reading the tree costs something.
    LinearLayout grid = new LinearLayout(this);
    grid.setOrientation(LinearLayout.VERTICAL);
    for (int i = 0; i < ROWS; i++) {
      TextView row = new TextView(this);
      row.setText("Stem " + i);
      row.setTextSize(9);
      grid.addView(row);
    }
    root.addView(grid);

    setContentView(root);
    start = SystemClock.uptimeMillis();
  }

  @Override protected void onResume() {
    super.onResume();
    Choreographer.getInstance().postFrameCallback(this);
  }

  @Override protected void onPause() {
    super.onPause();
    Choreographer.getInstance().removeFrameCallback(this);
  }

  @Override public void doFrame(long nanos) {
    long ms = SystemClock.uptimeMillis() - start;
    elapsed.setText(String.format(Locale.ROOT, "%d:%02d.%03d", ms / 60000, ms / 1000 % 60, ms % 1000));
    progress.setProgress((int) (ms % 10000 / 10));
    Choreographer.getInstance().postFrameCallback(this);
  }
}
