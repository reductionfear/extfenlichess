const WS_URL = "ws://localhost:8085";
const DEFAULT_DEPTH = 16;

let ws = null;
let ready = false;
const queue = [];
let reconnectTimer = null;

const lastFenByTab = new Map();
const lastKeyByTab = new Map();
const inflightByTab = new Map();
let hasEverSent = false;        
let lastServerMessage = null;

function wsState() {
  if (!ws) return "disconnected";
  switch (ws.readyState) {
    case WebSocket.CONNECTING: return "connecting";
    case WebSocket.OPEN:       return "connected";
    case WebSocket.CLOSING:    return "connecting";
    case WebSocket.CLOSED:     return "disconnected";
    default: return "disconnected";
  }
}

// yeah broadcast sometimes fails randomly but its fine
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    broadcast({ type: "wsStatus", state: wsState() });
    return;
  }

  ws.onopen = () => {
    ready = true;
    broadcast({ type: "wsStatus", state: "connected" });
    flushQueue();
  };

  ws.onclose = () => {
    ready = false;
    broadcast({ type: "wsStatus", state: "disconnected" });
    scheduleReconnect();
  };

  ws.onerror = () => {
    ready = false;
    try { ws.close(); } catch (_) {}
    broadcast({ type: "wsStatus", state: "disconnected" });
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      lastServerMessage = data;
      broadcast({ type: "serverMessage", payload: data });
    } catch {
    }
  };

  broadcast({ type: "wsStatus", state: wsState() });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  broadcast({ type: "wsStatus", state: "connecting" });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 1000);
}

function flushQueue() {
  while (ready && queue.length) {
    try {
      ws.send(JSON.stringify(queue.shift()));
    } catch {
      break;
    }
  }
}

function keyFromFen(fen) {
  if (typeof fen !== "string") return null;
  const parts = fen.trim().split(/\s+/);
  const placement = parts[0] || "";
  const active = parts[1] || "";
  return placement + "|" + active;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // i don’t wanna touch this again it works
  if (msg?.type === "getStatus") {
    const tabId = msg.tabId ?? sender?.tab?.id ?? -1;
    const fen = lastFenByTab.get(tabId) || "";
    const state = wsState();
    const showStatus = hasEverSent;
    const inflight = !!(inflightByTab.get(tabId) && Date.now() - inflightByTab.get(tabId) < 1200);
    sendResponse?.({
      ok: true,
      fen,
      wsState: state,
      showStatus,
      inflight,
      lastServerMessage
    });
    return true;
  }

  if (msg?.type === "FEN" && typeof msg.fen === "string") {
    const tabId = sender?.tab?.id ?? -1;
    lastFenByTab.set(tabId, msg.fen);

    const key = keyFromFen(msg.fen);
    if (!key) {
      sendResponse?.({ ok: false, reason: "bad_fen" });
      return true;
    }

    if (lastKeyByTab.get(tabId) === key) {
      broadcast({ type: "fenUpdate", tabId, fen: msg.fen });
      sendResponse?.({ ok: true, dedup: true });
      return true;
    }
    lastKeyByTab.set(tabId, key);

    const payload = { type: "analysis", fen: msg.fen, depth: DEFAULT_DEPTH };
    hasEverSent = true;
    broadcast({ type: "wsStatus", state: wsState() });

    const sendNow = () => {
      try {
        ws.send(JSON.stringify(payload));
        inflightByTab.set(tabId, Date.now());
        broadcast({ type: "sending", tabId });
      } catch {
        queue.push(payload);
        connectWS();
        broadcast({ type: "wsStatus", state: wsState() });
      }
    };

    if (ready && ws?.readyState === WebSocket.OPEN) {
      sendNow();
    } else {
      queue.push(payload);
      connectWS();
      broadcast({ type: "wsStatus", state: wsState() });
    }

    broadcast({ type: "fenUpdate", tabId, fen: msg.fen });
    sendResponse?.({ ok: true });
    return true;
  }
});

const MATCHES = [
  "*://*.chess.com/*",
  "*://chess.com/*",
  "*://*.lichess.org/*",
  "*://lichess.org/*",
  "*://*.chess24.com/*",
  "*://chess24.com/*",
  "<all_urls>"
];

function urlRoughMatches(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (
      host.endsWith("chess.com") ||
      host.endsWith("lichess.org") ||
      host.endsWith("chess24.com")
    ) return true;
  } catch {}
  return true;
}

async function injectAll(tabId) {
  if (!tabId || tabId < 0) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["bridge.js"]
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["mainListener.js"]
    });
  } catch (e) {
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab?.url && urlRoughMatches(tab.url)) {
    injectAll(tabId);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url && urlRoughMatches(tab.url)) {
      injectAll(activeInfo.tabId);
    }
  } catch {}
});

chrome.runtime.onInstalled.addListener(() => {
  connectWS();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id && urlRoughMatches(tabs[0].url)) injectAll(tabs[0].id);
  });
});
chrome.runtime.onStartup.addListener(connectWS);
