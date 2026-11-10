package dev.rayla.androidplugin

/**
 * The status bar height the page has to keep clear of. The app draws under the
 * status bar (so its colours show behind the clock); MainActivity reports the
 * inset here from its window-insets listener, which can run before the plugin
 * has loaded, so the value lives in this object and the plugin reads it.
 */
object SystemBars {
    /** Status bar height in CSS px (dp). */
    @Volatile var topDp: Float = 0f
        private set

    fun reportTop(px: Int, density: Float) {
        val dp = if (density > 0f) px / density else px.toFloat()
        if (dp == topDp) return
        topDp = dp
        Hub.plugin?.insetsChanged()
    }
}
