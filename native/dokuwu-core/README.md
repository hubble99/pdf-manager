# dokuwu-core

Shared native engine for Dokuwu. New features are written here in Rust and
called from Tauri commands, instead of going through the Python sidecar. The
sidecar stays in place for every feature that has not been ported yet.

The crate has no Tauri dependency. `frontend/src-tauri/src/core_bridge.rs`
wraps each operation in a command, and tests call the operations directly.

## Layout

| Module | Purpose |
|---|---|
| `error` | `CoreError`, serialized to the frontend as `{ code, message }` |
| `job` | `JobRunner`: background thread per job, throttled progress, cancel, panic capture |
| `resources` | `worker_count` from free RAM and `MemoryBrake`, so memory use does not grow with file size |
| `ops::checksum` | Streaming SHA-256 of a file; the first operation, used to prove the wiring |
| `ops::pdf_compress` | Compress PDF: JPEG re-encode of ordinary pictures, structural clean-up, batch flushes to a working copy so memory stays flat. CLI check: `cargo run --release --example pdf_compress -- in.pdf out.pdf 60` |

## Rules for new operations

1. Take file paths, never whole files as bytes. Write outputs to a path too.
2. Process one bounded unit at a time (a page, an image, a chunk).
3. Call `ctx.check_cancelled()?` between units and `ctx.report(stage, done, total)`
   for progress.
4. For parallel work, size the pool with `resources::worker_count` and call
   `MemoryBrake::wait_for_headroom` before each unit.
5. Return `CoreResult<T>` where `T: Serialize`; add one `core_*_start` command
   in `core_bridge.rs` that calls `start_job`, and a typed wrapper in
   `frontend/src/api/nativeCore.ts`.

## Frontend contract

- `core_<op>_start(args) -> jobId`
- event `core://job-progress`: `{ jobId, kind, stage, done, total }`
- event `core://job-finished`: `{ jobId, kind, status: "succeeded" | "failed" | "cancelled", result?, error? }`
- `core_job_cancel({ jobId }) -> bool`
- `core_info() -> { version, cpuThreads, totalMemoryBytes, availableMemoryBytes }`

## Tests

```sh
cargo test                      # this crate
cd ../../frontend/src-tauri && cargo test   # Tauri commands and events
cd .. && npx vitest run src/__tests__/nativeCore.test.ts
```
