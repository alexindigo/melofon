# ThumbHash reference vectors

`thumbhash-reference.json` contains fixed inputs and hashes generated in the
c07 test VM by the unmodified official `js/thumbhash.js` from
https://github.com/evanw/thumbhash at
`a652ce6ed691242f459f468f0a8756cda3b90a82` (MIT, Copyright (c) 2023 Evan Wallace).
The full permission notice is in `src/artwork/artwork-codecs-LICENSE.md`.
No production port was imported during vector generation. Both RGBA and hashes
are standard padded base64. Tests need no network or reference implementation.

Upstream has no checked-in test-vector suite. Its official example is
`images/field.jpg` (100x75) from the `gh-pages` commit
`fca1d25d3cd96ee1494775a5adf2e2818f2e8787`. `official-field` pins its RGBA
decoded with the existing node-av `imagePixels` boundary and the official JS
encoder's result for those exact pixels. This avoids making the JPEG decoder
part of a pure encoder test. The website's displayed hash is
`dc e7 11 25 80 78 77 78 7f 88 87 87 78 48 77 78 88 70 fa 3d c0`;
our reference output ends `fa 4d b0` because JPEG decoding differs. It is not
claimed to reproduce the website's unspecified decoder pixel-for-pixel.

The other vectors cover single-pixel red/black/white/translucent/transparent,
square, portrait, landscape, extreme aspect ratios and the 100x100 limit.
Pattern inputs use, for each `(x,y)`, channels
`[(47*x+13*y)%256, (11*x+61*y)%256, (29*x+7*y)%256, alpha]`, where alpha is
`(37*x+19*y)%256` for alpha patterns and 255 otherwise. Keeping reference JS
number precision and operation order matters even for apparently solid colors.

Dominant-color expectations are separate, based on Navidrome
`18205366c8f1a7b91b209b770f5dc966e824d33e`,
`core/artwork/dominant/dominant.go` and its tests. Alpha is explicitly ignored;
stable count ties use bin index as prescribed by the artwork research report.
