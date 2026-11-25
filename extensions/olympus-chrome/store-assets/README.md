# Chrome Web Store assets

- `screenshot-1-working.png`, `screenshot-2-control.png`, `screenshot-3-private.png`: 1280×800 Store screenshots.
- `promo-tile-440x280.png`: the small promo tile.
- The Store icon is `../icons/icon-128.png`: 96 px artwork with 16 px transparent padding.

## How they were made
Each image is a render of the HTML in `src/`, made with Chrome for Testing in headless mode. The page in screenshots 1 and 2 runs the real `overlay.js`, so the edge glow, cursor and status card are the extension's actual UI. The browser frame around it (tabs, address bar, toolbar dot) is drawn in HTML. Screenshot 3 uses a real Settings screenshot taken from the app.

To regenerate, run from this folder:
`"<Chrome for Testing>" --headless=new --allow-file-access-from-files --window-size=1280,800 --virtual-time-budget=2500 --screenshot=out.png "file://$PWD/src/store.html#v1"` (use `#v2` or `#v3` for the others, and `src/tile.html` at 440×280 for the tile)
