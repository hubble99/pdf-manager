# Edit Content engine worker

This crate is the independent, read-only worker foundation for Edit Content V1.
It is not registered with FastAPI or Edit Canvas.

The worker requires explicit `--pdfium-library`, `--workspace-root`, and
`--source-file` paths. Before loading PDFium, the
worker verifies the pinned Linux x86_64 Chromium/8035 library SHA-256 recorded by
the phase-1 engine manifest. Missing, unreadable, or mismatched libraries fail
startup before any request is read.

Each session copies the source into an ownership-marked private workspace with
separate working, checkpoint, and staging areas. The immutable source and first
checkpoint are hash-verified; native document handles are closed before an owned
workspace is removed. Startup orphan cleanup is restricted to direct children
with the exact owner and session marker.

stdin and stdout use length-prefixed JSON frames: a four-byte unsigned
big-endian payload length followed by one UTF-8 JSON envelope. stdout is reserved
for protocol frames; sanitized diagnostics go to stderr. Execution is serial on
the thread that owns PDFium, with a two-request waiting queue and command-specific
timeouts from the frozen phase-1 acceptance policy.

Resource/font inspection is delegated through an explicit read-only companion
command (`--inspector-program` plus repeatable `--inspector-arg`). If the command
is absent, fails, or returns an unsupported result, `inspect` fails closed. The
companion receives only the private source path and cannot act as a writer or a
second editing model.

After `open`, `inspect` returns the versioned native-object discovery snapshot.
Its opaque target IDs are scoped to the current worker instance, revision, and
snapshot. Read-only `hitTest` and `validateTextRange` inspect operations consume
that snapshot; `render` returns a bounded JPEG produced by PDFium. Unsupported
page objects remain visible in the native render but are reported as view-only,
and these operations never create a mutation command.

Example locked verification under the WSL environment holding the pinned engine:

```sh
EDIT_CONTENT_TEST_PDFIUM_PATH=/home/user-dhoni/pdfium/lib/libpdfium.so \
  cargo test --locked
```

## Phase-5 components under development

The library now has a private regeneration adapter (`replacement`) and a
saved/reopened evidence verifier (`verification`). Empty results explicitly
remove only the selected TextObject; `set_text("")` is not used for deletion.
The adapter captures the accepted-checkpoint baseline before mutation and
returns an unverified candidate. Verification is a separate step. Neither step
is connected to a public mutation route or advances accepted worker state.

The Python Content feature contains immutable transition contracts and an
isolated Windows commit store. Its file/fault tests use synthetic bytes and
do not replace native PDF integrity tests. Worker handoff, complete resource
proof/corpus coverage, full preparation-budget accounting, failed-request
reconciliation, and end-to-end checkpoint/history integration are still gates.
The internal prepared-result handshake must be reconciled with the frozen
reply contract before wiring these components together. These components do
not mean that phase 5 is complete or production mutation is enabled.

Public backend routing and packaging remain later tasks.
