# Changelog

## [0.3.0] - 2026-11-26

### Players (#17, #18, #19)

- Each household player has its own saved queue, speakers and volume. Edit or copy queues between players, and adjust speakers individually or link them to the player volume.

### Playback (#25, #27, #28, #31, #36, #38)

- Songs play on one continuous timeline: gapless transitions by default, with position and now-playing metadata tied to scheduled playback.
- Set crossfade to 0-13 seconds per player. It applies only when songs change naturally, not when you skip, seek or stop.
- Fixed playback freezing partway through long songs, including MP3 and FLAC.

### AirPlay (#29, #30, #33, #35, #41)

- Several players can play at once on separate AirPlay streams, as long as they use different speakers.
- A physical speaker with a known hardware ID keeps one entry across rediscovery and address changes.
- Fixed silent playback when starting on an idle Apple TV.
- New AirPlay speakers start at 25/100 by default. Admins can change `airplay.defaultSpeakerVolume` without changing saved speaker levels.

### Library and artwork (#16, #20, #40)

- Genre filters match all genre tags, not just the first. Album selection and totals respect the selected music folder.
- A background Worker computes artwork placeholders (ThumbHash) and dominant colors.

### Reliability and testing (#21, #22, #23, #24, #26, #32, #34, #37, #39)

- Shutdown retries pending saves and cleans up background work. Playback commands stay tied to the items they target, and native AirPlay diagnostics are retained during polling.
- Local development and GitHub CI share a reproducible dev container. CI runs native tests from clean checkouts and tests media playback in real Chromium.

**Known limits:** Chromium's native HLS player still fails to resume a paused video while its playlist is growing (tracked in `todos/hls-event-chromium-resume.md`).

[Full changes since 0.2.0](https://github.com/alexindigo/melofon/compare/v0.2.0...v0.3.0)

## [0.2.0] - 2026-11-05

- Expanded `/api/v1` library browsing with search totals, seeded random pages, sorting and catalog revisions.
- Added household now playing, explicit listen reports, session-negotiated song streams and authenticated video HLS with audio and caption choices.
- Added versioned artwork, ThumbHash placeholders and dominant colors, plus speaker discovery, management and saved AirPlay pairing.
- Added web radio and URL playback through AirPlay, including live station titles, reconnects and Home Assistant announcements via the OwnTone-compatible API.

## [0.1.0] - 2026-10-25

- First stage of Melofon's `/api/v1`: first-run setup, users and sessions, preferences and live events.
- Added administration for settings, libraries, scans and plugins, plus server status and logs. Core admin routes are loopback-only.
