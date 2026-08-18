use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
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
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      } else {
        // Production: spawn the Python sidecar
        use tauri_plugin_shell::ShellExt;
        let sidecar = app.shell()
          .sidecar("pdf-manager-backend")
          .expect("sidecar not found — run tauri build first");
        let (_rx, child) = sidecar
          .spawn()
          .expect("failed to spawn pdf-manager-backend sidecar");
        
        app.manage(std::sync::Mutex::new(Some(child)));
      }
      Ok(())
    });

  let app = builder.build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| match event {
    tauri::RunEvent::Exit => {
      // ── Graceful shutdown sequence ──────────────────────────────────────────
      // 1. Call the backend's clear-temp API so uvicorn can run its lifespan
      //    shutdown hook (cleans temp/ and output/ directories).
      // 2. Give uvicorn a short window to process the request and shut down.
      // 3. Kill the sidecar process (safety net in case step 1 fails).
      #[cfg(not(debug_assertions))]
      {
        // Best-effort HTTP call — ignore errors (backend may already be gone).
        let _ = std::process::Command::new("curl")
          .args([
            "-s", "-X", "POST",
            "http://127.0.0.1:8000/api/v1/settings/clear-temp",
            "--max-time", "3",
          ])
          .output();

        // Give the backend a moment to process the cleanup and begin shutdown.
        std::thread::sleep(std::time::Duration::from_millis(500));
      }

      // Kill the sidecar process (works in both debug and release).
      if let Some(state) = app_handle.try_state::<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>() {
        if let Ok(mut child_lock) = state.lock() {
          if let Some(child) = child_lock.take() {
            let _ = child.kill();
          }
        }
      }
    }
    _ => {}
  });
}
