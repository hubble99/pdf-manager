# Dokuwu brand assets

The logo is a friendly document mascot: folded corner, a second sheet behind it, a smiling face, a waving hand, and a shield with a check mark for "private, on your device".

## Masters

| File | Use |
| --- | --- |
| `dokuwu-logo.svg` | Full mascot on a transparent background. Used from 64 px up. |
| `dokuwu-mark.svg` | Simplified mascot (no arms, legs, text lines or shield). Used at 48 px and below. |

Edit the masters, then run `python scripts/brand/generate_brand_assets.py` (needs Pillow and a Chromium-based browser, for example Edge). It rewrites the Tauri icons, the favicon, the website images and everything in `store/`. Do not edit the PNG, ICO or ICNS files by hand.

The masters have no background plate. On opaque surfaces use the brand navy `#3A4E6E`.

## Microsoft Store (MSIX)

`store/Assets/` holds the package images, named the way MSIX expects (`Square44x44Logo.scale-200.png`, `Square44x44Logo.targetsize-32.png`, `SplashScreen.scale-100.png`, and so on). Copy the folder into the package as `Assets/`, and keep these references in `AppxManifest.xml`:

```xml
<uap:VisualElements
  DisplayName="Dokuwu"
  BackgroundColor="#3A4E6E"
  Square150x150Logo="Assets\Square150x150Logo.png"
  Square44x44Logo="Assets\Square44x44Logo.png">
  <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png"
                   Square71x71Logo="Assets\Square71x71Logo.png"
                   Square310x310Logo="Assets\Square310x310Logo.png" />
  <uap:SplashScreen Image="Assets\SplashScreen.png" />
</uap:VisualElements>
<Properties>
  <Logo>Assets\StoreLogo.png</Logo>
</Properties>
```

The `BackgroundColor` is the tile plate behind the transparent logo.

`store/listing/` holds the Partner Center art: `logo-300x300.png` (store logo), `logo-1080x1080-*.png` (1:1 box art, transparent and on navy) and `hero-2400x1200-navy.png`.
