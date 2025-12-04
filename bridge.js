(function () {
  if (window.__FEN_BRIDGE__) return;
  window.__FEN_BRIDGE__ = true;

  const handler = (ev) => {
    const fen = ev?.detail;
    if (typeof fen !== 'string') return;
    chrome.runtime.sendMessage({ type: 'FEN', fen }).catch(() => {});
  };

  window.addEventListener('FENPush', handler, false);
})();
