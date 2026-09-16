// OnlyHumans app shell: bridges the web UI to the core node + store.

use onlyhumans_core::net::{spawn, Command, NodeConfig, NodeEvent, NodeHandle};
use onlyhumans_core::store::{Conversation, StoredMessage, Store};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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
async fn open_conversation(
    state: tauri::State<'_, AppState>,
    peer: String,
) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::OpenConversation { peer })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, AppState>,
    room: String,
    text: String,
) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::SendMessage { room, text })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rotate_key(state: tauri::State<'_, AppState>, room: String) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::Rotate { room })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn approve_join(
    state: tauri::State<'_, AppState>,
    peer: String,
    room: String,
    allow: bool,
) -> Result<(), String> {
    if !allow {
        return Ok(()); // declining leaves the join unanswered
    }
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::Approve { peer, room })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn accept_invitation(
    state: tauri::State<'_, AppState>,
    room: String,
    host: String,
) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::AcceptInvitation { room, host })
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

pub fn run() {
    tauri::Builder::default()
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
            let cfg = NodeConfig {
                data_dir: dir,
                ..Default::default()
            };
            tauri::async_runtime::spawn(async move {
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                let node = match spawn(cfg, tx).await {
                    Ok(n) => n,
                    Err(e) => {
                        eprintln!("node failed to start: {e}");
                        return;
                    }
                };
                if let Some(state) = app_handle.try_state::<AppState>() {
                    *state.node.lock().unwrap() = Some(node);
                }
                while let Some(ev) = rx.recv().await {
                    let _ = app_handle.emit("node-event", &ev);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            my_id,
            conversations,
            messages,
            record_message,
            open_conversation,
            send_message,
            rotate_key,
            approve_join,
            accept_invitation,
            add_contact
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
