function $(sel) { return document.querySelector(sel); }

let currentTabId = null;
let lastFenAt = 0;

function formatAge(ms) {
  if (!ms) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return `${s}s`;
}

function updateFen(fen) {
  $("#fen").textContent = fen || "—";
  lastFenAt = Date.now();
  tickAge();
}

function updateStatus({ showStatus, wsState, inflight }) {
  const statusEl = $("#status");
  if (!showStatus) {
    statusEl.style.display = "none";
    return;
  }
  statusEl.style.display = "block";

  const dot = $("#dot");
  const state = $("#state");

  dot.className = "dot";
  switch (wsState) {
    case "connected":   dot.classList.add("connected"); state.textContent = inflight ? "Sending…" : "Connected"; break;
    case "connecting":  dot.classList.add("connecting"); state.textContent = "Reconnecting…"; break;
    default:            dot.classList.add("disconnected"); state.textContent = "Disconnected";
  }
  if (inflight) dot.classList.add("sending");
}

function tickAge() {
  if (!lastFenAt) { $("#age").textContent = ""; return; }
  $("#age").textContent = formatAge(Date.now() - lastFenAt);
}

async function getActiveTabId() {
    // chrome api magic don’t question it
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0]?.id ?? -1);
    });
  });
}

async function refresh() {
  currentTabId = await getActiveTabId();
  chrome.runtime.sendMessage({ type: "getStatus", tabId: currentTabId }, (res) => {
    if (!res || !res.ok) return;
    updateFen(res.fen);
    updateStatus(res);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "fenUpdate" && msg.tabId === currentTabId) {
    updateFen(msg.fen);
  }
  if (msg?.type === "wsStatus") {
    updateStatus({ showStatus: true, wsState: msg.state, inflight: false });
  }
  if (msg?.type === "sending" && msg.tabId === currentTabId) {
    updateStatus({ showStatus: true, wsState: "connected", inflight: true });
    setTimeout(() => {
      updateStatus({ showStatus: true, wsState: "connected", inflight: false });
    }, 1000);
  }
  if (msg?.type === "serverMessage") {
  }
});

setInterval(tickAge, 500);

refresh();