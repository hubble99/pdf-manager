use tauri::Manager;

mod core_bridge;
mod core_canvas;
mod core_convert;
mod core_edit_content;
mod core_housekeeping;
mod core_pdf_compress;
mod core_qr_barcode;
mod core_merge;
mod core_organize;
mod core_protect;
mod core_pdf_render;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(core_bridge::CoreState::default())
    .manage(core_pdf_render::RenderState::default())
    .manage(core_convert::ThumbState::default())
    .manage(core_organize::OrganizeState::default())
    .manage(core_canvas::FontState::default())
    .invoke_handler(tauri::generate_handler![
      core_bridge::core_info,
      core_bridge::core_checksum_start,
      core_bridge::core_pdf_to_word_start,
      core_bridge::core_image_convert_start,
      core_bridge::core_photo_compress_start,
      core_bridge::core_reveal_path,
      core_bridge::core_file_sizes,
      core_bridge::core_job_cancel,
      core_housekeeping::core_health,
      core_housekeeping::core_clear_temp,
      core_housekeeping::core_open_downloads,
      core_convert::core_pdf_to_image_start,
      core_convert::core_image_to_pdf_start,
      core_convert::core_image_thumbnail,
      core_merge::core_pdf_merge_start,
      core_merge::core_pdf_inspect,
      core_merge::core_pdf_describe,
      core_merge::core_folder_scan,
      core_merge::core_pdf_extract_start,
      core_protect::core_pdf_protect_start,
      core_protect::core_pdf_unprotect_start,
      core_pdf_compress::core_pdf_probe,
      core_pdf_compress::core_pdf_compress_start,
      core_qr_barcode::core_qr_generate,
      core_qr_barcode::core_barcode_generate,
      core_organize::core_organize_open,
      core_organize::core_organize_thumbnails,
      core_organize::core_organize_release,
      core_organize::core_organize_assemble_start,
      core_canvas::core_canvas_pages_meta,
      core_canvas::core_canvas_render_page,
      core_canvas::core_canvas_stash_annotations,
      core_canvas::core_canvas_save_start,
      core_canvas::core_font_list,
      core_canvas::core_font_add,
      core_canvas::core_font_remove,
      core_canvas::core_font_read,
      core_edit_content::core_edit_content_open,
      core_edit_content::core_edit_content_command,
      core_edit_content::core_edit_content_cancel,
      core_edit_content::core_edit_content_export,
      core_pdf_render::core_pdf_info,
      core_pdf_render::core_pdf_render_page,
    ])
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Resized(size) = event {
        use std::sync::atomic::{AtomicBool, Ordering};
        static IS_RESIZING: AtomicBool = AtomicBool::new(false);

        if IS_RESIZING.load(Ordering::SeqCst) {
          return;
        }

        if let Ok(Some(monitor)) = window.current_monitor() {
          let work_area = monitor.work_area();
          let work_size = work_area.size;

          if size.height > work_size.height || size.width > work_size.width {
              IS_RESIZING.store(true, Ordering::SeqCst);

              let new_width = size.width.min(work_size.width);
              let new_height = size.height.min(work_size.height);

              let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(new_width, new_height)));
              let _ = window.set_position(tauri::Position::Physical(work_area.position.into()));

              std::thread::spawn(|| {
                  std::thread::sleep(std::time::Duration::from_millis(50));
                  IS_RESIZING.store(false, Ordering::SeqCst);
              });
          }
        }
      }
    })
    .setup(|app| {
      app.manage(core_edit_content::EditContentState::for_app(app.handle()));
      core_housekeeping::sweep_stale_scratch();
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    });

  let app = builder.build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if let tauri::RunEvent::Exit = event {
      // Stop native core jobs at their next checkpoint.
      if let Some(core) = app_handle.try_state::<core_bridge::CoreState>() {
        core.runner.cancel_all();
      }
      if let Some(render) = app_handle.try_state::<core_pdf_render::RenderState>() {
        render.service.shutdown();
      }
      if let Some(thumbs) = app_handle.try_state::<core_convert::ThumbState>() {
        thumbs.service.shutdown();
      }
      // Drain Edit Content requests and stop every worker before anything else is torn down.
      if let Some(edit) = app_handle.try_state::<core_edit_content::EditContentState>() {
        edit.shutdown();
      }

      core_housekeeping::clear_on_exit();
    }
  });
}
