# Player

A music player for your phone, in the style of Apple Music and Spotify. **Sign in with Plex** to play the same library Plexamp uses, or stream **straight from a NAS folder** without any server software. Everything else happens on the phone: smart and beat-matched transitions, BPM detection, volume leveling, EQ and synced lyrics.

**Open it:** https://dsogh.github.io/player/

---

## Install on your phone

> **iPhone / CarPlay:** add the app to your Home Screen (below) and open it from there. The lock screen, Control Center and CarPlay then show **Player** with the song, artist, album and cover, instead of "Safari".


1. Open **https://dsogh.github.io/player/** in Chrome (Android / Surface Duo) or Safari (iPhone).
2. Android: tap **⋮ → Add to Home screen → Install**. iPhone: tap **Share → Add to Home Screen**.
3. Launch it from the home screen. It runs full screen, appears in your lock-screen and Bluetooth controls, and keeps playing with the screen off.

To look around before connecting your NAS, tap **Try the demo library**. It generates songs with real tempos, fade-outs and silences, so you can hear the smart and beat-matched transitions.

---

## Sign in with Plex (easiest)

1. Open the app and tap **Sign in with Plex**. A Plex window opens. Approve the device, or enter the 4-letter code at **plex.tv/link** on any device.
2. The app finds your Plex Media Server and connects over Plex's own secure address. It uses your home network when you're home, and remote access or Plex Relay when you're away.
3. Your music library syncs. If you have more than one server or music library, choose them in **Settings → Music Sources → Plex**.

What syncs with Plex:
* **Original files are streamed:** FLAC and hi-res stay lossless, and the player shows **Hi-Res Lossless** for 24-bit/96 kHz tracks.
* **Plex's loudness analysis** is used for volume leveling, the same values Plexamp uses.
* **Lyrics** come from Plex.
* **Loves (♥)** sync both ways.
* **Plex playlists**, including smart playlists, appear in your Library.
* **Plays** count in your Plex history, and the song shows as **Now Playing** in Plex. You can turn this off.

If the app can't connect, make sure **Remote Access** is enabled on the server and **Secure connections** is set to *Preferred* (Plex → Settings → Network).

## Connect your NAS directly (no Plex)

The app runs on GitHub Pages (HTTPS), so the browser needs two things from your NAS:

* an **HTTPS** address (browsers block plain `http://` from an HTTPS site), and
* **CORS** permission for `https://dsogh.github.io`.

### Option A: the ready-made container (recommended, works on any NAS with Docker)

The [`nas/`](nas/) folder has a small [Caddy](https://caddyserver.com) setup. It serves your music folder read-only, behind a password, with the right CORS headers.

```bash
# on the NAS (Synology Container Manager, QNAP Container Station, Unraid, TrueNAS, plain Docker)
cd nas
docker run --rm caddy:2 caddy hash-password --plaintext 'pick-a-password'
#   → paste the hash into MUSIC_HASH in docker-compose.yml (double every $ to $$)
#   → set the music folder path in docker-compose.yml
docker compose up -d
```

**HTTPS with Tailscale (free, also works away from home):** install Tailscale on the NAS and your phone, then on the NAS run:

```bash
tailscale serve --bg 8080
```

The NAS is now at `https://<nas-name>.<your-tailnet>.ts.net/`. In the app go to **Settings → Music Source → HTTP folder** and enter that address, user `music`, and your password. Tap **Save & Scan**.

> Don't want Tailscale? Any reverse proxy with a real certificate works, e.g. Synology's built-in reverse proxy with a Let's Encrypt cert pointing at port 8080.

### Option B: Synology's built-in WebDAV

1. **Package Center → WebDAV Server**, enable HTTPS (port 5006).
2. **Control Panel → Login Portal → Advanced → Reverse Proxy**: create a rule from your HTTPS hostname to `localhost:5006`, and under **Custom Header** add:
   * `Access-Control-Allow-Origin: https://dsogh.github.io`
   * `Access-Control-Allow-Headers: Authorization, Range, Depth, Content-Type, Accept`
   * `Access-Control-Allow-Methods: GET, HEAD, OPTIONS, PROPFIND`
   * `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges`
3. In the app choose **WebDAV**, enter `https://your-host/music/` (your music share) and your DSM user.

QNAP, TrueNAS, Nextcloud, `rclone serve webdav` and nginx `autoindex_format json` also work. They just need HTTPS and the same CORS headers. If something's off, **Test Connection** tells you what failed: wrong password, folder not found, or not reachable (usually HTTPS or CORS).

Your password is stored only on your phone. It's sent only to your NAS, never anywhere else.

### How your files are read

* **Formats:** MP3, FLAC, ALAC/AAC (M4A), OGG Vorbis, Opus, WAV. The app reads only the bytes it needs (tags and artwork), not whole files.
* **Artwork:** embedded art, or `cover.jpg` / `folder.jpg` / `front.jpg` in the album folder.
* **Lyrics:** put `Song Name.lrc` next to `Song Name.flac` for synced lyrics, or embed lyrics in the tags.
* **Playlists:** `.m3u` / `.m3u8` files on the NAS are imported automatically.
* **Untagged files** fall back to `Artist/Album/01 - Title.ext`.
* Synology `@eaDir`, `#recycle` and similar folders are skipped.

---

## Features

**Transitions** (tap the button under the controls to switch)
* **DJ Mix** (default) analyzes every song's tempo, beat grid, **musical key**, energy, intro and outro, then picks a move for each transition. Choose a **DJ style**: *Auto*, *Beat match* or *Word play*.
  * **Word play:** when a song sings the next song's title (found in synced lyrics), that line echoes out and the next song drops in right on its own title line.
  * **DJ blend:** a long (16–32 beat), phrase-aligned, beat-matched overlay. Both songs **meet at a middle tempo** (each can move up to 12%, pitch preserved), a live **beat lock** keeps the kicks within a few milliseconds, the incoming bass is held back, and the basses **swap** halfway while the outgoing song is high-passed away.
  * **Fade under:** when the song fades out on its own, the next one slides in underneath it.
  * **Echo out:** when a song ends hard, its last beats ring out through a tempo-synced echo as the next song drops in.
  * **Filter sweep:** when tempos clash, the outgoing song is low-passed away while the next one opens up from a high-pass.
  * **Harmonic mixing:** keys are shown in Camelot notation (e.g. 8A). Blends run long when keys agree and quick when they clash.
  * Silence is trimmed, and albums stay gapless.
* **DJ Order:** reorders your queue, a playlist or an album into a DJ set, with smooth tempo steps, compatible keys, a rising energy flow and word-play links. It's under the **DJ Order** button in the queue, the mix button next to Play/Shuffle, or *Play as DJ Set* in the menus.
* **Lyrics** come from a `.lrc` file, Plex or tags, and otherwise are looked up online by title and artist (LRCLIB).
* **Gapless albums:** consecutive tracks of the same album never crossfade (live albums, DJ mixes).
* **Crossfade** (classic, like Spotify; 1–16 s with equal-power, S-curve or linear curves) or **Gapless** (off).
* The player shows what's coming: *"Next: … · Beat-matched 124 BPM in 0:12"*.

**BPM**
* Detected on the phone (automatic, on demand, or off). BPM tags in your files are used when present. **Tap Tempo** lets you set it yourself.
* **BPM flow shuffle** orders shuffled songs so tempos change smoothly.
* Auto-generated **Chill / Groove / Energy** mixes by tempo.

**Sound**
* Volume leveling: ReplayGain (Smart / Track / Album) plus on-device loudness for untagged files.
* 10-band EQ with presets, a limiter, mono output and pre-amp.
* Soft pause and fade-on-skip.

**Library and player**
* Sign in with Plex, a NAS folder, or both at once: everything shows up in one library.
* Swipe the artwork left or right to skip. With the *Enhanced* audio engine, the artwork pulses gently with the beat.
* Album pages are tinted with the colors of their artwork. A History tab lists what you've played.
* Home (quick picks, mixes, Jump Back In, Recently Added, On Repeat), Albums, Artists, Songs, Genres, Playlists, Liked Songs and Downloaded.
* Full-screen player with an animated artwork background, a draggable queue, synced lyrics, sleep timer, track info, and Lossless / Hi-Res Lossless badges.
* **Downloads** for offline playback.
* Autoplay with similar music when the queue ends, Start Radio from any song, and search with a top result.
* Lock screen, notification, Bluetooth and headphone controls (Media Session).
* Swipe the mini player to skip, swipe the player down to close, long-press anything for options.

**iPhone Duo / Surface Duo / foldables**
* **iPhone Duo:** open it and the inner screen splits at the fold, with the library on the left and the player on the right. Rotated, the player is on top and the library below. Closed, the outer screen uses the normal phone layout.
* **Surface Duo / Duo 2:** split exactly at the hinge, using each model's real dimensions.
* Settings → Appearance has *Span over hinge*, *Nudge split* and *Hinge gap* if you want to adjust it.

**Settings for everything:** transitions, tempo, controls, queue, leveling, EQ, engine, theme (Dark / Black / Light / Auto), accent color (or dynamic from the artwork), grid size, badges, haptics, preloading, storage, backup/restore and more.

---

## Development

It's plain HTML, CSS and JavaScript modules, with no build step.

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

* `js/plex.js`: Plex sign-in (PIN), server discovery and connection racing, library/playlist sync, lyrics, play reporting
* `js/tags.js`: tag/artwork parser using HTTP Range requests
* `js/scanner.js`, `js/sources.js`: WebDAV / HTTP directory walking
* `js/engine.js`: two-deck Web Audio engine (transitions, leveling, EQ)
* `js/analysis.js`: BPM, beat grid, silence/fade detection, loudness
* `sw.js`: service worker (offline app, NAS auth proxy, seeking, downloads)
* `js/ui/*`: views, now playing, settings, dual-screen
