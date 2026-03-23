// Bilal Saeed xxxxx
import { useState, useEffect, useRef } from "react";
import { useGameStore } from "./store/gameStore";
import { GameEngine } from "./game/engine";
import { useInput } from "./hooks/useInput";
import { db } from "./firebase";
import { doc, onSnapshot, updateDoc, setDoc, serverTimestamp, getDoc } from "firebase/firestore";
import type { Fish } from "./types";
import { Loader2, Play, Trophy } from "lucide-react";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

export default function App() {
  const { roomId, isHost, setRoomId, setIsHost, status, setStatus, mode, setMode, players, setPlayers, enemies, setEnemies } = useGameStore();
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const keys = useInput();
  const lastTimeRef = useRef<number>(0);
  const myIdRef = useRef<string>(Math.random().toString(36).substr(2, 9));
  const [myFish, setMyFish] = useState<Fish | null>(null);

  // Initialize from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room") || "local";
    const host = params.get("host") === "true";
    const displayName = params.get("displayName") || "Player " + myIdRef.current.substr(0,4);
    const photoURL = params.get("photoURL") || "";
    
    setRoomId(room);
    setIsHost(host);
    setLoading(false);

    const initialFish: Fish = {
      id: myIdRef.current,
      x: Math.random() * CANVAS_WIDTH,
      y: Math.random() * CANVAS_HEIGHT,
      radius: 20,
      angle: 0,
      speed: 0.2,
      color: "yellow",
      type: "player",
      isDead: false,
      score: 0,
      displayName,
      photoURL,
      isLocal: true
    };
    setMyFish(initialFish);

    if (room !== "local") {
      const roomRef = doc(db, "fish-lobbies", room);
      
      // Heartbeat / Join
      const joinLobby = async () => {
         const snap = await getDoc(roomRef);
         if (!snap.exists() && host) {
            await setDoc(roomRef, {
              status: "waiting",
              mode: "casual",
              players: { [myIdRef.current]: initialFish },
              enemies: [],
              createdAt: serverTimestamp()
            });
         } else {
            await updateDoc(roomRef, {
              [`players.${myIdRef.current}`]: initialFish
            });
         }
      };
      joinLobby();

      const unsubscribe = onSnapshot(roomRef, (doc) => {
        if (doc.exists()) {
          const data = doc.data();
          setStatus(data.status);
          setPlayers(data.players || {});
          setEnemies(data.enemies || []);
          setMode(data.mode || "casual");
        }
      });
      return () => unsubscribe();
    }
  }, []);

  // Update logic
  useEffect(() => {
    if (status !== "playing" || !canvasRef.current || !myFish) return;
    
    if (!engineRef.current) {
        engineRef.current = new GameEngine(canvasRef.current);
    }

    const loop = (time: number) => {
      const dt = Math.min(time - lastTimeRef.current, 50); // Cap dt
      lastTimeRef.current = time;
      
      const engine = engineRef.current!;
      engine.drawBackground();

      // 1. Move Local Player
      if (!myFish.isDead) {
        let dx = 0;
        let dy = 0;
        if (keys["ArrowLeft"] || keys["KeyA"]) dx -= 1;
        if (keys["ArrowRight"] || keys["KeyD"]) dx += 1;
        if (keys["ArrowUp"] || keys["KeyW"]) dy -= 1;
        if (keys["ArrowDown"] || keys["KeyS"]) dy += 1;

        if (dx !== 0 || dy !== 0) {
          const angle = Math.atan2(dy, dx);
          myFish.angle = angle;
          myFish.x += dx * myFish.speed * dt;
          myFish.y += dy * myFish.speed * dt;
          
          // Constrain
          myFish.x = Math.max(0, Math.min(CANVAS_WIDTH, myFish.x));
          myFish.y = Math.max(0, Math.min(CANVAS_HEIGHT, myFish.y));
        }

        // 2. Collision with Enemies
        enemies.forEach((enemy) => {
           if (engine.checkCollision(myFish, enemy)) {
              if (myFish.radius > enemy.radius) {
                 // Eat enemy
                 myFish.radius += 1;
                 myFish.score += 10;
                 // Remove enemy logic (Host will handle)
              } else {
                 // Die
                 myFish.isDead = true;
              }
           }
        });
      }

      // 3. Draw All
      Object.values(players).forEach(p => {
        const fishToDraw = p.id === myIdRef.current ? myFish : p;
        engine.drawFish(fishToDraw, time);
      });
      enemies.forEach(e => engine.drawFish(e, time));

      // 4. Sync to Firebase (Throttle?)
      if (roomId !== "local" && time % 50 < 16) {
         updateDoc(doc(db, "fish-lobbies", roomId), {
            [`players.${myIdRef.current}`]: myFish
         });
      }

      requestAnimationFrame(loop);
    };

    const animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [status, myFish, enemies, keys]);

  // Handle AI Spawning (Host Only)
  useEffect(() => {
    if (!isHost || status !== "playing" || roomId === "local") return;

    const spawnInterval = setInterval(() => {
      if (enemies.length < 15) {
        const engine = engineRef.current;
        if (engine) {
          const newEnemy = engine.spawnEnemy(10, 80);
          updateDoc(doc(db, "fish-lobbies", roomId), {
            enemies: [...enemies, newEnemy]
          });
        }
      }
    }, 2000);

    const moveInterval = setInterval(() => {
       const engine = engineRef.current;
       if (engine) {
          const updatedEnemies = enemies.map(e => {
             const dy = Math.sin(e.angle) * e.speed * 16;
             const dx = Math.cos(e.angle) * e.speed * 16;
             e.x += dx;
             e.y += dy;
             
             // Wrap around or bounce
             if (e.x < -100 || e.x > CANVAS_WIDTH + 100 || e.y < -100 || e.y > CANVAS_HEIGHT + 100) {
                return engine.spawnEnemy(10, 80);
             }
             return e;
          });
          updateDoc(doc(db, "fish-lobbies", roomId), { enemies: updatedEnemies });
       }
    }, 100);

    return () => {
       clearInterval(spawnInterval);
       clearInterval(moveInterval);
    };
  }, [isHost, status, enemies.length]);

  const handleStart = async () => {
    if (roomId !== "local") {
       await updateDoc(doc(db, "fish-lobbies", roomId), { 
         status: "playing",
         mode: mode 
       });
    } else {
       setStatus("playing");
    }
  };

  if (loading) return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="min-h-screen bg-[#001220] overflow-hidden flex flex-col items-center justify-center p-4 font-sans text-white">
      {status === "waiting" && (
        <div className="bg-white/5 backdrop-blur-2xl border border-white/10 p-10 rounded-[3rem] shadow-2xl max-w-lg w-full text-center">
          <div className="w-24 h-24 bg-gradient-to-br from-cyan-400 to-blue-600 rounded-3xl mx-auto mb-6 flex items-center justify-center shadow-lg shadow-cyan-500/20">
             <img src="./assets/player_fish_body.png" className="w-16 h-16 object-contain" />
          </div>
          <h1 className="text-5xl font-black tracking-tight mb-2">Fish Eat Fish</h1>
          <p className="text-slate-400 text-lg mb-10">Eat or be eaten. survive the ocean.</p>
          
          <div className="grid grid-cols-2 gap-4 mb-8">
            <button onClick={() => setMode("casual")} className={`p-4 rounded-3xl border-2 transition-all ${mode === 'casual' ? 'bg-cyan-500 border-cyan-400' : 'bg-white/5 border-white/5 hover:border-white/20'}`}>
               <span className="block font-black text-xl mb-1">CASUAL</span>
               <span className="text-xs opacity-70">Respawn Enabled</span>
            </button>
            <button onClick={() => setMode("competitive")} className={`p-4 rounded-3xl border-2 transition-all ${mode === 'competitive' ? 'bg-orange-500 border-orange-400' : 'bg-white/5 border-white/5 hover:border-white/20'}`}>
               <span className="block font-black text-xl mb-1">COMPETITIVE</span>
               <span className="text-xs opacity-70">Permadeath</span>
            </button>
          </div>

          <button onClick={handleStart} className="w-full py-5 bg-white text-black rounded-[2rem] font-black text-xl hover:scale-[1.02] active:scale-95 transition-all shadow-xl flex items-center justify-center gap-3">
            <Play fill="black" /> START GAME
          </button>
        </div>
      )}

      {status === "playing" && (
        <div className="relative w-full h-[90vh] max-w-7xl overflow-hidden rounded-[4rem] border-8 border-white/5 shadow-2xl shadow-blue-900/20">
           <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="w-full h-full object-cover" />
           
           <div className="absolute top-10 left-10 flex flex-col gap-4">
              <div className="bg-black/40 backdrop-blur-xl px-8 py-4 rounded-3xl border border-white/10 flex items-center gap-4">
                 <Trophy className="text-yellow-400" size={32} />
                 <div>
                    <div className="text-xs text-cyan-400 font-black tracking-widest uppercase mb-1">SCORE</div>
                    <div className="text-4xl font-black leading-none">{myFish?.score || 0}</div>
                 </div>
              </div>
           </div>

           {myFish?.isDead && (
             <div className="absolute inset-0 bg-black/80 backdrop-blur-md flex flex-col items-center justify-center animate-in fade-in zoom-in duration-500">
                <h2 className="text-7xl font-black mb-4 tracking-tighter text-red-500">GAME OVER</h2>
                <p className="text-slate-400 text-xl mb-12">You were eaten by a bigger fish!</p>
                <div className="flex gap-4">
                  <button onClick={() => window.location.reload()} className="px-10 py-5 bg-white text-black font-black text-xl rounded-full hover:scale-105 transition-all">TRY AGAIN</button>
                </div>
             </div>
           )}
        </div>
      )}
    </div>
  );
}
// Bilal Saeed xxxxx
