# Artwork codec provenance

## ThumbHash (MIT)

`thumbhash.ts` is an encoder-only TypeScript port of `js/thumbhash.js` from
https://github.com/evanw/thumbhash at commit
`a652ce6ed691242f459f468f0a8756cda3b90a82`. Changes: types, naming, formatting,
explicit boolean-to-integer conversion and input validation. Math and operation
order are retained. No decoder or runtime dependency is included.

Copyright (c) 2023 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Dominant color (Melofon's own implementation)

`dominant-color.ts` is original Melofon code under the root `LICENSE`. It counts
exact RGB colours and ranks fixed-radius Oklab neighbourhoods by pixel population,
with packed-RGB tie-breaking and population-weighted sRGB output. No colour bins,
top-colour cap or progressive cluster merging are used.
Fully transparent pixels are excluded. Every pixel with nonzero alpha counts
once with its straight RGB, without compositing; all-transparent input returns
an empty string.

`color-math.ts` implements the published sRGB-to-Oklab formulas by Bjorn Ottosson,
using his matrices updated 2021-01-25:
https://bottosson.github.io/posts/oklab/. Ottosson makes the conversion available
in the public domain and alternatively under MIT:
https://bottosson.github.io/misc/License.txt. This implementation uses the
public-domain grant.

The idea of ranking by population alone was inspired by Atmosphera's muted
palette (`Scripts/python/src/theming/lib/palette.py`); its
`Services/Files/FileIconColors.js` also illustrates using Oklab. These were read
for ideas only. No code was shared or ported from Atmosphera or Navidrome.
