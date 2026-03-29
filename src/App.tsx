import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { Power, Clock, X, Minus, ScrollText } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Dither from "./components/Dither";

type Stats = {
  upload: number;
  download: number;
  total: number;
  expire: number;
};

type CloseAction = "quit" | "hide" | null;

export default function App() {
  const [subLink, setSubLink] = useState("");
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false);
  const [closePreference, setClosePreference] = useState<CloseAction>(null);

  useEffect(() => {
    async function loadSettings() {
      const store = await load("settings.bin");
      const savedLink = await store.get<string>("subLink");
      const pref = await store.get<CloseAction>("closePreference");
      
      setClosePreference(pref || null);

      if (savedLink) {
        setSubLink(savedLink);
        fetchStatsFromUri(savedLink);
      } else {
        setIsEditingLink(true);
      }

      const currentStatus = await invoke<string>("get_vpn_status");
      setStatus(currentStatus as any);
    }
    loadSettings();

    const unlistenLogs = listen<string>("vpn-log", (event) => {
      setLogs((prev) => [...prev, event.payload].slice(-200));
    });

    const unlistenStatus = listen<string>("vpn-status-changed", (event) => {
      setStatus(event.payload as any);
    });

    return () => {
      unlistenLogs.then(f => f());
      unlistenStatus.then(f => f());
    };
  }, []);

  async function fetchStatsFromUri(uri: string) {
    try {
      const token = uri.split("://")[1]?.split("@")[0];
      if (!token) return;
      const subUrl = `https://spicypepper.app/api/sub?token=${token}`;
      const res = await invoke<Stats>("fetch_sub_stats", { url: subUrl });
      setStats(res);
      setError("");
    } catch (e: any) {
      console.error("Stats fetch error:", e);
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
      fetchStatsFromUri(subLink);
    } catch (err: any) {
      setError("Failed to save: " + err.toString());
    }
  }

  async function resetConfig() {
    if (!confirm("Reset configuration?")) return;
    try {
      const store = await load("settings.bin");
      await store.delete("subLink");
      await store.save();
      setSubLink("");
      setStats(null);
      setError("");
      setIsEditingLink(true);
      if (status !== "disconnected") await disconnect();
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
      await fetchStatsFromUri(subLink);
      await invoke("start_vpn", { uri: subLink });
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
    navigator.clipboard.writeText(logs.join("")).catch(console.error);
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
      
      {/* Titlebar */}
      <div data-tauri-drag-region className="drag h-10 w-full flex-shrink-0 flex items-center justify-between px-4 z-50 relative">
        <span className="text-[10px] font-bold tracking-widest text-white/30 uppercase italic">SpicyVPN</span>
        <div className="flex items-center gap-1">
          <button onClick={() => invoke("minimize_window")} className="p-1.5 text-white/20 hover:text-white transition-colors no-drag"><Minus className="w-3.5 h-3.5" /></button>
          <button onClick={handleCloseRequest} className="p-1.5 text-white/20 hover:text-red-400 transition-colors no-drag"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <main className="relative flex-1 flex flex-col items-center justify-center p-8 z-10">
        {showLogs ? (
          <div className="w-full h-full flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold flex items-center gap-2 uppercase tracking-widest text-white/50"><ScrollText className="w-4 h-4" /> Trace Logs</h2>
              <div className="flex gap-2">
                <button onClick={copyLogs} className="text-[10px] font-bold uppercase tracking-widest text-white/30 hover:text-white px-3 py-1 bg-white/5 rounded transition-colors">Copy</button>
                <button onClick={() => setShowLogs(false)} className="text-[10px] font-bold uppercase tracking-widest text-white/30 hover:text-white px-3 py-1 bg-white/5 rounded transition-colors">Back</button>
              </div>
            </div>
            <div className="flex-1 bg-black border border-white/5 rounded-lg p-4 font-mono text-[9px] text-blue-400/60 overflow-y-auto whitespace-pre-wrap flex flex-col justify-end">
              {logs.length === 0 ? "// Waiting for telemetry..." : logs.join("")}
            </div>
          </div>
        ) : (
        <AnimatePresence mode="wait">
          {isEditingLink ? (
            <motion.form key="setup" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} className="w-full max-w-sm flex flex-col gap-6" onSubmit={saveLink}>
              <div className="text-center">
                <h2 className="text-2xl font-black uppercase italic tracking-tighter">Initialize</h2>
                <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mt-1">Paste Direct URI (hy2://)</p>
              </div>
              <input type="text" value={subLink} onChange={(e) => setSubLink(e.target.value)} placeholder="hy2://token@host:port..." className="w-full bg-black border border-white/10 rounded-xl px-4 py-4 text-sm outline-none focus:border-white/30 transition-all font-mono placeholder:text-white/10" autoFocus />
              {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] font-bold uppercase p-3 rounded-lg text-center leading-relaxed">{error}</div>}
              <button type="submit" className="w-full bg-white text-black font-black rounded-xl py-4 text-xs uppercase tracking-widest hover:bg-zinc-200 transition-colors">Save Gateway</button>
              <button type="button" onClick={() => invoke("exit_app")} className="text-[10px] font-bold uppercase tracking-widest text-white/20 hover:text-red-400 transition-colors mt-2">Kill Application</button>
            </motion.form>
          ) : (
            <motion.div key="main" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full flex flex-col items-center gap-10">
              <div className="text-center">
                <h1 className={`text-3xl font-black italic tracking-tighter uppercase transition-all duration-700 ${isExpired || isOutOfData ? 'text-red-500' : status === 'connected' ? 'text-white' : 'text-white/40'}`}>
                  {isExpired ? 'Link Expired' : isOutOfData ? 'Limit Hit' : status === 'connected' ? 'Secured' : status === 'connecting' ? 'Handshaking' : 'Dormant'}
                </h1>
                <div className="flex items-center justify-center gap-2 mt-2">
                  <div className={`w-1 h-1 rounded-full ${status === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : status === 'connecting' ? 'bg-blue-500 animate-pulse' : 'bg-zinc-800'}`} />
                  <span className="text-[9px] font-black uppercase tracking-[0.3em] text-white/30">{status === 'connected' ? 'Encrypted' : 'Unprotected'}</span>
                </div>
              </div>

              <button onClick={toggleVpn} disabled={status === 'connecting' || !!isExpired || !!isOutOfData} className={`relative group w-36 h-36 rounded-[2.5rem] flex items-center justify-center transition-all duration-700 border-2
                  ${status === 'connected' ? 'bg-white/10 border-white/20 text-white' : status === 'connecting' ? 'bg-white/5 border-white/10 text-white/40' : isExpired || isOutOfData ? 'bg-red-500/5 border-red-500/10 grayscale opacity-20' : 'bg-transparent border-white/5 text-white/20 hover:border-white/20 hover:text-white'}`}>
                <Power className={`w-14 h-14 transition-all duration-500 ${status === 'connected' ? 'scale-110 drop-shadow-[0_0_20px_rgba(255,255,255,0.4)]' : 'group-hover:scale-105'}`} strokeWidth={status === 'connected' ? 3 : 2} />
              </button>

              <div className="w-full max-w-xs space-y-6">
                {error ? (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-[9px] font-black uppercase p-4 rounded-xl text-center flex flex-col gap-3">
                    <span className="leading-relaxed">{error}</span>
                    <button onClick={() => setIsEditingLink(true)} className="text-white/40 hover:text-white underline decoration-white/10 transition-colors">Resolve Config</button>
                  </div>
                ) : (
                  <>
                    {stats && (
                      <div className="bg-black/40 border border-white/5 rounded-2xl p-5 space-y-3">
                        <div className="flex justify-between items-end">
                          <span className="text-[9px] font-black uppercase tracking-widest text-white/20">Data Payload</span>
                          <span className="text-[10px] font-bold font-mono text-white/60">{formatBytes(usedBytes)} <span className="text-[8px] text-white/20">/</span> {formatBytes(stats.total)}</span>
                        </div>
                        <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                          <div className={`h-full transition-all duration-1000 ${usedPct > 80 || isOutOfData ? 'bg-red-500' : status === 'connected' ? 'bg-emerald-500' : 'bg-zinc-700'}`} style={{ width: `${Math.min(100, usedPct)}%` }} />
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-widest px-2">
                      <span className={`flex items-center gap-1.5 ${isExpired ? 'text-red-500' : 'text-white/30'}`}>
                        <Clock className="w-3 h-3" /> {stats ? `${daysLeft(stats.expire)} D` : 'STATIC'}
                      </span>
                      <div className="flex gap-5">
                        <button onClick={() => setShowLogs(true)} className="hover:text-white text-white/30 transition-colors">Trace</button>
                        <button onClick={() => setIsEditingLink(true)} className="hover:text-white text-white/30 transition-colors">Gate</button>
                        <button onClick={resetConfig} className="hover:text-amber-500 text-white/30 transition-colors">Purge</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        )}

        <AnimatePresence>
          {showCloseModal && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md">
              <motion.div initial={{ scale: 0.95, y: 5 }} animate={{ scale: 1, y: 0 }} className="bg-[#0c0c0e] border border-white/5 rounded-3xl p-8 w-full max-w-xs shadow-2xl">
                <h3 className="text-xl font-black italic uppercase tracking-tighter mb-2">Power Down?</h3>
                <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-8 leading-relaxed">System termination behavior</p>
                <div className="space-y-3">
                  <button onClick={() => executeCloseAction("hide")} className="w-full bg-white/5 hover:bg-white/10 border border-white/5 text-white rounded-2xl py-4 text-[10px] font-black uppercase tracking-widest transition-all">Minimize to Tray</button>
                  <button onClick={() => executeCloseAction("quit")} className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/5 text-red-400 rounded-2xl py-4 text-[10px] font-black uppercase tracking-widest transition-all">Kill Instance</button>
                </div>
                <div className="mt-8 flex items-center gap-3 justify-center">
                   <label className="flex items-center gap-2 cursor-pointer group">
                     <div className="relative">
                       <input type="checkbox" checked={rememberCloseChoice} onChange={(e) => setRememberCloseChoice(e.target.checked)} className="sr-only peer" />
                       <div className="w-4 h-4 border border-white/10 rounded peer-checked:bg-white transition-all" />
                       <CheckIcon className="absolute inset-0 w-4 h-4 text-black scale-0 peer-checked:scale-100 transition-transform" />
                     </div>
                     <span className="text-[9px] font-black uppercase tracking-widest text-white/20 group-hover:text-white/40">Cache Selection</span>
                   </label>
                </div>
                <button onClick={() => setShowCloseModal(false)} className="w-full mt-6 text-[9px] font-black uppercase tracking-[0.2em] text-white/10 hover:text-white transition-colors">Abort</button>
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
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={5} {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
