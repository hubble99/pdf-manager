//! Read-only phase-7 baseline diagnostic. Reports unsupported evidence categories,
//! not document text; a successful capture alone is not transaction acceptance.
//! Arguments: PDF path, inspector Python path, backend module directory.
use edit_content_engine::discovery::discover_document;
use edit_content_engine::identity::ObjectRegistry;
use edit_content_engine::resource_inspector::{
    InspectionOutcome, ProcessResourceInspector, ResourceInspector,
};
use edit_content_engine::verification::capture;
use pdfium_render::prelude::*;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = PathBuf::from(&args[1]);
    let library = PathBuf::from(std::env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH").unwrap());
    edit_content_engine::verify_pdfium_library(&library).unwrap();
    let pdfium = Pdfium::new(Pdfium::bind_to_library(library).unwrap());
    let inspector = ProcessResourceInspector::new(PathBuf::from(&args[2]), vec!["-c".into(),
        "import sys; sys.path.insert(0,sys.argv.pop(1)); from features.edit_content.resource_inspector_cli import main; raise SystemExit(main())".into(), args[3].clone()]);
    let InspectionOutcome::Supported(resources) = inspector.inspect(&source) else {
        panic!("unsupported resource inspection");
    };
    let document = pdfium.load_pdf_from_file(&source, None).unwrap();
    let discovery = discover_document(
        &document,
        &resources,
        &mut ObjectRegistry::new("diagnostic"),
        0,
    )
    .unwrap();
    let mut clipped = 0;
    let mut unknown = 0;
    let mut transparent = 0;
    let mut multi_image_pages = 0;
    for (page_index, page) in document.pages().iter().enumerate() {
        let mut images = 0;
        let mut page_clipped = Vec::new();
        let mut page_opaque = Vec::new();
        let mut page_transparent = Vec::new();
        let mut page_unresolved = Vec::new();
        for (object_index, object) in page.objects().iter().enumerate() {
            if let Some(clip) = object.get_clip_path().filter(|clip| !clip.is_empty()) {
                clipped += 1;
                let paths = clip
                    .iter()
                    .map(|path| {
                        path.iter()
                            .map(|segment| {
                                format!(
                                    "{:?}@{:.3},{:.3}:{}",
                                    segment.segment_type(),
                                    segment.x().value,
                                    segment.y().value,
                                    segment.is_close()
                                )
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>();
                page_clipped.push(format!(
                    "{}:{:?}:{:?}",
                    object_index,
                    object.object_type(),
                    paths
                ));
            }
            if let Some(path) = object.as_path_object() {
                if path.has_transparency() {
                    transparent += 1;
                    page_transparent.push(object_index);
                }
            }
            if object.as_image_object().is_some() {
                images += 1;
            }
            if let Some(text) = discovery.text_objects.iter().find(|text| {
                text.page_index as usize == page_index
                    && text.source_scope.object_path == vec![object_index]
            }) {
                if text.font.resource_object.is_none() {
                    page_unresolved.push(object_index);
                }
            } else if object.as_path_object().is_none() && object.as_image_object().is_none() {
                unknown += 1;
                page_opaque.push(format!("{}:{:?}", object_index, object.object_type()));
            }
        }
        if images > 1 {
            multi_image_pages += 1;
        }
        let resource_page = resources["pages"].as_array().and_then(|pages| {
            pages
                .iter()
                .find(|item| item["pageIndex"].as_u64() == Some(page_index as u64))
        });
        println!(
            "page={} clipped={:?} opaque={:?} transparent_paths={:?} images={} unresolved_fonts={:?} preservation_resources={} page_preservation={}",
            page_index,
            page_clipped,
            page_opaque,
            page_transparent,
            images,
            page_unresolved,
            resource_page.is_some_and(|item| item["preservationResources"].is_object()),
            resource_page.is_some_and(|item| item["pagePreservation"].as_str().is_some_and(|hash| hash.len() == 64)),
        );
    }
    println!("pages={} clipped={} opaque={} transparent_paths={} multi_image_pages={} unresolved_fonts={}", document.pages().len(), clipped, unknown, transparent, multi_image_pages,
        discovery.text_objects.iter().filter(|text| text.font.resource_object.is_none()).count());
    drop(document);
    println!(
        "baseline_capture={:?}",
        capture(&pdfium, &source, &inspector, 0).map(|snapshot| snapshot.objects.len())
    );
}
