# Edit Content engine worker

The isolated worker process of Edit Content. The host in `dokuwu-core`
(`ops::edit_content`) starts one worker per open document. The worker has no
network access and shares no state with Canvas PDF.

## Starting a worker

The worker needs explicit `--pdfium-library`, `--workspace-root` and
`--source-file` paths. Before it loads PDFium it checks the library's SHA-256
against the pinned build in `pdfium-artifacts.json` (PDFium chromium/8035, from
bblanchon/pdfium-binaries). A missing, unreadable or mismatched library fails
startup before any request is read. `--native-inspector` selects the built-in
resource and font reader (`src/native_inspector/`), which is how the app runs it.

Each session copies the source into an ownership-marked private workspace with
separate working, checkpoint and staging areas. The source and the first
checkpoint are hash-verified, native document handles are closed before an owned
workspace is removed, and start-up orphan cleanup touches only direct children
with the exact owner and session marker.

## Protocol

stdin and stdout carry length-prefixed JSON frames: a four-byte big-endian
payload length followed by one UTF-8 JSON envelope. stdout is reserved for
protocol frames; sanitized diagnostics go to stderr. Requests run serially on the
thread that owns PDFium, with a two-request waiting queue and per-command timeouts.

After `open`, `inspect` returns the versioned discovery snapshot of the page
objects. Its opaque target IDs are scoped to the worker instance, revision and
snapshot. The read-only `hitTest` and `validateTextRange` operations consume that
snapshot, and `render` returns a bounded JPEG produced by PDFium. Unsupported
objects stay visible in the render but are reported as view-only, and none of
these operations can create a mutation.

## Transaction boundary

`replacement` regenerates the selected text in a private copy and returns an
unverified candidate; empty results remove only the selected text object.
`verification` then reopens the saved candidate and proves that nothing else
changed. The worker returns an `edit-content-preparation/v1` result with an opaque
candidate token and hash-bound evidence. Preparation never advances the accepted
state or publishes anything.

The Rust host in `dokuwu-core` is the only commit authority. It resolves the token
inside the owned workspace, rechecks the verified bytes, stores bounded immutable
checkpoints and makes the result visible with one atomic commit-record switch.
History keeps checked bytes, not inverse edits. A failure before the commit keeps
the previous state; a failure after it keeps the recorded outcome and is never replayed.

## Tests

```sh
EDIT_CONTENT_TEST_PDFIUM_PATH=/path/to/libpdfium.so cargo test --locked
```

`EDIT_CONTENT_TEST_PDFIUM_PATH` points at the pinned PDFium library for the
platform (the Linux build is `linux-x86_64` in `pdfium-artifacts.json`).
`tests/uat_survey.rs` (ignored by default) tries one edit per text object of the
PDFs in `EDIT_CONTENT_UAT_DIR` and prints why edits were refused.

## Notices

`notices/` holds the license files that ship with the pinned PDFium build. They
are checked against the hashes in `pdfium-artifacts.json` and are copied into the
installer by `scripts/prepare_edit_content_desktop.ps1`.
