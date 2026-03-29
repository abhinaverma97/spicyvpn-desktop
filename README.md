# 🖥️ SpicyVPN Desktop - Multi-Platform Client

A professional, high-performance VPN client built with **Tauri v2** and **Sing-box**. Specifically designed to bypass strict network environments while maintaining a sleek, modern aesthetic.

---

## 🚀 Features
- **One-Click Connectivity:** Instantly tunnel your entire system through SpicyVPN.
- **VLESS-Reality Support:** Uses the most advanced anti-censorship protocol available.
- **Native TUN Interface:** High-speed virtual network adapter for system-wide routing.
- **Real-Time Log Viewer:** Built-in terminal to monitor connection health and troubleshoot issues.
- **Dither UI:** Premium, animated WebGL background for a unique user experience.
- **Lightweight Sidecar:** Powered by a highly-optimized `sing-box` binary.

---

## 🛠️ Tech Stack
- **Frontend:** React + TypeScript + Tailwind CSS.
- **Backend:** Rust (Tauri v2 framework).
- **Core:** Sing-box sidecar.
- **Build System:** Vite.

---

## 🏗️ Development

### Prerequisites
- Node.js (v18+)
- Rust (Stable)
- Tauri CLI (`npm install -g @tauri-apps/cli@next`)

### Setup
```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Build (Release)
```bash
# Generate a production .exe / .dmg / .deb
npm run tauri build
```

---

## 📋 Release History
- **v0.2.21:** Standardized VLESS-Reality connection for daily use.
- **v0.2.18:** Implemented "Strict Tunneling" to defeat college firewalls.
- **v0.2.10:** Added real-time log viewer and clipboard integration.
- **v0.1.0:** Initial stable alpha release.

---

**🌶️ Stay Spicy.**
