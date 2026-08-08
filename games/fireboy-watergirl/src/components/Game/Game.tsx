import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  auth, db, rtdb, signInAnonymously, onAuthStateChanged, signInWithPopup, googleProvider,
  doc, setDoc, getDoc, onSnapshot, updateDoc, serverTimestamp,
  addDoc, collection, query, orderBy, limit,
  dbRef, dbSet, dbPush, dbOnValue, dbOnDisconnect, dbRemove
} from '../../firebase';
import { GameEngine } from '../../game/engine';
import { Level } from '../../types';
import { getLevels } from '../../game/levels';
import { RemoteSmoother, snapshotOf, worthSending, RemoteSnapshot } from '../../game/netSync';
import { toggleFullscreen, isTouchDevice } from '../../game/fullscreen';
import { MessageSquare, RefreshCw, Smartphone, Monitor, Gem, ArrowLeft, Settings, Users, Maximize2, Minimize2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import confetti from 'canvas-confetti';
import { playJumpSound, playCollectSound, playDeathSound, playWinSound } from '../../game/sounds';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

/**
 * How often our own state goes on the wire.
 *
 * 30/s over the DataChannel is comfortably more than the smoother needs to
 * reconstruct smooth motion, and it is free — the packets never touch a server.
 * The Firestore numbers are deliberately stingy: those writes are billed, and
 * with 2k players online a per-frame write would be the single largest line on
 * the bill. 10/s keeps the fallback playable; once WebRTC is up it drops to a
 * 1/s heartbeat so a peer that reconnects mid-level still finds a position.
 */
const DC_SYNC_INTERVAL_MS = 1000 / 30;
const FS_SYNC_ACTIVE_MS = 100;
const FS_SYNC_IDLE_MS = 1000;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export default function Game({
  customLevel,
  startLevelIndex = 0,
  onBack,
  onComplete,
  initialGameMode = 'single',
  initialRoomId,
  isHost = false,
  displayName,
  photoURL
}: {
  customLevel?: Level | null,
  startLevelIndex?: number,
  onBack?: () => void,
  onComplete?: (levelId: number) => void,
  initialGameMode?: 'single' | 'multi',
  initialRoomId?: string,
  isHost?: boolean,
  displayName?: string,
  photoURL?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  // A ref, not state: chaos mode nudges this every few frames and the old
  // useState triggered a full React re-render on every single animation frame.
  const screenShakeRef = useRef(0);
  const [levelIndex, setLevelIndex] = useState(startLevelIndex);
  const [userId, setUserId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState(initialRoomId || '');
  const [role, setRole] = useState<'fire' | 'water' | 'both' | null>(initialGameMode === 'single' ? 'both' : null);
  const [gameMode, setGameMode] = useState<'single' | 'multi' | null>(initialGameMode);
  const [gameStarted, setGameStarted] = useState(initialGameMode === 'single'); // Bilal Saeed 123: Corrected initialization
  const [lobbyData, setLobbyData] = useState<any>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [showChat, setShowChat] = useState(false);
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' | 'info' } | null>(null);
  // Touch controls used to render on any device merely in a landscape window,
  // which put two 80px thumb pads either side of every desktop game.
  const [isTouch] = useState(isTouchDevice);
  const [useTilt, setUseTilt] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /**
   * Largest 4:3 box that fits the available space, measured rather than left to
   * CSS. The old rules (`aspect-[4/3] max-h-[65vh]` in portrait, `h-full` in a
   * parent with no definite height in landscape) meant the level was a third of
   * a phone screen and a different size on every device.
   */
  const [stage, setStage] = useState({ w: CANVAS_WIDTH, h: CANVAS_HEIGHT });
  const [isGameOver, setIsGameOver] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettingsState] = useState({
    animations: true,
    particles: true,
    shadows: false,
    bloom: false,
  });
  const settingsRef = useRef(settings);
  const setSettings = (newSettings: typeof settings) => {
    setSettingsState(newSettings);
    settingsRef.current = newSettings;
  };
  const keys = useRef<Set<string>>(new Set());
  const engineRef = useRef<GameEngine | null>(null);
  const gameLoopRef = useRef<number | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const lastUpdateRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const rtcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const [rtcConnected, setRtcConnected] = useState(false);
  /** Holds the partner's authoritative state and eases the drawn player toward it. */
  const remoteRef = useRef(new RemoteSmoother());
  /** Last snapshot actually put on the wire, so identical frames aren't re-sent. */
  const lastSentRef = useRef<RemoteSnapshot | null>(null);
  const lastDcSendRef = useRef(0);

  const addParticles = useCallback((x: number, y: number, color: string, count: number = 10) => {
    if (!settingsRef.current.particles) return;
    const newParticles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      newParticles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 10,
        vy: (Math.random() - 0.5) * 10 - 2,
        life: 1,
        maxLife: Math.random() * 20 + 20,
        color,
        size: Math.random() * 4 + 2
      });
    }
    particlesRef.current.push(...newParticles);
  }, []);

  const levels = useMemo(() => getLevels(), []);

  // Tilt controls
  useEffect(() => {
    if (!useTilt) return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const gamma = e.gamma || 0; // -90 to 90
      if (gamma > 10) {
        keys.current.add(role === 'water' ? 'ArrowRight' : 'KeyD');
        keys.current.delete(role === 'water' ? 'ArrowLeft' : 'KeyA');
      } else if (gamma < -10) {
        keys.current.add(role === 'water' ? 'ArrowLeft' : 'KeyA');
        keys.current.delete(role === 'water' ? 'ArrowRight' : 'KeyD');
      } else {
        keys.current.delete(role === 'water' ? 'ArrowLeft' : 'KeyA');
        keys.current.delete(role === 'water' ? 'ArrowRight' : 'KeyD');
      }
    };

    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, [useTilt, role]);

  const [isAuthRestricted, setIsAuthRestricted] = useState(false);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const copyInviteLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    navigator.clipboard.writeText(url.toString());
    showToast('Invite link copied!', 'success');
  };

  const handleGameEvent = useCallback((event: string, data: any) => {
    if (event === 'jump') {
      playJumpSound();
      const p = data as any;
      if (p) {
        addParticles(p.x + p.width / 2, p.y + p.height, p.role === 'fire' ? '#ff4400' : '#00ccff', 15);
      }
    }
    if (event === 'collect') {
      playCollectSound();
      if (gameMode === 'multi' && roomId && userId) {
        const roomRef = doc(db, 'lobbies', roomId);
        updateDoc(roomRef, {
          [`collectedGems.${data.id || data}`]: true
        });
      }
      if (data.x !== undefined) {
        addParticles(data.x + data.width / 2, data.y + data.height / 2, data.color || '#fff', 30);
      }
    }
    if (event === 'death') {
      playDeathSound();
      const p = data as any;
      if (p) {
        addParticles(p.x + p.width / 2, p.y + p.height / 2, p.role === 'fire' ? '#ff4400' : '#00ccff', 50);
      }
    }
    if (event === 'win') playWinSound();
  }, [gameMode, roomId, userId, addParticles]);

  // Initialize engine
  useEffect(() => {
    const level = customLevel || levels[levelIndex];
    const newEngine = new GameEngine(level);
    newEngine.onEvent = handleGameEvent;
    engineRef.current = newEngine;
    setEngine(newEngine);
    // A new level means new start positions; a snapshot from the old one would
    // otherwise drag the partner across the map before the first packet lands.
    remoteRef.current.reset();
    lastSentRef.current = null;
  }, [levelIndex, customLevel, levels, handleGameEvent]);

  // Keep the play area at the biggest 4:3 that fits, on every device.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const scale = Math.min(width / CANVAS_WIDTH, height / CANVAS_HEIGHT);
      setStage({ w: Math.round(CANVAS_WIDTH * scale), h: Math.round(CANVAS_HEIGHT * scale) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    // ResizeObserver is delivered as part of the rendering steps, so a phone
    // that throttles a background tab can leave the box at a stale size when
    // the player comes back. The window events cost nothing and cover it.
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
    };
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Handle keys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => keys.current.add(e.code);
    const handleKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Firebase Auth and Room Setup
  useEffect(() => {
    if (gameMode !== 'multi') return;

    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
      if (user) {
        console.log("[Multiplayer] Authenticated as:", user.uid);
        setUserId(user.uid);
        joinRoom(user.uid);
      } else {
        console.log("[Multiplayer] Not authenticated. Attempting anonymous sign-in...");
        try {
          // If we have a roomId and we are in frame, try anonymous auth first
          await signInAnonymously(auth);
        } catch (error: any) {
          console.error("[Multiplayer] Auth error:", error);
          if (error.code === 'auth/admin-restricted-operation') {
            setIsAuthRestricted(true);
            console.log("[Multiplayer] Anonymous auth is disabled.");
            // If we are in the platform, we should have been authed already, 
            // but for the game's internal firebase, we'll show toast
            showToast("Please sign in to continue", "info");
          } else {
            showToast("Authentication failed", "error");
          }
        }
      }
    });

    const joinRoom = async (uid: string) => {
      const room = initialRoomId || '';
      if (room === '') {
        console.warn("[Multiplayer] No initialRoomId provided!");
        return;
      }
      setRoomId(room);

      // The platform owns the lobby document: it creates the room and seeds the
      // player list. The game only ever adds its own `role` field.
      //
      // This previously replaced `players.<uid>` wholesale with a game-shaped
      // record ({ id, ready, … }), wiping the platform's `uid` and `isReady`
      // fields and making players disappear from the lobby roster.
      const roomRef = doc(db, 'lobbies', room);
      const roomSnap = await getDoc(roomRef);

      if (!roomSnap.exists()) {
        showToast("Room not found", "error");
        return;
      }

      const data = roomSnap.data();
      if (!data.players?.[uid]) {
        showToast("You're not in this lobby", "error");
        return;
      }

      if (data.players[uid].role === undefined) {
        await updateDoc(roomRef, { [`players.${uid}.role`]: null }).catch(console.error);
      }
    };

    return () => unsubscribeAuth();
  }, [gameMode, initialRoomId, isHost, startLevelIndex]);

  // Firestore Listeners
  useEffect(() => {
    if (gameMode !== 'multi' || !roomId || !userId) return;

    console.log(`[Multiplayer] Setting up Firestore listeners for room [${roomId}]`);
    const roomRef = doc(db, 'lobbies', roomId);

    const unsubscribeRoom = onSnapshot(roomRef, (doc) => {
      if (doc.exists()) {
        const data = doc.data();
        console.log('[Multiplayer] Room update:', data);
        setLobbyData(data);

        const myPlayer = data.players[userId];
        if (myPlayer && myPlayer.role) {
          setRole(myPlayer.role);
        }

        // Sync level
        if (data.level !== undefined) {
          setLevelIndex(prev => {
            if (data.level !== prev) {
              console.log(`[Multiplayer] Level sync: ${prev} -> ${data.level}`);
              setIsGameOver(false);
              return data.level;
            }
            return prev;
          });
        }

        // The platform sets status='playing' to mount this iframe; that only
        // gets us to the role-select menu. The engine starts once the host
        // flips `matchStarted` and this player has picked a role.
        //
        // A separate field is used rather than mutating `status`, because the
        // platform unmounts the iframe whenever status !== 'playing' — writing
        // 'in_game' here used to tear the game down the moment it began.
        const actualRole = data.players?.[userId]?.role;
        if (data.matchStarted && actualRole !== null && actualRole !== undefined) {
          setGameStarted(true);
        } else {
          setGameStarted(false);
        }

        // Sync gems
        if (engineRef.current && data.collectedGems) {
          Object.keys(data.collectedGems).forEach(gemId => {
            const gem = engineRef.current?.level.entities.find(e => e.id === gemId);
            if (gem) gem.collected = true;
          });
        }

      }
    });

    // Chat is a subcollection shared with the platform lobby. It used to be an
    // arrayUnion field on this same document, which meant every message
    // rewrote and re-sent the entire room doc and would eventually exceed
    // Firestore's 1MB document limit, permanently breaking the room.
    const unsubscribeChat = onSnapshot(
      query(collection(db, 'lobbies', roomId, 'messages'), orderBy('createdAt', 'desc'), limit(50)),
      (snap) => {
        const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
        msgs.reverse();
        setChatMessages(msgs);
      },
      (err) => console.error('[Chat] listener failed', err)
    );

    return () => {
      unsubscribeRoom();
      unsubscribeChat();
    };
  }, [gameMode, roomId, userId, isHost]);

  // Separate effect for player updates to avoid re-subscribing to room doc
  const otherPlayerIds = lobbyData ? Object.keys(lobbyData.players).filter(id => id !== userId).join(',') : '';

  useEffect(() => {
    if (gameMode !== 'multi' || !roomId || !userId || !otherPlayerIds) return;

    const otherPlayers = otherPlayerIds.split(',');
    const unsubscribes: (() => void)[] = [];

    otherPlayers.forEach(pid => {
      const pRef = doc(db, 'lobbies', roomId, 'updates', pid);
      const unsub = onSnapshot(pRef, (snap) => {
        if (!snap.exists()) return;
        // Fallback path. The smoother orders snapshots by their own timestamp,
        // so a Firestore write that lands behind a fresher DataChannel packet
        // is simply ignored rather than yanking the player backwards.
        remoteRef.current.push(snap.data() as RemoteSnapshot);
      });
      unsubscribes.push(unsub);
    });

    return () => unsubscribes.forEach(u => u());
  }, [gameMode, roomId, userId, otherPlayerIds]);

  // WebRTC Setup for low-latency multiplayer
  const hasTwoPlayers = lobbyData ? Object.keys(lobbyData.players).length >= 2 : false;
  // This game is strictly 2-player, so the peer is simply the other occupant.
  const peerId = otherPlayerIds.split(',')[0] || '';

  useEffect(() => {
    if (gameMode !== 'multi' || !roomId || !userId || !hasTwoPlayers || !peerId) return;

    if (rtcRef.current) return;

    let unsubRoom: (() => void) | null = null;
    const addedCandidates = new Set<string>();

    const initWebRTC = async () => {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });
      rtcRef.current = pc;

      pc.oniceconnectionstatechange = () => {
        console.log('[WebRTC] ICE State:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setRtcConnected(true);
        } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          setRtcConnected(false);
        }
      };

      const setupDataChannel = (dc: RTCDataChannel) => {
        dc.onopen = () => console.log('[WebRTC] DataChannel open');
        dc.onclose = () => console.log('[WebRTC] DataChannel closed');
        dc.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.type !== 'sync') return;
            remoteRef.current.push({ ...data.state, lastUpdate: data.lastUpdate });
          } catch (err) {
            console.error('[WebRTC] Error parsing message', err);
          }
        };
      };

      // Signaling lives in Realtime Database, not on the lobby document.
      // ICE candidates were previously arrayUnion'd onto that shared doc: they
      // accumulated forever, were never cleaned up, and every candidate
      // re-broadcast the whole document to every listener — including the
      // platform's own lobby subscription.
      // One channel per (sender, recipient) pair rather than one per sender.
      // A two-player game never noticed the difference, but the shared rules
      // and the 8-player fish arena both need a mesh, and a single `desc` slot
      // per uid cannot carry more than one negotiation at a time.
      const myNodeRef = dbRef(rtdb, `signaling/${roomId}/${userId}`);
      const mineRef = dbRef(rtdb, `signaling/${roomId}/${userId}/${peerId}`);
      const theirsRef = dbRef(rtdb, `signaling/${roomId}/${peerId}/${userId}`);

      dbOnDisconnect(myNodeRef).remove().catch(() => {});
      dbRemove(mineRef).catch(() => {});

      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        dbPush(dbRef(rtdb, `signaling/${roomId}/${userId}/${peerId}/candidates`), JSON.stringify(e.candidate.toJSON()))
          .catch(console.error);
      };

      const dc = pc.createDataChannel('game-sync', { negotiated: true, id: 0 });
      dcRef.current = dc;
      setupDataChannel(dc);

      const applyRemoteCandidates = (candidates: Record<string, string> | null) => {
        if (!candidates) return;
        for (const cStr of Object.values(candidates)) {
          if (addedCandidates.has(cStr)) continue;
          addedCandidates.add(cStr);
          try {
            pc.addIceCandidate(new RTCIceCandidate(JSON.parse(cStr))).catch(console.error);
          } catch {
            /* malformed candidate — skip it */
          }
        }
      };

      if (isHost) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await dbSet(dbRef(rtdb, `signaling/${roomId}/${userId}/${peerId}/desc`), {
            type: offer.type,
            sdp: offer.sdp,
          });
        } catch (err) {
          console.error('[WebRTC] Error creating offer', err);
        }

        unsubRoom = dbOnValue(theirsRef, (snap) => {
          const data = snap.val();
          if (!data) return;
          if (data.desc && pc.signalingState === 'have-local-offer') {
            pc.setRemoteDescription(new RTCSessionDescription(data.desc)).catch(console.error);
          }
          applyRemoteCandidates(data.candidates);
        });
      } else {
        unsubRoom = dbOnValue(theirsRef, async (snap) => {
          const data = snap.val();
          if (!data) return;
          if (data.desc && pc.signalingState === 'stable' && !pc.currentRemoteDescription) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data.desc));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await dbSet(dbRef(rtdb, `signaling/${roomId}/${userId}/${peerId}/desc`), {
                type: answer.type,
                sdp: answer.sdp,
              });
            } catch (err) {
              console.error('[WebRTC] Error creating answer', err);
            }
          }
          applyRemoteCandidates(data.candidates);
        });
      }
    };

    initWebRTC();

    return () => {
      if (unsubRoom) unsubRoom();
      if (userId && roomId) dbRemove(dbRef(rtdb, `signaling/${roomId}/${userId}`)).catch(() => {});
      rtcRef.current?.close();
      rtcRef.current = null;
      dcRef.current = null;
      setRtcConnected(false);
    };
  }, [gameMode, roomId, userId, isHost, hasTwoPlayers, peerId]);

  // Game loop
  useEffect(() => {
    if (!gameStarted || !engine || isGameOver) return;

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const loop = (time: number) => {
      const currentEngine = engineRef.current;
      if (!currentEngine || isGameOver) return;

      // Delta time in 60fps-frame units, so physics runs at the same speed on
      // 60Hz, 120Hz and 144Hz displays. Capped so a backgrounded tab doesn't
      // resume with a single huge step that tunnels players through geometry.
      const now = performance.now();
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const dt = Math.min(3, (now - lastTimeRef.current) / (1000 / 60));
      lastTimeRef.current = now;

      // Chaos Mode logic
      if (currentEngine.level.worldSettings?.chaosMode) {
        if (Math.random() > 0.99) {
          // Random gravity shift
          currentEngine.gravity = (Math.random() * 0.4 + 0.1) * (currentEngine.level.worldSettings.gravityMultiplier || 1);
        }
        if (Math.random() > 0.98) {
          // Random screen shake
          screenShakeRef.current = Math.random() * 10;
        }
      }

      // Decay screen shake — per unit of time, not per frame, so a 144Hz
      // display doesn't shake for less than half as long as a 60Hz one.
      screenShakeRef.current =
        screenShakeRef.current > 0.1 ? screenShakeRef.current * Math.pow(0.9, dt) : 0;

      const currentCollisions = new Set<string>();


      // Update local player
      if (role === 'fire') {
        const fireBoyKeys = new Set(keys.current);
        if (keys.current.has('ArrowUp')) fireBoyKeys.add('KeyW');
        if (keys.current.has('ArrowLeft')) fireBoyKeys.add('KeyA');
        if (keys.current.has('ArrowRight')) fireBoyKeys.add('KeyD');
        currentEngine.updatePlayer(currentEngine.player1, fireBoyKeys, 'KeyW', 'KeyA', 'KeyD', currentCollisions, dt);
      } else if (role === 'water') {
        const waterGirlKeys = new Set(keys.current);
        if (keys.current.has('KeyW')) waterGirlKeys.add('ArrowUp');
        if (keys.current.has('KeyA')) waterGirlKeys.add('ArrowLeft');
        if (keys.current.has('KeyD')) waterGirlKeys.add('ArrowRight');
        currentEngine.updatePlayer(currentEngine.player2, waterGirlKeys, 'ArrowUp', 'ArrowLeft', 'ArrowRight', currentCollisions, dt);
      } else if (gameMode === 'single' || role === 'both') {
        // Local co-op mode
        currentEngine.update(keys.current, dt);
      }
      // Bilal Saeed 123: If role is null in multi, we don't process inputs!


      // Update engine's collision memory for levers
      if (role !== 'both') {
        // @ts-ignore - accessing private for sync
        currentEngine.collidingEntities = currentCollisions;

        // The partner is driven entirely by what they tell us, eased toward
        // their extrapolated position. Simulating them locally — which is what
        // this used to do — guarantees drift, because we have their velocity
        // but not their input or their collisions.
        const remotePlayer = role === 'fire' ? currentEngine.player2 : currentEngine.player1;
        remoteRef.current.apply(remotePlayer, dt, now);
      }


      // Sync player state
      if (gameMode === 'multi' && roomId && userId && role && role !== 'both') {
        const p = role === 'fire' ? currentEngine.player1 : currentEngine.player2;
        const wallClock = Date.now();
        const state = snapshotOf(p, wallClock);

        // Rate-limited rather than per-frame. At 144Hz the old code pushed 144
        // JSON.stringify calls a second down the channel to describe a
        // character that moves at 60 steps a second.
        if (dcRef.current?.readyState === 'open' && now - lastDcSendRef.current > DC_SYNC_INTERVAL_MS) {
          if (worthSending(lastSentRef.current, state)) {
            dcRef.current.send(JSON.stringify({ type: 'sync', role, state, lastUpdate: wallClock }));
            lastSentRef.current = state;
          }
          lastDcSendRef.current = now;
        }

        // Firestore is the fallback for when the peer connection never forms
        // (symmetric NAT, corporate proxy). Every write here is billed, so it
        // idles right down once the DataChannel is carrying the traffic.
        const fsInterval = rtcConnected ? FS_SYNC_IDLE_MS : FS_SYNC_ACTIVE_MS;
        if (wallClock - lastUpdateRef.current > fsInterval) {
          const pRef = doc(db, 'lobbies', roomId, 'updates', userId);
          setDoc(pRef, { ...state, role }, { merge: true }).catch(console.error);
          lastUpdateRef.current = wallClock;
        }
      }

      currentEngine.updateEntities(dt);

      draw(ctx, currentEngine, time, dt);

      if (currentEngine.player1.atDoor && currentEngine.player2.atDoor) {
        // Force one last sync before stopping game loop
        if (gameMode === 'multi' && roomId && userId && role && role !== 'both') {
          const p = role === 'fire' ? currentEngine.player1 : currentEngine.player2;
          const state = snapshotOf(p, Date.now());
          if (dcRef.current?.readyState === 'open') {
            dcRef.current.send(JSON.stringify({ type: 'sync', role, state, lastUpdate: state.lastUpdate }));
          }
          const pRef = doc(db, 'lobbies', roomId, 'updates', userId);
          setDoc(pRef, { ...state, role }, { merge: true }).catch(console.error);
        }
        handleWin();
        return;
      }

      if (currentEngine.player1.isDead || currentEngine.player2.isDead) {
        handleDeath();
        return;
      }

      gameLoopRef.current = requestAnimationFrame(loop);
    };

    lastTimeRef.current = 0; // restart the clock so a resumed loop starts at dt=1
    gameLoopRef.current = requestAnimationFrame(loop);
    return () => {
      if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    };
  }, [gameStarted, engine, role, roomId, userId, isGameOver, gameMode, rtcConnected]);

  const handleWin = () => {
    if (isGameOver) return;
    setIsGameOver(true);
    const winLevelIndex = levelIndex;

    playWinSound();
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 }
    });

    // Notify parent of completion
    if (!customLevel) {
      onComplete?.(levels[levelIndex].id);
    }

    setTimeout(() => {
      if (customLevel) {
        onBack?.();
        return;
      }

      if (levelIndex < levels.length - 1) {
        if (gameMode === 'multi' && roomId) {
          if (isHost) {
            const roomRef = doc(db, 'lobbies', roomId);
            updateDoc(roomRef, {
              level: winLevelIndex + 1,
              collectedGems: {} // Reset gems for next level
            });
          }
          // In multiplayer, clients wait for the host's Firestore update to change the level
        } else {
          setLevelIndex(prev => prev + 1);
          setIsGameOver(false);
        }
      } else {
        showToast("All levels complete!", "success");
        setTimeout(onBack || (() => { }), 2000);
      }
    }, 2000);
  };

  const handleDeath = () => {
    if (isGameOver) return;
    setIsGameOver(true);

    playDeathSound();

    // Immediately sync death if in multiplayer
    if (gameMode === 'multi' && roomId && userId && role && role !== 'both') {
      const p = role === 'fire' ? engineRef.current?.player1 : engineRef.current?.player2;
      if (p) {
        const state = snapshotOf({ ...p, isDead: true }, Date.now());
        const pRef = doc(db, 'lobbies', roomId, 'updates', userId);
        setDoc(pRef, { ...state, role }, { merge: true }).catch(console.error);
        if (dcRef.current?.readyState === 'open') {
          dcRef.current.send(JSON.stringify({ type: 'sync', role, state, lastUpdate: state.lastUpdate }));
        }
        lastSentRef.current = state;
      }
    }

    setTimeout(() => {
      const level = customLevel || levels[levelIndex];
      const newEngine = new GameEngine(level);
      newEngine.onEvent = handleGameEvent;
      engineRef.current = newEngine;
      setEngine(newEngine);
      // Both players restart at the level's spawn points, so anything buffered
      // about where the partner *was* is now wrong.
      remoteRef.current.reset();
      lastSentRef.current = null;

      // Republish our own reset position, or the partner's client keeps easing
      // toward the spot we died in.
      if (gameMode === 'multi' && roomId && userId && role && role !== 'both') {
        const pRef = doc(db, 'lobbies', roomId, 'updates', userId);
        const p = role === 'fire' ? newEngine.player1 : newEngine.player2;
        const state = snapshotOf(p, Date.now());
        setDoc(pRef, { ...state, role }, { merge: true }).catch(console.error);
        if (dcRef.current?.readyState === 'open') {
          dcRef.current.send(JSON.stringify({ type: 'sync', role, state, lastUpdate: state.lastUpdate }));
        }
      }

      setIsGameOver(false);
    }, 1500);
  };

  const drawParticles = (ctx: CanvasRenderingContext2D, dt: number) => {
    if (!settingsRef.current.particles) return;

    // Disable shadow blur for particles to drastically improve performance
    ctx.shadowBlur = 0;

    for (let i = particlesRef.current.length - 1; i >= 0; i--) {
      const p = particlesRef.current[i];
      // Stepped by dt like everything else, so sparks don't fly twice as far
      // and vanish twice as fast on a 120Hz phone.
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life += dt;

      if (p.life >= p.maxLife) {
        particlesRef.current.splice(i, 1);
        continue;
      }

      const alpha = 1 - (p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const drawBackground = (ctx: CanvasRenderingContext2D, time: number) => {
    const theme = engine?.level.worldSettings?.backgroundTheme || 'default';

    if (theme === 'void') {
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Draw some floating particles
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      for (let i = 0; i < 50; i++) {
        const x = (Math.sin(i * 123.45 + time * 0.001) * 10000) % CANVAS_WIDTH;
        const y = (Math.cos(i * 678.9 + time * 0.0005) * 10000) % CANVAS_HEIGHT;
        const size = Math.abs(Math.sin(i)) * 2 + 1;
        ctx.beginPath();
        ctx.arc(x < 0 ? x + CANVAS_WIDTH : x, y < 0 ? y + CANVAS_HEIGHT : y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    if (theme === 'matrix') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      ctx.fillStyle = '#0f0';
      ctx.font = '10px monospace';
      for (let i = 0; i < 40; i++) {
        const x = i * 20;
        const y = (time * 0.1 + i * 100) % CANVAS_HEIGHT;
        ctx.fillText(Math.random() > 0.5 ? '1' : '0', x, y);
      }
      return;
    }

    if (theme === 'neon') {
      const bgGradient = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      bgGradient.addColorStop(0, '#1a0033');
      bgGradient.addColorStop(1, '#000000');
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Neon grid
      ctx.strokeStyle = 'rgba(255, 0, 255, 0.1)';
      ctx.lineWidth = 1;
      for (let i = 0; i < CANVAS_WIDTH; i += 40) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_HEIGHT); ctx.stroke();
      }
      for (let i = 0; i < CANVAS_HEIGHT; i += 40) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_WIDTH, i); ctx.stroke();
      }
      return;
    }

    if (theme === 'cyberpunk') {
      ctx.fillStyle = '#0a0a12';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Perspective grid
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      const horizon = CANVAS_HEIGHT * 0.4;
      for (let i = -CANVAS_WIDTH; i < CANVAS_WIDTH * 2; i += 40) {
        ctx.beginPath();
        ctx.moveTo(CANVAS_WIDTH / 2, horizon);
        ctx.lineTo(i, CANVAS_HEIGHT);
        ctx.stroke();
      }
      for (let i = 0; i < 10; i++) {
        const y = horizon + Math.pow(i / 10, 2) * (CANVAS_HEIGHT - horizon);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(CANVAS_WIDTH, y);
        ctx.stroke();
      }

      // Distant buildings
      ctx.fillStyle = 'rgba(255, 0, 255, 0.05)';
      for (let i = 0; i < 10; i++) {
        const w = 40 + Math.random() * 60;
        const h = 100 + Math.random() * 200;
        ctx.fillRect(i * 80, horizon - h, w, h);
      }
      return;
    }

    if (theme === 'sunset') {
      const sunsetGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
      sunsetGrad.addColorStop(0, '#240b36');
      sunsetGrad.addColorStop(0.5, '#c31432');
      sunsetGrad.addColorStop(1, '#ed8f03');
      ctx.fillStyle = sunsetGrad;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Sun
      const sunY = CANVAS_HEIGHT * 0.6 + Math.sin(time * 0.0001) * 20;
      const sunGrad = ctx.createRadialGradient(CANVAS_WIDTH / 2, sunY, 0, CANVAS_WIDTH / 2, sunY, 150);
      sunGrad.addColorStop(0, '#fff700');
      sunGrad.addColorStop(0.2, '#ff8c00');
      sunGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = sunGrad;
      ctx.beginPath();
      ctx.arc(CANVAS_WIDTH / 2, sunY, 150, 0, Math.PI * 2);
      ctx.fill();

      // Scanlines
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      for (let i = 0; i < CANVAS_HEIGHT; i += 4) {
        ctx.fillRect(0, i, CANVAS_WIDTH, 1);
      }
      return;
    }

    if (theme === 'nebula') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      for (let i = 0; i < 3; i++) {
        const x = (Math.sin(time * 0.0002 + i) * 0.5 + 0.5) * CANVAS_WIDTH;
        const y = (Math.cos(time * 0.0003 + i) * 0.5 + 0.5) * CANVAS_HEIGHT;
        const rad = 300 + Math.sin(time * 0.0005 + i) * 100;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
        const color = i === 0 ? 'rgba(255, 0, 150, 0.15)' : i === 1 ? 'rgba(0, 100, 255, 0.15)' : 'rgba(100, 0, 255, 0.15)';
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }

      // Twinkling stars
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 100; i++) {
        const x = (Math.sin(i * 456.7) * 10000) % CANVAS_WIDTH;
        const y = (Math.cos(i * 123.4) * 10000) % CANVAS_HEIGHT;
        const opacity = (Math.sin(time * 0.002 + i) * 0.5 + 0.5) * 0.8;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.arc(Math.abs(x), Math.abs(y), Math.random() * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (theme === 'glitch') {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      if (Math.random() > 0.9) {
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255, 0, 0, 0.2)' : 'rgba(0, 255, 255, 0.2)';
        ctx.fillRect(Math.random() * CANVAS_WIDTH, 0, Math.random() * 100, CANVAS_HEIGHT);
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      for (let i = 0; i < 20; i++) {
        const y = (time * 0.5 + i * 50) % CANVAS_HEIGHT;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_WIDTH, y); ctx.stroke();
      }

      // Static
      for (let i = 0; i < 1000; i++) {
        const x = Math.random() * CANVAS_WIDTH;
        const y = Math.random() * CANVAS_HEIGHT;
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.1})`;
        ctx.fillRect(x, y, 1, 1);
      }
      return;
    }

    if (theme === 'underwater') {
      const waterGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
      waterGrad.addColorStop(0, '#005c97');
      waterGrad.addColorStop(1, '#363795');
      ctx.fillStyle = waterGrad;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Light rays
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      for (let i = 0; i < 5; i++) {
        const angle = Math.sin(time * 0.0005 + i) * 0.2;
        ctx.save();
        ctx.translate(CANVAS_WIDTH / 2 + (i - 2) * 100, 0);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(-50, 0);
        ctx.lineTo(50, 0);
        ctx.lineTo(200, CANVAS_HEIGHT * 1.5);
        ctx.lineTo(-200, CANVAS_HEIGHT * 1.5);
        ctx.fill();
        ctx.restore();
      }

      // Bubbles
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      for (let i = 0; i < 20; i++) {
        const x = (i * 137.5) % CANVAS_WIDTH;
        const y = (CANVAS_HEIGHT - (time * 0.05 + i * 100) % CANVAS_HEIGHT);
        const size = Math.sin(i) * 3 + 4;
        ctx.beginPath();
        ctx.arc(x + Math.sin(time * 0.002 + i) * 10, y, size, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }

    // Default theme
    const bgGradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
    bgGradient.addColorStop(0, '#2b0b3f'); // Purple
    bgGradient.addColorStop(1, '#0b1a3f'); // Blue
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Static stars
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    for (let i = 0; i < 100; i++) {
      const x = (Math.sin(i * 123.45) * 10000) % CANVAS_WIDTH;
      const y = (Math.cos(i * 678.9) * 10000) % CANVAS_HEIGHT;
      const size = Math.abs(Math.sin(i)) * 1.5 + 0.5;

      const px = x < 0 ? x + CANVAS_WIDTH : x;
      const py = y < 0 ? y + CANVAS_HEIGHT : y;

      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const draw = (ctx: CanvasRenderingContext2D, engine: GameEngine, time: number, dt: number) => {
    const world = engine.level.worldSettings;

    ctx.save();

    // Screen Shake
    const shake = (world?.screenShake || 0) + screenShakeRef.current;
    if (shake > 0) {
      ctx.translate(Math.random() * shake - shake / 2, Math.random() * shake - shake / 2);
    }

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Mirror World
    if (world?.mirrorWorld) {
      ctx.translate(CANVAS_WIDTH, 0);
      ctx.scale(-1, 1);
    }

    drawBackground(ctx, time);

    // Draw Entities
    engine.level.entities.forEach(entity => {
      if (entity.hidden) return;

      ctx.save();
      ctx.translate(entity.x + entity.width / 2, entity.y + entity.height / 2);
      if (entity.rotation) {
        ctx.rotate((entity.rotation * Math.PI) / 180);
      }
      ctx.translate(-(entity.x + entity.width / 2), -(entity.y + entity.height / 2));

      ctx.shadowBlur = 15;

      const drawShape = () => {
        if (entity.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(entity.x + entity.width / 2, entity.y + entity.height / 2, Math.min(entity.width, entity.height) / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (entity.shape === 'triangle') {
          ctx.beginPath();
          ctx.moveTo(entity.x, entity.y + entity.height);
          ctx.lineTo(entity.x + entity.width / 2, entity.y);
          ctx.lineTo(entity.x + entity.width, entity.y + entity.height);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(entity.x, entity.y, entity.width, entity.height);
        }
      };

      if (entity.type === 'platform') {
        ctx.fillStyle = '#222';
        if (settingsRef.current.bloom) {
          ctx.shadowColor = '#000';
          ctx.shadowBlur = 5;
        }
        drawShape();
        // Add a subtle top border for platforms (only for rectangles)
        if (!entity.shape || entity.shape === 'rect') {
          ctx.fillStyle = '#444';
          ctx.fillRect(entity.x, entity.y, entity.width, 4);
        }
      } else if (entity.type === 'box') {
        ctx.fillStyle = '#8B4513';
        if (settingsRef.current.bloom) {
          ctx.shadowColor = '#000';
          ctx.shadowBlur = 10;
        }
        drawShape();

        // Draw crate details
        ctx.strokeStyle = '#5C2E0B';
        ctx.lineWidth = 2;
        ctx.strokeRect(entity.x + 2, entity.y + 2, entity.width - 4, entity.height - 4);
        ctx.beginPath();
        ctx.moveTo(entity.x + 2, entity.y + 2);
        ctx.lineTo(entity.x + entity.width - 2, entity.y + entity.height - 2);
        ctx.moveTo(entity.x + entity.width - 2, entity.y + 2);
        ctx.lineTo(entity.x + 2, entity.y + entity.height - 2);
        ctx.stroke();
      } else if (entity.type === 'hazard') {
        if (entity.hazardType === 'fire') {
          ctx.fillStyle = '#ff4400';
          if (settingsRef.current.bloom) {
            ctx.shadowColor = '#ff4400';
            ctx.shadowBlur = 10;
          }
          drawShape();

          // Flames
          ctx.fillStyle = '#ffcc00';
          for (let i = 0; i < entity.width; i += 10) {
            ctx.beginPath();
            ctx.moveTo(entity.x + i, entity.y + entity.height);
            const flameHeight = settingsRef.current.animations
              ? 15 + Math.sin(time * 0.01 + i) * 5
              : 15;
            ctx.lineTo(entity.x + i + 5, entity.y + entity.height - flameHeight);
            ctx.lineTo(entity.x + i + 10, entity.y + entity.height);
            ctx.fill();
          }
        } else if (entity.hazardType === 'water') {
          ctx.fillStyle = 'rgba(0, 150, 255, 0.7)';
          if (settingsRef.current.bloom) {
            ctx.shadowColor = '#00ccff';
            ctx.shadowBlur = 10;
          }
          drawShape();

          // Surface
          ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
          if (settingsRef.current.animations) {
            ctx.beginPath();
            for (let i = 0; i <= entity.width; i += 10) {
              const waveY = Math.sin(time * 0.005 + i * 0.1) * 3;
              if (i === 0) ctx.moveTo(entity.x + i, entity.y + waveY);
              else ctx.lineTo(entity.x + i, entity.y + waveY);
            }
            ctx.lineTo(entity.x + entity.width, entity.y + 5);
            ctx.lineTo(entity.x, entity.y + 5);
            ctx.fill();
          } else {
            ctx.fillRect(entity.x, entity.y, entity.width, 5);
          }
        } else if (entity.hazardType === 'acid') {
          ctx.fillStyle = 'rgba(0, 255, 50, 0.7)';
          if (settingsRef.current.bloom) {
            ctx.shadowColor = '#00ff00';
            ctx.shadowBlur = 10;
          }
          drawShape();

          // Surface
          ctx.fillStyle = 'rgba(200, 255, 200, 0.4)';
          if (settingsRef.current.animations) {
            ctx.beginPath();
            for (let i = 0; i <= entity.width; i += 10) {
              const waveY = Math.sin(time * 0.003 + i * 0.15) * 2;
              if (i === 0) ctx.moveTo(entity.x + i, entity.y + waveY);
              else ctx.lineTo(entity.x + i, entity.y + waveY);
            }
            ctx.lineTo(entity.x + entity.width, entity.y + 3);
            ctx.lineTo(entity.x, entity.y + 3);
            ctx.fill();
          } else {
            ctx.fillRect(entity.x, entity.y, entity.width, 3);
          }
        }
      } else if (entity.type === 'door') {
        const doorColor = entity.color || '#fff';
        ctx.strokeStyle = doorColor;
        if (settingsRef.current.bloom) {
          ctx.shadowColor = doorColor;
          ctx.shadowBlur = 15;
        }
        ctx.lineWidth = 3;
        ctx.strokeRect(entity.x, entity.y, entity.width, entity.height);

        // Inner glowing grid for doors
        ctx.fillStyle = doorColor;
        ctx.globalAlpha = 0.2;
        ctx.fillRect(entity.x, entity.y, entity.width, entity.height);
        ctx.globalAlpha = 1;

        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 10; i < entity.width; i += 10) {
          ctx.moveTo(entity.x + i, entity.y);
          ctx.lineTo(entity.x + i, entity.y + entity.height);
        }
        for (let i = 10; i < entity.height; i += 10) {
          ctx.moveTo(entity.x, entity.y + i);
          ctx.lineTo(entity.x + entity.width, entity.y + i);
        }
        ctx.stroke();
      } else if (entity.type === 'lever') {
        // Draw base
        ctx.fillStyle = '#222';
        ctx.fillRect(entity.x, entity.y + entity.height - 10, entity.width, 10);
        ctx.fillStyle = '#444';
        ctx.fillRect(entity.x + 2, entity.y + entity.height - 10, entity.width - 4, 2);

        // Draw handle
        const glowColor = entity.active ? '#00ff00' : '#ff0000';
        ctx.strokeStyle = glowColor;
        if (settingsRef.current.bloom) {
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = 10;
        }
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(entity.x + entity.width / 2, entity.y + entity.height - 10);
        if (entity.active) {
          ctx.lineTo(entity.x + entity.width - 8, entity.y + 5);
        } else {
          ctx.lineTo(entity.x + 8, entity.y + 5);
        }
        ctx.stroke();

        // Handle knob
        ctx.fillStyle = glowColor;
        ctx.beginPath();
        if (entity.active) {
          ctx.arc(entity.x + entity.width - 8, entity.y + 5, 4, 0, Math.PI * 2);
        } else {
          ctx.arc(entity.x + 8, entity.y + 5, 4, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      } else if (entity.type === 'pressure-plate') {
        const glowColor = entity.active ? '#00ff00' : '#ff0000';

        // Draw base
        ctx.fillStyle = '#222';
        ctx.fillRect(entity.x, entity.y + entity.height - 5, entity.width, 5);

        // Draw button
        ctx.fillStyle = glowColor;
        if (settingsRef.current.bloom) {
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = 10;
        }
        const height = entity.active ? 2 : 6;
        ctx.fillRect(entity.x + 4, entity.y + entity.height - 5 - height, entity.width - 8, height);

        // Inner bright core
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.5;
        ctx.fillRect(entity.x + 6, entity.y + entity.height - 5 - height, entity.width - 12, 2);
        ctx.globalAlpha = 1;

        // Glow effect
        if (entity.active) {
          ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
          ctx.beginPath();
          ctx.arc(entity.x + entity.width / 2, entity.y + entity.height, entity.width, 0, Math.PI, true);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      } else if (entity.type === 'moving-platform') {
        ctx.fillStyle = '#2a2a35';
        if (settingsRef.current.bloom) {
          ctx.shadowColor = '#00ccff';
          ctx.shadowBlur = 10;
        }
        drawShape();

        // Add some technical detail to moving platforms
        ctx.strokeStyle = 'rgba(0, 204, 255, 0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(entity.x + 4, entity.y + 4, entity.width - 8, entity.height - 8);
      } else if (entity.type === 'cannon') {
        ctx.fillStyle = '#333';
        if (settingsRef.current.bloom) {
          ctx.shadowBlur = 10;
          ctx.shadowColor = '#000';
        }

        // Draw base
        ctx.beginPath();
        ctx.arc(entity.x + entity.width / 2, entity.y + entity.height / 2, entity.width / 2, 0, Math.PI * 2);
        ctx.fill();

        // Draw barrel
        ctx.save();
        ctx.translate(entity.x + entity.width / 2, entity.y + entity.height / 2);
        // No second rotation here, it's already rotated at the entity level
        ctx.fillStyle = entity.cannonType === 'laser' ? '#ff0044' : '#ff8800';
        ctx.fillRect(0, -6, entity.width / 2 + 10, 12);
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, -6, entity.width / 2 + 10, 12);
        ctx.restore();
      } else if (entity.type === 'gem' && !entity.collected) {
        const gemY = entity.y;

        ctx.fillStyle = entity.color || '#fff';
        if (settingsRef.current.bloom) {
          ctx.shadowColor = entity.color || '#fff';
          ctx.shadowBlur = 10;
        }

        // Draw diamond shape
        ctx.beginPath();
        ctx.moveTo(entity.x + entity.width / 2, gemY);
        ctx.lineTo(entity.x + entity.width, gemY + entity.height / 2);
        ctx.lineTo(entity.x + entity.width / 2, gemY + entity.height);
        ctx.lineTo(entity.x, gemY + entity.height / 2);
        ctx.closePath();
        ctx.fill();

        // Inner bright core
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(entity.x + entity.width / 2, gemY + 4);
        ctx.lineTo(entity.x + entity.width - 4, gemY + entity.height / 2);
        ctx.lineTo(entity.x + entity.width / 2, gemY + entity.height - 4);
        ctx.lineTo(entity.x + 4, gemY + entity.height / 2);
        ctx.closePath();
        ctx.fill();

        // Shine
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fillRect(entity.x + entity.width / 2 - 2, gemY + entity.height / 2 - 2, 4, 4);
      }
      ctx.shadowBlur = 0;
      ctx.restore();

      // Draw laser beam (outside of entity rotation context because laserEnd is absolute)
      if (entity.type === 'cannon' && entity.cannonType === 'laser' && entity.laserEnd) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(entity.x + entity.width / 2, entity.y + entity.height / 2);
        ctx.lineTo(entity.laserEnd.x, entity.laserEnd.y);

        // Core
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Glow
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 6;
        ctx.globalAlpha = 0.5;
        if (settingsRef.current.bloom) {
          ctx.shadowColor = '#ff0000';
          ctx.shadowBlur = 15;
        }
        ctx.stroke();

        ctx.restore();
      }
    });

    // Draw Players
    const drawPlayer = (p: typeof engine.player1, color: string) => {
      const isRight = p.facing === 'right';
      const isFire = p.role === 'fire';
      const isMoving = Math.abs(p.vx) > 0.5;

      if (settingsRef.current.particles && Math.abs(p.vx) > 1 && Math.random() > 0.5) {
        addParticles(p.x + 15, p.y + 30, color, 1);
      }

      ctx.save();
      ctx.translate(p.x + 15, p.y + 20); // Center of player
      if (!isRight) ctx.scale(-1, 1);

      if (settingsRef.current.bloom) {
        ctx.shadowBlur = 10;
        ctx.shadowColor = color;
      }

      // Animation variables
      let bodyScaleY = 1;
      let bodyScaleX = 1;
      let bodyOffsetY = 0;

      if (settingsRef.current.animations) {
        if (p.animState === 'jump') {
          bodyScaleY = 1.2;
          bodyScaleX = 0.8;
          bodyOffsetY = -4;
        } else if (p.animState === 'run') {
          bodyScaleY = 0.9 + Math.sin(p.animFrame * Math.PI) * 0.1;
          bodyScaleX = 1.1 - Math.sin(p.animFrame * Math.PI) * 0.05;
          bodyOffsetY = Math.abs(Math.sin(p.animFrame * Math.PI)) * 2;
        } else {
          bodyScaleY = 1 + Math.sin(time * 0.005) * 0.05;
          bodyScaleX = 1 - Math.sin(time * 0.005) * 0.02;
        }
      } else {
        if (p.animState === 'jump') {
          bodyScaleY = 1.2;
          bodyScaleX = 0.8;
          bodyOffsetY = -4;
        } else if (p.animState === 'run') {
          bodyScaleY = 0.9;
          bodyScaleX = 1.1;
          bodyOffsetY = 2;
        } else {
          bodyScaleY = 1;
          bodyScaleX = 1;
        }
      }

      ctx.scale(bodyScaleX, bodyScaleY);

      // Face offset for side profile
      const faceOffsetX = isMoving ? 6 : 0;

      // 1. Draw Head Shape
      ctx.fillStyle = color;
      if (isFire) {
        // Flame head shape (pointed top)
        ctx.beginPath();
        ctx.moveTo(-15, 0 + bodyOffsetY);
        const pointyTop = settingsRef.current.animations ? -35 + bodyOffsetY - Math.sin(time * 0.01) * 5 : -35 + bodyOffsetY;
        ctx.quadraticCurveTo(-15, -25 + bodyOffsetY, 0, pointyTop); // Pointy top
        ctx.quadraticCurveTo(15, -25 + bodyOffsetY, 15, 0 + bodyOffsetY);
        ctx.lineTo(-15, 0 + bodyOffsetY);
        ctx.fill();

        // Inner flame flicker
        ctx.fillStyle = '#ffcc00';
        ctx.beginPath();
        ctx.moveTo(-8, -5 + bodyOffsetY);
        const flicker = settingsRef.current.animations ? Math.sin(time * 0.02) * 6 : 0;
        ctx.quadraticCurveTo(-8, -20 + bodyOffsetY, 0, -28 + bodyOffsetY - flicker);
        ctx.quadraticCurveTo(8, -20 + bodyOffsetY, 8, -5 + bodyOffsetY);
        ctx.fill();
      } else {
        // Rounded water head
        ctx.beginPath();
        ctx.arc(0, -10 + bodyOffsetY, 18, 0, Math.PI * 2);
        ctx.fill();

        // Hair Bun / Ponytail
        ctx.beginPath();
        const bunBob = settingsRef.current.animations ? Math.sin(time * 0.01) * 2 : 0;
        if (isMoving) {
          // Flowing back ponytail
          ctx.moveTo(-10, -15 + bodyOffsetY);
          ctx.quadraticCurveTo(-25, -10 + bodyOffsetY + bunBob, -20, 5 + bodyOffsetY + bunBob);
          ctx.quadraticCurveTo(-15, 0 + bodyOffsetY, -5, -5 + bodyOffsetY);
          ctx.fill();
        } else {
          ctx.arc(0, -28 + bodyOffsetY + bunBob, 8, 0, Math.PI * 2);
          ctx.fill();
        }

        // Side-swept hair/bangs
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.beginPath();
        ctx.moveTo(-15 + faceOffsetX / 2, -15 + bodyOffsetY);
        ctx.quadraticCurveTo(0 + faceOffsetX / 2, -25 + bodyOffsetY, 15 + faceOffsetX / 2, -10 + bodyOffsetY);
        ctx.lineTo(15 + faceOffsetX / 2, -5 + bodyOffsetY);
        ctx.quadraticCurveTo(0 + faceOffsetX / 2, -15 + bodyOffsetY, -15 + faceOffsetX / 2, -5 + bodyOffsetY);
        ctx.fill();
      }

      // 2. Draw Body
      ctx.fillStyle = color;
      if (isFire) {
        // Boy body - rectangular
        ctx.beginPath();
        ctx.roundRect(-10, 0 + bodyOffsetY, 20, 20, 5);
        ctx.fill();
      } else {
        // Girl body - dress shape
        ctx.beginPath();
        ctx.moveTo(-8, 0 + bodyOffsetY);
        ctx.lineTo(8, 0 + bodyOffsetY);
        ctx.lineTo(12, 20 + bodyOffsetY);
        ctx.lineTo(-12, 20 + bodyOffsetY);
        ctx.fill();
      }

      // 3. Eyes (Large circular eyes with pupils)
      ctx.fillStyle = '#fff';
      if (isMoving) {
        // Side profile - only one eye visible
        ctx.beginPath();
        ctx.arc(faceOffsetX + 2, -12 + bodyOffsetY, 5, 0, Math.PI * 2); // Front eye
        ctx.fill();

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(faceOffsetX + 4, -12 + bodyOffsetY, 2, 0, Math.PI * 2); // Pupil looking forward
        ctx.fill();

        if (!isFire) {
          // Eyelashes for girl
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(faceOffsetX + 5, -16 + bodyOffsetY);
          ctx.lineTo(faceOffsetX + 8, -18 + bodyOffsetY);
          ctx.stroke();
        }
      } else {
        // Front profile
        ctx.beginPath();
        ctx.arc(5, -12 + bodyOffsetY, 5, 0, Math.PI * 2); // Right eye
        ctx.arc(-5, -12 + bodyOffsetY, 5, 0, Math.PI * 2); // Left eye
        ctx.fill();

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(6, -12 + bodyOffsetY, 2, 0, Math.PI * 2); // Right pupil
        ctx.arc(-4, -12 + bodyOffsetY, 2, 0, Math.PI * 2); // Left pupil
        ctx.fill();

        if (!isFire) {
          // Eyelashes for girl
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(8, -16 + bodyOffsetY);
          ctx.lineTo(11, -18 + bodyOffsetY);
          ctx.moveTo(-8, -16 + bodyOffsetY);
          ctx.lineTo(-11, -18 + bodyOffsetY);
          ctx.stroke();
        }
      }

      // 4. Smile
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (isMoving) {
        ctx.arc(faceOffsetX + 2, -5 + bodyOffsetY, 3, 0.1 * Math.PI, 0.7 * Math.PI);
      } else {
        ctx.arc(0, -5 + bodyOffsetY, 4, 0.2 * Math.PI, 0.8 * Math.PI);
      }
      ctx.stroke();

      // 5. Limbs
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';

      if (settingsRef.current.animations) {
        if (p.animState === 'run') {
          const legAngle = Math.sin(p.animFrame * Math.PI) * 0.6;
          ctx.beginPath(); ctx.moveTo(-3, 15); ctx.lineTo(Math.sin(legAngle) * 14 - 3, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(3, 15); ctx.lineTo(Math.sin(legAngle + Math.PI) * 14 + 3, 26); ctx.stroke();

          const armAngle = Math.cos(p.animFrame * Math.PI) * 0.5;
          ctx.beginPath(); ctx.moveTo(8, 5); ctx.lineTo(Math.sin(armAngle) * 12 + 8, 16); ctx.stroke();
        } else if (p.animState === 'jump') {
          ctx.beginPath(); ctx.moveTo(-5, 15); ctx.lineTo(-12, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(5, 15); ctx.lineTo(12, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(8, 5); ctx.lineTo(16, -8); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(-4, 18); ctx.lineTo(-4, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(4, 18); ctx.lineTo(4, 26); ctx.stroke();
        }
      } else {
        if (p.animState === 'run') {
          ctx.beginPath(); ctx.moveTo(-3, 15); ctx.lineTo(-8, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(3, 15); ctx.lineTo(8, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(8, 5); ctx.lineTo(14, 16); ctx.stroke();
        } else if (p.animState === 'jump') {
          ctx.beginPath(); ctx.moveTo(-5, 15); ctx.lineTo(-12, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(5, 15); ctx.lineTo(12, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(8, 5); ctx.lineTo(16, -8); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(-4, 18); ctx.lineTo(-4, 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(4, 18); ctx.lineTo(4, 26); ctx.stroke();
        }
      }

      ctx.restore();
      ctx.shadowBlur = 0;
    };

    drawPlayer(engine.player1, '#ff5500');
    drawPlayer(engine.player2, '#00ddff');

    // Draw Projectiles
    if (engine.projectiles.length > 0) {
      ctx.fillStyle = '#fff';
      if (settingsRef.current.bloom) {
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#fff';
      }

      ctx.beginPath();
      engine.projectiles.forEach(p => {
        ctx.moveTo(p.x + p.radius, p.y);
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);

        // Trail
        if (settingsRef.current.particles && Math.random() > 0.3) {
          addParticles(p.x, p.y, '#fff', 1);
        }
      });
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    drawParticles(ctx, dt);

    // Dark Mode Overlay
    if (engine.level.worldSettings?.darkMode) {
      const radius = engine.level.worldSettings.lightRadius || 150;

      // Create a temporary canvas for the mask if not exists or resized
      // For simplicity in this environment, we'll just draw directly with a composite operation

      ctx.save();
      ctx.globalCompositeOperation = 'multiply'; // This will darken everything

      // Create a separate buffer for the lighting to avoid complex composite operations on the main ctx
      const lightCanvas = document.createElement('canvas');
      lightCanvas.width = CANVAS_WIDTH;
      lightCanvas.height = CANVAS_HEIGHT;
      const lctx = lightCanvas.getContext('2d');

      if (lctx) {
        // Fill with black (complete darkness)
        lctx.fillStyle = 'black';
        lctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        // Cut out circles for players
        lctx.globalCompositeOperation = 'destination-out';

        const drawLight = (p: typeof engine.player1, color: string) => {
          const x = p.x + 15;
          const y = p.y + 20;

          const gradient = lctx.createRadialGradient(x, y, 0, x, y, radius);
          gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
          gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

          lctx.fillStyle = gradient;
          lctx.beginPath();
          lctx.arc(x, y, radius, 0, Math.PI * 2);
          lctx.fill();
        };

        drawLight(engine.player1, '#ff5500');
        drawLight(engine.player2, '#00ddff');

        // Add colored glow
        lctx.globalCompositeOperation = 'source-over';
        const drawGlow = (p: typeof engine.player1, color: string) => {
          const x = p.x + 15;
          const y = p.y + 20;

          const gradient = lctx.createRadialGradient(x, y, 0, x, y, radius);
          const r = parseInt(color.slice(1, 3), 16);
          const g = parseInt(color.slice(3, 5), 16);
          const b = parseInt(color.slice(5, 7), 16);

          gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.2)`);
          gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

          lctx.fillStyle = gradient;
          lctx.beginPath();
          lctx.arc(x, y, radius, 0, Math.PI * 2);
          lctx.fill();
        };

        drawGlow(engine.player1, '#ff5500');
        drawGlow(engine.player2, '#00ddff');

        // Draw the mask onto the main canvas
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(lightCanvas, 0, 0);
      }

      ctx.restore();
    }

    // Post-processing effects
    if (world?.invertColors) {
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.restore();
    }

    if (world?.pixelate) {
      const size = Math.max(1, world.pixelate);
      const w = CANVAS_WIDTH / size;
      const h = CANVAS_HEIGHT / size;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = w;
      tempCanvas.height = h;
      const tctx = tempCanvas.getContext('2d');
      if (tctx) {
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(canvasRef.current!, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.drawImage(tempCanvas, 0, 0, w, h, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    }

    ctx.restore();
  };

  const sendChat = (msg: string, emoji?: string) => {
    if (gameMode !== 'multi' || !roomId || !userId) return;
    const text = (emoji ? `${emoji} ${msg}` : msg).trim().slice(0, 200);
    if (!text) return;
    addDoc(collection(db, 'lobbies', roomId, 'messages'), {
      uid: userId,
      displayName: displayName || 'Player',
      text,
      createdAt: Date.now(),
    }).catch(console.error);
  };

  const handleStartMultiplayer = () => {
    if (!isHost || !roomId) return;
    updateDoc(doc(db, 'lobbies', roomId), { matchStarted: true }).catch(console.error);
  };

  const selectRole = (selectedRole: 'fire' | 'water') => {
    if (gameMode === 'multi' && roomId && userId) {
      const roomRef = doc(db, 'lobbies', roomId);
      updateDoc(roomRef, {
        [`players.${userId}.role`]: selectedRole
      });
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Google Sign-In Error:", error);
      showToast("Sign-in failed", "error");
    }
  };

  const requestFullscreen = (on: boolean) => {
    if (rootRef.current) toggleFullscreen(rootRef.current, on);
    setIsFull(on);
  };

  return (
    <div
      ref={rootRef}
      className="relative w-full h-[100dvh] overflow-hidden bg-black text-white font-mono flex flex-col"
    >
      <AnimatePresence>
        {!gameStarted && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className="absolute inset-0 z-50 flex flex-col items-center overflow-y-auto overscroll-contain bg-black/95 p-4 text-center sm:p-8"
          >
            {/* `justify-center` on a scroll container clips the top of anything
                taller than the viewport and makes it unreachable. `my-auto` on
                the content centres it when it fits and lets it scroll when it
                doesn't — which on a phone it always does. */}
            <div className="my-auto w-full max-w-md">
            <h1 className="text-4xl sm:text-6xl font-black mb-4 tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-orange-500 to-cyan-500">
              NEON ELEMENTS
            </h1>

            <div className="w-full max-w-md">
              <div className="mb-8 p-4 bg-zinc-900 rounded-2xl border border-white/5">
                <div className="text-xs text-zinc-500 uppercase mb-1">Room Code</div>
                <div className="text-2xl font-bold tracking-widest text-cyan-400">{roomId}</div>
                <button onClick={copyInviteLink} className="mt-2 text-xs text-zinc-400 underline">Copy Invite Link</button>
              </div>

              <div className="grid grid-cols-2 gap-6 mb-8">
                <button
                  onClick={() => selectRole('fire')}
                  disabled={Object.values(lobbyData?.players || {}).some((p: any) => p.role === 'fire' && p.uid !== userId)}
                  className={`relative p-6 rounded-2xl border-2 transition-all ${role === 'fire' ? 'border-orange-500 bg-orange-500/20' : 'border-white/10 bg-zinc-900 hover:border-orange-500/50'
                    } disabled:opacity-30 disabled:cursor-not-allowed`}
                >
                  <div className="text-4xl mb-2">🔥</div>
                  <div className="font-bold">FIREBOY</div>
                  {Object.values(lobbyData?.players || {}).find((p: any) => p.role === 'fire') && (
                    <div className="absolute -top-2 -right-2 bg-orange-500 text-[10px] px-2 py-1 rounded-full">TAKEN</div>
                  )}
                </button>

                <button
                  onClick={() => selectRole('water')}
                  disabled={Object.values(lobbyData?.players || {}).some((p: any) => p.role === 'water' && p.uid !== userId)}
                  className={`relative p-6 rounded-2xl border-2 transition-all ${role === 'water' ? 'border-cyan-500 bg-cyan-500/20' : 'border-white/10 bg-zinc-900 hover:border-cyan-500/50'
                    } disabled:opacity-30 disabled:cursor-not-allowed`}
                >
                  <div className="text-4xl mb-2">💧</div>
                  <div className="font-bold">WATERGIRL</div>
                  {Object.values(lobbyData?.players || {}).find((p: any) => p.role === 'water') && (
                    <div className="absolute -top-2 -right-2 bg-cyan-500 text-[10px] px-2 py-1 rounded-full">TAKEN</div>
                  )}
                </button>
              </div>

              <div className="mb-8 p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                <div className="text-xs text-zinc-500 uppercase mb-3 font-bold">Players in Lobby ({Object.keys(lobbyData?.players || {}).length}/2)</div>
                <div className="flex flex-col gap-2">
                  {lobbyData?.players && Object.values(lobbyData.players).map((p: any) => (
                    <div key={p.uid} className="flex items-center justify-between bg-black/30 px-4 py-2 rounded-lg border border-white/5">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${p.uid === userId ? 'bg-green-500' : 'bg-zinc-500'}`} />
                        <span className="font-mono text-sm text-zinc-300">
                          {p.uid === userId ? 'YOU' : `PLAYER (${p.uid?.substring(0, 4) || '....'})`}
                        </span>
                      </div>
                      {p.role && (
                        <span className={`text-xs font-bold uppercase ${p.role === 'fire' ? 'text-orange-500' : 'text-cyan-500'}`}>
                          {p.role}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {!userId ? (
                  <div className="flex flex-col gap-4">
                    {isAuthRestricted && (
                      <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-xl text-xs text-orange-400 text-center">
                        Anonymous login is restricted. Please sign in to continue.
                      </div>
                    )}
                    <button
                      onClick={handleGoogleSignIn}
                      className="px-12 py-4 bg-orange-500 text-white font-bold rounded-full hover:bg-orange-600 transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                      <Users size={20} /> SIGN IN WITH GOOLE
                    </button>
                  </div>
                ) : isHost ? (
                  <button
                    onClick={handleStartMultiplayer}
                    disabled={!lobbyData || !Object.values(lobbyData.players).some((p: any) => p.role === 'fire') || !Object.values(lobbyData.players).some((p: any) => p.role === 'water')}
                    className="px-12 py-4 bg-white text-black font-bold rounded-full hover:bg-zinc-200 transition-all active:scale-95 disabled:opacity-30"
                  >
                    {!lobbyData || Object.keys(lobbyData.players).length < 2 ? 'WAITING FOR PLAYERS...' :
                      (!Object.values(lobbyData.players).some((p: any) => p.role === 'fire') || !Object.values(lobbyData.players).some((p: any) => p.role === 'water') ? 'SELECT ROLES...' : 'START GAME')}
                  </button>
                ) : (
                  <div className="px-12 py-4 bg-zinc-800 text-white font-bold rounded-full opacity-50 text-center">
                    WAITING FOR HOST TO START...
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => onBack?.()} className="flex-1 py-4 bg-zinc-900 border border-white/5 rounded-xl text-xs font-bold text-zinc-500 hover:text-white transition-colors">BACK TO MENU</button>
                </div>

                <button
                  onClick={() => requestFullscreen(!isFull)}
                  className="w-full py-3 bg-zinc-900 border border-white/5 rounded-xl text-xs font-bold text-zinc-400 hover:text-white transition-colors flex items-center justify-center gap-2"
                >
                  {isFull ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  {isFull ? 'EXIT FULL SCREEN' : 'FULL SCREEN'}
                </button>

                <div className="p-2 bg-black/40 rounded border border-zinc-800 font-mono text-[10px] text-zinc-500 text-left">
                  <div>ROOM: {roomId}</div>
                  <div>PLAYERS: {Object.keys(lobbyData?.players || {}).length}</div>
                  <div>PEER: {rtcConnected ? 'DIRECT' : 'FALLBACK'}</div>
                </div>
              </div>
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative flex-1 min-h-0 w-full flex flex-col landscape:flex-row items-center justify-center gap-2 p-2">
        {/* Left Side Controls (Landscape) */}
        <div className={`${isTouch ? 'hidden landscape:flex' : 'hidden'} flex-col gap-6 p-4 z-20`}>
          <button
            onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
            onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
            className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl pointer-events-auto"
          >
            <span className="text-3xl text-white">←</span>
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
            onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
            className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl pointer-events-auto"
          >
            <span className="text-3xl text-white">→</span>
          </button>
        </div>

        {/* Game Area — sized by measurement, so the framing is identical on a
            phone, a laptop and a 4K monitor: only the scale changes. */}
        {/* self-stretch rather than w-full: this row is a column on a phone in
            portrait and a row in landscape, and w-full fights flex-1 in the
            row case. */}
        <div ref={stageRef} className="relative flex-1 min-h-0 min-w-0 self-stretch flex items-center justify-center">
        <div
          style={{ width: stage.w, height: stage.h }}
          className="relative bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl flex items-center justify-center z-10"
        >

          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="w-full h-full"
          />

          {/* HUD */}
          <div className="absolute top-0 left-0 right-0 p-2 sm:p-6 flex justify-between items-start pointer-events-none bg-gradient-to-b from-black/80 to-transparent">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2">
                <div className="w-1 h-3 bg-orange-500" />
                <div className="text-[10px] text-zinc-500 uppercase tracking-[0.3em] font-bold">
                  {customLevel ? 'USER_DATA_ARCHive' : `SECTOR_0${levelIndex + 1}`}
                </div>
              </div>
              <div className="text-sm sm:text-2xl font-black tracking-tighter italic uppercase truncate">{customLevel ? customLevel.name : levels[levelIndex].name}</div>

              {/* Telemetry is a nice-to-have; on a phone the level itself needs the pixels. */}
              <div className="hidden sm:flex gap-6 mt-4">
                <div className="flex flex-col">
                  <span className="text-[8px] text-zinc-500 uppercase font-bold mb-1">Mission Timer</span>
                  <span className="text-sm font-mono font-bold text-white">
                    {engine ? Math.floor((Date.now() - engine.startTime) / 1000).toString().padStart(3, '0') : '000'}s
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] text-zinc-500 uppercase font-bold mb-1">Gems Recovered</span>
                  <div className="flex gap-3">
                    <div className="flex items-center gap-1 text-orange-500 text-sm font-bold">
                      <Gem size={12} /> {engine?.player1.score / 10}
                    </div>
                    <div className="flex items-center gap-1 text-cyan-500 text-sm font-bold">
                      <Gem size={12} /> {engine?.player2.score / 10}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] text-zinc-500 uppercase font-bold mb-1">System Status</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${engine?.player1.isDead || engine?.player2.isDead ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`} />
                    <span className={`text-[10px] font-bold ${engine?.player1.isDead || engine?.player2.isDead ? 'text-red-500' : 'text-green-500'}`}>
                      {engine?.player1.isDead || engine?.player2.isDead ? 'CRITICAL_FAILURE' : 'NOMINAL'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-2 bg-black/40 rounded-full overflow-hidden border border-white/10">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${((levelIndex + 1) / levels.length) * 100}%` }}
                className="h-full bg-gradient-to-r from-orange-500 to-cyan-500"
              />
            </div>

            <div className="flex gap-2 pointer-events-auto">
              {onBack && (
                <button
                  onClick={onBack}
                  className="p-2 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
                  title="Back to Menu"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <button
                onClick={copyInviteLink}
                className="px-3 py-2 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors text-xs font-bold"
              >
                INVITE
              </button>
              <button
                onClick={() => requestFullscreen(!isFull)}
                className="p-2 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
                title={isFull ? 'Exit Full Screen' : 'Full Screen'}
              >
                {isFull ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
              {isTouch && (
                <button
                  onClick={() => setUseTilt(!useTilt)}
                  className={`p-2 border rounded-lg transition-colors ${useTilt ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-black/50 border-white/10 text-white'}`}
                  title="Tilt Controls"
                >
                  <Smartphone size={18} />
                </button>
              )}
              <button
                onClick={() => setEngine(new GameEngine(levels[levelIndex]))}
                className="p-2 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
              >
                <RefreshCw size={18} />
              </button>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="p-2 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
                title="Settings"
              >
                <Settings size={18} />
              </button>
              <button
                onClick={() => setShowChat(!showChat)}
                className="p-2 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
              >
                <MessageSquare size={18} />
              </button>
            </div>
          </div>

          {/* Chat Overlay */}
          <AnimatePresence>
            {showChat && (
              <motion.div
                initial={{ x: 300 }}
                animate={{ x: 0 }}
                exit={{ x: 300 }}
                className="absolute top-0 right-0 bottom-0 w-64 bg-black/80 backdrop-blur-md border-l border-white/10 p-4 flex flex-col"
              >
                <div className="flex-1 overflow-y-auto space-y-2 mb-4">
                  {chatMessages.map((msg) => (
                    <div key={msg.id} className={`text-sm ${msg.uid === userId ? 'text-orange-400' : 'text-cyan-400'}`}>
                      <span className="font-bold opacity-50">{msg.displayName}: </span>
                      {msg.text}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {['🔥', '💧', '👍', '👎', '🏃', '🛑', '❓', '✨'].map(e => (
                    <button
                      key={e}
                      onClick={() => sendChat('', e)}
                      className="p-2 bg-white/5 rounded hover:bg-white/10 transition-colors text-xl"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Settings Overlay */}
          <AnimatePresence>
            {showSettings && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="absolute inset-0 bg-black/80 backdrop-blur-md z-50 flex items-start justify-center overflow-y-auto overscroll-contain p-4"
              >
                <div className="my-auto bg-zinc-900 border border-white/10 rounded-2xl p-4 sm:p-6 w-full max-w-md shadow-2xl">
                  <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-black uppercase tracking-widest text-white">Optimization Control</h2>
                    <button
                      onClick={() => setShowSettings(false)}
                      className="p-2 hover:bg-white/10 rounded-lg transition-colors text-zinc-400 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-black/50 rounded-xl border border-white/5">
                      <div>
                        <div className="font-bold text-white uppercase tracking-wider text-sm">Animations</div>
                        <div className="text-xs text-zinc-500 mt-1">Player movements, hazard effects, dynamic elements</div>
                      </div>
                      <button
                        onClick={() => setSettings({ ...settings, animations: !settings.animations })}
                        className={`w-12 h-6 rounded-full transition-colors relative ${settings.animations ? 'bg-cyan-500' : 'bg-zinc-700'}`}
                      >
                        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.animations ? 'translate-x-6' : 'translate-x-0'}`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-black/50 rounded-xl border border-white/5">
                      <div>
                        <div className="font-bold text-white uppercase tracking-wider text-sm">Particles</div>
                        <div className="text-xs text-zinc-500 mt-1">Sparks, splashes, ambient dust, collection effects</div>
                      </div>
                      <button
                        onClick={() => setSettings({ ...settings, particles: !settings.particles })}
                        className={`w-12 h-6 rounded-full transition-colors relative ${settings.particles ? 'bg-orange-500' : 'bg-zinc-700'}`}
                      >
                        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.particles ? 'translate-x-6' : 'translate-x-0'}`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-black/50 rounded-xl border border-white/5">
                      <div>
                        <div className="font-bold text-white uppercase tracking-wider text-sm">Shadows</div>
                        <div className="text-xs text-zinc-500 mt-1">Dynamic lighting, drop shadows, ambient occlusion</div>
                      </div>
                      <button
                        onClick={() => setSettings({ ...settings, shadows: !settings.shadows })}
                        className={`w-12 h-6 rounded-full transition-colors relative ${settings.shadows ? 'bg-green-500' : 'bg-zinc-700'}`}
                      >
                        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.shadows ? 'translate-x-6' : 'translate-x-0'}`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-black/50 rounded-xl border border-white/5">
                      <div>
                        <div className="font-bold text-white uppercase tracking-wider text-sm">Bloom</div>
                        <div className="text-xs text-zinc-500 mt-1">Glow effects, light bleeding, neon highlights</div>
                      </div>
                      <button
                        onClick={() => setSettings({ ...settings, bloom: !settings.bloom })}
                        className={`w-12 h-6 rounded-full transition-colors relative ${settings.bloom ? 'bg-purple-500' : 'bg-zinc-700'}`}
                      >
                        <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.bloom ? 'translate-x-6' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-6 pt-6 border-t border-white/10 text-center">
                    <p className="text-xs text-zinc-500">Disable features to improve performance on older devices.</p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>


        </div>
        </div>

        {/* Right Side Control (Landscape) */}
        <div className={`${isTouch ? 'hidden landscape:flex' : 'hidden'} p-4 z-20`}>
          <button
            onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
            onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
            className="w-24 h-24 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/30 active:bg-white/50 shadow-xl pointer-events-auto"
          >
            <span className="text-4xl text-white">↑</span>
          </button>
        </div>

        {/* Bottom Controls (Portrait) */}
        <div className={`${isTouch ? 'flex landscape:hidden' : 'hidden'} w-full items-center justify-between px-8 py-4 z-20 pointer-events-none shrink-0`}>
          <div className="flex gap-6 pointer-events-auto">
            <button
              onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
              onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
              className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl"
            >
              <span className="text-3xl text-white">←</span>
            </button>
            <button
              onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
              onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
              className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl"
            >
              <span className="text-3xl text-white">→</span>
            </button>
          </div>
          <div className="pointer-events-auto">
            <button
              onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
              onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
              className="w-24 h-24 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/30 active:bg-white/50 shadow-xl"
            >
              <span className="text-4xl text-white">↑</span>
            </button>
          </div>
        </div>
      </div>

      <div className="mt-8 flex gap-8 text-zinc-500 text-xs uppercase tracking-widest hidden">
        <div className="flex items-center gap-2">
          <Monitor size={14} />
          <span>Desktop: WASD & Arrows</span>
        </div>
        <div className="flex items-center gap-2">
          <Smartphone size={14} />
          <span>Mobile: Touch Controls</span>
        </div>
      </div>
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className={`fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full font-bold shadow-2xl z-[100] flex items-center gap-3 border ${toast.type === 'success' ? 'bg-green-500/20 border-green-500 text-green-500' :
              toast.type === 'error' ? 'bg-red-500/20 border-red-500 text-red-500' :
                'bg-cyan-500/20 border-cyan-500 text-cyan-500'
              }`}
          >
            <div className={`w-2 h-2 rounded-full ${toast.type === 'success' ? 'bg-green-500' :
              toast.type === 'error' ? 'bg-red-500' :
                'bg-cyan-500'
              } animate-pulse`} />
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
