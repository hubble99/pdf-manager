//! Read-only corpus diagnostic that persists pre/post snapshots outside publication.
use edit_content_engine::discovery::discover_document;
use edit_content_engine::identity::ObjectRegistry;
use edit_content_engine::preflight::PreflightInput;
use edit_content_engine::replacement::prepare_candidate;
use edit_content_engine::resource_inspector::{
    InspectionOutcome, ProcessResourceInspector, ResourceInspector,
};
use edit_content_engine::verification::{capture, compare};
use edit_content_engine::verify_pdfium_library;
use edit_content_engine::workspace::{CancellationToken, SessionWorkspace};
use pdfium_render::prelude::*;
use std::fs;
use std::path::PathBuf;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let source = PathBuf::from(&args[1]);
    let page_index = args[2].parse::<u16>().unwrap();
    let object_index = args[3].parse::<usize>().unwrap();
    let find = &args[4];
    let replacement = &args[5];
    let python = PathBuf::from(&args[6]);
    let backend = PathBuf::from(&args[7]);
    let output = PathBuf::from(&args[8]);
    fs::create_dir_all(&output).unwrap();
    let library = PathBuf::from(std::env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH").unwrap());
    verify_pdfium_library(&library).unwrap();
    let pdfium = Pdfium::new(Pdfium::bind_to_library(library).unwrap());
    let inspector = ProcessResourceInspector::new(
        python,
        vec![
            "-c".into(),
            "import sys; sys.path.insert(0,sys.argv.pop(1)); from features.edit_content.resource_inspector_cli import main; raise SystemExit(main())".into(),
            backend.display().to_string(),
        ],
    );
    let workspace = SessionWorkspace::create(
        &output.join("sessions"),
        &source,
        "corpus-diagnostic",
        &CancellationToken::default(),
    )
    .unwrap();
    let InspectionOutcome::Supported(resources) = inspector.inspect(workspace.source_path()) else {
        panic!("unsupported resource inspection");
    };
    let mut registry = ObjectRegistry::new("corpus-diagnostic");
    let target = {
        let document = pdfium
            .load_pdf_from_file(workspace.source_path(), None)
            .unwrap();
        let discovery = discover_document(&document, &resources, &mut registry, 0).unwrap();
        discovery
            .text_objects
            .into_iter()
            .find(|object| {
                object.page_index == page_index
                    && object.source_scope.object_path == vec![object_index]
            })
            .unwrap()
    };
    let scalar_start = target.text.find(find).unwrap();
    let utf16_start = target.text[..scalar_start].encode_utf16().count();
    let utf16_end = utf16_start + find.encode_utf16().count();
    let input = PreflightInput {
        expected_text: target.text,
        expected_old_text: find.clone(),
        replacement_text: replacement.clone(),
        utf16_start,
        utf16_end,
    };
    let candidate = prepare_candidate(
        &pdfium,
        &workspace,
        &registry,
        0,
        &target.target_id,
        &input,
        &inspector,
    )
    .unwrap();
    let reopened = capture(&pdfium, &candidate.path, &inspector, 0).unwrap();
    fs::write(
        output.join("baseline.json"),
        serde_json::to_vec_pretty(&candidate.baseline).unwrap(),
    )
    .unwrap();
    fs::write(
        output.join("candidate.json"),
        serde_json::to_vec_pretty(&reopened).unwrap(),
    )
    .unwrap();
    fs::copy(&candidate.path, output.join("candidate.pdf")).unwrap();
    println!(
        "compare={:?}",
        compare(&candidate.baseline, &reopened, &candidate.expectation)
    );
}
