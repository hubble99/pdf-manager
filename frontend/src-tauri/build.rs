fn main() {
  // The unit-test executable links the dialog code, which needs Common Controls v6
  // (TaskDialogIndirect). The app gets that from tauri-build's manifest, but test
  // binaries have none and fail to start on Windows (0xc0000139). Cargo has no
  // link-arg kind for unit tests of a lib, so the dependency goes on every MSVC link.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
  {
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
      "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
  }
  tauri_build::build()
}
