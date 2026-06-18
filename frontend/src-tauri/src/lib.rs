use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
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
