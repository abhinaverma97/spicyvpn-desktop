import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { Power, Clock, X, Minus, ScrollText, Copy, LogOut, AlertTriangle, Wifi, Settings, RotateCcw, ExternalLink } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Dither from "./components/Dither";

type Stats = {
  upload: number;
  download: number;
  total: number;
  expire: number;
  name?: string;
  email?: string;
};

type CloseAction = "quit" | "hide" | null;

export default function App() {
  const [subLink, setSubLink] = useState("");
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [gamingMode, setGamingMode] = useState(false);

  // Logs state
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  
  // Close behavior states
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false);
  const [closePreference, setClosePreference] = useState<CloseAction>(null);

  useEffect(() => {
    async function loadSettings() {
      const store = await load("settings.bin");
      const savedLink = await store.get<string>("subLink");
      const pref = await store.get<CloseAction>("closePreference");
      const savedGamingMode = await store.get<boolean>("gamingMode");
      
      setClosePreference(pref || null);
      if (savedGamingMode !== undefined) setGamingMode(savedGamingMode);

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

    const unlistenLogs = listen<string>("vpn-log", (event) => {
      setLogs((prev) => [...prev, event.payload].slice(-200)); // Keep last 200 lines
    });

    const unlistenStatus = listen<string>("vpn-status-changed", (event) => {
      setStatus(event.payload as any);
    });

    return () => {
      unlistenLogs.then(f => f());
      unlistenStatus.then(f => f());
    };
  }, []);

  async function fetchStats(link: string) {
    let targetUrl = link;
    if (link.startsWith("hy2://") || link.startsWith("dhv2://")) {
      const token = link.split("://")[1]?.split("@")[0];
      if (!token) return;
      targetUrl = `https://spicypepper.app/api/sub?token=${token}`;
    }

    try {
      const res = await invoke<Stats>("fetch_sub_stats", { url: targetUrl });
      setStats(res);
      setError("");
    } catch (e: any) {
      console.error(e);
      setError(e.toString());
    }
  }

  async function toggleGamingMode() {
    if (status !== "disconnected") return;
    const newVal = !gamingMode;
    setGamingMode(newVal);
    const store = await load("settings.bin");
    await store.set("gamingMode", newVal);
    await store.save();
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

  async function resetConfig() {
    if (!confirm("Are you sure you want to reset your configuration? This will clear your subscription link.")) return;
    try {
      const store = await load("settings.bin");
      await store.delete("subLink");
      await store.save();
      setSubLink("");
      setStats(null);
      setError("");
      setIsEditingLink(true);
      if (status === "connected") await disconnect();
    } catch (err: any) {
      setError("Reset failed: " + err.toString());
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
    setLogs([]);
    try {
      await fetchStats(subLink);
      await invoke("start_vpn", { url: subLink, gamingMode });
      // Status will be updated via 'vpn-status-changed' event
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

  async function handleCloseRequest() {
    if (closePreference === "quit") {
      invoke("exit_app");
    } else if (closePreference === "hide") {
      invoke("hide_window");
    } else {
      setShowCloseModal(true);
    }
  }

  function copyLogs() {
    const logText = logs.join("");
    navigator.clipboard.writeText(logText).catch(console.error);
  }

  async function executeCloseAction(action: "quit" | "hide") {
    if (rememberCloseChoice) {
      const store = await load("settings.bin");
      await store.set("closePreference", action);
      await store.save();
      setClosePreference(action);
    }
    
    setShowCloseModal(false);
    if (action === "quit") {
      invoke("exit_app");
    } else {
      invoke("hide_window");
    }
  }

  function formatBytes(bytes: number) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1024).toFixed(0) + " KB";
  }

  function daysLeft(expiresAt: number) {
    const diff = expiresAt * 1000 - Date.now();
    return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
  }

  const usedBytes = stats ? (stats.upload + stats.download) : 0;
  const usedPct = stats && stats.total > 0 ? (usedBytes / stats.total) * 100 : 0;
  const isExpired = stats && stats.expire > 0 && stats.expire * 1000 < Date.now();
  const isOutOfData = stats && stats.total > 0 && usedBytes >= stats.total;

  return (
    <div className="relative w-full h-screen bg-[#09090b] text-white flex flex-col overflow-hidden">
      <Dither />
      
      {/* Custom Titlebar */}
      <div data-tauri-drag-region className="drag h-10 w-full flex-shrink-0 flex items-center justify-between px-4 z-50 relative">
        <div className="flex items-center gap-2 pointer-events-none">
          <span className="text-xs font-semibold tracking-wide text-white/70">SpicyVPN</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => invoke("minimize_window")} className="p-1.5 text-white/40 hover:text-white hover:bg-white/10 rounded-md transition-colors no-drag">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleCloseRequest} className="p-1.5 text-white/40 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors no-drag">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <main className="relative flex-1 flex flex-col items-center justify-center p-6 z-10 w-full h-full">
        
        {showLogs ? (
          <div className="w-full h-full flex flex-col pt-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2"><ScrollText className="w-5 h-5" /> Connection Logs</h2>
              <div className="flex items-center gap-2">
                <button onClick={copyLogs} className="text-xs flex items-center gap-1 text-white/40 hover:text-white px-3 py-1 bg-white/5 rounded-md transition-colors"><Copy className="w-3 h-3"/> Copy</button>
                <button onClick={() => setShowLogs(false)} className="text-xs text-white/40 hover:text-white px-3 py-1 bg-white/5 rounded-md transition-colors">Back</button>
              </div>
            </div>
            <div className="flex-1 bg-black/50 border border-white/10 rounded-lg p-4 font-mono text-[10px] text-emerald-400/80 overflow-y-auto whitespace-pre-wrap flex flex-col justify-end">
              {logs.length === 0 ? "No logs yet..." : logs.join("")}
            </div>
          </div>
        ) : (
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
              <button 
                type="button"
                onClick={() => invoke("exit_app")}
                className="w-full mt-2 text-white/20 hover:text-red-400 text-xs py-2 transition-colors flex items-center justify-center gap-2"
              >
                <LogOut className="w-3 h-3" /> Quit Application
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
                <h1 className={`text-2xl font-black tracking-tight transition-colors duration-500 ${isExpired || isOutOfData ? 'text-red-500' : status === 'connected' ? 'text-white' : 'text-white/40'}`}>
                  {isExpired ? 'Subscription Expired' : isOutOfData ? 'Data Limit Reached' : status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Unprotected'}
                </h1>
                <p className="text-sm text-white/40 mt-1">
                  {isExpired || isOutOfData ? 'Please renew your plan' : status === 'connected' ? 'Your traffic is encrypted & hidden' : 'VPN is currently offline'}
                </p>
              </div>

              {/* Main Toggle Button */}
              <button
                onClick={toggleVpn}
                disabled={status === 'connecting' || !!isExpired || !!isOutOfData}
                className={`relative group w-32 h-32 rounded-3xl flex items-center justify-center transition-all duration-500
                  ${status === 'connected'
                    ? 'bg-white/10 border-white/30 text-white'
                    : status === 'connecting'
                    ? 'bg-white/5 border-white/20 text-white/70'
                    : isExpired || isOutOfData
                    ? 'bg-red-500/5 border-red-500/20 text-red-500/30 grayscale'
                    : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white hover:border-white/20'}
                  border-2 shadow-2xl`}
              >
                <Power className={`w-12 h-12 transition-transform duration-300 ${status === 'connected' ? 'scale-110 drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]' : 'group-hover:scale-105'}`} />
              </button>
              {/* Stats & Info */}
              <div className="w-full space-y-4">
                {error ? (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-3 rounded-lg text-center break-words flex flex-col items-center gap-3">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>{error}</span>
                    </div>
                    <div className="flex items-center gap-4 w-full">
                      <button 
                        onClick={() => invoke("open_browser", { url: "https://spicypepper.app/dashboard" })} 
                        className="flex-1 flex justify-center items-center gap-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 py-1.5 rounded-md transition-colors"
                      >
                        Renew Plan <ExternalLink className="w-3 h-3" />
                      </button>
                      <button 
                        onClick={() => setIsEditingLink(true)} 
                        className="flex-1 text-white/40 hover:text-white underline decoration-white/10 transition-colors"
                      >
                        Try another link
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-3">
                      <div 
                        className={`w-full bg-transparent border border-white/5 rounded-xl p-4 transition-all relative group ${status !== "disconnected" ? 'opacity-50' : 'hover:border-white/10'}`}
                      >
                        <div className="flex justify-between items-center mb-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-white/70">Gaming Mode</span>
                          </div>
                          
                          <button 
                            onClick={toggleGamingMode}
                            disabled={status !== "disconnected"}
                            className={`w-8 h-4.5 rounded-full relative transition-all duration-300 outline-none ${gamingMode ? 'bg-emerald-500' : 'bg-white/10'} ${status === "disconnected" ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                          >
                            <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-300 ${gamingMode ? 'left-[16px]' : 'left-[2px]'}`} />
                          </button>
                        </div>
                        <p className="text-[10px] text-white/20">Optimized for low-latency gaming only (3Mbps Limit)</p>
                      </div>

                      <div className="bg-black/50 border border-white/5 rounded-xl p-4">
                        <div className="flex justify-between text-xs text-white/50 mb-2">
                          <span className="flex items-center gap-1.5"><Wifi className="w-3 h-3"/> Data Usage</span>
                          <span>{stats ? `${formatBytes(usedBytes)} / ${formatBytes(stats.total)}` : 'Loading...'}</span>
                        </div>
                        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full transition-all duration-1000 ${usedPct > 80 || isOutOfData ? 'bg-red-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(100, usedPct)}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs text-white/40 px-2">
                      <span className={`flex items-center gap-1.5 ${isExpired ? 'text-red-400' : ''}`}>
                        <Clock className="w-3 h-3" /> 
                        {stats ? `${daysLeft(stats.expire)} days left` : '--'}
                      </span>
                      <div className="flex gap-4">
                        <button 
                          onClick={() => setShowLogs(true)}
                          className="flex items-center gap-1 hover:text-white transition-colors"
                        >
                          <ScrollText className="w-3 h-3" /> Logs
                        </button>
                        <button 
                          onClick={() => setIsEditingLink(true)}
                          className="flex items-center gap-1 hover:text-white transition-colors"
                        >
                          <Settings className="w-3 h-3" /> Config
                        </button>
                        <button 
                          onClick={resetConfig}
                          className="flex items-center gap-1 hover:text-amber-400 transition-colors"
                        >
                          <RotateCcw className="w-3 h-3" /> Reset
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

            </motion.div>
          )}
        </AnimatePresence>
        )}

        {/* Close Choice Modal */}
        <AnimatePresence>
          {showCloseModal && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 10 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-[#0c0c0e] border border-white/10 rounded-2xl p-6 w-full max-w-xs shadow-2xl"
              >
                <h3 className="text-lg font-bold mb-2">Close SpicyVPN?</h3>
                <p className="text-xs text-white/40 mb-6 leading-relaxed">Choose how you want to handle the application when clicking the close button.</p>
                
                <div className="space-y-2">
                  <button 
                    onClick={() => executeCloseAction("hide")}
                    className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl py-3 text-sm font-semibold transition-colors flex flex-col items-center"
                  >
                    <span>Minimize to Tray</span>
                    <span className="text-[10px] opacity-40 font-normal">VPN stays connected</span>
                  </button>
                  <button 
                    onClick={() => executeCloseAction("quit")}
                    className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-xl py-3 text-sm font-semibold transition-colors flex flex-col items-center"
                  >
                    <span>Quit Application</span>
                    <span className="text-[10px] opacity-40 font-normal">VPN will disconnect</span>
                  </button>
                </div>

                <div className="mt-6 flex items-center gap-3 justify-center">
                   <label className="flex items-center gap-2 cursor-pointer group">
                     <div className="relative">
                       <input 
                        type="checkbox" 
                        checked={rememberCloseChoice}
                        onChange={(e) => setRememberCloseChoice(e.target.checked)}
                        className="sr-only peer"
                       />
                       <div className="w-4 h-4 border border-white/20 rounded peer-checked:bg-white peer-checked:border-white transition-all" />
                       <CheckIcon className="absolute inset-0 w-4 h-4 text-black scale-0 peer-checked:scale-100 transition-transform" />
                     </div>
                     <span className="text-[11px] text-white/30 group-hover:text-white/50 transition-colors">Remember my choice</span>
                   </label>
                </div>

                <button 
                  onClick={() => setShowCloseModal(false)}
                  className="w-full mt-4 text-[11px] text-white/20 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

      </main>
    </div>
  );
}

function CheckIcon(props: any) {
  return (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4} {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
