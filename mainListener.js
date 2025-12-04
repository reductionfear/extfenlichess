(function () {
  if (window.__FEN_LISTENER__) return;

  const dispatch = (fen) => {
    if (!fen) return;
    // Ensure we handle basic padding if Lichess sends short FEN
    window.dispatchEvent(new CustomEvent('FENPush', { detail: fen }));
  };

  // --- LICHESS WEBSOCKET INTERCEPTOR ---
  if (window.location.hostname.includes('lichess.org')) {
    try {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct: function (target, args) {
          const ws = new target(...args);
          
          // Store WebSocket reference globally for automove
          if (typeof webSocketWrapper !== 'undefined') {
            webSocketWrapper = ws;
            console.log('[FEN Live] WebSocket reference stored for automove');
          }
          
          ws.addEventListener("message", function (event) {
            try {
              const msg = JSON.parse(event.data);
              
              // Handle gameFull message type - extract gameId and determine player color
              if (msg.t === 'gameFull' || msg.type === 'gameFull') {
                if (typeof gameId !== 'undefined') {
                  if (msg.id) {
                    gameId = msg.id;
                  } else if (msg.d && msg.d.id) {
                    gameId = msg.d.id;
                  }
                  console.log('[FEN Live] Game ID set:', gameId);
                }
                
                // Determine if playing as white
                if (typeof isWhite !== 'undefined') {
                  if (msg.d && msg.d.player && msg.d.player.color) {
                    isWhite = msg.d.player.color === 'white';
                    console.log('[FEN Live] Playing as:', isWhite ? 'white' : 'black');
                  }
                }
              }
              
              // Handle gameState message type - detect game end (status >= 30)
              if (msg.t === 'gameState' || msg.type === 'gameState') {
                const status = msg.status || (msg.d && msg.d.status);
                if (status && status >= 30) {
                  if (typeof handleGameEnd === 'function') {
                    handleGameEnd();
                  }
                  return;
                }
              }
              
              // Logic adapted from your fen.txt
              if (msg.t === 'd' || msg.t === 'move') {
                if (msg.d && typeof msg.d.fen === "string") {
                  let fenStr = msg.d.fen;
                  
                  // Calculate active color based on ply
                  // ply even = white's turn, ply odd = black's turn
                  const isWhitesTurn = msg.d.ply % 2 === 0;
                  
                  // Lichess FEN often lacks the active color in these messages
                  if (!fenStr.includes(' w ') && !fenStr.includes(' b ')) {
                     fenStr += isWhitesTurn ? " w" : " b";
                  }
                  
                  // Complete the FEN and store it globally for automove
                  if (typeof completeFen === 'function') {
                    const completedFen = completeFen(fenStr);
                    if (typeof currentFen !== 'undefined') {
                      currentFen = completedFen;
                    }
                  }
                  
                  // Add dummies for castling/ep/clocks if missing to ensure proper processing
                  // The existing splitFen below handles '-' padding, but let's be safe
                  dispatch(fenStr);
                  
                  // Trigger move calculation if automove is enabled and it's our turn
                  if (typeof calculateMove === 'function' && typeof autoMoveEnabled !== 'undefined' && autoMoveEnabled) {
                    // Check if it's our turn to move
                    if (typeof isWhite !== 'undefined') {
                      if ((isWhite && isWhitesTurn) || (!isWhite && !isWhitesTurn)) {
                        calculateMove();
                      }
                    }
                  }
                }
              }
            } catch (e) {
              // Ignore non-JSON or unrelated messages
            }
          });
          return ws;
        }
      });
      
      // Copy constants to ensure compatibility
      window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      window.WebSocket.OPEN = NativeWebSocket.OPEN;
      window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
      window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
      
      // Initialize chess engine if Stockfish is available
      if (typeof initializeChessEngine === 'function' && typeof window.STOCKFISH !== 'undefined') {
        initializeChessEngine().then(() => {
          console.log('[FEN Live] Chess engine integration ready');
        }).catch((err) => {
          console.log('[FEN Live] Chess engine not available:', err.message);
        });
      }
      
    } catch (e) {
      console.error("[FEN Live] Lichess hook failed:", e);
    }
  }
  // --- END LICHESS INTERCEPTOR ---

  const SELECTOR = 'wc-chess-board, chess-board';
  const STABLE_DELAY_MS = 220;
  const CONFIRM_DELAY_MS = 120;
  const MAX_WAIT_MS = 1500;

  const getFEN = () => {
    try {
      const el = document.querySelector(SELECTOR);
      const fen = el?.game?.getFEN?.();
      return typeof fen === 'string' ? fen.trim() : null;
    } catch { return null; }
  };

  const splitFen = (fen) => {
    if (!fen) return null;
    const parts = fen.split(/\s+/);
    while (parts.length < 6) parts.push('-');
    return {
      placement: parts[0],
      active: parts[1] || '?',
      castling: parts[2] || '-',
      ep: parts[3] || '-',
      half: parts[4] || '0',
      full: parts[5] || '1',
      raw: fen
    };
  };

  let lastSentPlacement = null;
  let lastSentActive = null;
  let settleTimer = null;
  let confirmTimer = null;
  let pending = false;

  const clearTimers = () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  };

  const stableEmit = () => {
    pending = true;
    const start = performance.now();

    const attempt = () => {
      const fen1 = getFEN();
      const f1 = splitFen(fen1);
      if (!f1) { pending = false; return; }

      confirmTimer = setTimeout(() => {
        const fen2 = getFEN();
        const f2 = splitFen(fen2);
        if (!f2) { pending = false; return; }

        const unchanged = f2.placement === f1.placement && f2.active === f1.active;

        const isNewPosition =
          f2.placement !== lastSentPlacement || f2.active !== lastSentActive;

        if (isNewPosition && unchanged) {
          lastSentPlacement = f2.placement;
          lastSentActive = f2.active;
          dispatch(f2.raw);
          pending = false;
        } else {
          if (performance.now() - start < MAX_WAIT_MS) {
            settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
          } else {
            pending = false;
          }
        }
      }, CONFIRM_DELAY_MS);
    };

    settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
  };

  const onAnyChange = () => {
    if (pending) return;
    stableEmit();
  };

  const initial = getFEN();
  const fi = splitFen(initial);
  if (fi) {
    lastSentPlacement = fi.placement;
    lastSentActive = fi.active;
    dispatch(fi.raw);
  }

  const el = document.querySelector(SELECTOR);
  const ctrl = el?.game;

  if (ctrl && typeof ctrl.on === 'function') {
    ctrl.on?.('Move', onAnyChange);
    ctrl.on?.('Undo', onAnyChange);
    ctrl.on?.('ResetGame', onAnyChange);
    ctrl.on?.('LoadFen', onAnyChange);
    window.__FEN_LISTENER__ = { type: 'events', clearTimers };
    return;
  }

  if (el && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(onAnyChange);
    mo.observe(el, { attributes: true, childList: true, subtree: true });
    window.__FEN_LISTENER__ = { type: 'mutation', mo, clearTimers };
    return;
  }

  // Fallback poller (keeps running even if Lichess hook is active, just in case)
  const iv = setInterval(onAnyChange, 300);
  window.__FEN_LISTENER__ = { type: 'poll', iv, clearTimers };
})();

(function () {
  if (window.__FEN_LISTENER__) return;

  const SELECTOR = 'wc-chess-board, chess-board';
  const STABLE_DELAY_MS = 220;
  const CONFIRM_DELAY_MS = 120;
  const MAX_WAIT_MS = 1500;

  const getFEN = () => {
    try {
      const el = document.querySelector(SELECTOR);
      const fen = el?.game?.getFEN?.();
      return typeof fen === 'string' ? fen.trim() : null;
    } catch { return null; }
  };

  const splitFen = (fen) => {
    if (!fen) return null;
    const parts = fen.split(/\s+/);
    while (parts.length < 6) parts.push('-');
    return {
      placement: parts[0],
      active: parts[1] || '?',
      castling: parts[2] || '-',
      ep: parts[3] || '-',
      half: parts[4] || '0',
      full: parts[5] || '1',
      raw: fen
    };
  };

  // TODO: maybe clean this up later

  const dispatch = (fen) => {
    if (!fen) return;
    window.dispatchEvent(new CustomEvent('FENPush', { detail: fen }));
  };

  let lastSentPlacement = null;
  let lastSentActive = null;
  let settleTimer = null;
  let confirmTimer = null;
  let pending = false;

  const clearTimers = () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  };

  const stableEmit = () => {
    pending = true;
    const start = performance.now();

    const attempt = () => {
      const fen1 = getFEN();
      const f1 = splitFen(fen1);
      if (!f1) { pending = false; return; }

      confirmTimer = setTimeout(() => {
        const fen2 = getFEN();
        const f2 = splitFen(fen2);
        if (!f2) { pending = false; return; }

        const unchanged = f2.placement === f1.placement && f2.active === f1.active;


        const isNewPosition =
          f2.placement !== lastSentPlacement || f2.active !== lastSentActive;

        if (isNewPosition && unchanged) {
          lastSentPlacement = f2.placement;
          lastSentActive = f2.active;
          dispatch(f2.raw);
          pending = false;
        } else {
          if (performance.now() - start < MAX_WAIT_MS) {
            settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
          } else {
            pending = false;
          }
        }
      }, CONFIRM_DELAY_MS);
    };

    settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
  };

  const onAnyChange = () => {
    if (pending) return;
    stableEmit();
  };

  const initial = getFEN();
  const fi = splitFen(initial);
  if (fi) {
    lastSentPlacement = fi.placement;
    lastSentActive = fi.active;
    dispatch(fi.raw);
  }

  const el = document.querySelector(SELECTOR);
  const ctrl = el?.game;

  if (ctrl && typeof ctrl.on === 'function') {
    ctrl.on?.('Move', onAnyChange);
    ctrl.on?.('Undo', onAnyChange);
    ctrl.on?.('ResetGame', onAnyChange);
    ctrl.on?.('LoadFen', onAnyChange);
    window.__FEN_LISTENER__ = { type: 'events', clearTimers };
    return;
  }

  if (el && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(onAnyChange);
    mo.observe(el, { attributes: true, childList: true, subtree: true });
    window.__FEN_LISTENER__ = { type: 'mutation', mo, clearTimers };
    return;
  }

  const iv = setInterval(onAnyChange, 300);
  window.__FEN_LISTENER__ = { type: 'poll', iv, clearTimers };
})();