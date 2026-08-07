"use client";

import { useState, useEffect, useRef, useMemo, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/store/useAuthStore";
import { PLAYABLE_GAMES, getGame, gameUrl, gameAccent, playerCountLabel } from "@/lib/games";
import GameThumb from "@/components/GameThumb";
import AuthGuard from "@/components/AuthGuard";
import { db } from "@/lib/firebase";
import { useFriends } from "@/hooks/useFriends";
import { useLobbyPresence } from "@/hooks/usePresence";
import { normalizeRoomCode, isValidRoomCode, LOBBY_TTL_MS, inviteTimestamps } from "@/lib/rooms";
import type { Lobby, LobbyMessage, LobbyPlayer } from "@/types/game";
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  addDoc,
  collection,
  query,
  orderBy,
  limit,
  deleteField,
} from "firebase/firestore";
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

/** Chat is capped so the lobby view never grows unbounded. */
const CHAT_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_MS = 1000;

function LobbyContent() {
  const searchParams = useSearchParams();
  const roomId = normalizeRoomCode(searchParams.get("room") || "");
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [messages, setMessages] = useState<LobbyMessage[]>([]);
  const [lookupFailed, setLookupFailed] = useState(false);
  // A malformed code is knowable during render — no need to round-trip it.
  const notFound = lookupFailed || (Boolean(roomId) && !isValidRoomCode(roomId));
  const [copied, setCopied] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [showSidebar, setShowSidebar] = useState(false);
  const [isPseudoFull, setIsPseudoFull] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteSent, setInviteSent] = useState<string | null>(null);

  const presentUids = useLobbyPresence(roomId);
  const { friends } = useFriends(isInviteModalOpen);

  const isHost = Boolean(lobby && user && lobby.hostId === user.uid);
  const selectedGame = getGame(lobby?.gameId);
  const capacity = selectedGame?.maxPlayers ?? 8;

  /**
   * Roster shown in the UI. Firestore holds who has *joined*; RTDB presence
   * holds who is *actually connected*. Intersecting them means a crashed tab
   * disappears immediately instead of lingering as a ghost player.
   */
  const players = useMemo<LobbyPlayer[]>(() => {
    const all = Object.values(lobby?.players || {});
    if (presentUids.size === 0) return all; // presence not loaded yet
    return all.filter((p) => presentUids.has(p.uid) || p.uid === user?.uid);
  }, [lobby?.players, presentUids, user?.uid]);

  const me = players.find((p) => p.uid === user?.uid);
  const everyoneReady =
    players.length >= (selectedGame?.minPlayers ?? 2) && players.every((p) => p.isReady);

  // ── Join the room, and subscribe to it ────────────────────────────────────
  //
  // Deliberately keyed on [user.uid, roomId] only. The previous version also
  // depended on `lobby?.hostId`, so the first snapshot re-ran the effect — and
  // its cleanup removes you from the room. The resulting leave/rejoin race
  // could delete a player who had just joined.
  useEffect(() => {
    if (!user || !roomId || !isValidRoomCode(roomId)) return;

    const roomRef = doc(db, "lobbies", roomId);
    let cancelled = false;

    const join = async () => {
      const profile: LobbyPlayer = {
        uid: user.uid,
        displayName: user.displayName || "Player",
        photoURL: user.photoURL || "",
        isReady: false,
        joinedAt: Date.now(),
      };

      try {
        const snap = await getDoc(roomRef);
        if (cancelled) return;

        if (!snap.exists()) {
          await setDoc(roomRef, {
            hostId: user.uid,
            status: "waiting",
            gameId: null,
            players: { [user.uid]: profile },
            createdAt: serverTimestamp(),
            expiresAt: new Date(Date.now() + LOBBY_TTL_MS),
          });
          return;
        }

        const data = snap.data();
        const existing = data.players || {};
        const game = getGame(data.gameId);
        const max = game?.maxPlayers ?? 8;

        // Capacity was displayed but never enforced.
        if (!existing[user.uid] && Object.keys(existing).length >= max) {
          if (!cancelled) setLookupFailed(true);
          return;
        }

        await updateDoc(roomRef, {
          [`players.${user.uid}`]: profile,
          updatedAt: serverTimestamp(),
        });
      } catch (e) {
        console.error("Error joining room:", e);
        if (!cancelled) setLookupFailed(true);
      }
    };

    join();

    const unsubRoom = onSnapshot(
      roomRef,
      (snapshot) => {
        if (cancelled) return;
        if (snapshot.exists()) setLobby(snapshot.data() as Lobby);
        else setLookupFailed(true);
      },
      (e) => {
        console.error("Lobby listener failed", e);
        if (!cancelled) setLookupFailed(true);
      },
    );

    const unsubChat = onSnapshot(
      query(collection(db, "lobbies", roomId, "messages"), orderBy("createdAt", "desc"), limit(CHAT_LIMIT)),
      (snap) => {
        if (cancelled) return;
        const next = snap.docs.map((d) => ({ id: d.id, ...d.data() } as LobbyMessage));
        next.reverse(); // query is newest-first; render oldest-first
        setMessages(next);
      },
      (e) => console.error("Chat listener failed", e),
    );

    return () => {
      cancelled = true;
      unsubRoom();
      unsubChat();
      // Best-effort leave. If it doesn't land, presence still removes the
      // player from everyone's roster.
      updateDoc(roomRef, { [`players.${user.uid}`]: deleteField() }).catch(() => {});
    };
  }, [user, roomId]);

  // ── Host migration ────────────────────────────────────────────────────────
  // If the host's presence drops, the longest-present remaining player claims
  // the room. Without this a host leaving stranded everyone permanently.
  useEffect(() => {
    if (!lobby || !user || presentUids.size === 0) return;
    if (lobby.hostId === user.uid) return;
    if (presentUids.has(lobby.hostId)) return;

    const candidates = Object.values(lobby.players || {})
      .filter((p) => presentUids.has(p.uid))
      .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));

    if (candidates[0]?.uid !== user.uid) return;

    updateDoc(doc(db, "lobbies", roomId), {
      hostId: user.uid,
      [`players.${lobby.hostId}`]: deleteField(),
    }).catch((e) => console.error("Host migration failed", e));
  }, [lobby, presentUids, user, roomId]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setIsPseudoFull(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /** Ready state now persists, so other players actually see it. */
  const toggleReady = useCallback(async () => {
    if (!user || !me) return;
    try {
      await updateDoc(doc(db, "lobbies", roomId), {
        [`players.${user.uid}.isReady`]: !me.isReady,
      });
    } catch (e) {
      console.error("Error toggling ready:", e);
    }
  }, [user, me, roomId]);

  const selectGame = async (gameId: string) => {
    if (!isHost) return;
    try {
      await updateDoc(doc(db, "lobbies", roomId), { gameId });
    } catch (e) {
      console.error("Error selecting game:", e);
    }
  };

  const startGame = async () => {
    if (!isHost || !lobby?.gameId || !everyoneReady) return;
    try {
      // `matchStarted` is the game's own go-signal; reset it so a rematch
      // doesn't start instantly from a previous round's flag.
      await updateDoc(doc(db, "lobbies", roomId), {
        status: "playing",
        matchStarted: false,
        collectedGems: {},
      });
    } catch (e) {
      console.error("Error starting game:", e);
    }
  };

  const endGame = async () => {
    if (!isHost) return;
    try {
      await updateDoc(doc(db, "lobbies", roomId), {
        status: "waiting",
        matchStarted: false,
      });
    } catch (e) {
      console.error("Error ending game:", e);
    }
  };

  const lastMessageTimeRef = useRef<number>(0);
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatMessage.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text || !user) return;

    const now = Date.now();
    if (now - lastMessageTimeRef.current < CHAT_COOLDOWN_MS) return;
    lastMessageTimeRef.current = now;

    setChatMessage("");
    try {
      // A subcollection, not an array on the room document. The old arrayUnion
      // rewrote and re-broadcast the whole document on every message and would
      // eventually hit the 1MB document ceiling, bricking the lobby for good.
      await addDoc(collection(db, "lobbies", roomId, "messages"), {
        uid: user.uid,
        displayName: user.displayName || "Player",
        text,
        createdAt: now,
      });
    } catch (err) {
      console.error("Error sending message:", err);
      setChatMessage(text);
    }
  };

  const sendInvite = async (friendId: string) => {
    if (!user || !roomId) return;
    try {
      await addDoc(collection(db, "invites"), {
        targetId: friendId,
        fromUid: user.uid,
        fromName: user.displayName || "A friend",
        roomId,
        ...inviteTimestamps(),
      });
      setInviteSent(friendId);
      setTimeout(() => setInviteSent(null), 2000);
    } catch (e) {
      console.error("Invite error:", e);
    }
  };

  const toggleFullScreen = () => {
    const isDeviceMobile =
      "ontouchstart" in window || navigator.maxTouchPoints > 0 || window.innerWidth < 1024;

    if (isDeviceMobile) {
      setIsPseudoFull((v) => !v);
      return;
    }
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => setIsPseudoFull(true));
      setIsPseudoFull(true);
    } else {
      document.exitFullscreen?.();
      setIsPseudoFull(false);
    }
  };

  if (notFound) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-6 text-center">
        <h2 className="text-2xl font-bold text-white">This lobby isn&apos;t available</h2>
        <p className="text-text-secondary max-w-sm">
          It may have expired, been closed by the host, or already be full.
        </p>
        <button
          onClick={() => router.push("/dashboard")}
          className="px-6 py-3 bg-primary hover:bg-primary/90 text-white font-bold rounded-2xl transition-colors"
        >
          Back to dashboard
        </button>
      </div>
    );
  }

  if (!lobby) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <Loader2 size={48} className="animate-spin text-primary mb-4" />
        <h2 className="text-xl font-bold text-white">Joining Lobby...</h2>
      </div>
    );
  }

  const accent = selectedGame ? gameAccent(selectedGame) : null;

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <nav className="glass border-b border-white/5 px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
            <Gamepad2 size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">
              Lobby: <span className="font-mono tracking-widest">{roomId}</span>
            </h1>
            <span className="text-xs text-text-muted flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              {players.length}/{capacity} connected
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsInviteModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold transition-all"
          >
            <Users size={18} />
            <span className="hidden sm:inline">Invite Friends</span>
          </button>
          <button
            onClick={copyLink}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 glass text-white font-medium hover:bg-white/10 transition-colors"
          >
            {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
            <span className="hidden sm:inline">{copied ? "Copied!" : "Copy Link"}</span>
          </button>
          <button
            onClick={() => router.push("/dashboard")}
            className="p-2 rounded-lg glass hover:bg-error/20 hover:text-error text-text-muted transition-colors border border-white/5"
            title="Leave lobby"
          >
            <LogOut size={18} />
          </button>
        </div>
      </nav>

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
                <button
                  onClick={() => setIsInviteModalOpen(false)}
                  className="p-2 hover:bg-white/10 rounded-xl transition-colors"
                >
                  <X className="text-text-muted" size={20} />
                </button>
              </div>

              <div className="p-4 max-h-[60vh] overflow-y-auto space-y-2">
                {friends.length === 0 ? (
                  <div className="text-center py-10 text-text-muted">
                    <Users size={48} className="mx-auto opacity-20 mb-4" />
                    <p>No friends to invite yet.</p>
                    <p className="text-sm">Add them from the friends panel.</p>
                  </div>
                ) : (
                  friends.map((f) => (
                    <div
                      key={f.uid}
                      className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <Avatar uid={f.uid} src={f.photoURL} name={f.displayName} />
                        <p className="font-bold text-white">{f.displayName}</p>
                      </div>
                      <button
                        onClick={() => sendInvite(f.uid)}
                        disabled={inviteSent === f.uid}
                        className="px-4 py-2 bg-primary/20 hover:bg-primary text-primary hover:text-white text-xs font-bold rounded-xl transition-all disabled:opacity-60"
                      >
                        {inviteSent === f.uid ? "Sent!" : "Send Invite"}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-row overflow-hidden relative">
        <button
          onClick={() => setShowSidebar(!showSidebar)}
          className="lg:hidden fixed bottom-6 right-6 z-[60] w-14 h-14 bg-primary text-white rounded-full shadow-2xl flex items-center justify-center border-2 border-white/20 active:scale-95 transition-all"
          aria-label={showSidebar ? "Hide players and chat" : "Show players and chat"}
        >
          {showSidebar ? <X size={24} /> : <MessageSquare size={24} />}
        </button>

        <div
          className={`${
            showSidebar ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
          } fixed lg:relative inset-y-0 left-0 w-80 flex flex-col border-r border-white/5 bg-black/90 lg:bg-black/20 z-50 transition-transform duration-300 ease-in-out`}
        >
          <div className="p-6 flex flex-col min-h-0 h-[45%] border-b border-white/5">
            <h2 className="text-sm font-bold text-text-muted uppercase tracking-wider mb-4 flex items-center gap-2">
              <Users size={16} /> Crew ({players.length}/{capacity})
            </h2>

            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
              <div className="space-y-3">
                <AnimatePresence initial={false}>
                  {players.map((player) => (
                    <motion.div
                      key={player.uid}
                      layout
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className="flex items-center justify-between p-3 rounded-xl glass border border-white/5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar uid={player.uid} src={player.photoURL} name={player.displayName} />
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-white flex items-center gap-1 truncate">
                            {player.displayName}
                            {player.uid === lobby.hostId && (
                              <Crown size={14} className="text-yellow-400 shrink-0" />
                            )}
                          </p>
                          <p className="text-xs text-text-muted">
                            {player.uid === user?.uid ? "You" : "In Lobby"}
                          </p>
                        </div>
                      </div>
                      {player.isReady && (
                        <span className="shrink-0 text-success" title="Ready">
                          <Check size={18} />
                        </span>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>

            {lobby.status !== "playing" && me && (
              <button
                onClick={toggleReady}
                className={`mt-4 w-full py-3 rounded-xl font-bold text-sm transition-colors ${
                  me.isReady
                    ? "bg-success/20 text-success border border-success/40"
                    : "bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                {me.isReady ? "Ready ✓" : "Mark as Ready"}
              </button>
            )}
          </div>

          <div className="flex-1 flex flex-col min-h-0 p-4 bg-black/40">
            <div className="flex-1 overflow-y-auto mb-4 p-2 space-y-4">
              {messages.length === 0 ? (
                <div className="text-center text-xs text-text-muted my-2">
                  No messages yet. Start the trash talk!
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${msg.uid === user?.uid ? "items-end" : "items-start"}`}
                  >
                    <span className="text-[10px] text-text-muted mb-1 px-1">{msg.displayName}</span>
                    <div
                      className={`px-3 py-2 rounded-2xl text-sm max-w-[90%] break-words ${
                        msg.uid === user?.uid
                          ? "bg-primary text-white rounded-tr-none"
                          : "bg-white/10 text-white rounded-tl-none"
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                ))
              )}
            </div>
            <form onSubmit={sendMessage} className="relative">
              <label htmlFor="chat-input" className="sr-only">Message</label>
              <input
                id="chat-input"
                type="text"
                placeholder="Type a message..."
                maxLength={MAX_MESSAGE_LENGTH}
                className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 pr-12 text-sm text-white focus:outline-none focus:border-primary/50 transition-colors"
                value={chatMessage}
                onChange={(e) => setChatMessage(e.target.value)}
              />
              <button
                type="submit"
                aria-label="Send message"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-white/10 rounded-lg text-text-muted hover:text-white transition-colors"
              >
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>

        <div
          className={`flex-1 relative flex flex-col ${
            lobby.status === "playing" ? "p-0" : "p-6 lg:p-12 overflow-y-auto"
          }`}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />

          {lobby.status === "playing" && lobby.gameId ? (
            <div
              className={`${
                isPseudoFull ? "fixed inset-0 z-[100] bg-black" : "flex-1 relative"
              } w-full flex flex-col`}
            >
              <iframe
                id="game-iframe"
                src={gameUrl(lobby.gameId, {
                  room: roomId,
                  displayName: user?.displayName || "Player",
                  photoURL: user?.photoURL || "",
                })}
                className="flex-1 w-full h-full border-none z-10"
                title={selectedGame?.name || "Game Window"}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              />

              <div className="absolute top-4 right-4 z-[110] flex gap-2">
                <button
                  onClick={toggleFullScreen}
                  className={`p-2 rounded-xl border border-white/20 shadow-2xl backdrop-blur-md transition-colors ${
                    isPseudoFull
                      ? "bg-primary text-white border-primary/50"
                      : "bg-black/60 hover:bg-black text-white"
                  }`}
                  title={isPseudoFull ? "Close Full Screen" : "Full Screen"}
                >
                  <Maximize2 size={18} />
                </button>

                {isHost && (
                  <button
                    onClick={endGame}
                    className="glass px-4 py-2 bg-black/80 hover:bg-black text-white font-bold rounded-xl border border-white/20 text-sm shadow-2xl backdrop-blur-md"
                  >
                    End Game
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-8 relative">
              <div className="text-center mb-12">
                <h1 className="text-4xl font-black text-white mb-2">
                  {isHost ? "Select a Game" : "Waiting for Host..."}
                </h1>
                <p className="text-text-secondary">
                  {isHost
                    ? "Pick what your crew will play next."
                    : `${lobby.players?.[lobby.hostId]?.displayName || "The host"} is picking a game.`}
                </p>
              </div>

              {selectedGame && (
                <div className="glass p-8 rounded-3xl border border-primary/30 flex flex-col md:flex-row items-center gap-8 relative overflow-hidden">
                  {accent && (
                    <div
                      className="absolute inset-0 opacity-10"
                      style={{
                        backgroundImage: `linear-gradient(to right, ${accent.from}, ${accent.to})`,
                      }}
                    />
                  )}
                  <div className="w-24 h-24 shrink-0 rounded-2xl overflow-hidden">
                    <GameThumb game={selectedGame} size={96} className="w-full h-full" />
                  </div>
                  <div className="flex-1 relative text-center md:text-left">
                    <h2 className="text-3xl font-bold text-white">{selectedGame.name}</h2>
                    <p className="text-primary font-medium">{selectedGame.subtitle}</p>
                    <p className="text-text-muted mt-2 text-sm">{selectedGame.description}</p>
                    {selectedGame.controls && (
                      <p className="text-text-muted mt-2 text-xs font-mono">{selectedGame.controls}</p>
                    )}
                  </div>

                  {isHost && (
                    <div className="relative shrink-0 flex flex-col items-center gap-2">
                      <button
                        onClick={startGame}
                        disabled={!everyoneReady}
                        className="btn-glow px-8 py-4 bg-gradient-to-r from-primary to-accent rounded-2xl text-white font-bold text-lg shadow-xl shadow-primary/20 flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Play size={20} className="fill-white" /> Start Game
                      </button>
                      {!everyoneReady && (
                        <span className="text-xs text-text-muted">
                          Waiting for everyone to be ready
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 relative">
                {PLAYABLE_GAMES.map((game) => {
                  const isSelected = lobby.gameId === game.id;
                  return (
                    <button
                      key={game.id}
                      type="button"
                      onClick={() => selectGame(game.id)}
                      disabled={!isHost}
                      className={`relative rounded-2xl p-6 glass transition-all text-left ${
                        isHost ? "cursor-pointer hover:scale-105" : "cursor-default opacity-50 grayscale"
                      } ${
                        isSelected
                          ? "border-2 border-primary shadow-lg shadow-primary/20 ring-4 ring-primary/10"
                          : "border border-white/5 hover:border-white/20"
                      }`}
                    >
                      <div className="w-12 h-12 mx-auto mb-3 rounded-xl overflow-hidden">
                        <GameThumb game={game} size={48} className="w-full h-full" />
                      </div>
                      <h3 className="text-sm font-bold text-white text-center mb-1">{game.name}</h3>
                      <div className="text-[10px] font-semibold text-center text-text-muted uppercase tracking-wider">
                        {playerCountLabel(game)}P
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Avatar({ uid, src, name }: { uid: string; src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const fallback = `https://api.dicebear.com/7.x/avataaars/svg?seed=${uid}`;
  return (
    <img
      src={!src || failed ? fallback : src}
      onError={() => setFailed(true)}
      alt={name}
      width={40}
      height={40}
      className="w-10 h-10 rounded-full border-2 border-primary/50 shrink-0"
    />
  );
}

export default function LobbyPage() {
  return (
    <AuthGuard>
      <Suspense
        fallback={
          <div className="min-h-screen bg-background flex flex-col items-center justify-center text-white">
            <Loader2 size={48} className="animate-spin text-primary mb-4" />
            <h2 className="text-xl font-bold">Joining Lobby...</h2>
          </div>
        }
      >
        <LobbyContent />
      </Suspense>
    </AuthGuard>
  );
}
