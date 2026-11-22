# Player

A music player for your phone, in the style of Apple Music and Spotify, that streams **directly from your NAS**. You don't need Plex or a media server. The app reads tags, artwork and lyrics from your files and does everything else on the phone: smart transitions, BPM detection, volume leveling and EQ.

**Open it:** https://dsogh.github.io/player/

---

## Install on your phone

1. Open **https://dsogh.github.io/player/** in Chrome (Android / Surface Duo) or Safari (iPhone).
2. Android: tap **⋮ → Add to Home screen → Install**. iPhone: tap **Share → Add to Home Screen**.
3. Launch it from the home screen. It runs full screen, appears in your lock-screen and Bluetooth controls, and keeps playing with the screen off.

To look around before connecting your NAS, tap **Try the demo library**. It generates songs with real tempos, fade-outs and silences, so you can hear the smart and beat-matched transitions.

---

## Connect your NAS

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
* **Smart:** analyzes each song's intro and outro. Fade-outs get blended, dead air is trimmed, hard endings get a tight cut, and soft intros start under the previous song.
* **Beat-matched mixing:** when two songs have similar tempos, the mix starts on the beat, lands the next song on its first beat, and nudges its tempo to match (pitch preserved) before gliding back.
* **Gapless albums:** consecutive tracks of the same album never crossfade (live albums, DJ mixes).
* **Crossfade** (1–12 s, with equal-power, S-curve or linear curves) or **Gapless** (off).
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
* Home (quick picks, mixes, Jump Back In, Recently Added, On Repeat), Albums, Artists, Songs, Genres, Playlists, Liked Songs and Downloaded.
* Full-screen player with an animated artwork background, a draggable queue, synced lyrics, sleep timer, track info, and Lossless / Hi-Res Lossless badges.
* **Downloads** for offline playback.
* Autoplay with similar music when the queue ends, Start Radio from any song, and search with a top result.
* Lock screen, notification, Bluetooth and headphone controls (Media Session).
* Swipe the mini player to skip, swipe the player down to close, long-press anything for options.

**Surface Duo / foldables / tablets**
* Span the app across both screens: library on one side, player on the other, split exactly at the hinge. When the Duo is rotated, the player goes on top and the library on the bottom.

**Settings for everything:** transitions, tempo, controls, queue, leveling, EQ, engine, theme (Dark / Black / Light / Auto), accent color (or dynamic from the artwork), grid size, badges, haptics, preloading, storage, backup/restore and more.

---

## Development

It's plain HTML, CSS and JavaScript modules, with no build step.

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

* `js/tags.js`: tag/artwork parser using HTTP Range requests
* `js/scanner.js`, `js/sources.js`: WebDAV / HTTP directory walking
* `js/engine.js`: two-deck Web Audio engine (transitions, leveling, EQ)
* `js/analysis.js`: BPM, beat grid, silence/fade detection, loudness
* `sw.js`: service worker (offline app, NAS auth proxy, seeking, downloads)
* `js/ui/*`: views, now playing, settings, dual-screen
