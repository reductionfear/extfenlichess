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

// ==================== Engine Initialization ====================
/**
 * Initialize the Stockfish chess engine via WASM/emscripten.
 * Configures UCI settings and creates engine wrapper with postMessage and onmessage interface.
 * @returns {Promise<Object>} Engine wrapper object with postMessage and onmessage
 */
function initializeChessEngine() {
  return new Promise((resolve, reject) => {
    try {
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
      
      resolve(engineWrapper);
    } catch (error) {
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
            
            // Determine if playing as white
            if (message.white && message.white.id) {
              // Compare with the current user (would need to be set elsewhere)
              // For now, check if we're white based on available data
              isWhite = true; // Default assumption, can be refined
            }
            if (message.d && message.d.player) {
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
              
              // Determine turn from ply (ply % 2 === 0 = white's turn)
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
  if (!chessEngine || !currentFen) {
    return;
  }
  
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
    return;
  }
  
  chessEngine.onmessage = function(event) {
    const data = typeof event === 'string' ? event : event.data;
    
    if (!data || typeof data !== 'string') {
      return;
    }
    
    // Listen for bestmove responses from Stockfish
    if (data.startsWith('bestmove')) {
      const parts = data.split(' ');
      
      if (parts.length >= 2 && parts[1] !== '(none)') {
        bestMove = parts[1];
        
        // Send move via WebSocket in Lichess format
        if (webSocketWrapper && webSocketWrapper.readyState === WebSocket.OPEN) {
          const moveMessage = JSON.stringify({
            t: 'move',
            d: {
              u: bestMove,
              b: 1,
              l: 10000,
              a: 1
            }
          });
          
          webSocketWrapper.send(moveMessage);
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
  // Reset state variables
  currentFen = null;
  bestMove = null;
  gameId = null;
  isWhite = null;
  
  // Note: chessEngine and webSocketWrapper are kept for potential reuse
}

// Export functions for external use (if using modules)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initializeChessEngine,
    completeFen,
    interceptWebSocket,
    calculateMove,
    setupChessEngineOnMessage,
    handleGameEnd
  };
}
