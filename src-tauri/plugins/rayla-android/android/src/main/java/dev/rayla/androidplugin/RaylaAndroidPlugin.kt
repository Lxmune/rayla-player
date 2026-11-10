package dev.rayla.androidplugin

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Environment
import android.os.StatFs
import android.os.storage.StorageManager
import android.provider.Settings
import android.os.PowerManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class NowPlayingInfo {
    var title: String = ""
    var artist: String = ""
    var album: String = ""
    var artUrl: String? = null
    var durationMs: Long = 0
    var positionMs: Long = 0
    var playing: Boolean = false
    var canPrevious: Boolean = false
    var canNext: Boolean = false
    var liked: Boolean = false
}

@InvokeArg
class SystemBarsArgs {
    /** True when the app behind the bars is light: dark status / navigation icons. */
    var lightBackground: Boolean = false
    /** #rrggbb shown behind the bars where the page doesn't draw (navigation bar). */
    var background: String = "#09090b"
}

@InvokeArg
class UpdateArgs {
    lateinit var info: NowPlayingInfo
}

/** Process-wide link between the plugin (JS bridge) and the media service. */
object Hub {
    @Volatile var info: NowPlayingInfo? = null
    @Volatile var plugin: RaylaAndroidPlugin? = null
    @Volatile var service: MediaService? = null

    /** Reports an action to JS (`media-action`). */
    fun emit(type: String, positionMs: Long? = null) {
        val o = JSObject()
        o.put("type", type)
        if (positionMs != null) o.put("positionMs", positionMs)
        plugin?.trigger("media-action", o)
    }
}

@TauriPlugin
class RaylaAndroidPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private var askedNotifications = false
    private val audio get() = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = outputsChanged()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = outputsChanged()
    }

    private fun outputsChanged() {
        trigger("outputs-changed", JSObject())
    }

    private val connectivity get() = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var lastNetwork: String? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = networkMaybeChanged()
        override fun onLost(network: Network) = networkMaybeChanged()
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = networkMaybeChanged()
    }

    private fun transportOf(caps: NetworkCapabilities?): String = when {
        caps == null -> "none"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        else -> "other"
    }

    /** Active network type; a VPN reports its underlying transport where Android exposes it. */
    private fun currentNetwork(): String {
        return try {
            val cm = connectivity
            val active = cm.activeNetwork ?: return "none"
            val caps = cm.getNetworkCapabilities(active) ?: return "none"
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                // Prefer the underlying (non-VPN) network that is up.
                @Suppress("DEPRECATION")
                val under = cm.allNetworks.mapNotNull { n ->
                    cm.getNetworkCapabilities(n)?.takeIf {
                        !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    }
                }.firstOrNull()
                if (under != null) transportOf(under) else "other"
            } else transportOf(caps)
        } catch (e: Exception) {
            "other"
        }
    }

    private fun networkMaybeChanged() {
        val now = currentNetwork()
        if (now == lastNetwork) return
        lastNetwork = now
        trigger("network-changed", JSObject().apply { put("type", now) })
    }

    @Command
    fun getNetworkType(invoke: Invoke) {
        invoke.resolve(JSObject().apply { put("type", currentNetwork()) })
    }

    @Command
    fun isIgnoringBatteryOptimizations(invoke: Invoke) {
        val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
        invoke.resolve(JSObject().apply { put("value", pm.isIgnoringBatteryOptimizations(activity.packageName)) })
    }

    @Command
    fun requestIgnoreBatteryOptimizations(invoke: Invoke) {
        try {
            val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + activity.packageName))
            try {
                activity.startActivity(direct)
            } catch (e: Exception) {
                activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "battery settings unavailable")
        }
    }

    @Command
    fun listStorageVolumes(invoke: Invoke) {
        val arr = JSArray()
        try {
            val sm = activity.getSystemService(Context.STORAGE_SERVICE) as StorageManager
            val dirs = activity.getExternalFilesDirs(Environment.DIRECTORY_MUSIC)
            for (dir in dirs) {
                if (dir == null) continue
                try {
                    if (!dir.exists()) dir.mkdirs()
                    if (!dir.canWrite()) continue
                    val vol = sm.getStorageVolume(dir)
                    val removable = vol?.isRemovable ?: false
                    val primary = vol?.isPrimary ?: (dir == dirs[0])
                    val label = if (primary && !removable) "Internal storage"
                    else vol?.getDescription(activity)?.takeIf { it.isNotBlank() }
                        ?: if (removable) "SD card" else "Storage"
                    val st = StatFs(dir.path)
                    val o = JSObject()
                    o.put("path", dir.absolutePath)
                    o.put("label", label)
                    o.put("removable", removable)
                    o.put("freeBytes", st.availableBytes)
                    o.put("totalBytes", st.totalBytes)
                    arr.put(o)
                } catch (e: Exception) {
                    // Skip a volume that can't be inspected.
                }
            }
        } catch (e: Exception) {
        }
        invoke.resolve(JSObject().apply { put("volumes", arr) })
    }

    override fun load(webView: WebView) {
        Hub.plugin = this
        try {
            lastNetwork = currentNetwork()
            connectivity.registerDefaultNetworkCallback(networkCallback, main)
        } catch (e: Exception) {
            // No ACCESS_NETWORK_STATE: network events simply don't fire.
        }
        audio.registerAudioDeviceCallback(deviceCallback, main)
    }

    @Command
    fun updateNowPlaying(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(UpdateArgs::class.java)
            Hub.info = args.info
            requestNotificationPermissionOnce()
            val svc = Hub.service
            if (svc != null) {
                main.post { svc.refresh() }
            } else {
                val intent = Intent(activity, MediaService::class.java).setAction(MediaService.ACTION_UPDATE)
                try {
                    ContextCompat.startForegroundService(activity, intent)
                } catch (e: Exception) {
                    // Not allowed to start a foreground service from the background; playback continues.
                }
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "update failed")
        }
    }

    /** Event `insets-changed` with the current `SystemInsets`. */
    fun insetsChanged() {
        trigger("insets-changed", insetsObject())
    }

    private fun insetsObject() = JSObject().apply { put("top", SystemBars.topDp.toDouble()) }

    @Command
    fun getSystemInsets(invoke: Invoke) {
        invoke.resolve(insetsObject())
    }

    @Command
    fun setSystemBars(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SystemBarsArgs::class.java)
            val color = android.graphics.Color.parseColor(args.background)
            main.post {
                val window = activity.window
                window.decorView.setBackgroundColor(color)
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = args.lightBackground
                    isAppearanceLightNavigationBars = args.lightBackground
                }
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "set system bars failed")
        }
    }

    @Command
    fun clearNowPlaying(invoke: Invoke) {
        Hub.info = null
        main.post { Hub.service?.shutdown() }
        invoke.resolve()
    }

    private fun requestNotificationPermissionOnce() {
        if (askedNotifications || Build.VERSION.SDK_INT < 33) return
        askedNotifications = true
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            main.post {
                try {
                    ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
                } catch (e: Exception) {
                    // Denial or failure must not affect playback.
                }
            }
        }
    }

    @Command
    fun listAudioOutputs(invoke: Invoke) {
        val arr = JSArray()
        for (d in audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            val label = typeLabel(d.type) ?: continue
            val product = d.productName?.toString()?.trim().orEmpty()
            val name = if (product.isEmpty()) label else "$product · $label"
            val exclusive = when (d.type) {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                AudioDeviceInfo.TYPE_WIRED_HEADSET,
                AudioDeviceInfo.TYPE_USB_DEVICE,
                AudioDeviceInfo.TYPE_USB_HEADSET,
                AudioDeviceInfo.TYPE_USB_ACCESSORY -> true
                else -> false
            }
            val rates = JSArray()
            val sr = d.sampleRates
            if (sr.isEmpty()) {
                rates.put(44100)
                rates.put(48000)
            } else {
                sr.sorted().forEach { rates.put(it) }
            }
            var depth = 16
            for (e in d.encodings) {
                depth = maxOf(
                    depth,
                    when (e) {
                        AudioFormat.ENCODING_PCM_32BIT, AudioFormat.ENCODING_PCM_FLOAT -> 32
                        AudioFormat.ENCODING_PCM_24BIT_PACKED -> 24
                        else -> 16
                    }
                )
            }
            val o = JSObject()
            o.put("id", d.id.toString())
            o.put("name", name)
            o.put("isDefault", false)
            o.put("supportsExclusive", exclusive)
            o.put("sampleRates", rates)
            o.put("maxBitDepth", depth)
            arr.put(o)
        }
        val res = JSObject()
        res.put("devices", arr)
        invoke.resolve(res)
    }

    private fun typeLabel(type: Int): String? = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired"
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth"
        AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "Bluetooth LE"
        AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, AudioDeviceInfo.TYPE_HDMI_EARC -> "HDMI"
        AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL -> "Line"
        else -> null
    }
}
