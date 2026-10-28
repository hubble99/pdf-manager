# How Dokuwu is built

Dokuwu is a Windows desktop app: a small **Tauri** shell around a **React** interface, with all the
document work done by a **Rust core**. There is no server and no network access; the only other process
is the Edit Content worker.

```
┌─────────────────────────── Dokuwu (app.exe) ───────────────────────────┐
│  WebView2                       Tauri commands                          │
│  React + TypeScript   ──────▶   frontend/src-tauri/src/core_*.rs        │
│  (frontend/src)       ◀──────   events: job progress / finished         │
│                                      │                                  │
│                                      ▼                                  │
│                             native/dokuwu-core  (Rust)                  │
│                       MuPDF · image · own PDF/DOCX writers              │
└──────────────────────────────────────┬─────────────────────────────────┘
                                       │ length-prefixed JSON over stdin/stdout
                                       ▼
                    edit-content-engine.exe  +  pdfium.dll  (Edit Content only)
```

## The interface (`frontend/`)

- `src/pages/` has one page per tool; `src/features/<tool>/` holds its state, helpers and API calls.
- `src/config/features.ts` is the single registry of tools. The sidebar and the Home cards both read it.
- `src/api/` wraps the Tauri commands. Long jobs go through `runCoreJob` (`api/nativeCore.ts`): a
  `core_<tool>_start` command returns a job id, then `core://job-progress` and `core://job-finished`
  events report progress, the result or an error, and a job can be cancelled.
- Files are named by their **path on disk**, chosen with the system dialog or dropped on the window.
  The interface never holds a whole PDF in memory.
- `src/i18n/`: English strings are the keys; `id.ts` holds the Indonesian text, `en.ts` the friendlier English wording.
- `src/components/icons/`: the feature icons, drawn as glossy document sheets that follow the theme.
- Four themes (Light, Dark, Dusty Rose, Steel Blue) are CSS variables in `src/index.css`.

## The core (`native/dokuwu-core`)

A plain Rust crate with no Tauri dependency, so every operation can be tested and run from the command line
(`examples/`). Its rules:

1. Take paths, never whole files as bytes, and write results to a path.
2. Work on one bounded unit at a time (a page, a picture, a chunk).
3. Check for cancellation and report progress between units.
4. Size parallel work from free memory (`resources`), so memory use does not grow with the size of the file.
5. Never overwrite: results go to the Downloads folder under a free name (`naming`).

`job` runs each job on its own thread and turns a panic into an error, instead of taking the app down.
`ops/` has one module per tool; see the table in `native/dokuwu-core/README.md`.

## Edit Content

Editing existing PDF text is the risky part, so it is isolated and fail-closed:

- `native/edit-content-engine` is a separate process that uses **PDFium** to regenerate the edited text. A crash
  or a hang there cannot corrupt the app, and it has no network access.
- A change is never published until the regenerated PDF has been **reopened and compared** with the original:
  the pages, fonts, graphics and every other text object must be unchanged. If that cannot be proven, the edit is refused.
- The host (`ops/edit_content` in the core) is the only commit authority. It stores checked bytes in a private workspace
  and switches them in with one atomic record, so history, undo and redo never see a half-written state.
- Details: `native/edit-content-engine/README.md`.

## Tests

| What | How |
|---|---|
| Rust core | `cargo test --locked --manifest-path native/dokuwu-core/Cargo.toml` |
| Edit Content engine | `EDIT_CONTENT_TEST_PDFIUM_PATH=<libpdfium> cargo test --locked` in `native/edit-content-engine` |
| Tauri commands | `cargo test` in `frontend/src-tauri` |
| Interface | `npm test`, `npx tsc -b` and `npm run lint` in `frontend` |

Real documents are never committed. The Edit Content survey (`tests/uat_survey.rs`) reads a folder of PDFs you point it at.

## Packaging

`npm run tauri:build` makes the installers. `packaging/msix/` turns that build into the Microsoft Store package.
`scripts/brand/` regenerates the icons, and `scripts/generate_third_party_notices.py` the license list.
