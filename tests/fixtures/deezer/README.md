# Deezer public response fixtures

Captured on 2026-10-21 UTC inside the dedicated g9 test VM, with the real
Deezer plugin running through Melofon's isolated Worker and approved network
service. One well-known artist: The Beatles (Deezer artist 1). Seven bounded
requests, all HTTP 200, including the artist photo download. No user account,
API key or personal data was used.

`search.json` keeps the first public artist object; `related.json` keeps the
first three related artists; `top.json` keeps the first three songs and their
public id/title/duration/artist/album fields. Unused playback preview tokens
and contributors are omitted. `biography.json` keeps only GraphQL data, with
diagnostic extensions omitted. `auth.json` replaces the anonymous JWT with an
explicitly synthetic token; no live token is retained. Values in the public
artist/song/biography objects are unchanged.

Tests derive synthetic homonyms, case variants, placeholders, optional ISRC,
quota and error responses from these recorded shapes. Those are deliberate
test scenarios, not claims of additional live requests. HTTP image replay
uses the existing repository JPEG fixture, so tests remain offline and do not
redistribute the remote artist photo.

The live photo URL and all image URLs in the recorded artist/album objects
used `cdn-images.dzcdn.net`. The manifest requests that exact CDN hostname.
