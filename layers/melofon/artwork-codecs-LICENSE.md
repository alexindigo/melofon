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

## Dominant color (GPL-3.0-only adaptation)

`dominant-color.ts` adapts Navidrome's
`core/artwork/dominant/dominant.go`: 4-bit bins, top 64, first Oklab cluster
within distance <0.10, largest population and rounded channel means. Packed
RGBA follows the NRGBA path, ignoring alpha. Count ties use ascending bin index.
Source: https://github.com/navidrome/navidrome at commit
`18205366c8f1a7b91b209b770f5dc966e824d33e`. Navidrome is distributed under GPL
version 3; the full text is in `dominant-color-COPYING`. Melofon's
AGPL-3.0-or-later license is in the root `LICENSE`; section 13 covers combination
with GPL version 3 code.
