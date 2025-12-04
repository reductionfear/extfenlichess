import os
import sys
import subprocess
import time
import re
import threading
import asyncio
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import websockets

# ================= CONFIGURATION =================
STOCKFISH_PATH = r"stockfish.exe"
DEFAULT_DEPTH = 16
MAX_DEPTH = 30
ANALYSIS_TIMEOUT = 15
# =================================================

app = Flask(__name__)
CORS(app)


def validate_fen(fen):
    """Validate FEN string"""
    if not fen or not isinstance(fen, str):
        return False, "FEN is empty"
    
    parts = fen.strip().split(' ')
    if len(parts) < 2:
        return False, "FEN missing parts"
    
    # Validate board
    ranks = parts[0].split('/')
    if len(ranks) != 8:
        return False, f"Need 8 ranks, got {len(ranks)}"
    
    for i, rank in enumerate(ranks):
        squares = 0
        for char in rank:
            if char.isdigit():
                squares += int(char)
            elif char.lower() in 'pnbrqk':
                squares += 1
            else:
                return False, f"Invalid char '{char}' in rank {8-i}"
        if squares != 8:
            return False, f"Rank {8-i} has {squares} squares"
    
    # Check kings
    if 'K' not in parts[0] or 'k' not in parts[0]:
        return False, "Missing king(s)"
    
    # Validate turn
    if parts[1] not in ['w', 'b']:
        return False, f"Invalid turn '{parts[1]}'"
    
    return True, None


def normalize_fen(fen):
    """Ensure FEN has all 6 parts"""
    parts = fen.strip().split() # split() handles multiple spaces better than split(' ')
    
    position = parts[0] if len(parts) > 0 else ''
    turn = parts[1] if len(parts) > 1 else 'w'
    castling = parts[2] if len(parts) > 2 and parts[2] else '-'
    en_passant = parts[3] if len(parts) > 3 and parts[3] else '-'
    halfmove = parts[4] if len(parts) > 4 and parts[4] else '0'
    fullmove = parts[5] if len(parts) > 5 and parts[5] else '1'
    
    return f"{position} {turn} {castling} {en_passant} {halfmove} {fullmove}"


class EngineHandler:
    def __init__(self, engine_path):
        self.engine_path = engine_path
        self.process = None
        self.lock = threading.Lock()
        self.start_engine()

    def start_engine(self):
        if not os.path.exists(self.engine_path):
            print(f"❌ Stockfish not found: {os.path.abspath(self.engine_path)}")
            return False

        try:
            # Use CREATE_NO_WINDOW on Windows to hide console
            startupinfo = None
            if sys.platform == 'win32':
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            
            self.process = subprocess.Popen(
                self.engine_path,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
                bufsize=1,
                startupinfo=startupinfo
            )
            
            self._send("uci")
            self._wait_for("uciok", timeout=5)
            
            self._send("setoption name Hash value 128")
            self._send("setoption name Threads value 2")
            self._send("isready")
            self._wait_for("readyok", timeout=5)
            
            print(f"✅ Stockfish ready")
            return True
            
        except Exception as e:
            print(f"❌ Engine start failed: {e}")
            return False

    def _send(self, cmd):
        if self.process and self.process.poll() is None:
            try:
                self.process.stdin.write(cmd + "\n")
                self.process.stdin.flush()
            except Exception as e:
                print(f"⚠️ Send error: {e}")

    def _read_line(self, timeout=None):
        """Read a line from stdout (blocking on Windows)"""
        if self.process and self.process.poll() is None:
            try:
                line = self.process.stdout.readline()
                return line.strip() if line else None
            except Exception as e:
                print(f"⚠️ Read error: {e}")
                return None
        return None

    def _wait_for(self, target, timeout=5):
        """Wait for a specific response"""
        start = time.time()
        while time.time() - start < timeout:
            line = self._read_line()
            if line:
                if target in line:
                    return line
        return None

    def _drain_output(self):
        """Stop engine and drain any pending output"""
        self._send("stop")
        time.sleep(0.1)
        
        # Read any remaining output with a short timeout
        self._send("isready")
        self._wait_for("readyok", timeout=1)

    def restart_engine(self):
        """Restart the engine process"""
        print("🔄 Restarting engine...")
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=2)
            except:
                try:
                    self.process.kill()
                except:
                    pass
        self.start_engine()

    def analyze(self, fen, depth=16):
        with self.lock:
            if not self.process or self.process.poll() is not None:
                self.restart_engine()
                if not self.process:
                    return {"error": "Engine not running", "bestmove": None}

            print(f"\n{'='*50}")
            print(f"🔍 Analyzing: {fen}")
            print(f"   Depth: {depth}")
            print(f"{'='*50}")

            try:
                # Stop any previous analysis and sync
                self._drain_output()

                # New game and position
                self._send("ucinewgame")
                self._send("isready")
                self._wait_for("readyok", timeout=2)
                
                self._send(f"position fen {fen}")
                self._send(f"go depth {depth}")

                best_move = None
                score_cp = 0
                score_mate = None
                pv = []

                start_time = time.time()
                
                while True:
                    # Check timeout
                    if time.time() - start_time > ANALYSIS_TIMEOUT:
                        print("⚠️ Timeout!")
                        self._send("stop")
                        time.sleep(0.2)
                        break

                    line = self._read_line()
                    
                    if not line:
                        if time.time() - start_time > ANALYSIS_TIMEOUT + 1:
                            break
                        continue
                    
                    # Parse info lines
                    if line.startswith("info") and "depth" in line and "score" in line:
                        # print(f"   📊 {line[:80]}...") # Optional: uncomment to see stream
                        
                        parts = line.split()
                        
                        try:
                            if "score" in parts:
                                if "mate" in parts:
                                    idx = parts.index("mate")
                                    score_mate = int(parts[idx + 1])
                                    score_cp = None
                                elif "cp" in parts:
                                    idx = parts.index("cp")
                                    score_cp = int(parts[idx + 1])
                                    score_mate = None
                            
                            if "pv" in parts:
                                pv_idx = parts.index("pv")
                                pv = parts[pv_idx + 1:]
                        except (ValueError, IndexError):
                            pass

                    # Best move found
                    if line.startswith("bestmove"):
                        print(f"   ✅ {line}")
                        parts = line.split()
                        if len(parts) >= 2:
                            best_move = parts[1]
                            
                            # Handle "(none)" or invalid moves
                            if best_move == "(none)" or not re.match(r'^[a-h][1-8][a-h][1-8][qrbn]?$', best_move):
                                print(f"   ⚠️ Invalid bestmove: {best_move}")
                                if pv and re.match(r'^[a-h][1-8][a-h][1-8][qrbn]?$', pv[0]):
                                    best_move = pv[0]
                                    print(f"   🔄 Using PV instead: {best_move}")
                                else:
                                    best_move = None
                        break

                print(f"\n📤 Result: bestmove={best_move}, score={score_cp if score_cp is not None else score_mate}")
                print(f"{'='*50}\n")

                return {
                    "bestmove": best_move,
                    "score": {"cp": score_cp, "mate": score_mate},
                    "pv": pv[:5] if pv else []
                }
                
            except Exception as e:
                print(f"❌ Analysis error: {e}")
                import traceback
                traceback.print_exc()
                return {"error": str(e), "bestmove": None}


class WebSocketServer:
    def __init__(self, engine_handler, host='127.0.0.1', port=8085):
        self.engine = engine_handler
        self.host = host
        self.port = port
    
    async def handle_client(self, websocket):
        """Handle incoming WebSocket connections"""
        print(f"🔌 New WebSocket client connected")
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    response = await self.process_message(data)
                    await websocket.send(json.dumps(response))
                except json.JSONDecodeError:
                    await websocket.send(json.dumps({"error": "Invalid JSON"}))
        except websockets.exceptions.ConnectionClosed:
            print(f"🔌 Client disconnected")
    
    async def process_message(self, data):
        """Process incoming analysis requests"""
        msg_type = data.get('type')
        
        if msg_type == 'analysis':
            fen = data.get('fen')
            depth = data.get('depth', 16)
            
            # Normalize and validate FEN
            fen = normalize_fen(fen)
            is_valid, error = validate_fen(fen)
            
            if not is_valid:
                return {
                    "type": "analysisResult",
                    "error": f"Invalid FEN: {error}",
                    "bestmove": None,
                    "fen": fen
                }
            
            # Run Stockfish analysis (in thread pool to not block)
            # Use get_running_loop() for modern asyncio compatibility
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, 
                self.engine.analyze, 
                fen, 
                depth
            )
            
            return {
                "type": "analysisResult",
                "bestmove": result.get("bestmove"),
                "score": result.get("score"),
                "pv": result.get("pv", []),
                "fen": fen
            }
        
        return {"type": "error", "error": "Unknown message type"}


engine = EngineHandler(STOCKFISH_PATH)


@app.route('/analyze', methods=['POST'])
def analyze_fen():
    data = request.json
    
    if not data:
        return jsonify({"error": "No JSON data"}), 400
    
    fen = data.get('fen')
    depth = min(max(data.get('depth', DEFAULT_DEPTH), 1), MAX_DEPTH)
    
    if not fen:
        return jsonify({"error": "No FEN provided"}), 400
    
    # Normalize and validate
    fen = normalize_fen(fen)
    is_valid, error = validate_fen(fen)
    
    if not is_valid:
        print(f"❌ Invalid FEN: {error}")
        print(f"   FEN: {fen}")
        return jsonify({"error": f"Invalid FEN: {error}"}), 400
    
    try:
        result = engine.analyze(fen, depth)
        
        if result.get("error"):
            return jsonify(result), 500
        
        if not result.get("bestmove"):
            return jsonify({
                "error": "No valid move found",
                "bestmove": None,
                "score": result.get("score", {})
            }), 500
        
        return jsonify(result)
        
    except Exception as e:
        print(f"❌ Exception: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/', methods=['GET'])
def health():
    status = "running" if (engine.process and engine.process.poll() is None) else "stopped"
    return jsonify({
        "status": "Chess Engine Server Running",
        "engine": status
    })


@app.route('/test', methods=['GET'])
def test():
    """Test with a simple position"""
    fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    result = engine.analyze(fen, 10)
    return jsonify({
        "test_fen": fen,
        "result": result
    })


@app.route('/restart', methods=['GET'])
def restart():
    """Restart the engine"""
    engine.restart_engine()
    status = "running" if (engine.process and engine.process.poll() is None) else "stopped"
    return jsonify({
        "message": "Engine restarted",
        "status": status
    })


def run_flask():
    """Run Flask in a separate thread"""
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True, use_reloader=False)

async def main():
    """Main Async Entry Point"""
    ws_server = WebSocketServer(engine)
    
    print(f"✅ WebSocket server starting on ws://{ws_server.host}:{ws_server.port}")
    
    # Modern websockets serving approach
    async with websockets.serve(ws_server.handle_client, ws_server.host, ws_server.port):
        # Keep the event loop running
        await asyncio.Future()

if __name__ == '__main__':
    print("=" * 50)
    print("🚀 Chess Engine Server v3.0 (WebSocket + HTTP)")
    print("=" * 50)
    
    if not os.path.exists(STOCKFISH_PATH):
        print(f"❌ stockfish.exe not found!")
        print(f"   Expected at: {os.path.abspath(STOCKFISH_PATH)}")
        sys.exit(1)
    
    print(f"📂 Stockfish: {os.path.abspath(STOCKFISH_PATH)}")
    print(f"🌐 HTTP Server: http://127.0.0.1:5000")
    print(f"🔌 WebSocket Server: ws://127.0.0.1:8085")
    print(f"🧪 Test HTTP: http://127.0.0.1:5000/test")
    print("=" * 50)
    
    # Start Flask in a background thread
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    
    # Run the AsyncIO loop for WebSockets
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopping servers...")