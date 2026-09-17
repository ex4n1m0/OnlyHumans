// OnlyHumans app shell: bridges the web UI to the core node + store.

use onlyhumans_core::net::{spawn, Command, NodeConfig, NodeEvent, NodeHandle};
use onlyhumans_core::store::{Contact, Conversation, StoredMessage, Store};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

struct AppState {
    store: Mutex<Store>,
    node: Mutex<Option<NodeHandle>>,
    my_id: String,
}

#[tauri::command]
fn my_id(state: State<AppState>) -> String {
    state.my_id.clone()
}

#[tauri::command]
fn has_username(app: AppHandle) -> bool {
    resolve_dir(&app).map(|d| read_username(&d).is_some()).unwrap_or(false)
}

#[tauri::command]
async fn set_username(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let name: String = name.chars().filter(|c| !c.is_control()).take(32).collect();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name must not be empty".into());
    }
    let dir = resolve_dir(&app).ok_or("no data dir")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("username.txt"), &name).map_err(|e| e.to_string())?;
    // Idempotent: if the node is already running the name applies from the
    // next join/re-join; otherwise start it now.
    if state.node.lock().unwrap().is_none() {
        start_node(app, dir, name);
    }
    Ok(())
}

fn resolve_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    // OH_DATA_DIR overrides the profile location (multi-instance testing).
    if let Some(d) = std::env::var_os("OH_DATA_DIR") {
        let d = std::path::PathBuf::from(d);
        let _ = std::fs::create_dir_all(&d);
        return Some(d);
    }
    use tauri::Manager;
    app.path().app_data_dir().ok()
}

fn read_username(dir: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("username.txt")).ok()?;
    let name = raw.chars().filter(|c| !c.is_control()).take(32).collect::<String>();
    let name = name.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Spawn the core node + event pump. Called at startup when a username
/// already exists, or from `set_username` after the first-run gate.
fn start_node(app_handle: AppHandle, dir: std::path::PathBuf, username: String) {
    // Diagnostics for shipped builds: everything else only reaches
    // eprintln/WebView console, which release users cannot see.
    let log_dir = dir.join("logs");
    append_log(
        &log_dir,
        &format!(
            "=== OnlyHumans v{} starting, peer {}",
            env!("CARGO_PKG_VERSION"),
            app_handle.try_state::<AppState>().map(|s| s.my_id.clone()).unwrap_or_default()
        ),
    );
    let cfg = NodeConfig {
        data_dir: dir,
        username: Some(username),
        ..Default::default()
    };
    tauri::async_runtime::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let node = match spawn(cfg, tx).await {
            Ok(n) => n,
            Err(e) => {
                eprintln!("node failed to start: {e}");
                append_log(&log_dir, &format!("node failed to start: {e}"));
                return;
            }
        };
        if let Some(state) = app_handle.try_state::<AppState>() {
            *state.node.lock().unwrap() = Some(node);
        }
        while let Some(ev) = rx.recv().await {
            match &ev {
                NodeEvent::Log { message } => append_log(&log_dir, message),
                NodeEvent::ConnectionStateChanged { peer, connected } => append_log(
                    &log_dir,
                    &format!("conn {peer} {}", if *connected { "up" } else { "down" }),
                ),
                NodeEvent::Listening { addr } => {
                    append_log(&log_dir, &format!("listening {addr}"))
                }
                _ => {}
            }
            // Desktop toast when the window is in the background.
            // Metadata only: no message content ever enters the
            // Windows notification history.
            let toast = match &ev {
                NodeEvent::Message { sender, .. } => {
                    Some(format!("New message from {}", &sender[..10.min(sender.len())]))
                }
                _ => None,
            };
            if let Some(body) = toast {
                let unfocused = app_handle
                    .get_webview_window("main")
                    .map(|w| !w.is_focused().unwrap_or(true))
                    .unwrap_or(true);
                if unfocused {
                    if let Err(e) = app_handle
                        .notification()
                        .builder()
                        .title("OnlyHumans")
                        .body(body)
                        .show()
                    {
                        append_log(&log_dir, &format!("notification failed: {e}"));
                    }
                }
            }
            let _ = app_handle.emit("node-event", &ev);
        }
    });
}

#[tauri::command]
fn conversations(state: State<AppState>) -> Result<Vec<Conversation>, String> {
    state.store.lock().unwrap().conversations().map_err(|e| e.to_string())
}

#[tauri::command]
fn messages(state: State<AppState>, room: String, limit: i64) -> Result<Vec<StoredMessage>, String> {
    let mut msgs = state
        .store
        .lock()
        .unwrap()
        .messages(&room, limit)
        .map_err(|e| e.to_string())?;
    let my = state.my_id.clone();
    for m in &mut msgs {
        m.outgoing = m.sender == my;
    }
    Ok(msgs)
}

#[tauri::command]
fn record_message(
    state: State<AppState>,
    room: String,
    sender: String,
    body: String,
    epoch: u64,
) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .append_message(&room, &sender, &body, epoch, false)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::SendMessage { text })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rotate_key(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx.send(Command::Rotate).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_history(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::ClearHistory)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn request_state(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::RequestState)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn add_contact(state: State<AppState>, peer: String, name: String) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .add_contact(&peer, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn contacts(state: State<AppState>) -> Result<Vec<Contact>, String> {
    state
        .store
        .lock()
        .unwrap()
        .contacts()
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // OH_DATA_DIR overrides the profile location so multiple
            // instances (testing) can run with separate identities.
            let dir = std::env::var_os("OH_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    app.path()
                        .app_data_dir()
                        .expect("app data dir")
                });
            std::fs::create_dir_all(&dir)?;
            if let Ok(instance) = std::env::var("OH_INSTANCE") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title(&format!("OnlyHumans — {instance}"));
                }
            }
            let store = Store::open(&dir)?;
            let identity = onlyhumans_core::identity::Identity::load_or_create(&dir)?;
            let my_id = identity.id_string();

            let app_handle: AppHandle = app.handle().clone();
            app.manage(AppState {
                store: Mutex::new(store),
                node: Mutex::new(None),
                my_id: my_id.clone(),
            });

            // The node only starts once a username exists (the UI gates
            // first-run on it); returning members start immediately.
            if let Some(name) = read_username(&dir) {
                start_node(app_handle, dir, name);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            my_id,
            has_username,
            set_username,
            conversations,
            contacts,
            messages,
            record_message,
            send_message,
            rotate_key,
            clear_history,
            request_state,
            add_contact
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Append one line to `<data_dir>/logs/node.log`, rotating the previous
/// file to node.log.old past ~1 MB. Never panics: logging is best-effort.
fn append_log(log_dir: &std::path::Path, line: &str) {
    use std::io::Write as _;
    let _ = std::fs::create_dir_all(log_dir);
    let path = log_dir.join("node.log");
    let oversized = std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false);
    if oversized {
        let _ = std::fs::rename(&path, log_dir.join("node.log.old"));
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let _ = writeln!(f, "{ts} {line}");
}
