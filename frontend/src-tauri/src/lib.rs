use tauri::Manager;

#[cfg(any(not(debug_assertions), test))]
mod desktop_lifecycle;

struct DesktopLifecycleToken(String);

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
        let resource_dir = app.path().resource_dir()?;
        let lifecycle_token = DesktopLifecycleToken(uuid::Uuid::new_v4().simple().to_string());
        let sidecar = app.shell()
          .sidecar("pdf-manager-backend")
          .expect("sidecar not found — run tauri build first")
          .env(
            "PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR",
            resource_dir.join("edit-content").to_string_lossy().into_owned(),
          )
          .env("PDF_MANAGER_DESKTOP_LIFECYCLE_TOKEN", lifecycle_token.0.clone());
        let (_rx, child) = sidecar
          .spawn()
          .expect("failed to spawn pdf-manager-backend sidecar");
        
        app.manage(std::sync::Mutex::new(Some(child)));
        app.manage(lifecycle_token);
      }
      Ok(())
    });

  let app = builder.build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| match event {
    tauri::RunEvent::Exit => {
      // ── Graceful shutdown sequence ──────────────────────────────────────────
      // 1. Drain Content requests, then request the existing temp cleanup.
      // 2. Give the backend a short window to finish cleanup.
      // 3. Kill the sidecar process (safety net in case step 1 fails).
      #[cfg(not(debug_assertions))]
      {
        if let Some(token) = app_handle.try_state::<DesktopLifecycleToken>() {
          let _ = desktop_lifecycle::post(
            "/api/v1/edit-content/shutdown", Some(&token.0), std::time::Duration::from_secs(15),
          );
        }

        // Best-effort HTTP call — ignore errors (backend may already be gone).
        let _ = desktop_lifecycle::post(
          "/api/v1/settings/clear-temp", None, std::time::Duration::from_secs(3),
        );

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
