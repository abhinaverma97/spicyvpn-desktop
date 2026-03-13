use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
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

    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let b64 = res.text().await.map_err(|e| e.to_string())?;

    use base64::{Engine as _, engine::general_purpose};
    let decoded = general_purpose::STANDARD.decode(b64.trim()).map_err(|e| format!("Base64 Error: {}", e))?;
    let uri = String::from_utf8(decoded).map_err(|e| e.to_string())?;

    let parsed_url = Url::parse(&uri).map_err(|e| format!("Invalid URI format: {}", e))?;
    
    let uuid = parsed_url.username();
    let host = parsed_url.host_str().unwrap_or("140.245.13.64");
    let port = parsed_url.port().unwrap_or(8443);
    
    let mut sni = String::new();
    let mut insecure = false;

    for (k, v) in parsed_url.query_pairs() {
        if k == "sni" { sni = v.to_string(); }
        if k == "insecure" && v == "1" { insecure = true; }
    }

    let config_json = serde_json::json!({
        "log": { "level": "info" },
        "dns": {
            "servers": [
                { "tag": "remote", "address": "tls://8.8.8.8", "detour": "proxy" },
                { "tag": "local", "address": "https://1.1.1.1/dns-query", "detour": "direct" }
            ],
            "rules": [ { "outbound": "any", "server": "local" } ]
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
                "sniff": true
            }
        ],
        "outbounds": [
            {
                "type": "hysteria2",
                "tag": "proxy",
                "server": host,
                "server_port": port,
                "password": uuid,
                "up_mbps": 100,
                "down_mbps": 100,
                "tls": {
                    "enabled": true,
                    "server_name": sni,
                    "insecure": insecure
                }
            },
            { "type": "direct", "tag": "direct" },
            { "type": "dns", "tag": "dns-out" }
        ],
        "route": {
            "auto_detect_interface": true,
            "rules": [ { "protocol": "dns", "outbound": "dns-out" } ],
            "final": "proxy"
        }
    });

    let app_dir = app.path().app_data_dir().map_err(|_| "Failed to get app dir".to_string())?;
    std::fs::create_dir_all(&app_dir).unwrap_or_default();
    let config_path = app_dir.join("sing-box.json");
    std::fs::write(&config_path, config_json.to_string()).map_err(|e| e.to_string())?;

    let (_rx, child) = app.shell()
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
fn request_close(app: AppHandle) {
    let _ = app.emit("show-quit-dialog", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(VpnState {
            child: Mutex::new(None),
            status: Mutex::new("disconnected".to_string()),
        })
        .setup(|app| {
            kill_orphaned_singbox();

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
                    "quit" => {
                        let state = app.state::<VpnState>();
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
            request_close,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}