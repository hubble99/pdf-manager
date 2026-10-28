# Dokuwu 2.0.0: Partner Center, ready to paste

Product: Dokuwu, Store ID 9NC9W2L2DG15, identity hubble99.Dokuwu
Package to upload: `Dokuwu_2.0.0.0_x64.msix` (see the README in this folder)

## 1. Pricing and availability
- Markets: all (default)
- Discoverability: make this product available and discoverable in the Store
- Pricing: Free, no free trial

## 2. Properties
- Category: Productivity
- Does this product access, collect, or transmit personal information? **No.**
  Dokuwu processes the files the user opens on the device and sends nothing anywhere.
  If you prefer the cautious answer (it opens user documents), choose Yes and give the privacy policy URL; the policy covers it.
- Privacy policy URL: https://hubble99.github.io/pdf-manager/privacy.html
- Website: https://github.com/hubble99/pdf-manager
- Support contact info: https://github.com/hubble99/pdf-manager/issues
- Product declarations:
  - "Allows purchases but does not use the Microsoft Store commerce system": unchecked (the support page is a voluntary tip, nothing is unlocked)
  - "Customers can install this product to alternate drives": checked
  - "Windows can include this product's data in automatic backups": checked
  - Everything else: unchecked
- System requirements: minimum keyboard and mouse, 4 GB memory

## 3. Age rating (IARC)
Category "Productivity / Utility". Answer **No** to violence, sexual content, language, controlled substances,
gambling, user interaction, location sharing, digital purchases and unrestricted internet access.
Expected result: PEGI 3 / ESRB Everyone / IARC 3+.

## 4. Packages
Upload `Dokuwu_2.0.0.0_x64.msix`. Device family: Windows 10/11 Desktop.

## 5. Store listings
Add English (United States) and Indonesian, then paste from `store-listing-en.md` and `store-listing-id.md`.
Images: `docs\brand\store\listing\` (store logo 300x300, box art 1080x1080, hero 2400x1200) and the screenshots
in `docs\assets\` (1366x768 or larger).

## 6. License terms (important)
Dokuwu is free software under the GNU AGPL v3 or later, so do **not** rely on the standard Microsoft
license terms alone: they restrict reverse engineering and redistribution, which the AGPL forbids
(section 10). In "Additional license terms" paste:

```
Dokuwu is free software, licensed under the GNU Affero General Public License, version 3 or
later. You may use, copy, change and share it under the terms of that license. The license text
and the complete source code of this version are at https://github.com/hubble99/pdf-manager
(tag v2.0.0). Dokuwu comes with ABSOLUTELY NO WARRANTY.
```

If Partner Center lets you replace the standard terms with your own, use that text instead.

## 7. Notes for certification
```
Dokuwu is a Tauri (WebView2) desktop app packaged as a full-trust MSIX.
Why runFullTrust: the window process (app.exe) reads and writes the PDF and image files the
user picks anywhere on the PC, and Edit Content starts the bundled helper
edit-content\edit-content-engine.exe (PDFium) as a separate process. There is no local server
and the app never contacts the internet.

No account, sign-in or test credentials are needed. To test: open the app, choose a tool
(for example Merge PDF), add one or more PDF files and run it. Results are saved to the
Downloads folder under a free name; nothing is overwritten.

The optional "Support" page only shows donation QR codes and opens a PayPal tip link in the
default browser on request; nothing in the app is locked behind payment.
Requires the Microsoft Edge WebView2 Runtime (preinstalled on Windows 11).
```
