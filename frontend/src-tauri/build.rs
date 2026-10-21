fn main() {
  // The unit-test executable links the dialog code, which needs Common Controls v6
  // (TaskDialogIndirect). The app gets its manifest from tauri-build; test binaries
  // do not, so without this they fail to start on Windows (0xc0000139).
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
  {
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-test.manifest");
    println!("cargo:rerun-if-changed=windows-test.manifest");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
  }
  tauri_build::build()
}
