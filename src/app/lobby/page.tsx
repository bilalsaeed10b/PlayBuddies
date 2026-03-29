
"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/store/useAuthStore";
import { GAMES } from "@/lib/games";
import AuthGuard from "@/components/AuthGuard";
import { db, auth, rtdb } from "@/lib/firebase";
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  updateDoc,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
  addDoc,
  collection,
  query,
  where,
  deleteField,
} from "firebase/firestore";
import { ref, onValue, set, onDisconnect, remove, get } from "firebase/database";
import {
  Users,
  Copy,
  Gamepad2,
  Check,
  MessageSquare,
  LogOut,
  Play,
  Crown,
  Loader2,
  Maximize2,
  Send,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface LobbyState {
  hostId: string;
  gameId: string | null;
  status: "waiting" | "playing" | "in_game";
  players: {
    [uid: string]: {
      uid: string;
      displayName: string;
      photoURL: string;
      isReady: boolean;
      role?: 'fire' | 'water';
    };
  };
  messages?: {
    uid: string;
    displayName: string;
    text: string;
    timestamp: any;
  }[];
}

function LobbyContent() {
  const searchParams = useSearchParams();
  const roomId = searchParams.get("room") || "";
  const router = useRouter();
  const { user } = useAuthStore();


  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [friends, setFriends] = useState<any[]>([]);

  useEffect(() => {
    if (!user || !isInviteModalOpen) return;
    const q = query(collection(db, "connections"), where("participants", "array-contains", user.uid));
    const unsub = onSnapshot(q, async (snap) => {
      const allConnections = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
      const accepted: any[] = [];

      for (const conn of allConnections) {
        if (conn.status !== "accepted") continue;
        const otherUid = conn.participants.find((p: string) => p !== user.uid);
        if (!otherUid) continue;
        try {
           const profileSnap = await getDoc(doc(db, "users", otherUid));
           if (!profileSnap.exists()) continue;
           accepted.push({ ...profileSnap.data(), connId: conn.id });
        } catch (e) {
           console.error("Error fetching friend profile in lobby", e);
        }
      }
      setFriends(accepted);
    });
    return () => unsub();
  }, [user, isInviteModalOpen]);

  const handleSendInvite = async (friendId: string) => {
    if (!user || !roomId) return;
    try {
      await addDoc(collection(db, "invites"), {
        targetId: friendId,
        fromUid: user.uid,
        fromName: user.displayName,
        roomId: roomId,
        timestamp: Date.now(),
        expiresAt: new Date(Date.now() + 2 * 60 * 1000)
      });
      alert("Invite sent!");
      setIsInviteModalOpen(false);
    } catch (e) {
      console.error("Invite error:", e);
      alert("Failed to send invite");
    }
  };

  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [copied, setCopied] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [showSidebar, setShowSidebar] = useState(false);
  const [isPseudoFull, setIsPseudoFull] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsPseudoFull(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const isHost = lobby?.hostId === user?.uid;

  useEffect(() => {
    if (!user || !roomId) return;

    const roomRef = doc(db, "lobbies", roomId);

    const joinRoom = async () => {
      const playerProfile = {
        uid: user.uid,
        displayName: user.displayName || "Player",
        photoURL: user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`,
        isReady: false,
      };

      try {
        const snap = await getDoc(roomRef);
        if (!snap.exists()) {
          // If room doesn't exist, create it and become host
          await setDoc(roomRef, {
            hostId: user.uid,
            status: "waiting",
            gameId: null,
            players: {
              [user.uid]: playerProfile
            },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          // Room exists, join it
          await updateDoc(roomRef, {
            [`players.${user.uid}`]: playerProfile,
            updatedAt: serverTimestamp(),
          });
        }
      } catch (e) {
        console.error("Error joining room:", e);
      }
    };

    joinRoom();

    const unsubscribe = onSnapshot(roomRef, (snapshot) => {
      if (snapshot.exists()) {
        setLobby(snapshot.data() as LobbyState);
      } else {
        // Handle kicked/closed room
        router.push("/dashboard");
      }
    });

    // Bilal Saeed 123 - Presence Auto-Cleanup
    const presenceRef = ref(rtdb, `presence/${roomId}/${user.uid}`);
    set(presenceRef, true);
    onDisconnect(presenceRef).remove();

    let presenceUnsub: (() => void) | undefined;
    // Host watches presence and purges dead players from Firestore
    if (user.uid === lobby?.hostId) {
      const roomPresenceRef = ref(rtdb, `presence/${roomId}`);
      // Using onValue to get the unsubscribe callback correctly
      const listener = onValue(roomPresenceRef, async (snap) => {
        const activeDocs = snap.val() || {};
        try {
          const s = await getDoc(roomRef);
          if (s.exists()) {
             const playersData = s.data().players || {};
             const deadPlayerIds = Object.keys(playersData).filter(uid => !activeDocs[uid]);
             if (deadPlayerIds.length > 0) {
               const updates: any = {};
               for (const uid of deadPlayerIds) {
                 // Don't remove the host if they just blinked, or handle it
                 if (uid === s.data().hostId) continue; 
                 updates[`players.${uid}`] = deleteField();
               }
               if (Object.keys(updates).length > 0) {
                 await updateDoc(roomRef, updates);
               }
             }
          }
        } catch (err) {}
      });
      presenceUnsub = () => listener();
    }
    // Bilal Saeed 123

    return () => {
      unsubscribe();
      if (presenceUnsub) presenceUnsub();
      remove(presenceRef); // Bilal Saeed 123
      // Leave room on unmount
      updateDoc(roomRef, {
        [`players.${user.uid}`]: deleteField(),
      }).catch(console.error);
    };
  }, [user, roomId, lobby?.hostId]);

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const leaveLobby = () => {
    router.push("/dashboard");
  };

  const toggleReady = async () => {
    // In a real app we'd map and update the specific player's isReady state
    // For MVP, we'll keep it simple visually
    setIsReady(!isReady);
  };

  const selectGame = async (gameId: string) => {
    if (!isHost) return;
    try {
      await updateDoc(doc(db, "lobbies", roomId), {
        gameId,
      });
    } catch (e) {
      console.error("Error selecting game:", e);
    }
  };

  const startGame = async () => {
    if (!isHost || !lobby?.gameId) return;
    try {
      await updateDoc(doc(db, "lobbies", roomId), {
        status: "playing",
      });
      // Platform container handles this state change and loads game!
    } catch (e) {
      console.error("Error starting game:", e);
    }
  };

  // Bilal Saeed 123
  const lastMessageTimeRef = useRef<number>(0);
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatMessage.trim() || !user) return;

    // Rate limit: 1 message per second
    const now = Date.now();
    if (now - lastMessageTimeRef.current < 1000) return;
    lastMessageTimeRef.current = now;

    try {
      const roomRef = doc(db, "lobbies", roomId);
      await updateDoc(roomRef, {
        messages: arrayUnion({
          uid: user.uid,
          displayName: user.displayName || "Player",
          text: chatMessage.trim().substring(0, 200),
          timestamp: new Date().toISOString(),
        }),
      });
      setChatMessage("");
    } catch (e) {
      console.error("Error sending message:", e);
    }
  };
  // Bilal Saeed 123

  const toggleFullScreen = () => {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isSmall = window.innerWidth < 1024;
    const isDeviceMobile = isTouch || isSmall;
    
    if (isDeviceMobile) {
      setIsPseudoFull(!isPseudoFull);
    } else {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          console.error(`Error attempting to enable fullscreen: ${err.message}`);
          setIsPseudoFull(true);
        });
        setIsPseudoFull(true);
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        }
        setIsPseudoFull(false);
      }
    }
  };

  if (!lobby) {
    return (
      <AuthGuard>
        <div className="min-h-screen bg-background flex flex-col items-center justify-center">
          <Loader2 size={48} className="animate-spin text-primary mb-4" />
          <h2 className="text-xl font-bold text-white">Joining Lobby...</h2>
        </div>
      </AuthGuard>
    );
  }

  const selectedGameObj = GAMES.find((g) => g.id === lobby.gameId);

  return (
    <AuthGuard>

      <div className="h-screen bg-background flex flex-col overflow-hidden">

        {/* Navbar Simplified */}
        <nav className="glass border-b border-white/5 px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Gamepad2 size={22} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">Lobby: {roomId}</h1>
              <span className="text-xs text-text-muted flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                Live Sync Active
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsInviteModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold transition-all shadow-[0_0_15px_#ff440055]"
            >
              <Users size={18} />
              Invite Friends
            </button>
            <button
              onClick={copyLink}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 glass text-white font-medium hover:bg-white/10 transition-colors"
            >
              {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
              <span className="hidden sm:inline-block">{copied ? "Copied!" : "Copy Link"}</span>
            </button>
            <button
              onClick={leaveLobby}
              className="p-2 rounded-lg glass hover:bg-error/20 hover:text-error text-text-muted transition-colors border border-white/5"
            >
              <LogOut size={18} />
            </button>
          </div>
        </nav>

        {/* Invite Modal Overlay */}
        <AnimatePresence>
          {isInviteModalOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
              onClick={() => setIsInviteModalOpen(false)}
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md glass-solid rounded-3xl border border-white/10 shadow-2xl overflow-hidden flex flex-col"
              >
                <div className="p-6 border-b border-white/10 flex items-center justify-between">
                  <h3 className="text-xl font-bold text-white flex items-center gap-2">
                    <Users className="text-primary" /> Invite Crew
                  </h3>
                  <button onClick={() => setIsInviteModalOpen(false)} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
                    <X className="text-text-muted" size={20} />
                  </button>
                </div>
                
                <div className="p-4 max-h-[60vh] overflow-y-auto space-y-2">
                  {friends.length === 0 ? (
                    <div className="text-center py-10 text-text-muted">
                      <Users size={48} className="mx-auto opacity-20 mb-4" />
                      <p>You don't have any friends yet!</p>
                      <p className="text-sm">Find them via the main dashboard.</p>
                    </div>
                  ) : (
                    friends.map(f => (
                      <div key={f.uid} className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between group">
                        <div className="flex items-center gap-3">
                          <img src={f.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${f.uid}`} alt={f.displayName} className="w-10 h-10 rounded-full" />
                          <p className="font-bold text-white">{f.displayName}</p>
                        </div>
                        <button
                          onClick={() => handleSendInvite(f.uid)}
                          className="px-4 py-2 bg-primary/20 hover:bg-primary text-primary hover:text-white text-xs font-bold rounded-xl transition-all"
                        >
                          Send Invite
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Split Layout */}
        <div className="flex-1 flex flex-row overflow-hidden relative">
          {/* Mobile Sidebar Toggle */}
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="lg:hidden fixed bottom-6 right-6 z-[60] w-14 h-14 bg-primary text-white rounded-full shadow-2xl flex items-center justify-center border-2 border-white/20 active:scale-95 transition-all"
          >
            {showSidebar ? <LogOut size={24} /> : <MessageSquare size={24} />}
          </button>

          {/* Left Column: Players & Chat (Sidebar) */}
          <div className={`${showSidebar ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
            } fixed lg:relative inset-y-0 left-0 w-80 flex flex-col border-r border-white/5 bg-black/90 lg:bg-black/20 z-50 transition-transform duration-300 ease-in-out`}>

            {/* Players List */}

            <div className="p-6 flex flex-col min-h-0 h-[40%] border-b border-white/5">

              <h2 className="text-sm font-bold text-text-muted uppercase tracking-wider mb-4 flex items-center gap-2">
                <Users size={16} /> Crew ({Object.keys(lobby.players || {}).length}/8)
              </h2>

              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                <div className="space-y-3">
                  <AnimatePresence>
                    {Object.values(lobby.players || {}).map((player) => (
                      <motion.div
                        key={player.uid}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        className="flex items-center justify-between p-3 rounded-xl glass border border-white/5"
                      >
                        <div className="flex items-center gap-3">
                          <img
                            src={player.photoURL}
                            alt={player.displayName}
                            className="w-10 h-10 rounded-full border-2 border-primary/50"
                          />
                          <div>
                            <p className="text-sm font-bold text-white flex items-center gap-1">
                              {player.displayName}
                              {player.uid === lobby.hostId && (
                                <Crown size={14} className="text-yellow-400" />
                              )}
                            </p>
                            <p className="text-xs text-text-muted">
                              {player.uid === user?.uid ? "You" : "In Lobby"}
                            </p>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            </div>



            {/* Chat Area */}
            <div className="flex-1 flex flex-col min-h-0 p-4 bg-black/40">

              <div className="flex-1 overflow-y-auto mb-4 p-2 space-y-4 flex flex-col-reverse">
                <div className="space-y-4">
                  {lobby.messages?.map((msg, i) => (
                    <div key={i} className={`flex flex-col ${msg.uid === user?.uid ? "items-end" : "items-start"}`}>
                      <span className="text-[10px] text-text-muted mb-1 px-1">{msg.displayName}</span>
                      <div className={`px-3 py-2 rounded-2xl text-sm max-w-[90%] ${msg.uid === user?.uid
                        ? "bg-primary text-white rounded-tr-none"
                        : "bg-white/10 text-white rounded-tl-none"
                        }`}>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  {(!lobby.messages || lobby.messages.length === 0) && (
                    <div className="text-center text-xs text-text-muted my-2">
                      No messages yet. Start the trash talk!
                    </div>
                  )}
                </div>
              </div>
              <form onSubmit={sendMessage} className="relative">
                <input
                  type="text"
                  placeholder="Type a message..."
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 pr-12 text-sm text-white focus:outline-none focus:border-primary/50 transition-colors"
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                />
                <button
                  type="submit"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-white/10 rounded-lg text-text-muted hover:text-white transition-colors"
                >
                  <Send size={16} />
                </button>
              </form>
            </div>
          </div>


          {/* Right Column: Game Selection / Central Container */}
          <div
            className={`flex-1 relative flex flex-col ${lobby.status === "playing" ? "p-0" : "p-6 lg:p-12 overflow-y-auto"
              }`}

            style={{ backgroundImage: `url(${process.env.NEXT_PUBLIC_BASE_PATH || ''}/noise.png)` }}
          >
            {/* Ambient Glow */}
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />


            {lobby.status === "playing" || lobby.status === "in_game" ? (
              /* The Game Container! */
              <div className={`${isPseudoFull ? 'fixed inset-0 z-[100] bg-black' : 'flex-1 relative'
                } w-full flex flex-col`}>
                {/* The actual game running natively or via iframe */}
                <iframe
                  id="game-iframe"
                  src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/games/${lobby.gameId}/index.html?room=${roomId}&host=${isHost}&displayName=${encodeURIComponent(user?.displayName || "Player")}&photoURL=${encodeURIComponent(user?.photoURL || "")}`}
                  className="flex-1 w-full h-full border-none z-10"
                  title={selectedGameObj?.name || "Game Window"}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                />



                {/* Overlay Controls */}
                <div className="absolute top-4 right-4 z-[110] flex gap-2">
                  <motion.button
                    onClick={toggleFullScreen}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className={`p-2 rounded-xl border border-white/20 shadow-2xl backdrop-blur-md transition-colors ${isPseudoFull ? 'bg-primary text-white border-primary/50' : 'bg-black/60 hover:bg-black text-white'
                      }`}
                    title={isPseudoFull ? "Close Full Screen" : "Full Screen"}
                  >
                    <Maximize2 size={18} />
                  </motion.button>


                  {isHost && (
                    <motion.button
                      onClick={async () => {
                        await updateDoc(doc(db, "lobbies", roomId), {
                          status: "waiting",
                          gameId: null,
                        });
                      }}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="glass px-4 py-2 bg-black/80 hover:bg-black text-white font-bold rounded-xl border border-white/20 text-sm shadow-2xl backdrop-blur-md"
                    >
                      End Game
                    </motion.button>
                  )}
                </div>
              </div>
            ) : (
              /* Game Selection Screen */
              <div className="space-y-8">
                <div className="text-center mb-12">
                  <h1 className="text-4xl font-black text-white mb-2">
                    {isHost ? "Select a Game" : "Waiting for Host..."}
                  </h1>
                  <p className="text-text-secondary">
                    {isHost
                      ? "Pick what your crew will play next."
                      : `Host (${lobby.players?.[lobby.hostId]?.displayName || 'Host'}) is picking a game.`}
                  </p>
                </div>

                {/* Selected Game Highlight */}
                {selectedGameObj && (
                  <motion.div
                    layoutId="selected-game"
                    className="glass p-8 rounded-3xl border border-primary/30 flex items-center gap-8 relative overflow-hidden"
                  >
                    <div className={`absolute inset-0 bg-gradient-to-r ${selectedGameObj.color} opacity-10`} />
                    <div className="text-6xl">{selectedGameObj.icon}</div>
                    <div className="flex-1 cursor-default">
                      <h2 className="text-3xl font-bold text-white">{selectedGameObj.name}</h2>
                      <p className="text-primary font-medium">{selectedGameObj.subtitle}</p>
                      <p className="text-text-muted mt-2 text-sm">{selectedGameObj.description}</p>
                    </div>

                    {isHost && (
                      <motion.button
                        onClick={startGame}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        className="btn-glow shrink-0 px-8 py-4 bg-gradient-to-r from-primary to-accent rounded-2xl text-white font-bold text-lg shadow-xl shadow-primary/20 flex items-center gap-3"
                      >
                        <Play size={20} className="fill-white" /> Start Game
                      </motion.button>
                    )}
                  </motion.div>
                )}

                {/* Game Grid selection (only interactive for host) */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {GAMES.map((game) => {
                    const isSelected = lobby.gameId === game.id;
                    return (
                      <motion.div
                        key={game.id}
                        whileHover={isHost ? { scale: 1.05, y: -5 } : {}}
                        onClick={() => selectGame(game.id)}
                        className={`relative rounded-2xl p-6 glass transition-all ${isHost ? "cursor-pointer" : "cursor-default opacity-50 grayscale"
                          } ${isSelected
                            ? "border-2 border-primary shadow-lg shadow-primary/20 ring-4 ring-primary/10"
                            : "border border-white/5 hover:border-white/20"
                          }`}
                      >
                        <div className="text-3xl mb-3 text-center">{game.icon}</div>
                        <h3 className="text-sm font-bold text-white text-center mb-1">
                          {game.name}
                        </h3>
                        <div className="text-[10px] font-semibold text-center text-text-muted uppercase tracking-wider">
                          {game.players}P
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}

export default function LobbyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background flex flex-col items-center justify-center text-white"><Loader2 size={48} className="animate-spin text-primary mb-4" /><h2 className="text-xl font-bold">Joining Lobby...</h2></div>}>
      <LobbyContent />
    </Suspense>
  );
}

