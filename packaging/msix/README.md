# Dokuwu for the Microsoft Store (MSIX)

`build-msix.ps1` packs the Tauri build into the Store package. The package holds exactly what the
installer installs: `app.exe`, `edit-content\` (the Edit Content worker and PDFium) and `legal\`
(the license and the third-party notices). Store images come from `docs\brand\store\Assets`.

## Build

1. Build the app on Windows (see "Build from source" in the main README):

   ```powershell
   . native\dokuwu-core\windows\build-env.ps1
   cd frontend
   npm ci
   npm run tauri:build
   ```

   The MSI ends up in `frontend\src-tauri\target\release\bundle\msi\` (or under `CARGO_TARGET_DIR`).

2. Pack it with the values from Partner Center > Product management > Product identity:

   ```powershell
   cd packaging\msix
   .\build-msix.ps1 -Version 2.0.0.0 `
                    -IdentityName "hubble99.Dokuwu" `
                    -Publisher "CN=386DE0B9-C4EC-460D-9AD6-816F1A61442D" `
                    -PublisherDisplayName "hubble99" `
                    -Msi <path to Dokuwu_2.0.0_x64_en-US.msi>
   ```

   Output: `Dokuwu_2.0.0.0_x64.msix`, unsigned (Partner Center signs it on upload). The version must
   be `X.Y.Z.0`: the Store reserves the last number.

3. Upload the `.msix` in Partner Center, then fill the listing from `listing\`.

## Local test

`-TestSign` also writes a throwaway self-signed copy to `test-cert\`. Install it for a quick
sideload test, and never upload it. `build\`, `test-cert\` and `*.msix` are not committed.

## License

Dokuwu is under the GNU AGPL v3 or later, and so is the package. Do not add terms that restrict
copying, changing or reverse engineering (AGPL section 10). `listing\partner-center-fill.md` has
the license text to paste into Partner Center.

## Files

- `AppxManifest.template.xml`: manifest template (`build-msix.ps1` fills the `{{...}}` tokens).
- `build-msix.ps1`: the build script. Staging goes to `build\` and is safe to delete.
- `listing\`: Store listing text (English, Indonesian) and the Partner Center answers.
