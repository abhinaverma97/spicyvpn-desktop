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
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", name, "/T"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
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
        let _ = Command::new("pkill").arg("-f").arg("sing-box").output();
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
    
    if !res.status().is_success() {
        let error_msg = res.text().await.unwrap_or_default();
        let msg = if error_msg.is_empty() { "Subscription is inactive or expired".to_string() } else { error_msg };
        return Err(msg);
    }
    
    let info = res.headers()
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("upload=0; download=0; total=0; expire=0");

    let b64_name = res.headers().get("x-user-name").and_then(|v| v.to_str().ok()).unwrap_or("");
    let email = res.headers().get("x-user-email").and_then(|v| v.to_str().ok()).unwrap_or("");

    let mut name = String::new();
    if !b64_name.is_empty() {
        use base64::{engine::general_purpose, Engine as _};
        if let Ok(decoded) = general_purpose::STANDARD.decode(b64_name) {
            name = String::from_utf8_lossy(&decoded).to_string();
        }
    }

    let mut stats = serde_json::json!({
        "upload": 0,
        "download": 0,
        "total": 0,
        "expire": 0,
        "name": name,
        "email": email
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
async fn start_vpn(url: String, app: AppHandle, state: State<'_, VpnState>) -> Result<(), String> {
    // 1. Cleanup old instances
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

    // 2. Resolve the URI (Handle both Subscription Link and Direct URI)
    let uri = if url.starts_with("http") {
        let client = reqwest::Client::new();
        let res = client.get(&url).send().await.map_err(|e| format!("Failed to fetch sub: {}", e))?;
        
        if !res.status().is_success() {
            let error_msg = res.text().await.unwrap_or_default();
            let msg = if error_msg.is_empty() { "Subscription is inactive or expired".to_string() } else { error_msg };
            return Err(msg);
        }

        let b64_body = res.text().await.map_err(|e| format!("Empty sub body: {}", e))?;
        
        use base64::{engine::general_purpose, Engine as _};
        let decoded = general_purpose::STANDARD
            .decode(b64_body.trim())
            .map_err(|_| "Failed to decode subscription content".to_string())?;
        String::from_utf8(decoded).map_err(|e| e.to_string())?
    } else {
        url.clone()
    };

    // 3. Parse the URI
    let parsed_url = Url::parse(&uri).map_err(|e| format!("Invalid URI format: {}", e))?;
    let scheme = parsed_url.scheme();
    
    if scheme != "vless" {
        return Err(format!("Unsupported protocol '{}'. Please use VLESS.", scheme));
    }

    let host = parsed_url.host_str().unwrap_or("140.245.13.64").to_string();
    let port = parsed_url.port().unwrap_or(443);
    let auth_info = parsed_url.username().to_string();
    
    let query: std::collections::HashMap<_, _> = parsed_url.query_pairs().into_owned().collect();
    let sni = query.get("sni").cloned().unwrap_or(host.clone());
    let insecure = query.get("insecure").map(|v| v == "1").unwrap_or(false);

    // 4. Generate optimized sing-box config for VLESS + gRPC
    let transport_type = query.get("type").cloned().unwrap_or("grpc".to_string());
    let service_name = query.get("serviceName").cloned().unwrap_or("spicypepper-grpc".to_string());
    
    let outbound = serde_json::json!({
        "type": "vless",
        "tag": "proxy",
        "server": host,
        "server_port": port,
        "uuid": auth_info,
        "packet_encoding": "xudp",
        "domain_resolver": "dns-remote",
        "multiplex": {
            "enabled": true,
            "protocol": "smux"
        },
        "tls": {
            "enabled": true,
            "server_name": sni,
            "insecure": insecure,
            "utls": {
                "enabled": true,
                "fingerprint": "chrome"
            }
        },
        "transport": {
            "type": transport_type,
            "service_name": service_name
        }
    });

    let config_json = serde_json::json!({
        "log": { "level": "info" },
        "dns": {
            "servers": [
                { "tag": "dns-remote", "type": "https", "server": "1.1.1.1", "server_port": 443, "path": "/dns-query", "detour": "proxy" },
                { "tag": "dns-direct", "type": "udp", "server": "8.8.8.8", "server_port": 53, "detour": "direct" }
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
                "mtu": 1280,
                "sniff": true
            }
        ],
        "outbounds": [
            outbound,
            { "type": "direct", "tag": "direct", "domain_resolver": "dns-direct" }
        ],
        "route": {
            "auto_detect_interface": true,
            "rules": [
                { "protocol": "dns", "action": "hijack-dns" },
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
    let config_path = app_dir.join("sing-box-v12.json");
    std::fs::write(&config_path, config_json.to_string()).map_err(|e| e.to_string())?;

    // 5. Spawn process and monitor logs
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

    {
        let mut status_lock = state.status.lock().unwrap();
        *status_lock = "connecting".to_string();
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    
                    if text.contains("sing-box started") || text.contains("tunnel started") {
                        let state = app_clone.state::<VpnState>();
                        let mut status_lock = state.status.lock().unwrap();
                        *status_lock = "connected".to_string();
                        let _ = app_clone.emit("vpn-status-changed", "connected");
                    }

                    let state = app_clone.state::<VpnState>();
                    if let Ok(mut lock) = state.logs.lock() {
                        lock.push_str(&text);
                        lock.push('\n');
                    }
                    let _ = app_clone.emit("vpn-log", text);
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    
                    if text.contains("sing-box started") || text.contains("tunnel started") {
                        let state = app_clone.state::<VpnState>();
                        let mut status_lock = state.status.lock().unwrap();
                        *status_lock = "connected".to_string();
                        let _ = app_clone.emit("vpn-status-changed", "connected");
                    }

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
                    *lock = "disconnected".to_string();
                    let _ = app_clone.emit("vpn-status-changed", "disconnected");
                    break;
                }
                tauri_plugin_shell::process::CommandEvent::Error(_) => {
                    let state = app_clone.state::<VpnState>();
                    let mut lock = state.status.lock().unwrap();
                    *lock = "disconnected".to_string();
                    let _ = app_clone.emit("vpn-status-changed", "disconnected");
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

#[tauri::command]
fn open_browser(url: String, app: AppHandle) {
    use tauri_plugin_shell::ShellExt;
    let _ = app.shell().open(url, None);
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
            minimize_window,
            open_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
