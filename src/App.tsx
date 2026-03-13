import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { Power, Wifi, Clock, Settings, X, Minus } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import Dither from "./components/Dither";

type Stats = {
  upload: number;
  download: number;
  total: number;
  expire: number;
};

export default function App() {
  const [subLink, setSubLink] = useState("");
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  
  // Dialog State
  const [showQuitDialog, setShowQuitDialog] = useState(false);
  const [rememberQuitChoice, setRememberQuitChoice] = useState(false);
  
  const appWindow = getCurrentWindow();

  useEffect(() => {
    async function loadSettings() {
      const store = await load("settings.bin");
      const savedLink = await store.get<string>("subLink");
      if (savedLink) {
        setSubLink(savedLink);
        fetchStats(savedLink);
      } else {
        setIsEditingLink(true);
      }

      const currentStatus = await invoke<string>("get_vpn_status");
      setStatus(currentStatus as any);
    }
    loadSettings();
    
    const unlistenQuit = listen("show-quit-dialog", async () => {
      const store = await load("settings.bin");
      const quitAction = await store.get<string>("quitAction");
      
      if (quitAction === "quit") {
        await invoke("stop_vpn");
        await invoke("exit_app");
      } else if (quitAction === "minimize") {
        await appWindow.hide();
      } else {
        setShowQuitDialog(true);
      }
    });

    return () => {
      unlistenQuit.then((f) => f());
    };
  }, []);

  async function handleQuitDialog(action: "quit" | "minimize") {
    if (rememberQuitChoice) {
      const store = await load("settings.bin");
      await store.set("quitAction", action);
      await store.save();
    }
    
    setShowQuitDialog(false);
    
    if (action === "quit") {
      await invoke("stop_vpn");
      await invoke("exit_app");
    } else {
      await appWindow.hide();
    }
  }

  async function fetchStats(link: String) {
    try {
      const res = await invoke<Stats>("fetch_sub_stats", { url: link });
      setStats(res);
      setError("");
    } catch (e: any) {
      console.error(e);
      setError(e.toString());
      if (e.toString().includes("403") || e.toString().includes("404")) {
         if (status === "connected") {
           await disconnect();
         }
      }
    }
  }

  async function saveLink(e: React.FormEvent) {
    e.preventDefault();
    if (!subLink) return;
    try {
      const store = await load("settings.bin");
      await store.set("subLink", subLink);
      await store.save();
      setIsEditingLink(false);
      fetchStats(subLink);
    } catch (err: any) {
      console.error("Save error", err);
      setError("Failed to save settings: " + err.toString());
    }
  }

  async function toggleVpn() {
    if (!subLink) {
      setIsEditingLink(true);
      return;
    }

    if (status === "connected" || status === "connecting") {
      await disconnect();
    } else {
      await connect();
    }
  }

  async function connect() {
    setStatus("connecting");
    setError("");
    try {
      const latestStats = await invoke<Stats>("fetch_sub_stats", { url: subLink });
      setStats(latestStats);
      await invoke("start_vpn", { url: subLink });
      setStatus("connected");
    } catch (e: any) {
      setError(e.toString());
      setStatus("disconnected");
    }
  }

  async function disconnect() {
    try {
      await invoke("stop_vpn");
    } catch (e) {
      console.error(e);
    }
    setStatus("disconnected");
  }

  function formatBytes(bytes: number) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + " MB";
    return (bytes / 1e3).toFixed(0) + " KB";
  }

  function daysLeft(expiresAt: number) {
    const diff = expiresAt * 1000 - Date.now();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  const usedBytes = stats ? (stats.upload + stats.download) : 0;
  const usedPct = stats && stats.total > 0 ? (usedBytes / stats.total) * 100 : 0;

  return (
    <div className="relative w-full h-screen bg-[#09090b] text-white flex flex-col overflow-hidden">
      <Dither />
      
      {/* Custom Titlebar */}
      <div data-tauri-drag-region className="drag h-10 w-full flex-shrink-0 flex items-center justify-between px-4 z-50 relative">
        <div className="flex items-center gap-2 pointer-events-none">
          <span className="text-xs font-semibold tracking-wide text-white/70">SpicyVPN</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => appWindow.minimize()} className="p-1.5 text-white/40 hover:text-white hover:bg-white/10 rounded-md transition-colors no-drag">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => invoke("request_close")} className="p-1.5 text-white/40 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors no-drag">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <main className="relative flex-1 flex flex-col items-center justify-center p-6 z-10 w-full h-full">
        
        <AnimatePresence mode="wait">
          {isEditingLink ? (
            <motion.form 
              key="setup"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="w-full flex flex-col gap-4 relative z-20"
              onSubmit={saveLink}
            >
              <div className="text-center mb-2">
                <h2 className="text-lg font-semibold">Setup Connection</h2>
                <p className="text-xs text-white/40">Paste your SpicyVPN subscription link</p>
              </div>
              <input
                type="text"
                value={subLink}
                onChange={(e) => setSubLink(e.target.value)}
                placeholder="https://spicypepper.app/api/sub?token=..."
                className="w-full bg-black border border-white/10 rounded-lg px-4 py-3 text-sm outline-none focus:border-white/30 transition-colors placeholder:text-white/20"
                autoFocus
              />
              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-3 rounded-lg text-center break-words">
                  {error}
                </div>
              )}
              <button 
                type="submit" 
                className="w-full cursor-pointer pointer-events-auto bg-white text-black font-semibold rounded-lg py-3 text-sm hover:bg-white/90 transition-colors"
              >
                Save & Continue
              </button>
            </motion.form>
          ) : (
            <motion.div 
              key="main"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full flex flex-col items-center gap-8"
            >
              {/* Status Header */}
              <div className="text-center">
                <h1 className={`text-2xl font-black tracking-tight transition-colors duration-500 text-white`}>
                  {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Unprotected'}
                </h1>
                <p className="text-sm text-white/40 mt-1">
                  {status === 'connected' ? 'Your traffic is encrypted & hidden' : 'VPN is currently offline'}
                </p>
              </div>

              {/* Main Toggle Button */}
              <button
                onClick={toggleVpn}
                disabled={status === 'connecting'}
                className={`relative group w-32 h-32 rounded-3xl flex items-center justify-center transition-all duration-500
                  ${status === 'connected'
                    ? 'bg-white/10 border-white/30 text-white'
                    : status === 'connecting'
                    ? 'bg-white/5 border-white/20 text-white/70'
                    : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white hover:border-white/20'}
                  border-2 shadow-2xl`}
              >
                <Power className={`w-12 h-12 transition-transform duration-300 ${status === 'connected' ? 'scale-110 drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]' : 'group-hover:scale-105'}`} />
              </button>
              {/* Stats & Info */}
              <div className="w-full space-y-4">
                {error ? (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-3 rounded-lg text-center break-words">
                    {error}
                  </div>
                ) : (
                  <>
                    <div className="bg-black/50 border border-white/5 rounded-xl p-4">
                      <div className="flex justify-between text-xs text-white/50 mb-2">
                        <span className="flex items-center gap-1.5"><Wifi className="w-3 h-3"/> Data Usage</span>
                        <span>{stats ? `${formatBytes(usedBytes)} / ${formatBytes(stats.total)}` : 'Loading...'}</span>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-all duration-1000 ${usedPct > 80 ? 'bg-red-500' : 'bg-emerald-500'}`}
                          style={{ width: `${Math.min(100, usedPct)}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs text-white/40 px-2">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3" /> 
                        {stats ? `${daysLeft(stats.expire)} days left` : '--'}
                      </span>
                      <button 
                        onClick={() => setIsEditingLink(true)}
                        className="flex items-center gap-1 hover:text-white transition-colors"
                      >
                        <Settings className="w-3 h-3" /> Config
                      </button>
                    </div>
                  </>
                )}
              </div>

            </motion.div>
          )}
        </AnimatePresence>

      </main>

      {/* Quit Dialog Overlay */}
      <AnimatePresence>
        {showQuitDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="bg-[#09090b] border border-white/10 p-5 rounded-2xl w-full max-w-sm shadow-2xl flex flex-col gap-5"
            >
              <div>
                <h3 className="text-lg font-bold text-white mb-1">Close SpicyVPN?</h3>
                <p className="text-xs text-white/50 leading-relaxed">
                  Quitting will stop the VPN connection. You can minimize to the system tray to keep it running in the background.
                </p>
              </div>

              <div className="flex items-center gap-2 px-1">
                <input 
                  type="checkbox" 
                  id="remember" 
                  checked={rememberQuitChoice}
                  onChange={(e) => setRememberQuitChoice(e.target.checked)}
                  className="w-4 h-4 rounded border-white/20 bg-black accent-white"
                />
                <label htmlFor="remember" className="text-xs text-white/60 cursor-pointer select-none">
                  Remember my choice
                </label>
              </div>

              <div className="flex gap-2">
                <button 
                  onClick={() => handleQuitDialog("quit")}
                  className="flex-1 py-2 rounded-lg border border-red-500/20 text-red-400 text-xs font-semibold hover:bg-red-500/10 transition-colors"
                >
                  Quit App
                </button>
                <button 
                  onClick={() => handleQuitDialog("minimize")}
                  className="flex-1 py-2 rounded-lg bg-white text-black text-xs font-semibold hover:bg-white/90 transition-colors"
                >
                  Minimize to Tray
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}