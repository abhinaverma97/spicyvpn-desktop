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
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
struct SubStats {
    upload: u64,
    download: u64,
    total: u64,
    expire: i64,
}

struct VpnState {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<String>,
    logs: Mutex<String>,
}

fn kill_orphaned_singbox() {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "sing-box.exe", "/T"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn();
    }
}

#[tauri::command]
async fn fetch_sub_stats(url: String) -> Result<SubStats, String> {
    let client = reqwest::Client::new();
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Server returned {}", res.status()));
    }

    let headers = res.headers();
    let userinfo = headers
        .get("Subscription-Userinfo")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let mut stats = SubStats {
        upload: 0,
        download: 0,
        total: 0,
        expire: 0,
    };

    for part in userinfo.split(';') {
        let kv: Vec<&str> = part.trim().split('=').collect();
        if kv.len() == 2 {
            let val: u64 = kv[1].parse().unwrap_or(0);
            match kv[0] {
                "upload" => stats.upload = val,
                "download" => stats.download = val,
                "total" => stats.total = val,
                "expire" => stats.expire = kv[1].parse().unwrap_or(0),
                _ => {}
            }
        }
    }

    Ok(stats)
}

#[tauri::command]
async fn start_vpn(url: String, app: AppHandle, state: State<'_, VpnState>) -> Result<(), String> {
    {
        let mut lock = state.child.lock().unwrap();
        if let Some(child) = lock.take() {
            let _ = child.kill();
        }
        kill_orphaned_singbox();
    }
    
    // Clear old logs
    {
        let mut log_lock = state.logs.lock().unwrap();
        *log_lock = String::new();
    }

    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let b64 = res.text().await.map_err(|e| e.to_string())?;

    use base64::{engine::general_purpose, Engine as _};
    let decoded = general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Base64 Error: {}", e))?;
    let uri = String::from_utf8(decoded).map_err(|e| e.to_string())?;

    let parsed_url = Url::parse(&uri).map_err(|e| format!("Invalid URI format: {}", e))?;

    let uuid = parsed_url.username();
    let host = parsed_url.host_str().unwrap_or("140.245.13.64");
    let port = parsed_url.port().unwrap_or(443);

    let mut sni = String::new();
    let mut pbk = String::new();
    let mut sid = String::new();
    let mut flow = String::new();
    
    // Parse VLESS parameters
    for (k, v) in parsed_url.query_pairs() {
        match k.as_ref() {
            "sni" => sni = v.to_string(),
            "pbk" => pbk = v.to_string(),
            "sid" => sid = v.to_string(),
            "flow" => flow = v.to_string(),
            _ => {}
        }
    }

    let config_json = serde_json::json!({
        "log": { "level": "info" },
        "dns": {
            "servers": [
                { "tag": "dns-remote", "address": "https://1.1.1.1/dns-query", "detour": "proxy" }
            ],
            "rules": [ 
                { "outbound": "any", "server": "dns-remote" } 
            ],
            "final": "dns-remote",
            "strategy": "prefer_ipv4"
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
                "sniff": true,
                "sniff_override_destination": true,
                "udp_timeout": 300
            }
        ],
        "outbounds": [
            {
                "type": "vless",
                "tag": "proxy",
                "server": host,
                "server_port": port,
                "uuid": uuid,
                "flow": if flow.is_empty() { "xtls-rprx-vision" } else { &flow },
                "domain_strategy": "prefer_ipv4",
                "tls": {
                    "enabled": true,
                    "server_name": sni,
                    "utls": {
                        "enabled": true,
                        "fingerprint": "chrome"
                    },
                    "reality": {
                        "enabled": true,
                        "public_key": pbk,
                        "short_id": sid
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
    let config_path = app_dir.join("sing-box-v3.json");
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
fn exit_app(app: AppHandle, state: State<'_, VpnState>) {
    {
        let mut lock = state.child.lock().unwrap();
        if let Some(child) = lock.take() {
            let _ = child.kill();
        }
    }
    kill_orphaned_singbox();
    app.exit(0);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn stop_vpn(state: State<'_, VpnState>) -> Result<(), String> {
    {
        let mut lock = state.child.lock().unwrap();
        if let Some(child) = lock.take() {
            let _ = child.kill();
        }
    }
    kill_orphaned_singbox();
    let mut status_lock = state.status.lock().unwrap();
    *status_lock = "disconnected".to_string();
    Ok(())
}

#[tauri::command]
fn get_vpn_status(state: State<'_, VpnState>) -> String {
    let lock = state.status.lock().unwrap();
    lock.clone()
}

#[tauri::command]
fn minimize_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
fn get_vpn_logs(state: State<'_, VpnState>) -> String {
    let lock = state.logs.lock().unwrap();
    lock.clone()
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
            let show_i = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        let state: State<VpnState> = app.state();
                        {
                            let mut lock = state.child.lock().unwrap();
                            if let Some(child) = lock.take() {
                                let _ = child.kill();
                            }
                        }
                        kill_orphaned_singbox();
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Down,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
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
