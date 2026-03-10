use std::env;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

/// Shared state for the Python backend process.
struct BackendState {
    process: Option<Child>,
    port: u16,
    /// Job Object handle (Windows only). Kept alive so Windows auto-kills Python
    /// when the Tauri process exits for any reason (panic, Task Manager, etc.).
    /// `None` on non-Windows platforms.
    job_handle: Option<isize>,
}

/// Find a free TCP port starting from `start`.
fn find_free_port(start: u16) -> u16 {
    for port in start..start + 100 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    start
}

/// Resolve the app root directory (where the executable lives).
fn app_root() -> PathBuf {
    let exe = env::current_exe().expect("cannot determine executable path");
    exe.parent().unwrap().to_path_buf()
}

/// Resolve the Python interpreter path for the bundled standalone Python.
fn python_path() -> PathBuf {
    let root = app_root();
    if cfg!(target_os = "windows") {
        root.join("python").join("python.exe")
    } else {
        root.join("python").join("bin").join("python3")
    }
}

/// Resolve the ffmpeg binary path.
fn ffmpeg_path() -> PathBuf {
    let root = app_root();
    if cfg!(target_os = "windows") {
        root.join("bin").join("ffmpeg.exe")
    } else {
        root.join("bin").join("ffmpeg")
    }
}

/// Spawn the Python backend as a child process.
///
/// On Windows, the child is assigned to a Job Object with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so that Python is automatically
/// terminated whenever the Tauri process exits — including panics or kills.
/// Returns `(Child, Option<isize>)` where the second value is the Job Object
/// handle on Windows (must be kept alive in `BackendState`), or `None` on
/// other platforms.
fn spawn_backend(port: u16) -> (Child, Option<isize>) {
    let root = app_root();
    let python = python_path();
    let ffmpeg = ffmpeg_path();
    let models_dir = root.join("models");

    #[cfg(target_os = "windows")]
    let creation_flags: u32 = 0x08000000; // CREATE_NO_WINDOW

    let mut cmd = Command::new(&python);
    cmd.arg("-m")
        .arg("backend")
        .env("CENSOR_ME_PORT", port.to_string())
        .env("CENSOR_ME_PORTABLE", "1")
        .env("FFMPEG_PATH", &ffmpeg)
        .env(
            "EASYOCR_MODEL_STORAGE",
            models_dir.join("easyocr").to_string_lossy().to_string(),
        )
        .env(
            "SPACY_MODEL_PATH",
            models_dir
                .join("spacy")
                .join("en_core_web_lg")
                .to_string_lossy()
                .to_string(),
        )
        .current_dir(&root);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(creation_flags);
    }

    let child = cmd
        .spawn()
        .unwrap_or_else(|e| panic!("Failed to spawn Python backend: {e}\nPython path: {python:?}"));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job_handle = unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
                Some(job as isize)
            } else {
                None
            }
        };
        return (child, job_handle);
    }

    #[allow(unreachable_code)]
    (child, None)
}

/// Poll the backend health endpoint until it responds with 200.
async fn wait_for_backend(port: u16, app: &AppHandle) -> bool {
    let url = format!("http://127.0.0.1:{port}/system/status");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();

    for i in 0..60 {
        let status_msg = match i {
            0..=2 => "Starting backend...",
            3..=10 => "Loading models...",
            11..=30 => "Initializing (this may take a moment)...",
            _ => "Still waiting for backend...",
        };
        let _ = app.emit("splash:status", status_msg);

        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let _ = app.emit("splash:status", "Ready!");
                return true;
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

/// Send POST /system/shutdown and wait for the process to exit.
fn shutdown_backend(state: &Mutex<BackendState>) {
    let mut guard = state.lock().unwrap();
    let port = guard.port;

    // Try graceful shutdown via HTTP
    let url = format!("http://127.0.0.1:{port}/system/shutdown");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok();
    if let Some(client) = client {
        let _ = client.post(&url).send();
    }

    // Wait up to 5 seconds for process to exit, then force-kill
    if let Some(ref mut child) = guard.process {
        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                _ => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        let _ = child.kill();
    }
}

/// IPC command: return the backend port for the frontend to connect to.
#[tauri::command]
fn get_backend_port(state: tauri::State<'_, Mutex<BackendState>>) -> u16 {
    state.lock().unwrap().port
}

pub fn run() {
    let port = find_free_port(8010);
    let (child, job_handle) = spawn_backend(port);

    let backend_state = Mutex::new(BackendState {
        process: Some(child),
        port,
        job_handle,
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when a second instance is launched
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(backend_state)
        .invoke_handler(tauri::generate_handler![get_backend_port])
        .setup(move |app| {
            // Build system tray
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let about = MenuItemBuilder::with_id("about", "About Censor Me").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&show, &about, &quit])
                .build()?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Censor Me")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "about" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.emit("show:about", ());
                            }
                        }
                        "quit" => {
                            let state = app.state::<Mutex<BackendState>>();
                            shutdown_backend(&state);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Poll backend readiness and transition from splash to main window
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let ready = wait_for_backend(port, &handle).await;

                if let Some(splash) = handle.get_webview_window("splash") {
                    let _ = splash.close();
                }

                if let Some(main_win) = handle.get_webview_window("main") {
                    if ready {
                        let _ = main_win.show();
                        let _ = main_win.set_focus();
                    } else {
                        let _ = main_win.set_title("Censor Me - Backend Error");
                        let _ = main_win.show();
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { .. },
                    ..
                } if label == "main" => {
                    let state = app.state::<Mutex<BackendState>>();
                    shutdown_backend(&state);
                }
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { .. },
                    ..
                } if label == "splash" => {
                    // User force-closed the splash during loading — exit cleanly
                    let state = app.state::<Mutex<BackendState>>();
                    shutdown_backend(&state);
                    app.exit(0);
                }
                RunEvent::ExitRequested { .. } => {
                    let state = app.state::<Mutex<BackendState>>();
                    shutdown_backend(&state);
                }
                _ => {}
            }
        });
}
