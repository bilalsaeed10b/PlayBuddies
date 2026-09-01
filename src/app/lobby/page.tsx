"use client";

import { useState, useEffect, useRef, useMemo, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/store/useAuthStore";
import { PLAYABLE_GAMES, getGame, gameUrl, gameAccent, playerCountLabel } from "@/lib/games";
import GameThumb from "@/components/GameThumb";
import AuthGuard from "@/components/AuthGuard";
import { db } from "@/lib/firebase";
import { useFriends } from "@/hooks/useFriends";
import { useLobbyPresence, useFriendsOnline } from "@/hooks/usePresence";
import { normalizeRoomCode, isValidRoomCode, LOBBY_TTL_MS, inviteTimestamps } from "@/lib/rooms";
import { FRIEND_CODE_LENGTH, findByFriendCode, sendFriendRequest } from "@/lib/friends";
import { rememberLobby, forgetLobby } from "@/lib/lastLobby";
import { cleanWallet, EMPTY_WALLET, readWallet, recordMatch, writeWallet, type Wallet } from "@/lib/wallet";
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
  Send,
  X,
  MoreVertical,
  UserPlus,
  UserX,
  Search,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

/** Chat is capped so the lobby view never grows unbounded. */
const CHAT_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_MS = 1000;

/**
 * How long the host must be absent from presence before someone else claims
 * the room.
 *
 * Presence comes from RTDB `onDisconnect`, which fires on the server the
 * instant a socket closes — including the brief, ordinary reconnect a phone
 * does on a cell handoff or a wifi-to-data switch, exactly the kind of network
 * a player without a stable connection has. Without a grace period, that one
 * dropped frame was enough to hand the room to someone else *and delete the
 * real host's own player record*, which from the host's side looked like the
 * match simply breaking under them for no reason.
 */
const HOST_MIGRATION_GRACE_MS = 6000;

function LobbyContent() {
  const searchParams = useSearchParams();
  const roomId = normalizeRoomCode(searchParams.get("room") || "");
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const clearStats = useAuthStore((s) => s.clearStats);

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [messages, setMessages] = useState<LobbyMessage[]>([]);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [wasKicked, setWasKicked] = useState(false);
  // A malformed code is knowable during render — no need to round-trip it.
  const notFound = lookupFailed || (Boolean(roomId) && !isValidRoomCode(roomId));
  const [copied, setCopied] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [showSidebar, setShowSidebar] = useState(false);
  const [isPseudoFull, setIsPseudoFull] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteSent, setInviteSent] = useState<string | null>(null);
  /** "Add a friend by code" inside the invite modal — separate from the invite list below it. */
  const [addCode, setAddCode] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addNotice, setAddNotice] = useState("");
  /** Crew and chat share the sidebar as tabs rather than a fixed vertical split. */
  const [sidebarTab, setSidebarTab] = useState<"crew" | "chat">("crew");
  /** Which crew member's "…" menu is open, if any. One at a time. */
  const [crewMenuFor, setCrewMenuFor] = useState<string | null>(null);
  const [crewNotice, setCrewNotice] = useState("");
  /**
   * How many chat messages have actually been seen.
   *
   * Crew and chat used to both be on screen at once, so a new message was
   * always visible. Now that chat is a tab, a message arriving while Crew is
   * open would otherwise go completely unnoticed — this is what the dot on
   * the Chat tab is tracking against.
   */
  const seenChatCount = useRef(0);
  const gameFrameRef = useRef<HTMLIFrameElement>(null);
  /** The wrapper that goes fullscreen — the frame plus its floating controls. */
  const gameShellRef = useRef<HTMLDivElement>(null);
  /** Always the latest `endGame`, for the message handler below to call without needing it as a dependency. */
  const endGameRef = useRef<() => Promise<void>>(async () => {});

  /**
   * The player's purse, held here rather than in the game.
   *
   * A ref, not state: nothing on this page renders it, and putting it in state
   * would repaint the lobby every time a coin was earned. The iframe's src is
   * built during render, so a repaint there is not free, it is a reload of the
   * running game.
   */
  const walletRef = useRef<Wallet>(EMPTY_WALLET);
  const walletLoaded = useRef(false);

  const presentUids = useLobbyPresence(roomId);
  // Always on, not just while the invite modal is open — the crew list also
  // needs to know who is already a friend, to offer "Add Friend" only where
  // it means something.
  const { friends } = useFriends(true);
  const friendUidSet = useMemo(() => new Set(friends.map((f) => f.uid)), [friends]);
  // Per-friend presence listeners are the more expensive part, though, so
  // those stay scoped to the picker being open.
  const friendUids = useMemo(
    () => (isInviteModalOpen ? friends.map((f) => f.uid) : []),
    [friends, isInviteModalOpen],
  );
  const onlineFriends = useFriendsOnline(friendUids);

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

  // Ready is opt-out, not opt-in: players join ready and can un-ready if they
  // need a moment. Nothing blocks on player count — a host alone can start and
  // play solo, which is how you test a room or warm up while friends arrive.
  const everyoneReady = players.every((p) => p.isReady);
  const isSolo = players.length < (selectedGame?.minPlayers ?? 2);

  /**
   * Invite list: whoever can actually be invited, most useful first. Friends
   * already sitting in the room are kept visible but disabled — sending them a
   * second invite did nothing except cost a write and confuse them.
   */
  const invitees = useMemo(() => {
    const inRoom = new Set(players.map((p) => p.uid));
    return friends
      .map((f) => ({
        ...f,
        joined: inRoom.has(f.uid),
        online: onlineFriends.has(f.uid),
      }))
      .sort(
        (a, b) =>
          Number(a.joined) - Number(b.joined) ||
          Number(b.online) - Number(a.online) ||
          a.displayName.localeCompare(b.displayName),
      );
  }, [friends, players, onlineFriends]);

  const roomFull = players.length >= capacity;

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
    // Flips true the first time a snapshot actually shows us as a member.
    // `join()` writes asynchronously, so the very first snapshot or two can
    // legitimately arrive before it lands — without this guard, that window
    // would read identically to being kicked and bounce a player who is
    // mid-join right back out.
    let wasMember = false;

    const join = async () => {
      const profile: LobbyPlayer = {
        uid: user.uid,
        displayName: user.displayName || "Player",
        photoURL: user.photoURL || "",
        isReady: true,
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
    rememberLobby(roomId);

    const unsubRoom = onSnapshot(
      roomRef,
      (snapshot) => {
        if (cancelled) return;
        if (!snapshot.exists()) {
          setLookupFailed(true);
          return;
        }
        const data = snapshot.data() as Lobby;
        const amMember = Boolean(data.players?.[user.uid]);
        if (amMember) {
          wasMember = true;
        } else if (wasMember) {
          // Was here a moment ago, isn't now, and the room itself is still
          // there: the host removed us. A missing room entirely is handled
          // above, by `!snapshot.exists()` — this is specifically the
          // "still a room, just not one with me in it anymore" case.
          setWasKicked(true);
          forgetLobby();
          return;
        }
        setLobby(data);
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
  // If the host's presence drops and *stays* dropped, the longest-present
  // remaining player claims the room. Without this a host leaving stranded
  // everyone permanently. With no grace period, it also fired on a presence
  // blip that recovered on its own a moment later — see HOST_MIGRATION_GRACE_MS.
  useEffect(() => {
    if (!lobby || !user || presentUids.size === 0) return;
    if (lobby.hostId === user.uid) return;
    if (presentUids.has(lobby.hostId)) return;

    const candidates = Object.values(lobby.players || {})
      .filter((p) => presentUids.has(p.uid))
      .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));

    if (candidates[0]?.uid !== user.uid) return;

    // Cancelled by this effect's own cleanup the moment `presentUids` changes
    // again — including the moment it changes because the host came back.
    const timer = setTimeout(() => {
      updateDoc(doc(db, "lobbies", roomId), {
        hostId: user.uid,
        [`players.${lobby.hostId}`]: deleteField(),
      }).catch((e) => console.error("Host migration failed", e));
    }, HOST_MIGRATION_GRACE_MS);

    return () => clearTimeout(timer);
  }, [lobby, presentUids, user, roomId]);

  // Marks messages as seen for as long as the chat tab is the one showing.
  useEffect(() => {
    if (sidebarTab === "chat") seenChatCount.current = messages.length;
  }, [sidebarTab, messages.length]);
  const hasUnreadChat = sidebarTab !== "chat" && messages.length > seenChatCount.current;

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setIsPseudoFull(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  /**
   * Hand the current wallet down to the game.
   *
   * The game asks on boot rather than the page pushing on load, because a
   * frame that has not run its scripts yet has nothing listening, and "wait a
   * moment and hope" is not a handshake.
   */
  const sendWallet = useCallback(async () => {
    const frame = gameFrameRef.current?.contentWindow;
    if (!frame) return;
    if (user && !walletLoaded.current) {
      try {
        walletRef.current = await readWallet(user.uid);
        walletLoaded.current = true;
      } catch (err) {
        console.error("Could not read the wallet:", err);
      }
    }
    frame.postMessage(
      {
        source: "playbuddies-host",
        type: "wallet",
        coins: walletRef.current.coins,
        unlocks: walletRef.current.unlocks,
      },
      "*",
    );
  }, [user]);

  // A different account gets a different purse, so drop the cached one.
  useEffect(() => {
    walletLoaded.current = false;
    walletRef.current = EMPTY_WALLET;
  }, [user?.uid]);

  /**
   * Everything a game says to the page it is embedded in.
   *
   * A game is sandboxed in an iframe and signed in to nothing, so it cannot
   * read or write the player's account itself. It asks, and this page answers.
   * Every message is checked against this lobby's own frame first, so another
   * page cannot talk its way into a coin balance by posting at us.
   *
   *   fullscreen    Expand me. Games cannot do this alone: iOS has no
   *                 Element.requestFullscreen, and even where the API exists it
   *                 only blows up the iframe's own document while this page's
   *                 chrome stays wrapped around it.
   *   end-game      The host pressed the game's own "End Game" button. Every
   *                 game now carries this in its own control bar rather than
   *                 this page floating a duplicate one over the iframe, so
   *                 this is the only way it hears about it. `endGame` itself
   *                 still checks host-ness — a non-host game sending this is
   *                 either a bug or someone poking postMessage by hand, and
   *                 either way it should not end anyone's match.
   *   wallet-request  I have booted, what does this player own?
   *   wallet-save   Their balance changed, please keep it.
   *   result        A match finished, and whether this player won it.
   */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || data.source !== "playbuddies-game") return;
      if (e.source !== gameFrameRef.current?.contentWindow) return;

      if (data.type === "fullscreen") {
        setIsPseudoFull(Boolean(data.value));
        return;
      }

      if (data.type === "end-game") {
        void endGameRef.current();
        return;
      }

      if (data.type === "wallet-request") {
        void sendWallet();
        return;
      }

      if (data.type === "wallet-save") {
        if (!user) return;
        const next = cleanWallet({ coins: data.coins, unlocks: data.unlocks });
        walletRef.current = next;
        void writeWallet(user.uid, next).catch((err) =>
          console.error("Could not save the wallet:", err),
        );
        return;
      }

      if (data.type === "result") {
        if (!user) return;
        void recordMatch(user.uid, Boolean(data.won))
          .then(clearStats)
          .catch((err) => console.error("Could not record the match:", err));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // endGame is read through endGameRef (assigned below, after it's defined)
    // rather than listed here — it isn't memoized, and this listener has no
    // reason to be torn down and rebuilt on every render just because that
    // function identity changed.
  }, [user, sendWallet, clearStats]);

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
      // `fishIndex`/`role` are the small per-player schema every game shares
      // (see the security rules), so a face picked in one game was still
      // sitting in the doc when the next game's picker read it -- showing up
      // there as somebody else's fish already locked in, in whatever
      // unrelated skin happens to share that index. Games differ entirely on
      // what index N means, so a value from the last game is never valid for
      // the next one and has to be cleared here, the one place a game change
      // actually happens, rather than in every game.
      //
      // isReady is reset to true, not cleared. Ready is opt-out everywhere
      // else in this file (see join()) -- deleting it here made it read as
      // falsy instead, so every game switch silently un-readied the whole
      // room with nothing on screen explaining why the host suddenly could
      // not start.
      const reset: Record<string, ReturnType<typeof deleteField> | true> = {};
      for (const uid of Object.keys(lobby?.players ?? {})) {
        reset[`players.${uid}.fishIndex`] = deleteField();
        reset[`players.${uid}.role`] = deleteField();
        reset[`players.${uid}.isReady`] = true;
      }
      await updateDoc(doc(db, "lobbies", roomId), { gameId, ...reset });
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
        // Frozen at start. Deriving it live would remount the iframe — and
        // discard the run in progress — the moment a friend joined.
        soloMode: isSolo,
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
  endGameRef.current = endGame;

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

  /**
   * "Add a friend by code", inline in the invite modal.
   *
   * Sends a friend request rather than an invite — friendship is required
   * before an invite can even be sent (the platform's own rule, so a stranger
   * can't be spammed into a room), so this is the step that has to happen
   * first for someone who isn't a friend yet.
   */
  const submitAddByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = addCode.trim().toUpperCase();
    if (code.length !== FRIEND_CODE_LENGTH || !user || addBusy) return;

    setAddBusy(true);
    setAddNotice("");
    try {
      const matches = await findByFriendCode(code, user.uid);
      if (matches.length === 0) {
        setAddNotice("No player found with that code.");
        return;
      }
      const outcome = await sendFriendRequest(user.uid, matches[0].uid);
      if (outcome === "sent") {
        setAddNotice(`Friend request sent to ${matches[0].displayName}.`);
        setAddCode("");
      } else if (outcome === "already-friends") {
        setAddNotice("You're already friends.");
      } else if (outcome === "already-pending") {
        setAddNotice("Request already pending.");
      } else {
        setAddNotice("Couldn't send that request.");
      }
    } catch (e) {
      console.error("Add by code failed:", e);
      setAddNotice("Couldn't send that request.");
    } finally {
      setAddBusy(false);
    }
  };

  /** "Add Friend" from a crew member's own "…" menu. */
  const addCrewFriend = async (targetUid: string) => {
    if (!user) return;
    setCrewMenuFor(null);
    const outcome = await sendFriendRequest(user.uid, targetUid);
    setCrewNotice(
      outcome === "sent"
        ? "Friend request sent."
        : outcome === "already-friends"
          ? "Already friends."
          : outcome === "already-pending"
            ? "Request already pending."
            : "Couldn't send that request.",
    );
    setTimeout(() => setCrewNotice(""), 2500);
  };

  /**
   * Host only: hand the crown to someone else already in the room.
   *
   * Permitted by the existing rules with no changes needed — the host branch
   * in firestore.rules has no restriction on which fields it can touch, only
   * on who is allowed to write (`isLobbyHost()`), so this is exactly as
   * legitimate a host write as picking the game already was. The mover loses
   * host the instant this lands; there's no separate "confirm" step because
   * undoing it is just the new host doing the same thing back.
   */
  const makeHost = async (targetUid: string, name: string) => {
    if (!isHost) return;
    setCrewMenuFor(null);
    try {
      await updateDoc(doc(db, "lobbies", roomId), { hostId: targetUid });
    } catch (e) {
      console.error("Error transferring host:", e);
      setCrewNotice(`Couldn't make ${name} host.`);
      setTimeout(() => setCrewNotice(""), 2500);
    }
  };

  /**
   * Host only: remove someone from the room outright.
   *
   * Same write shape as a normal self-leave (`players.{uid}` deleted) — the
   * kicked player's own listener notices they've disappeared from a room that
   * still exists and treats it as being kicked. See the `wasKicked` branch in
   * the room snapshot handler above.
   */
  const kickPlayer = async (targetUid: string, name: string) => {
    if (!isHost) return;
    setCrewMenuFor(null);
    try {
      await updateDoc(doc(db, "lobbies", roomId), {
        [`players.${targetUid}`]: deleteField(),
      });
      setCrewNotice(`${name} was removed from the lobby.`);
    } catch (e) {
      console.error("Error kicking player:", e);
      setCrewNotice(`Couldn't remove ${name}.`);
    }
    setTimeout(() => setCrewNotice(""), 2500);
  };

  /**
   * While the game owns the screen, nothing behind it should scroll or rotate.
   * On a phone this is the difference between "bigger" and "fullscreen".
   */
  useEffect(() => {
    if (!isPseudoFull) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
      unlock?: () => void;
    };
    orientation?.lock?.("landscape").catch(() => {
      /* most browsers only allow this in true fullscreen */
    });

    return () => {
      document.body.style.overflow = previous;
      try {
        orientation?.unlock?.();
      } catch {
        /* not supported */
      }
    };
  }, [isPseudoFull]);

  if (wasKicked) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-6 text-center">
        <h2 className="text-2xl font-bold text-white">You were removed from this lobby</h2>
        <p className="text-text-secondary max-w-sm">
          The host removed you. Ask them for a fresh invite if you want back in.
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

  if (notFound) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-6 text-center">
        <h2 className="text-2xl font-bold text-white">This lobby isn&apos;t available</h2>
        <p className="text-text-secondary max-w-sm">
          It may have expired, been closed by the host, or already be full.
        </p>
        <ForgetLobbyOnMount />
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

  // dvh, not vh: on a phone `vh` counts the space the URL bar occupies, so the
  // bottom of the lobby sat underneath the browser chrome.
  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden">
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
            onClick={() => {
              // Leaving on purpose, so don't offer to resume this room later.
              forgetLobby();
              router.push("/dashboard");
            }}
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

              <div className="px-6 pt-4 flex items-center justify-between text-xs text-text-muted">
                <span>
                  {players.length}/{capacity} in the room
                </span>
                <button
                  onClick={copyLink}
                  className="flex items-center gap-1.5 hover:text-white transition-colors"
                >
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                  {copied ? "Link copied" : "Copy invite link"}
                </button>
              </div>

              {/*
                Not everyone worth inviting is a friend yet. Sending a friend
                request here — rather than only from the separate friends
                panel — is what makes this modal a real substitute for it
                mid-invite, instead of a dead end that sends the host looking
                for a different button.
              */}
              <div className="px-6 pt-4">
                <form onSubmit={submitAddByCode} className="flex gap-2">
                  <div className="relative flex-1">
                    <Search
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                      size={14}
                    />
                    <label htmlFor="add-by-code" className="sr-only">Friend code</label>
                    <input
                      id="add-by-code"
                      type="text"
                      placeholder="Add a friend by code"
                      value={addCode}
                      onChange={(e) => {
                        setAddCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                        setAddNotice("");
                      }}
                      maxLength={FRIEND_CODE_LENGTH}
                      className="w-full uppercase font-mono tracking-widest bg-white/5 border border-white/10 rounded-xl py-2 pl-9 pr-3 text-xs text-white focus:outline-none focus:border-primary transition-colors"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={addCode.length !== FRIEND_CODE_LENGTH || addBusy}
                    className="shrink-0 px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-xs font-bold rounded-xl transition-colors disabled:opacity-50"
                  >
                    {addBusy ? "…" : "Add"}
                  </button>
                </form>
                {addNotice && <p className="mt-2 text-xs text-amber-300">{addNotice}</p>}
              </div>

              <div className="p-4 max-h-[60vh] overflow-y-auto space-y-2">
                {invitees.length === 0 ? (
                  <div className="text-center py-10 text-text-muted">
                    <Users size={48} className="mx-auto opacity-20 mb-4" />
                    <p>No friends to invite yet.</p>
                    <p className="text-sm">Add them from the friends panel, or share the link above.</p>
                  </div>
                ) : (
                  invitees.map((f) => (
                    <div
                      key={f.uid}
                      className={`glass p-3 rounded-2xl border border-white/5 flex items-center justify-between ${
                        f.joined ? "opacity-50" : ""
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative shrink-0">
                          <Avatar uid={f.uid} src={f.photoURL} name={f.displayName} />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background ${
                              f.online ? "bg-success" : "bg-text-muted/60"
                            }`}
                            title={f.online ? "Online" : "Offline"}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-white truncate">{f.displayName}</p>
                          <p className="text-[11px] text-text-muted">
                            {f.joined ? "Already here" : f.online ? "Online" : "Offline"}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => sendInvite(f.uid)}
                        disabled={f.joined || roomFull || inviteSent === f.uid}
                        className="shrink-0 px-4 py-2 bg-primary/20 hover:bg-primary text-primary hover:text-white text-xs font-bold rounded-xl transition-all disabled:opacity-40 disabled:hover:bg-primary/20 disabled:hover:text-primary"
                        title={roomFull ? "The room is full" : undefined}
                      >
                        {f.joined ? "In lobby" : inviteSent === f.uid ? "Sent!" : "Send Invite"}
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
          {/* ── crew / chat tabs ──
              Each pane gets the sidebar's full height now, rather than a fixed
              45/55 split — Crew stops truncating a full room, and Chat stops
              being a cramped strip under it. */}
          <div className="flex border-b border-white/5 shrink-0">
            <button
              onClick={() => setSidebarTab("crew")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                sidebarTab === "crew"
                  ? "border-primary text-white bg-white/5"
                  : "border-transparent text-text-muted hover:text-white hover:bg-white/5"
              }`}
            >
              <Users size={14} /> Crew ({players.length}/{capacity})
            </button>
            <button
              onClick={() => setSidebarTab("chat")}
              className={`relative flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                sidebarTab === "chat"
                  ? "border-primary text-white bg-white/5"
                  : "border-transparent text-text-muted hover:text-white hover:bg-white/5"
              }`}
            >
              <MessageSquare size={14} /> Chat
              {hasUnreadChat && (
                <span className="w-2 h-2 rounded-full bg-primary" aria-label="Unread messages" />
              )}
            </button>
          </div>

          {sidebarTab === "crew" ? (
            <div className="flex-1 flex flex-col min-h-0 p-6">
              {crewNotice && (
                <p className="mb-3 text-xs text-center text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg py-2 px-3">
                  {crewNotice}
                </p>
              )}
              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                <div className="space-y-3">
                  <AnimatePresence initial={false}>
                    {players.map((player) => {
                      const isSelf = player.uid === user?.uid;
                      const isFriend = friendUidSet.has(player.uid);
                      return (
                        <motion.div
                          key={player.uid}
                          layout
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -20 }}
                          // Ready/not-ready used to be a bare checkmark that only
                          // ever appeared, never the reverse — a room stuck on
                          // "why can't I start" had nothing on screen naming who
                          // it was waiting on. A glowing border does double duty:
                          // green-and-lit reads as fine at a glance, red-and-lit
                          // reads as "this one" without having to scan for a tiny
                          // icon.
                          className={`relative flex items-center justify-between p-3 rounded-xl glass border transition-colors duration-300 ${
                            player.isReady
                              ? "border-success/50 shadow-[0_0_16px_-2px_var(--color-success)]"
                              : "border-error/60 shadow-[0_0_16px_-2px_var(--color-error)]"
                          }`}
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
                                {isSelf ? "You" : "In Lobby"}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <span
                              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                                player.isReady
                                  ? "bg-success/15 text-success"
                                  : "bg-error/15 text-error"
                              }`}
                              title={player.isReady ? "Ready" : "Not ready"}
                            >
                              {player.isReady ? <Check size={12} /> : <X size={12} />}
                              {player.isReady ? "Ready" : "Not ready"}
                            </span>
                            {!isSelf && (
                              <button
                                onClick={() =>
                                  setCrewMenuFor((cur) => (cur === player.uid ? null : player.uid))
                                }
                                aria-label={`Options for ${player.displayName}`}
                                className="p-1.5 rounded-lg text-text-muted hover:text-white hover:bg-white/10 transition-colors"
                              >
                                <MoreVertical size={16} />
                              </button>
                            )}
                          </div>

                          {crewMenuFor === player.uid && (
                            <>
                              {/* Closes the menu on an outside click, without
                                  intercepting clicks meant for anything else. */}
                              <div
                                className="fixed inset-0 z-30"
                                onClick={() => setCrewMenuFor(null)}
                              />
                              <div className="absolute right-2 top-12 z-40 w-44 py-1 rounded-xl glass-solid border border-white/10 shadow-2xl">
                                {isFriend ? (
                                  <p className="px-3 py-2 text-xs text-text-muted">Already friends</p>
                                ) : (
                                  <button
                                    onClick={() => addCrewFriend(player.uid)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold text-white hover:bg-white/10 transition-colors"
                                  >
                                    <UserPlus size={14} /> Add Friend
                                  </button>
                                )}
                                {isHost && (
                                  <>
                                    <div className="my-1 border-t border-white/10" />
                                    <button
                                      onClick={() => makeHost(player.uid, player.displayName)}
                                      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold text-white hover:bg-white/10 transition-colors"
                                    >
                                      <Crown size={14} className="text-yellow-400" /> Make Host
                                    </button>
                                    <button
                                      onClick={() => kickPlayer(player.uid, player.displayName)}
                                      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold text-error hover:bg-error/10 transition-colors"
                                    >
                                      <UserX size={14} /> Kick
                                    </button>
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </div>

              {lobby.status !== "playing" && me && (
                <button
                  onClick={toggleReady}
                  className={`mt-4 w-full py-3 rounded-xl font-bold text-sm transition-colors duration-300 border ${
                    me.isReady
                      ? "bg-success/20 text-success border-success/40 shadow-[0_0_18px_-4px_var(--color-success)]"
                      : "bg-error/20 text-error border-error/40 shadow-[0_0_18px_-4px_var(--color-error)]"
                  }`}
                >
                  {me.isReady ? "Ready ✓ — click to un-ready" : "Not ready — click when set"}
                </button>
              )}
            </div>
          ) : (
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
          )}
        </div>

        <div
          className={`flex-1 relative flex flex-col ${
            lobby.status === "playing" ? "p-0" : "p-6 lg:p-12 overflow-y-auto"
          }`}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />

          {lobby.status === "playing" && lobby.gameId ? (
            <div
              ref={gameShellRef}
              className={`${
                isPseudoFull ? "fixed inset-0 z-[100] bg-black" : "flex-1 relative"
              } w-full flex flex-col`}
            >
              <iframe
                id="game-iframe"
                ref={gameFrameRef}
                allowFullScreen
                src={gameUrl(lobby.gameId, {
                  room: roomId,
                  displayName: user?.displayName || "Player",
                  photoURL: user?.photoURL || "",
                  solo: lobby.soloMode ?? false,
                })}
                className="flex-1 w-full h-full border-none z-10"
                title={selectedGame?.name || "Game Window"}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              />
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
                        <Play size={20} className="fill-white" />
                        {isSolo ? "Play Solo" : "Start Game"}
                      </button>
                      <span className="text-xs text-text-muted max-w-[12rem] text-center">
                        {!everyoneReady
                          ? "Waiting for everyone to be ready"
                          : isSolo
                            ? "You'll control both characters"
                            : ""}
                      </span>
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

/** Drops the remembered room once we know it's unreachable. */
function ForgetLobbyOnMount() {
  useEffect(() => {
    forgetLobby();
  }, []);
  return null;
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
