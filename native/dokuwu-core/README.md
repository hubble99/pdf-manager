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

## Building on Windows

PDF to Word uses the `mupdf` crate, which compiles MuPDF from C source and runs
bindgen. You need Visual Studio Build Tools (C++ workload) and LLVM
(`winget install LLVM.LLVM`). Then, in PowerShell:

```powershell
. native\dokuwu-core\windows\build-env.ps1
cargo test
```

The script sets `LIBCLANG_PATH`, the MSVC toolset (`MUPDF_MSVC_PLATFORM_TOOLSET`,
`v145` for Build Tools 18; edit it for your install), a short `CARGO_TARGET_DIR`,
and `BINDGEN_EXTRA_CLANG_ARGS` with `windows/max_align.h`. That header is needed
because MSVC's C headers do not define `max_align_t`, which `mupdf` 0.8 asserts
on. If a build fails after you change these, delete the `mupdf-sys-*` folder under
the target dir so bindgen runs again. The first build takes 15 minutes or more.
