use serde_json::Value;
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"))
        .join("pdfium-artifacts.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("read pinned PDFium artifact manifest"),
    )
    .expect("parse pinned PDFium artifact manifest");
    let build = manifest["buildIdentity"]
        .as_str()
        .expect("PDFium build identity is pinned");
    let wrapper = manifest["wrapperVersion"]
        .as_str()
        .expect("PDFium wrapper version is pinned");
    assert_eq!(build, "154.0.8035.0", "unexpected PDFium build identity");
    assert_eq!(wrapper, "0.9.4", "unexpected pdfium-render wrapper version");

    let os = env::var("CARGO_CFG_TARGET_OS").expect("target operating system");
    let arch = env::var("CARGO_CFG_TARGET_ARCH").expect("target architecture");
    let target = match (os.as_str(), arch.as_str()) {
        ("windows", "x86_64") => "windows-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        _ => panic!("Edit Content has no pinned PDFium artifact for {os}-{arch}"),
    };
    let pin = &manifest["targets"][target];
    let library_hash = pin["librarySha256"]
        .as_str()
        .expect("target PDFium library hash is pinned");
    assert_eq!(library_hash.len(), 64, "invalid PDFium SHA-256 pin");
    let runtime_build = build.strip_suffix(".0").unwrap_or(build);

    println!("cargo:rustc-env=PDFIUM_BUILD_IDENTITY={runtime_build}");
    println!("cargo:rustc-env=PDFIUM_RENDER_VERSION={wrapper}");
    println!("cargo:rustc-env=PDFIUM_LIBRARY_SHA256={library_hash}");
}
