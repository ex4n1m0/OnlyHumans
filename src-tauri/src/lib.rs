// OnlyHumans app shell: bridges the web UI to the core node + store.

use onlyhumans_core::net::{spawn, Command, NodeConfig, NodeEvent, NodeHandle};
use onlyhumans_core::store::{Contact, Conversation, StoredMessage, Store};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    store: Mutex<Store>,
    node: Mutex<Option<NodeHandle>>,
    my_id: String,
    /// Anonymous site-presence token for THIS process; the core heartbeats
    /// it and the shell removes it on exit/restart paths.
    presence_token: std::sync::OnceLock<String>,
    /// Last-seen room state, mirrored by the event pump. The UI polls this
    /// as a PULL channel: the push channel (webview events) proved
    /// intermittently lossy in the field — a missed RoomReady froze the
    /// UI on "joining" while the core was fully in the room. Polling the
    /// pump's cache heals any missed event.
    room_snap: Mutex<Option<RoomSnapshot>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomSnapshot {
    status: String,
    room: Option<String>,
    host: Option<String>,
    we_are_host: bool,
    epoch: u64,
    members: Vec<onlyhumans_core::rooms::MemberInfo>,
    updated_ms: u64,
}

/// The UI's self-healing pull: current room state straight from the
/// pump-mirrored cache (see AppState::room_snap).
#[tauri::command]
fn room_snapshot(state: State<AppState>) -> Option<RoomSnapshot> {
    state.room_snap.lock().unwrap().clone()
}

/// Remove our presence token from the site's online counter. Blocking by
/// design: it must complete (or time out) before the process exits, and it
/// must not depend on the node task, which can be busy mid-dial for up to
/// its 10s hub timeout. Never takes longer than the 3s client timeout.
fn leave_presence_blocking(token: &str) {
    let r = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .and_then(|c| {
            c.post(format!("{}/api/presence", onlyhumans_core::hub::DEFAULT_HUB))
                .json(&serde_json::json!({ "token": token, "leave": true }))
                .send()
        });
    if let Err(e) = r {
        eprintln!("presence leave failed: {e}");
    }
}

#[tauri::command]
fn my_id(state: State<AppState>) -> String {
    state.my_id.clone()
}

/// Build version for the UI header (kept in lockstep with tauri.conf.json
/// by tools/deploy-release.sh, which bumps both on every deployment).
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn has_username(app: AppHandle) -> bool {
    resolve_dir(&app).map(|d| read_username(&d).is_some()).unwrap_or(false)
}

/// The UI's own display name. The member list over the wire only ever
/// carries OTHER peers' names to a host (a solo founder would otherwise
/// have no name to show for itself).
#[tauri::command]
fn username(app: AppHandle) -> Option<String> {
    resolve_dir(&app).and_then(|d| read_username(&d))
}

/// This profile's room code, so the gate can prefill it after a logoff
/// (logging off keeps the room binding — only the name is forgotten).
#[tauri::command]
fn passcode(app: AppHandle) -> Option<String> {
    resolve_dir(&app).and_then(|d| read_passcode(&d))
}

/// Log off: forget this profile's username and drop back to the name/code
/// gate. The passcode (room binding) and identity stay, so submitting the
/// gate re-enters the SAME room under a new name.
#[tauri::command]
fn logoff(app: AppHandle) -> Result<(), String> {
    let dir = resolve_dir(&app).ok_or("no data dir")?;
    std::fs::remove_file(dir.join("username.txt")).map_err(|e| e.to_string())?;
    // Drop the site-presence token before the process goes away.
    if let Some(t) = app.try_state::<AppState>().and_then(|s| s.presence_token.get().cloned()) {
        leave_presence_blocking(&t);
    }
    app.restart(); // does not return (same semantics as set_passcode)
    Ok(())
}

/// Open a second app window living in its own parallel room: a fresh
/// profile dir under <data>/rooms/<id> boots straight into the welcome
/// gate, where a new name + code word select that window's room universe.
/// Detached from this process so it survives our exit.
#[tauri::command]
fn open_parallel_room(app: AppHandle) -> Result<(), String> {
    let base = resolve_dir(&app).ok_or("no data dir")?.join("rooms");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    // Random-enough dir name from the clock; retry on the (absurd) collision.
    let mut dir = base.join(format!(
        "{:016x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos() as u64
            ^ std::process::id() as u64
    ));
    let mut n = 0;
    while dir.exists() && n < 8 {
        dir = base.join(format!("{:016x}-{}", n, std::process::id()));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.env("OH_DATA_DIR", &dir).env("OH_INSTANCE", "parallel room");
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_username(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    passcode: Option<String>,
) -> Result<(), String> {
    let name: String = name.chars().filter(|c| !c.is_control()).take(32).collect();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name must not be empty".into());
    }
    let dir = resolve_dir(&app).ok_or("no data dir")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("username.txt"), &name).map_err(|e| e.to_string())?;
    let passcode = write_passcode(&dir, passcode.as_deref())?;
    // Idempotent: if the node is already running the name applies from the
    // next join/re-join; otherwise start it now.
    if state.node.lock().unwrap().is_none() {
        start_node(app, dir, name, passcode);
    }
    Ok(())
}

/// Store (or clear, when blank) the room passcode. Returns the value to
/// feed the node: normalized lowercase, None when it addresses the main
/// room. Mirrors the core's `normalize_passcode` so both layers fold the
/// word identically.
fn write_passcode(dir: &std::path::Path, word: Option<&str>) -> Result<Option<String>, String> {
    let word = word.unwrap_or("").trim().to_lowercase();
    if word.is_empty() {
        let _ = std::fs::remove_file(dir.join("passcode.txt"));
        Ok(None)
    } else {
        std::fs::write(dir.join("passcode.txt"), &word).map_err(|e| e.to_string())?;
        Ok(Some(word))
    }
}

fn read_passcode(dir: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("passcode.txt")).ok()?;
    let word = raw.trim().to_lowercase();
    if word.is_empty() { None } else { Some(word) }
}

#[tauri::command]
fn has_passcode(app: AppHandle) -> bool {
    resolve_dir(&app).map(|d| read_passcode(&d).is_some()).unwrap_or(false)
}

/// Change or clear the room passcode for an ALREADY-running profile.
/// Rooms can't be swapped mid-session (the whole node keys off the
/// effective GK), so this persists the word and restarts the app, which
/// rejoins the addressed room with restored history.
#[tauri::command]
fn set_passcode(app: AppHandle, word: Option<String>) -> Result<(), String> {
    let dir = resolve_dir(&app).ok_or("no data dir")?;
    write_passcode(&dir, word.as_deref())?;
    // The restart mints a fresh presence token; drop the old one first so
    // the site's counter never double-counts the swap.
    if let Some(t) = app.try_state::<AppState>().and_then(|s| s.presence_token.get().cloned()) {
        leave_presence_blocking(&t);
    }
    app.restart(); // does not return
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
fn start_node(app_handle: AppHandle, dir: std::path::PathBuf, username: String, passcode: Option<String>) {
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
    // Port-forward escape hatch for NAT-to-NAT dead ends: a fixed listen
    // port plus the forwarded public address make this machine directly
    // dialable (publish it on the hub ahead of the LAN addresses).
    //   OH_LISTEN_PORT=42333  (bind QUIC+TCP on one fixed port)
    //   OH_PUBLIC_ADDR=203.0.113.7  (or a DNS name; published first)
    let mut cfg = NodeConfig {
        data_dir: dir,
        username: Some(username),
        passcode,
        ..Default::default()
    };
    if let Some(port) = std::env::var("OH_LISTEN_PORT").ok().and_then(|p| p.trim().parse().ok()) {
        cfg.listen_quic = Some(port);
        cfg.listen_tcp = Some(port);
    }
    if let Some(pa) = std::env::var("OH_PUBLIC_ADDR").ok().map(|s| s.trim().to_string()) {
        if !pa.is_empty() {
            cfg.public_addr = Some(pa);
        }
    }
    // One anonymous presence token per process: the core heartbeats it to
    // the site's counter; remember it here so exit paths can remove it.
    let presence_token = cfg.presence_token.clone();
    if let Some(state) = app_handle.try_state::<AppState>() {
        let _ = state.presence_token.set(presence_token);
    }
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
        // peer -> display name, for toast formatting (the shell otherwise
        // only sees raw peer ids)
        let mut names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        // Mirror of the room state for the UI's pull channel.
        let mut snap_status = String::from("connecting");
        let mut snap: Option<RoomSnapshot> = None;
        while let Some(ev) = rx.recv().await {
            tracing::debug!("pump event: {ev:?}");
            match &ev {
                NodeEvent::Log { message } => append_log(&log_dir, message),
                NodeEvent::MembersChanged { members, .. } => {
                    for m in members {
                        if !m.name.is_empty() {
                            names.insert(m.peer.clone(), m.name.clone());
                        }
                    }
                }
                NodeEvent::ConnectionStateChanged { peer, connected } => append_log(
                    &log_dir,
                    &format!("conn {peer} {}", if *connected { "up" } else { "down" }),
                ),
                NodeEvent::JoinStatus { status } => {
                    snap_status = status.clone();
                }
                NodeEvent::RoomReady { room, peer, we_are_host, epoch } => {
                    snap_status = if *we_are_host { "hosting".into() } else { "connected".into() };
                    snap = Some(RoomSnapshot {
                        status: snap_status.clone(),
                        room: Some(room.clone()),
                        host: Some(peer.clone()),
                        we_are_host: *we_are_host,
                        epoch: *epoch,
                        members: snap.as_ref().map(|s| s.members.clone()).unwrap_or_default(),
                        updated_ms: now_ms(),
                    });
                }
                NodeEvent::MembersChanged { members, .. } => {
                    if let Some(s) = snap.as_mut() {
                        s.members = members.clone();
                        s.updated_ms = now_ms();
                    }
                }
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
                    let who = names.get(sender).cloned()
                        .unwrap_or_else(|| sender.chars().take(10).collect());
                    Some(format!("New message from {who}"))
                }
                NodeEvent::Rotated { new_epoch, .. } => {
                    Some(format!("Room key rotated — now on epoch {new_epoch}"))
                }
                _ => None,
            };
            if let Some(body) = toast {
                let unfocused = app_handle
                    .get_webview_window("main")
                    .map(|w| !w.is_focused().unwrap_or(true))
                    .unwrap_or(true);
                if unfocused {
                    // One path for every desktop OS: notify-rust. On
                    // Windows the registry AUMID entry resolves our app_id
                    // to "OnlyHumans"; on Linux it maps to the bundled
                    // .desktop entry over D-Bus.
                    let shown = (|| -> Result<(), notify_rust::error::Error> {
                        let mut n = notify_rust::Notification::new();
                        // notify-rust names the sender per platform: the
                        // AUMID on Windows, the appname on XDG desktops.
                        #[cfg(windows)]
                        n.app_id("space.deepflux.onlyhumans");
                        #[cfg(not(windows))]
                        n.appname("OnlyHumans");
                        n.summary("OnlyHumans").body(&body).show()?;
                        Ok(())
                    })();
                    if let Err(e) = shown {
                        append_log(&log_dir, &format!("notification failed: {e}"));
                    }
                }
            }
            let _ = app_handle.emit("node-event", &ev);
            // Publish the pull-channel snapshot after every event.
            if let Some(state) = app_handle.try_state::<AppState>() {
                let mut s = snap.clone().unwrap_or(RoomSnapshot {
                    status: snap_status.clone(),
                    room: None,
                    host: None,
                    we_are_host: false,
                    epoch: 1,
                    members: Vec::new(),
                    updated_ms: now_ms(),
                });
                s.status = snap_status.clone();
                s.updated_ms = now_ms();
                *state.room_snap.lock().unwrap() = Some(s);
            }
        }
    });
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
async fn open_dm(
    state: tauri::State<'_, AppState>,
    peer: String,
) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::OpenDm { peer })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rotate_key(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx.send(Command::Rotate).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn reset_room(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let node = state.node.lock().unwrap().clone().ok_or("node not running")?;
    node.cmd_tx
        .send(Command::ResetRoom)
        .await
        .map_err(|e| e.to_string())
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

/// Give Windows a proper identity for our toasts so they are attributed
/// to OnlyHumans instead of falling back to PowerShell. Uses the
/// documented registry form of AppUserModelID registration (no COM, no
/// Start Menu shortcut): HKCU\Software\Classes\AppUserModelId\<id>
/// with DisplayName + IconUri.
#[cfg(windows)]
fn register_toast_identity(icon_png: &std::path::Path) {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    const AUMID: &str = "space.deepflux.onlyhumans";
    let aumid_w: Vec<u16> = AUMID.encode_utf16().chain([0]).collect();
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(aumid_w.as_ptr());

        let subkey: Vec<u16> = format!("Software\\Classes\\AppUserModelId\\{AUMID}")
            .encode_utf16()
            .chain([0])
            .collect();
        let mut hkey: HKEY = 0;
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        ) != 0
        {
            return;
        }
        let mut set = |name: &str, value: &str| {
            let name_w: Vec<u16> = name.encode_utf16().chain([0]).collect();
            let val_w: Vec<u16> = value.encode_utf16().chain([0]).collect();
            let bytes = (val_w.len() * 2) as u32;
            RegSetValueW(hkey, name_w.as_ptr(), REG_SZ, val_w.as_ptr(), bytes);
        };
        set("DisplayName", "OnlyHumans");
        if let Some(icon) = icon_png.to_str() {
            let uri = format!("file:///{}", icon.replace('\\', "/"));
            set("IconUri", &uri);
        }
        RegCloseKey(hkey);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // OH_TRACE=1 (+ RUST_LOG) turns on libp2p/core internals on stderr —
    // the release app otherwise shows nothing below NodeEvent level.
    if std::env::var_os("OH_TRACE").is_some() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .with_target(true)
            .try_init();
    }
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
            #[cfg(windows)]
            {
                // Icon for toast attribution, placed in the data dir.
                let icon_dst = dir.join("icon-256.png");
                if !icon_dst.exists() {
                    let icon_src = std::env::current_exe()
                        .ok()
                        .and_then(|e| e.parent().map(|p| p.join("icon-256.png")))
                        .filter(|p| p.exists())
                        .or_else(|| {
                            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                                .join("icons")
                                .join("icon.png")
                                .exists()
                                .then(|| {
                                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                                        .join("icons")
                                        .join("icon.png")
                                })
                        });
                    if let Some(src) = icon_src {
                        let _ = std::fs::copy(src, &icon_dst);
                    }
                }
                register_toast_identity(&icon_dst);
            }

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
                presence_token: std::sync::OnceLock::new(),
                room_snap: Mutex::new(None),
            });

            // The node only starts once a username exists (the UI gates
            // first-run on it); returning members start immediately.
            if let Some(name) = read_username(&dir) {
                let passcode = read_passcode(&dir);
                start_node(app_handle, dir, name, passcode);
            }

            Ok(())
        })
        // Graceful exit: the window X first lets the node shut down and
        // removes our anonymous presence token (so the site's online
        // counter forgets us immediately instead of at TTL expiry), then
        // closes. The leave is a blocking call in its own thread — the
        // node task may be mid-dial for up to 10s and cannot be relied on
        // here. restart() bypasses CloseRequested, so the passcode/logoff
        // restart flows are unaffected (they leave explicitly).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                let state = app.try_state::<AppState>();
                let node = state.as_ref().and_then(|s| s.node.lock().unwrap().clone());
                let token = state.as_ref().and_then(|s| s.presence_token.get().cloned());
                let Some(token) = token else { return }; // gate screen: nothing beaconed yet
                api.prevent_close();
                if let Some(node) = node {
                    let _ = node.cmd_tx.send(Command::Shutdown);
                }
                std::thread::spawn(move || {
                    leave_presence_blocking(&token);
                    match app.get_webview_window("main") {
                        Some(w) => {
                            if let Err(e) = w.destroy() {
                                eprintln!("close after shutdown failed: {e}");
                                std::process::exit(0);
                            }
                        }
                        None => std::process::exit(0),
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            my_id,
            app_version,
            has_username,
            username,
            passcode,
            logoff,
            open_parallel_room,
            set_username,
            has_passcode,
            set_passcode,
            conversations,
            contacts,
            messages,
            record_message,
            send_message,
            open_dm,
            rotate_key,
            reset_room,
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
