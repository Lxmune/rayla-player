package dev.rayla.androidplugin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.LruCache
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Foreground media service. Audio is produced by the Rust engine; this only
 * owns the MediaSession, the notification, audio focus, the wake lock and the
 * "becoming noisy" receiver, and reports everything to JS through [Hub].
 */
class MediaService : Service() {
    companion object {
        const val ACTION_UPDATE = "dev.rayla.action.UPDATE"
        const val ACTION_PLAY = "dev.rayla.action.PLAY"
        const val ACTION_PAUSE = "dev.rayla.action.PAUSE"
        const val ACTION_NEXT = "dev.rayla.action.NEXT"
        const val ACTION_PREVIOUS = "dev.rayla.action.PREVIOUS"
        const val ACTION_STOP = "dev.rayla.action.STOP"
        const val ACTION_LIKE = "dev.rayla.action.LIKE"
        const val ACTION_DISLIKE = "dev.rayla.action.DISLIKE"
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 7301
        private val artCache = object : LruCache<String, Bitmap>(8) {}
        private val artPool = Executors.newSingleThreadExecutor()
    }

    private lateinit var session: MediaSessionCompat
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var focusRequest: AudioFocusRequest? = null
    private var resumeOnGain = false
    private var noisyRegistered = false
    private var inForeground = false
    private var wasPlaying = false
    private var art: Bitmap? = null
    private var artFor: String? = null
    private var wantedArt: String? = null

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            Hub.emit("noisy")
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                resumeOnGain = false
                Hub.emit("pause")
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                if (Hub.info?.playing == true) resumeOnGain = true
                Hub.emit("pause")
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (resumeOnGain) {
                    resumeOnGain = false
                    Hub.emit("play")
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        Hub.service = this
        createChannel()
        session = MediaSessionCompat(this, "Rayla").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = Hub.emit("play")
                override fun onPause() = Hub.emit("pause")
                override fun onSkipToNext() = Hub.emit("next")
                override fun onSkipToPrevious() = Hub.emit("previous")
                override fun onStop() = Hub.emit("stop")
                override fun onSeekTo(pos: Long) = Hub.emit("seek", pos)
                override fun onCustomAction(action: String?, extras: Bundle?) {
                    when (action) {
                        ACTION_LIKE -> Hub.emit("like")
                        ACTION_DISLIKE -> Hub.emit("dislike")
                    }
                }
            })
            isActive = true
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> Hub.emit("play")
            ACTION_PAUSE -> Hub.emit("pause")
            ACTION_NEXT -> Hub.emit("next")
            ACTION_PREVIOUS -> Hub.emit("previous")
            ACTION_STOP -> Hub.emit("stop")
            ACTION_LIKE -> Hub.emit("like")
            ACTION_DISLIKE -> Hub.emit("dislike")
        }
        if (Hub.info == null) {
            // Nothing to show (e.g. a stale notification after the app was killed).
            if (!inForeground) {
                val n = NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_rayla_stat).setContentTitle("Rayla").build()
                startFg(n)
            }
            shutdown()
            return START_NOT_STICKY
        }
        refresh()
        return START_NOT_STICKY
    }

    private fun startFg(n: Notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
        inForeground = true
    }

    /** Applies [Hub.info] to the session, notification, focus, wake lock and receiver. */
    fun refresh() {
        val info = Hub.info ?: return
        loadArt(info.artUrl)

        val meta = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, info.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, info.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, info.album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, info.durationMs)
        art?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
        session.setMetadata(meta.build())

        var actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP or
            PlaybackStateCompat.ACTION_SEEK_TO
        if (info.canPrevious) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        if (info.canNext) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        val likeIcon = if (info.liked) R.drawable.ic_like_filled else R.drawable.ic_like
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(actions)
                .addCustomAction(ACTION_LIKE, if (info.liked) "Remove from favourites" else "Favourite", likeIcon)
                .addCustomAction(ACTION_DISLIKE, "Not for me", R.drawable.ic_dislike)
                .setState(
                    if (info.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                    info.positionMs,
                    if (info.playing) 1f else 0f
                )
                .build()
        )

        if (info.playing) {
            resumeOnGain = false
            requestFocus()
            acquireWakeLock()
            acquireWifiLock()
            registerNoisy()
        } else {
            if (!resumeOnGain) abandonFocus()
            releaseWakeLock()
            releaseWifiLock()
            unregisterNoisy()
        }

        val n = buildNotification(info)
        if (!inForeground) {
            startFg(n)
        } else {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
        }
        if (wasPlaying && !info.playing) {
            // Keep the notification but let it be swiped away while paused.
            stopForeground(STOP_FOREGROUND_DETACH)
            inForeground = false
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
        }
        wasPlaying = info.playing
    }

    /** Stops foreground, removes the notification and ends the service. */
    fun shutdown() {
        abandonFocus()
        resumeOnGain = false
        releaseWakeLock()
        releaseWifiLock()
        unregisterNoisy()
        stopForeground(STOP_FOREGROUND_REMOVE)
        inForeground = false
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        stopSelf()
    }

    override fun onDestroy() {
        abandonFocus()
        releaseWakeLock()
        releaseWifiLock()
        unregisterNoisy()
        session.isActive = false
        session.release()
        if (Hub.service === this) Hub.service = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Playback continues without the activity; nothing to do.
        super.onTaskRemoved(rootIntent)
    }

    // ----------------------------------------------------------- notification

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    private fun action(icon: Int, title: String, act: String): NotificationCompat.Action {
        val pi = PendingIntent.getService(
            this, act.hashCode(),
            Intent(this, MediaService::class.java).setAction(act),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Action.Builder(icon, title, pi).build()
    }

    private fun buildNotification(info: NowPlayingInfo): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val content = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_rayla_stat)
            .setContentTitle(info.title)
            .setContentText(info.artist)
            .setSubText(info.album)
            .setContentIntent(content)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(info.playing)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
        art?.let { b.setLargeIcon(it) }

        val compact = ArrayList<Int>()
        if (info.canPrevious) {
            b.addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS))
        }
        val playIdx = if (info.canPrevious) 1 else 0
        if (info.playing) {
            b.addAction(action(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE))
        } else {
            b.addAction(action(android.R.drawable.ic_media_play, "Play", ACTION_PLAY))
        }
        if (info.canPrevious) compact.add(0)
        compact.add(playIdx)
        if (info.canNext) {
            b.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
            compact.add(playIdx + 1)
        }
        b.addAction(
            action(
                if (info.liked) R.drawable.ic_like_filled else R.drawable.ic_like,
                if (info.liked) "Remove from favourites" else "Favourite",
                ACTION_LIKE
            )
        )
        b.addAction(action(R.drawable.ic_dislike, "Not for me", ACTION_DISLIKE))
        b.setStyle(
            MediaStyle()
                .setMediaSession(session.sessionToken)
                .setShowActionsInCompactView(*compact.toIntArray())
        )
        return b.build()
    }

    // ------------------------------------------------------------------- art

    private fun loadArt(url: String?) {
        wantedArt = url
        if (url == null) {
            art = null
            artFor = null
            return
        }
        if (url == artFor) return
        val cached = artCache.get(url)
        if (cached != null) {
            art = cached
            artFor = url
            return
        }
        art = null
        artFor = null
        artPool.execute {
            val bmp = fetch(url) ?: return@execute
            artCache.put(url, bmp)
            ContextCompat.getMainExecutor(this).execute {
                if (Hub.service === this && wantedArt == url) {
                    art = bmp
                    artFor = url
                    refresh()
                }
            }
        }
    }

    private fun fetch(url: String): Bitmap? = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 8000
        val bytes = c.inputStream.use { it.readBytes() }
        c.disconnect()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= 600 && bounds.outHeight / (sample * 2) >= 600) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    } catch (e: Exception) {
        null
    }

    // ----------------------------------------------- focus / wake lock / noisy

    private fun requestFocus() {
        if (focusRequest != null) return
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setOnAudioFocusChangeListener(focusListener)
            .build()
        focusRequest = req
        am.requestAudioFocus(req)
    }

    private fun abandonFocus() {
        val req = focusRequest ?: return
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(req)
        focusRequest = null
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rayla:playback").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    @Suppress("DEPRECATION")
    private fun acquireWifiLock() {
        if (wifiLock?.isHeld == true) return
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = wm.createWifiLock(mode, "rayla:playback").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            // Missing permission or no Wi-Fi hardware: streaming still works, just without the lock.
        }
    }

    private fun releaseWifiLock() {
        try {
            wifiLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
        }
        wifiLock = null
    }

    private fun registerNoisy() {
        if (noisyRegistered) return
        ContextCompat.registerReceiver(
            this, noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        noisyRegistered = true
    }

    private fun unregisterNoisy() {
        if (!noisyRegistered) return
        try {
            unregisterReceiver(noisyReceiver)
        } catch (e: Exception) {
        }
        noisyRegistered = false
    }
}
