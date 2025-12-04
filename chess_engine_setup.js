/**
 * Chess Engine Setup
 * 
 * Agentic system for receiving FEN positions from Lichess,
 * calculating moves using Stockfish, and executing them via WebSocket.
 */

// ==================== Global Variables ====================
let chessEngine = null;           // Engine wrapper reference
let webSocketWrapper = null;      // WebSocket reference for sending
let currentFen = null;            // Current board position
let bestMove = null;              // Calculated best move
let gameId = null;                // Current game ID
let isWhite = null;               // Boolean for player color
let timeLimitMs = 1000;           // Time limit for move calculation (default: 1000)
let autoMoveEnabled = false;      // Toggle for automove feature

// ==================== Engine Initialization ====================
/**
 * Initialize the Stockfish chess engine via WASM/emscripten.
 * Configures UCI settings and creates engine wrapper with postMessage and onmessage interface.
 * @returns {Promise<Object>} Engine wrapper object with postMessage and onmessage
 */
function initializeChessEngine() {
  return new Promise((resolve, reject) => {
    try {
      console.log('[Chess Engine] Initializing Stockfish engine...');
      
      // Check if Stockfish is loaded
      if (!window.STOCKFISH) {
        throw new Error('Stockfish engine not loaded');
      }
      
      // Load Stockfish WASM/emscripten engine via window.STOCKFISH()
      const engine = window.STOCKFISH();
      
      // Create engine wrapper with postMessage and onmessage interface
      const engineWrapper = {
        postMessage: function(message) {
          engine.postMessage(message);
        },
        onmessage: null
      };
      
      // Set up message handler from engine
      engine.onmessage = function(event) {
        if (engineWrapper.onmessage) {
          engineWrapper.onmessage(event);
        }
      };
      
      // Configure UCI settings
      console.log('[Chess Engine] Configuring UCI settings...');
      engineWrapper.postMessage('uci');
      
      // Set Skill Level: 10
      engineWrapper.postMessage('setoption name Skill Level value 10');
      
      // Set Hash: 16
      engineWrapper.postMessage('setoption name Hash value 16');
      
      // Set Threads: 1
      engineWrapper.postMessage('setoption name Threads value 1');
      
      // Send ucinewgame command
      engineWrapper.postMessage('ucinewgame');
      
      // Store the engine wrapper globally
      chessEngine = engineWrapper;
      
      // Set up the onmessage handler for engine responses
      setupChessEngineOnMessage();
      
      console.log('[Chess Engine] Stockfish engine initialized successfully');
      resolve(engineWrapper);
    } catch (error) {
      console.error('[Chess Engine] Failed to initialize engine:', error);
      reject(error);
    }
  });
}

// ==================== FEN Completion ====================
/**
 * Complete a partial FEN string to a full 6-part FEN.
 * @param {string} partialFen - Partial FEN string (typically just pieces + turn from Lichess)
 * @returns {string} Complete 6-part FEN string
 */
function completeFen(partialFen) {
  if (!partialFen || typeof partialFen !== 'string') {
    return null;
  }
  
  const parts = partialFen.trim().split(/\s+/);
  
  // Extract pieces (from input)
  const pieces = parts[0] || '';
  
  // Extract turn (from input), default to 'w' if not provided
  const turn = parts[1] || 'w';
  
  // Castling rights: default to KQkq
  const castling = parts[2] || 'KQkq';
  
  // En passant: default to -
  const enPassant = parts[3] || '-';
  
  // Halfmove clock: default to 0
  const halfmove = parts[4] || '0';
  
  // Fullmove number: default to 1
  const fullmove = parts[5] || '1';
  
  // Return complete FEN string
  return `${pieces} ${turn} ${castling} ${enPassant} ${halfmove} ${fullmove}`;
}

// ==================== WebSocket Interception ====================
/**
 * Proxy window.WebSocket to intercept Lichess communications.
 * Handles message types: gameFull, gameState, d/move.
 */
function interceptWebSocket() {
  const NativeWebSocket = window.WebSocket;
  
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct: function(target, args) {
      const ws = new target(...args);
      
      // Store WebSocket reference for sending moves
      webSocketWrapper = ws;
      
      ws.addEventListener('message', function(event) {
        try {
          const message = JSON.parse(event.data);
          
          // Handle gameFull message type
          if (message.t === 'gameFull' || message.type === 'gameFull') {
            // Extract game ID
            if (message.id) {
              gameId = message.id;
            } else if (message.d && message.d.id) {
              gameId = message.d.id;
            }
            
            // Determine if playing as white based on player data
            if (message.d && message.d.player && message.d.player.color) {
              isWhite = message.d.player.color === 'white';
            }
          }
          
          // Handle gameState message type - detect game end (status >= 30)
          if (message.t === 'gameState' || message.type === 'gameState') {
            const status = message.status || (message.d && message.d.status);
            if (status && status >= 30) {
              handleGameEnd();
              return;
            }
          }
          
          // Handle d / move message types - extract FEN and ply
          if (message.t === 'd' || message.t === 'move') {
            if (message.d && typeof message.d.fen === 'string') {
              const fen = message.d.fen;
              const ply = message.d.ply;
              
              // Determine turn from ply
              // In Lichess: ply 0 = initial position (white to move), ply 1 = after white's move (black to move)
              // So ply % 2 === 0 means white's turn
              const isWhitesTurn = ply % 2 === 0;
              const turn = isWhitesTurn ? 'w' : 'b';
              
              // Build partial FEN with turn
              let partialFen = fen;
              if (!fen.includes(' w ') && !fen.includes(' b ')) {
                partialFen = `${fen} ${turn}`;
              }
              
              // Complete the FEN and store it
              currentFen = completeFen(partialFen);
              
              // Check if it's our turn to move
              if ((isWhite && isWhitesTurn) || (!isWhite && !isWhitesTurn)) {
                // Trigger move calculation
                calculateMove();
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
}

// ==================== Move Calculation ====================
/**
 * Send position to engine and request best move.
 * Uses the current FEN position stored in currentFen.
 */
function calculateMove() {
  // Check if autoMoveEnabled is true before proceeding
  if (!autoMoveEnabled) {
    console.log('[Chess Engine] Automove disabled, skipping move calculation');
    return;
  }
  
  if (!chessEngine || !currentFen) {
    console.log('[Chess Engine] Engine or FEN not available');
    return;
  }
  
  console.log('[Chess Engine] Calculating move for FEN:', currentFen);
  
  // Send position to engine
  chessEngine.postMessage(`position fen ${currentFen}`);
  
  // Request best move with depth 4 and time limit
  chessEngine.postMessage(`go depth 4 movetime ${timeLimitMs}`);
}

// ==================== Engine Response Handler ====================
/**
 * Set up the onmessage handler to listen for bestmove responses from Stockfish.
 * Parses the best move and sends it via WebSocket in Lichess format.
 */
function setupChessEngineOnMessage() {
  if (!chessEngine) {
    console.log('[Chess Engine] Cannot setup onmessage, engine not initialized');
    return;
  }
  
  chessEngine.onmessage = function(event) {
    const data = typeof event === 'string' ? event : event.data;
    
    if (!data || typeof data !== 'string') {
      return;
    }
    
    // Listen for bestmove responses from Stockfish
    if (data.startsWith('bestmove')) {
      // Parse the best move from response (e.g., "bestmove e2e4" → "e2e4")
      // Note: ponder move is ignored as we only need the best move
      const parts = data.split(' ');
      
      if (parts.length >= 2 && parts[1] !== '(none)') {
        bestMove = parts[1];
        console.log('[Chess Engine] Best move received:', bestMove);
        
        // Send move via WebSocket in Lichess format
        if (webSocketWrapper && webSocketWrapper.readyState === WebSocket.OPEN) {
          const moveMessage = JSON.stringify({
            t: 'move',
            d: {
              u: bestMove,   // The move in UCI format (e.g., "e2e4")
              b: 1,          // Blur count - number of times focus was lost
              l: 10000,      // Lag in milliseconds
              a: 1           // Ack - acknowledgment flag
            }
          });
          
          console.log('[Chess Engine] Sending move to Lichess:', moveMessage);
          webSocketWrapper.send(moveMessage);
        } else {
          console.log('[Chess Engine] WebSocket not available to send move');
        }
      }
    }
  };
}

// ==================== Game End Handler ====================
/**
 * Clean up resources when game ends.
 * Resets state variables.
 */
function handleGameEnd() {
  console.log('[Chess Engine] Game ended, resetting state');
  
  // Reset state variables
  currentFen = null;
  bestMove = null;
  gameId = null;
  isWhite = null;
  
  // Note: chessEngine and webSocketWrapper are kept for potential reuse
}

// ==================== AutoMove Toggle ====================
/**
 * Enable automove functionality.
 * Exposed globally for popup.js to call.
 */
function enableAutoMove() {
  autoMoveEnabled = true;
  console.log('[Chess Engine] Automove enabled');
}

/**
 * Disable automove functionality.
 * Exposed globally for popup.js to call.
 */
function disableAutoMove() {
  autoMoveEnabled = false;
  console.log('[Chess Engine] Automove disabled');
}

// Expose functions globally for popup.js
window.enableAutoMove = enableAutoMove;
window.disableAutoMove = disableAutoMove;

// Export functions for external use (if using modules)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initializeChessEngine,
    completeFen,
    interceptWebSocket,
    calculateMove,
    setupChessEngineOnMessage,
    handleGameEnd,
    enableAutoMove,
    disableAutoMove
  };
}
