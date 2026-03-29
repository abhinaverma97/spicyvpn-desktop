use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, Emitter,
};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use url::Url;

#[cfg(windows)]
fn kill_process_by_name(name: &str) {
    use std::process::Command;
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", name, "/T"])
        .spawn();
}

struct VpnState {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<String>,
    logs: Mutex<String>,
}

fn kill_orphaned_singbox() {
    #[cfg(windows)]
    {
        kill_process_by_name("sing-box.exe");
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let _ = Command::new("pkill").arg("-f").arg("sing-box").spawn();
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
async fn fetch_sub_stats(url: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("SpicyVPN Desktop")
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    
    let info = res.headers()
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("upload=0; download=0; total=0; expire=0");

    let mut stats = serde_json::json!({
        "upload": 0,
        "download": 0,
        "total": 0,
        "expire": 0
    });

    for part in info.split(';') {
        let kv: Vec<&str> = part.split('=').map(|s| s.trim()).collect();
        if kv.len() == 2 {
            if let Ok(val) = kv[1].parse::<u64>() {
                match kv[0] {
                    "upload" => stats["upload"] = serde_json::json!(val),
                    "download" => stats["download"] = serde_json::json!(val),
                    "total" => stats["total"] = serde_json::json!(val),
                    "expire" => stats["expire"] = serde_json::json!(val),
                    _ => {}
                }
            }
        }
    }

    Ok(stats)
}

#[tauri::command]
async fn start_vpn(b64: String, app: AppHandle, state: State<'_, VpnState>) -> Result<(), String> {
    {
        let mut lock = state.child.lock().unwrap();
        if let Some(child) = lock.take() {
            let _ = child.kill();
        }
        kill_orphaned_singbox();
    }
    
    {
        let mut log_lock = state.logs.lock().unwrap();
        *log_lock = String::new();
    }

    use base64::{engine::general_purpose, Engine as _};
    let decoded = general_purpose::STANDARD
        .decode(&b64)
        .map_err(|e| e.to_string())?;
    let uri = String::from_utf8(decoded).map_err(|e| e.to_string())?;

    let parsed_url = Url::parse(&uri).map_err(|e| format!("Invalid URI format: {}", e))?;
    let scheme = parsed_url.scheme();
    
    if scheme != "hy2" {
        return Err("Unsupported protocol. Please use a Hysteria 2 link.".to_string());
    }

    let host = parsed_url.host_str().unwrap_or("140.245.13.64").to_string();
    let port = parsed_url.port().unwrap_or(443);
    let auth_user = parsed_url.username().to_string();
    
    let query: std::collections::HashMap<_, _> = parsed_url.query_pairs().into_owned().collect();
    let sni = query.get("sni").cloned().unwrap_or(host.clone());
    let insecure = query.get("insecure").map(|v| v == "1").unwrap_or(false);

    let config_json = serde_json::json!({
        "log": { "level": "info" },
        "dns": {
            "servers": [
                { "tag": "dns-remote", "address": "https://1.1.1.1/dns-query", "detour": "proxy" },
                { "tag": "dns-direct", "address": "8.8.8.8", "detour": "direct" }
            ],
            "rules": [
                { "outbound": "any", "server": "dns-remote" }
            ]
        },
        "inbounds": [
            {
                "type": "tun",
                "tag": "tun-in",
                "interface_name": "SpicyVPN-TUN",
                "inet4_address": "172.19.0.1/30",
                "auto_route": true,
                "strict_route": true,
                "stack": "gvisor",
                "mtu": 1350,
                "sniff": true
            }
        ],
        "outbounds": [
            {
                "type": "hysteria2",
                "tag": "proxy",
                "server": host,
                "server_port": port,
                "password": auth_user,
                "tls": {
                    "enabled": true,
                    "server_name": sni,
                    "insecure": insecure,
                    "utls": {
                        "enabled": true,
                        "fingerprint": "chrome"
                    }
                }
            },
            { "type": "direct", "tag": "direct" },
            { "type": "dns", "tag": "dns-out" }
        ],
        "route": {
            "auto_detect_interface": true,
            "rules": [
                { "protocol": "dns", "outbound": "dns-out" },
                { "ip_is_private": true, "outbound": "direct" },
                { "outbound": "direct", "ip_cidr": [host] }
            ],
            "final": "proxy"
        }
    });

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to get app dir".to_string())?;
    std::fs::create_dir_all(&app_dir).unwrap_or_default();
    let config_path = app_dir.join("sing-box-v7.json");
    std::fs::write(&config_path, config_json.to_string()).map_err(|e| e.to_string())?;

    let (mut rx, child) = app
        .shell()
        .sidecar("sing-box")
        .map_err(|e| e.to_string())?
        .args(["run", "-c", config_path.to_str().unwrap()])
        .spawn()
        .map_err(|e| e.to_string())?;

    {
        let mut lock = state.child.lock().unwrap();
        *lock = Some(child);
    }

    let mut status_lock = state.status.lock().unwrap();
    *status_lock = "connected".to_string();

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    let state = app_clone.state::<VpnState>();
                    if let Ok(mut lock) = state.logs.lock() {
                        lock.push_str(&text);
                        lock.push('\n');
                    }
                    let _ = app_clone.emit("vpn-log", text);
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    let state = app_clone.state::<VpnState>();
                    if let Ok(mut lock) = state.logs.lock() {
                        lock.push_str(&text);
                        lock.push('\n');
                    }
                    let _ = app_clone.emit("vpn-log", text);
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(_) => {
                    let state = app_clone.state::<VpnState>();
                    let mut lock = state.status.lock().unwrap();
                    if *lock == "connected" {
                        *lock = "disconnected".to_string();
                    }
                    if let Ok(mut log_lock) = state.logs.lock() {
                        log_lock.push_str("[Process Terminated]\n");
                    }
                    break;
                }
                tauri_plugin_shell::process::CommandEvent::Error(err) => {
                    let state = app_clone.state::<VpnState>();
                    let mut lock = state.status.lock().unwrap();
                    if *lock == "connected" {
                        *lock = "disconnected".to_string();
                    }
                    if let Ok(mut log_lock) = state.logs.lock() {
                        log_lock.push_str(&format!("[Process Error] {}\n", err));
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_vpn(state: State<'_, VpnState>) {
    let mut lock = state.child.lock().unwrap();
    if let Some(child) = lock.take() {
        let _ = child.kill();
    }
    kill_orphaned_singbox();
    let mut status_lock = state.status.lock().unwrap();
    *status_lock = "disconnected".to_string();
}

#[tauri::command]
fn get_vpn_status(state: State<'_, VpnState>) -> String {
    let lock = state.status.lock().unwrap();
    lock.clone()
}

#[tauri::command]
fn get_vpn_logs(state: State<'_, VpnState>) -> String {
    let lock = state.logs.lock().unwrap();
    lock.clone()
}

#[tauri::command]
fn exit_app(app: AppHandle, state: State<'_, VpnState>) {
    {
        let mut lock = state.child.lock().unwrap();
        if let Some(child) = lock.take() {
            let _ = child.kill();
        }
        kill_orphaned_singbox();
    }
    app.exit(0);
}

#[tauri::command]
fn minimize_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(VpnState {
            child: Mutex::new(None),
            status: Mutex::new("disconnected".to_string()),
            logs: Mutex::new(String::new()),
        })
        .setup(|app| {
            kill_orphaned_singbox();

            let quit_i = MenuItem::with_id(app, "quit", "Quit SpicyVPN", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Interface", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        kill_orphaned_singbox();
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_sub_stats,
            start_vpn,
            stop_vpn,
            get_vpn_status,
            get_vpn_logs,
            exit_app,
            hide_window,
            minimize_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
