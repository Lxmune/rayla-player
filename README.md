# Rayla

A minimal music player for [Jellyfin](https://jellyfin.org) with an audiophile signal chain.
Built with Tauri 2 (Rust) and Svelte 5.

> **Status: early / unreleased.** The code is feature-complete for a first version but has not
> yet been tested end to end on every platform. Expect rough edges.

## Features

- **Bit-perfect output**: WASAPI exclusive (Windows), CoreAudio hog mode (macOS), ALSA `hw:`
  devices (Linux), AAudio (Android), automatic sample-rate switching, and a signal-path view
  with a bit-perfect badge.
- **DSP** (all bypassable): parametric EQ with AutoEQ import, FIR convolution, crossfeed,
  resampler + dither, ReplayGain (track/album) with preamp and clip guard.
- **Playback**: true gapless, crossfade (never inside an album), DSD (DoP + PCM fallback),
  original files or server transcodes, offline downloads.
- **Library**: multiple servers, synced lyrics, smart playlists, daily mixes and radio, Jellyfin
  remote-control target, per-track technical info.
- **Integrations**: scrobbling to Jellyfin, ListenBrainz and Last.fm; customizable Discord
  Rich Presence.

## Platforms

| Platform | Status |
| --- | --- |
| Windows (x64) | Release builds (NSIS installer + MSI) |
| macOS (universal) | Release builds (.dmg), unsigned |
| Linux (x64) | Release builds (.deb, .rpm, .AppImage) |
| Android (API 26+) | Release builds (universal APK), unsigned |
| iOS | Planned |

Download builds from the [Releases](../../releases) page.

> macOS builds are not notarized. On first launch, right-click the app and choose **Open**.

> The Android APK is **unsigned** and Android refuses to install it as is. Sign it with your
> own key first, for example:
> `apksigner sign --ks my.jks --out Rayla.apk Rayla_X.Y.Z_android_universal_unsigned.apk`

### Linux notes

- **Audio**: choose "System default" to play through PipeWire / PulseAudio (shared), or pick a
  hardware device (`hw:`) and enable exclusive mode for bit-perfect output. Exclusive mode
  needs the card to be free: other apps playing through it make the open fail, and Rayla
  then falls back to shared mode.
- **Secrets** (server tokens, API keys) are stored in the Secret Service (GNOME Keyring,
  KWallet). Without one, they go to `secrets.json` in the app data directory, readable only
  by your user.

## Setup notes

- **Discord Rich Presence** needs your own Discord Application ID (Settings › Integrations) with
  image assets named `rayla`, `play` and `pause`.
- **Last.fm** scrobbling needs your own Last.fm API key and secret.

## Building from source

Requirements: Rust (stable), Node.js 24, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm ci
npx tauri dev          # run in development
npx tauri build        # build installers for the current OS
```

Linux (Debian / Ubuntu) also needs:

```sh
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev
```

Android: install the Android SDK, NDK 28 and JDK 21, then run
`npx tauri android build --apk`.

### Tests

```sh
cargo test -p rayla_dsp -p rayla_engine
npm run check
npm test
```

## Project layout

- `crates/dsp`: the DSP chain (EQ, convolution, crossfeed, resampler, dither, ReplayGain)
- `crates/engine`: streaming source with disk cache, decoders (symphonia + DSD), audio
  outputs, gapless/crossfade player, Discord IPC
- `src-tauri`: the Tauri app and the Android plugin
- `src`: the Svelte frontend (Jellyfin client, player, settings, UI)

## Releasing

1. Set the same version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Push a tag `vX.Y.Z`. The `release` workflow builds every platform and attaches the files
   to a **draft** release.
3. Review the draft on the Releases tab and publish it.

No repository secrets are needed: macOS and Android builds are unsigned.

## License

[MIT](LICENSE)
