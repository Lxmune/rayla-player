package dev.rayla.player

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.rayla.androidplugin.SystemBars

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Light status/navigation icons over the app's near-black background.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(Color.rgb(0x0b, 0x0b, 0x0c))

    // Android WebView doesn't report system bars through CSS env(). The page
    // draws under the status bar (its colours show behind the clock) and keeps
    // clear of it with --sai-top, which the rayla-android plugin hands to JS;
    // sides, navigation bar and keyboard are kept clear by padding the parent.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, 0, bars.right, bars.bottom)
      SystemBars.reportTop(bars.top, resources.displayMetrics.density)
      WindowInsetsCompat.CONSUMED
    }
  }
}
