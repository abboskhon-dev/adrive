package dev.adrive.fixture.compose

import android.os.Bundle
import java.util.Locale
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class MainActivity : ComponentActivity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    setContent { Player() }
  }
}

// Same screen as bench/fixture: the elapsed label and progress bar change on every frame, forever.
@Composable
fun Player() {
  var ms by remember { mutableLongStateOf(0L) }
  var taps by remember { mutableIntStateOf(0) }
  LaunchedEffect(Unit) {
    val start = withFrameMillis { it }
    while (true) withFrameMillis { ms = it - start }
  }
  Column(Modifier.padding(start = 24.dp, top = 48.dp, end = 24.dp), horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(String.format(Locale.ROOT, "%d:%02d.%03d", ms / 60000, ms / 1000 % 60, ms % 1000), fontSize = 32.sp)
    LinearProgressIndicator(progress = { (ms % 10000) / 10000f }, modifier = Modifier.fillMaxWidth())
    Button(onClick = { taps++ }) { Text("Mute Bass") }
    Text("taps $taps")
    LazyColumn(Modifier.fillMaxWidth()) {
      items(40) { Text("Stem $it", fontSize = 9.sp) }
    }
  }
}
