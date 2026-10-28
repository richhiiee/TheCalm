# CalmSkip store artwork

Upload `icon-128.png` as the store icon and the two `screenshot-*.png` files as listing screenshots. Both screenshots are 1280×800 RGB PNGs showing the production extension UI with clearly labeled synthetic demonstration playback. No show footage or posters are included.

`icon-source.png` is the original generated artwork. `icon-512.png` is a larger export for future branding. The four runtime PNG sizes are in `extension/icons/` and are included in the extension ZIP.

Regenerate the icon exports and screenshots from this checkout with Node.js, the locked development dependencies, and Chromium:

```sh
node scripts/export-icons.js
node scripts/store-screenshots.js
```

Set `CHROMIUM_PATH` if Chromium is not installed at `/usr/bin/chromium`. These are development tools; the installed extension has no build or browser-tool dependency.
