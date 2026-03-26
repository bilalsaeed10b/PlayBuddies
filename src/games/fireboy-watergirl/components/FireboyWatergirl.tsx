import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  auth, db, googleProvider
} from '@/lib/firebase';
import {
  doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp
} from 'firebase/firestore';
import { signInAnonymously, onAuthStateChanged, signInWithPopup } from 'firebase/auth';
import { GameEngine } from '../game/engine';
import { Level } from '../types';
import { getLevels } from '../game/levels';
import { MessageSquare, Smile, RefreshCw, Smartphone, Monitor, Gem, ArrowLeft, Settings, Users, Maximize2, LogOut, Eye, EyeOff } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import { playJumpSound, playCollectSound, playDeathSound, playWinSound } from '../game/sounds';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

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

export default function FireboyWatergirl({
  customLevel,
  startLevelIndex = 0,
  onBack,
  onComplete,
  initialGameMode = 'single',
  initialRoomId,
  isHost = false,
  displayName,
  photoURL,
  platformUserId
}: {
  customLevel?: Level | null,
  startLevelIndex?: number,
  onBack?: () => void,
  onComplete?: (levelId: number) => void,
  initialGameMode?: 'single' | 'multi',
  initialRoomId?: string,
  isHost?: boolean,
  displayName?: string,
  photoURL?: string,
  platformUserId?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [screenShake, setScreenShake] = useState(0);
  const [levelIndex, setLevelIndex] = useState(startLevelIndex);
  const [userId, setUserId] = useState<string | null>(platformUserId || null);
  const [roomId, setRoomId] = useState(initialRoomId || '');
  const [role, setRole] = useState<'fire' | 'water' | 'both' | null>(initialGameMode === 'single' ? 'both' : null);
  const [gameMode, setGameMode] = useState<'single' | 'multi' | null>(initialGameMode);
  const [gameStarted, setGameStarted] = useState(initialGameMode === 'single');
  const [lobbyData, setLobbyData] = useState<any>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [showChat, setShowChat] = useState(false);
  const [showHud, setShowHud] = useState(false);
  const [showTitle, setShowTitle] = useState(true);
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' | 'info' } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  
  useEffect(() => {
    const checkMobile = () => {
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const isSmall = window.innerWidth < 1024;
      setIsMobile(isTouch || isSmall);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  const [useTilt, setUseTilt] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);

  useEffect(() => {
    if (gameStarted && !isGameOver) {
      setShowTitle(true);
      const timer = setTimeout(() => setShowTitle(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [gameStarted, levelIndex, isGameOver]);

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
  const rtcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const [rtcConnected, setRtcConnected] = useState(false);
  const [fps, setFps] = useState(0);
  const [ping, setPing] = useState(0);
  const lastTimeRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const lastFpsUpdateRef = useRef<number>(0);
  const lastPingSentRef = useRef<number>(0);

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
        const roomRef = doc(db, 'rooms', roomId);
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
  }, [levelIndex, customLevel, levels, handleGameEvent]);

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

      const roomRef = doc(db, 'rooms', room);
      const roomSnap = await getDoc(roomRef);

      if (!roomSnap.exists()) {
        if (isHost) {
          console.log(`[Multiplayer] Creating room [${room}]`);
          await setDoc(roomRef, {
            roomId: room,
            status: 'lobby',
            level: startLevelIndex,
            players: {
              [uid]: { id: uid, role: null, ready: false, displayName: displayName || 'Host', photoURL: photoURL || '' }
            },
            chat: [],
            collectedGems: {}
          });
        } else {
          showToast("Room not found", "error");
          return;
        }
      } else {
        console.log(`[Multiplayer] Joining room [${room}]`);
        const data = roomSnap.data();
        if (data.status === 'playing' && !data.players[uid]) {
          showToast("Game already in progress", "error");
          return;
        }

        await updateDoc(roomRef, {
          [`players.${uid}`]: { id: uid, role: null, ready: false, displayName: displayName || 'Player', photoURL: photoURL || '' }
        });
      }
    };

    return () => unsubscribeAuth();
  }, [gameMode, initialRoomId, isHost, startLevelIndex]);

  // Firestore Listeners
  useEffect(() => {
    if (gameMode !== 'multi' || !roomId || !userId) return;

    console.log(`[Multiplayer] Setting up Firestore listeners for room [${roomId}]`);
    const roomRef = doc(db, 'rooms', roomId);

    const unsubscribeRoom = onSnapshot(roomRef, (docSnap: any) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
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

        if (data.status === 'playing') {
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

        // Sync chat
        if (data.chat) {
          setChatMessages(data.chat);
        }
      }
    });

    return () => {
      unsubscribeRoom();
    };
  }, [gameMode, roomId, userId, isHost]);

  // Separate effect for player updates to avoid re-subscribing to room doc
  const otherPlayerIds = lobbyData ? Object.keys(lobbyData.players).filter(id => id !== userId).join(',') : '';

  useEffect(() => {
    if (gameMode !== 'multi' || !roomId || !userId || !otherPlayerIds) return;

    const otherPlayers = otherPlayerIds.split(',');
    const unsubscribes: (() => void)[] = [];

    otherPlayers.forEach(pid => {
      const pRef = doc(db, 'rooms', roomId, 'updates', pid);
      const unsub = onSnapshot(pRef, (snap: any) => {
        if (snap.exists()) {
          const state = snap.data();
          const currentEngine = engineRef.current;
          if (!currentEngine) return;

          const targetPlayer = state.role === 'fire' ? currentEngine.player1 : currentEngine.player2;

          // Only update if the Firestore state is newer than what we have, 
          // or if WebRTC isn't connected
          if (!rtcConnected || (state.lastUpdate && state.lastUpdate > ((targetPlayer as any).lastUpdate || 0))) {
            Object.assign(targetPlayer, state);
            (targetPlayer as any).lastUpdate = state.lastUpdate || Date.now();
          }
        }
      });
      unsubscribes.push(unsub);
    });

    return () => unsubscribes.forEach(u => u());
  }, [gameMode, roomId, userId, otherPlayerIds, rtcConnected]);

  // WebRTC Setup for low-latency multiplayer
  const hasTwoPlayers = lobbyData ? Object.keys(lobbyData.players).length >= 2 : false;

  useEffect(() => {
    if (gameMode !== 'multi' || !roomId || !userId || !hasTwoPlayers) return;

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
            const currentEngine = engineRef.current;
            if (!currentEngine) return;

            if (data.type === 'sync') {
              const targetPlayer = data.role === 'fire' ? currentEngine.player1 : currentEngine.player2;
              Object.assign(targetPlayer, data.state);
              (targetPlayer as any).lastUpdate = data.lastUpdate || Date.now();
            } else if (data.type === 'ping') {
              dcRef.current?.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
            } else if (data.type === 'pong') {
              setPing(Date.now() - data.timestamp);
            }
          } catch (err) {
            console.error('[WebRTC] Error parsing message', err);
          }
        };
      };

      const roomRef = doc(db, 'rooms', roomId);

      if (isHost) {
        const dc = pc.createDataChannel('game-sync', { negotiated: true, id: 0 });
        dcRef.current = dc;
        setupDataChannel(dc);

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            updateDoc(roomRef, {
              hostCandidates: arrayUnion(JSON.stringify(e.candidate.toJSON()))
            }).catch(console.error);
          }
        };

        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await updateDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp } });
        } catch (err) {
          console.error('[WebRTC] Error creating offer', err);
        }

        unsubRoom = onSnapshot(roomRef, (snap: any) => {
          const data = snap.data();
          if (data?.answer && pc.signalingState === 'have-local-offer') {
            pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(console.error);
          }
          if (data?.clientCandidates) {
            data.clientCandidates.forEach((cStr: string) => {
              if (addedCandidates.has(cStr)) return;
              addedCandidates.add(cStr);
              try {
                const c = JSON.parse(cStr);
                pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
              } catch (e) { }
            });
          }
        });

      } else {
        const dc = pc.createDataChannel('game-sync', { negotiated: true, id: 0 });
        dcRef.current = dc;
        setupDataChannel(dc);

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            updateDoc(roomRef, {
              clientCandidates: arrayUnion(JSON.stringify(e.candidate.toJSON()))
            }).catch(console.error);
          }
        };

        unsubRoom = onSnapshot(roomRef, async (snap: any) => {
          const data = snap.data();
          if (data?.offer && pc.signalingState === 'stable' && !pc.currentRemoteDescription) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await updateDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp } });
            } catch (err) {
              console.error('[WebRTC] Error creating answer', err);
            }
          }
          if (data?.hostCandidates) {
            data.hostCandidates.forEach((cStr: string) => {
              if (addedCandidates.has(cStr)) return;
              addedCandidates.add(cStr);
              try {
                const c = JSON.parse(cStr);
                pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
              } catch (e) { }
            });
          }
        });
      }
    };

    initWebRTC();

    return () => {
      if (unsubRoom) unsubRoom();
      rtcRef.current?.close();
      rtcRef.current = null;
      dcRef.current = null;
      setRtcConnected(false);
    };
  }, [gameMode, roomId, userId, isHost, hasTwoPlayers]);

  // Game loop
  useEffect(() => {
    if (!gameStarted || !engine || isGameOver) return;

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const loop = (time: number) => {
      const currentEngine = engineRef.current;
      if (!currentEngine || isGameOver) return;

      const now = performance.now();
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const dt = Math.min(3, (now - lastTimeRef.current) / (1000 / 60)); // Cap dt to avoid huge jumps
      lastTimeRef.current = now;

      // Update FPS every second
      frameCountRef.current++;
      if (now - lastFpsUpdateRef.current > 1000) {
        setFps(Math.round((frameCountRef.current * 1000) / (now - lastFpsUpdateRef.current)));
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;

        // Send ping every second in multiplayer
        if (gameMode === 'multi' && dcRef.current?.readyState === 'open') {
          dcRef.current.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }

      // Chaos Mode logic
      if (currentEngine.level.worldSettings?.chaosMode) {
        if (Math.random() > 0.99) {
          // Random gravity shift
          currentEngine.gravity = (Math.random() * 0.4 + 0.1) * (currentEngine.level.worldSettings.gravityMultiplier || 1);
        }
        if (Math.random() > 0.98) {
          // Random screen shake
          setScreenShake(Math.random() * 10);
        }
      }

      // Decay screen shake
      if (screenShake > 0.1) {
        setScreenShake(prev => prev * 0.9);
      } else if (screenShake !== 0) {
        setScreenShake(0);
      }

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
      } else {

        // Local co-op mode
        currentEngine.update(keys.current, dt);
      }


      // Update engine's collision memory for levers
      if (role !== 'both') {
        // @ts-ignore - accessing private for sync
        currentEngine.collidingEntities = currentCollisions;

        // Apply movement smoothing for remote player
        const remotePlayer = role === 'fire' ? currentEngine.player2 : currentEngine.player1;
        if (!remotePlayer.isDead && !remotePlayer.atDoor) {
          remotePlayer.x += remotePlayer.vx * dt;
          remotePlayer.y += remotePlayer.vy * dt;
          // Apply gravity if not on ground (simplified)
          if (remotePlayer.vy < 15) remotePlayer.vy += currentEngine.gravity * dt;
        }
      }


      // Sync player state
      if (gameMode === 'multi' && roomId && userId && role && role !== 'both') {
        const p = role === 'fire' ? currentEngine.player1 : currentEngine.player2;
        const state = {
          x: p.x,
          y: p.y,
          vx: p.vx,
          vy: p.vy,
          animState: p.animState,
          animFrame: p.animFrame,
          isDead: p.isDead,
          atDoor: p.atDoor,
          facing: p.facing,
          score: p.score
        };

        if (dcRef.current?.readyState === 'open') {
          dcRef.current.send(JSON.stringify({ type: 'sync', role, state, lastUpdate: Date.now() }));
        }

        const syncNow = Date.now();
        const syncInterval = rtcConnected ? 200 : 50; // 5fps if WebRTC connected, 20fps otherwise
        if (syncNow - lastUpdateRef.current > syncInterval) {
          const pRef = doc(db, 'rooms', roomId, 'updates', userId);
          setDoc(pRef, { ...state, role, lastUpdate: syncNow }, { merge: true }).catch(console.error);
          lastUpdateRef.current = syncNow;
        }
      }

      currentEngine.updateEntities(dt);

      draw(ctx, currentEngine, time);

      if (currentEngine.player1.atDoor && currentEngine.player2.atDoor) {
        // Force one last sync before stopping game loop
        if (gameMode === 'multi' && roomId && userId && role && role !== 'both') {
          const p = role === 'fire' ? currentEngine.player1 : currentEngine.player2;
          const state = {
            x: p.x, y: p.y, vx: p.vx, vy: p.vy,
            animState: p.animState, animFrame: p.animFrame,
            isDead: p.isDead, atDoor: p.atDoor, facing: p.facing,
            score: p.score
          };
          if (dcRef.current?.readyState === 'open') {
            dcRef.current.send(JSON.stringify({ type: 'sync', role, state, lastUpdate: Date.now() }));
          }
          const pRef = doc(db, 'rooms', roomId, 'updates', userId);
          setDoc(pRef, { ...state, role, lastUpdate: Date.now() }, { merge: true }).catch(console.error);
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
            const roomRef = doc(db, 'rooms', roomId);
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
      const pRef = doc(db, 'rooms', roomId, 'updates', userId);
      updateDoc(pRef, { isDead: true }).catch(console.error);

      if (dcRef.current?.readyState === 'open') {
        const p = role === 'fire' ? engineRef.current?.player1 : engineRef.current?.player2;
        if (p) {
          dcRef.current.send(JSON.stringify({
            type: 'sync',
            role,
            state: { ...p, isDead: true },
            lastUpdate: Date.now()
          }));
        }
      }
    }

    setTimeout(() => {
      const level = customLevel || levels[levelIndex];
      const newEngine = new GameEngine(level);
      newEngine.onEvent = handleGameEvent;
      engineRef.current = newEngine;
      setEngine(newEngine);

      // Reset Firestore state for this player to prevent immediate re-death sync
      if (gameMode === 'multi' && roomId && userId && role && role !== 'both') {
        const pRef = doc(db, 'rooms', roomId, 'updates', userId);
        const p = role === 'fire' ? newEngine.player1 : newEngine.player2;
        setDoc(pRef, {
          x: p.x,
          y: p.y,
          vx: 0,
          vy: 0,
          isDead: false,
          atDoor: false,
          animState: 'idle',
          lastUpdate: Date.now()
        }, { merge: true });
      }

      setIsGameOver(false);
    }, 1500);
  };

  const drawParticles = (ctx: CanvasRenderingContext2D) => {
    if (!settingsRef.current.particles) return;

    // Disable shadow blur for particles to drastically improve performance
    ctx.shadowBlur = 0;

    for (let i = particlesRef.current.length - 1; i >= 0; i--) {
      const p = particlesRef.current[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life++;

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

  const draw = (ctx: CanvasRenderingContext2D, engine: GameEngine, time: number) => {
    const world = engine.level.worldSettings;

    ctx.save();

    // Screen Shake
    const shake = (world?.screenShake || 0) + screenShake;
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

    drawParticles(ctx);

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
    if (gameMode === 'multi' && roomId && userId) {
      const roomRef = doc(db, 'rooms', roomId);
      updateDoc(roomRef, {
        chat: arrayUnion({
          id: userId,
          message: msg,
          emoji,
          role,
          timestamp: Date.now()
        })
      });
    }
  };

  const handleStartMultiplayer = () => {
    if (lobbyData?.status === 'lobby' && roomId) {
      const roomRef = doc(db, 'rooms', roomId);
      updateDoc(roomRef, { status: 'playing' });
    }
  };

  const selectRole = (selectedRole: 'fire' | 'water') => {
    if (gameMode === 'multi' && roomId && userId) {
      const roomRef = doc(db, 'rooms', roomId);
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

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 font-mono">
      <AnimatePresence>
        {!gameStarted && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/95 p-8 text-center overflow-y-auto"
          >
            <h1 className="text-6xl font-black mb-4 tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-orange-500 to-cyan-500">
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
                  disabled={Object.values(lobbyData?.players || {}).some((p: any) => p.role === 'fire' && p.id !== userId)}
                  className={`relative p-6 rounded-2xl border-2 transition-all ${role === 'fire' ? 'border-orange-500 bg-orange-500/20' : 'border-white/10 bg-zinc-900 hover:border-orange-500/50'
                    } disabled:opacity-30 disabled:cursor-not-allowed`}
                >
                  <div className="text-4xl mb-2">🔥</div>
                  <div className="font-bold">FIREBOY</div>
                  {!!(Object.values(lobbyData?.players || {}).find((p: any) => p.role === 'fire')) && (
                    <div className="absolute -top-2 -right-2 bg-orange-500 text-[10px] px-2 py-1 rounded-full text-white font-bold">TAKEN</div>
                  )}
                </button>

                <button
                  onClick={() => selectRole('water')}
                  disabled={Object.values(lobbyData?.players || {}).some((p: any) => p.role === 'water' && p.id !== userId)}
                  className={`relative p-6 rounded-2xl border-2 transition-all ${role === 'water' ? 'border-cyan-500 bg-cyan-500/20' : 'border-white/10 bg-zinc-900 hover:border-cyan-500/50'
                    } disabled:opacity-30 disabled:cursor-not-allowed`}
                >
                  <div className="text-4xl mb-2">💧</div>
                  <div className="font-bold">WATERGIRL</div>
                  {!!(Object.values(lobbyData?.players || {}).find((p: any) => p.role === 'water')) && (
                    <div className="absolute -top-2 -right-2 bg-cyan-500 text-[10px] px-2 py-1 rounded-full text-white font-bold">TAKEN</div>
                  )}
                </button>
              </div>

              <div className="mb-8 p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                <div className="text-xs text-zinc-500 uppercase mb-3 font-bold">Players in Lobby ({Object.keys(lobbyData?.players || {}).length}/2)</div>
                <div className="flex flex-col gap-2">
                  {lobbyData?.players && Object.values(lobbyData.players).map((p: any) => (
                    <div key={p.id} className="flex items-center justify-between bg-black/30 px-4 py-2 rounded-lg border border-white/5">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${p.id === userId ? 'bg-green-500' : 'bg-zinc-500'}`} />
                        <span className="font-mono text-sm text-zinc-300">
                          {p.id === userId ? 'YOU' : `PLAYER (${p.id?.substring(0, 4) || '....'})`}
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

                {/* Debug Info (Visible in Lobby) */}
                <div className="mt-4 p-2 bg-black/40 rounded border border-zinc-800 font-mono text-[10px] text-zinc-500 text-left">
                  <div>ROOM: {roomId}</div>
                  <div>USER: {userId || 'AUTHENTICATING...'}</div>
                  <div>SYNC: FIRESTORE</div>
                  <div>PLAYERS: {Object.keys(lobbyData?.players || {}).length}</div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative w-full h-full flex flex-col landscape:flex-row items-center justify-center gap-4 p-2">
        {/* Left Side Controls (Landscape) */}
        {isMobile && (
          <div className="hidden landscape:flex flex-col gap-6 p-4 z-20">
            <motion.button
              drag
              dragConstraints={{ left: 0, right: 200, top: -200, bottom: 200 }}
              dragElastic={0.1}
              dragMomentum={false}
              whileDrag={{ scale: 1.1, cursor: "grabbing" }}
              onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
              onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
              className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl pointer-events-auto touch-none"
            >
              <span className="text-3xl text-white">←</span>
            </motion.button>
            <motion.button
              drag
              dragConstraints={{ left: 0, right: 200, top: -200, bottom: 200 }}
              dragElastic={0.1}
              dragMomentum={false}
              whileDrag={{ scale: 1.1, cursor: "grabbing" }}
              onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
              onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
              className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl pointer-events-auto touch-none"
            >
              <span className="text-3xl text-white">→</span>
            </motion.button>
          </div>
        )}

        {/* Game Area */}
        <div className="relative w-full landscape:w-auto h-auto landscape:h-full max-h-[65vh] landscape:max-h-full aspect-[4/3] bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl flex items-center justify-center z-10">

          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="w-full h-full"
          />

          <AnimatePresence>
            {showTitle && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.1 }}
                className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-20"
              >
                <div className="text-sm text-orange-500 uppercase tracking-[0.5em] font-bold mb-2">
                  {customLevel ? 'USER_DATA_ARCHive' : `SECTOR_0${levelIndex + 1}`}
                </div>
                <div className="text-6xl font-black tracking-tighter italic uppercase text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]">
                  {customLevel ? customLevel.name : levels[levelIndex].name}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* HUD Overlay */}
          <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-start pointer-events-none bg-gradient-to-b from-black/80 to-transparent z-10">
            <AnimatePresence>
              {showHud && (
                <motion.div 
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="flex flex-col gap-1 pointer-events-auto"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-1 h-3 bg-orange-500" />
                    <div className="text-[10px] text-zinc-500 uppercase tracking-[0.3em] font-bold">
                      {customLevel ? 'USER_DATA_ARCHive' : `SECTOR_0${levelIndex + 1}`}
                    </div>
                  </div>
                  <div className="text-2xl font-black tracking-tighter italic uppercase">{customLevel ? customLevel.name : levels[levelIndex].name}</div>

                  <div className="flex gap-6 mt-4">
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
                          <Gem size={12} /> {(engine?.player1?.score ?? 0) / 10}
                        </div>
                        <div className="flex items-center gap-1 text-cyan-500 text-sm font-bold">
                          <Gem size={12} /> {(engine?.player2?.score ?? 0) / 10}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[8px] text-zinc-500 uppercase font-bold mb-1">System Status</span>
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${engine?.player1?.isDead || engine?.player2?.isDead ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`} />
                        <span className={`text-[10px] font-bold ${engine?.player1?.isDead || engine?.player2?.isDead ? 'text-red-500' : 'text-green-500'}`}>
                          {engine?.player1?.isDead || engine?.player2?.isDead ? 'CRITICAL_FAILURE' : 'NOMINAL'}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[8px] text-zinc-500 uppercase font-bold mb-1">Performance</span>
                      <div className="flex gap-4">
                        <div className="flex flex-col">
                          <span className="text-[8px] text-zinc-400">FPS</span>
                          <span className={`text-xs font-mono font-bold ${fps < 30 ? 'text-red-500' : 'text-green-500'}`}>{fps}</span>
                        </div>
                        {gameMode === 'multi' && (
                          <div className="flex flex-col">
                            <span className="text-[8px] text-zinc-400">PING</span>
                            <span className={`text-xs font-mono font-bold ${ping > 200 ? 'text-red-500' : (ping > 100 ? 'text-orange-500' : 'text-green-500')}`}>
                              {ping}ms
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

            {/* Progress Bar */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-2 bg-black/40 rounded-full overflow-hidden border border-white/10">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${((levelIndex + 1) / levels.length) * 100}%` }}
                className="h-full bg-gradient-to-r from-orange-500 to-cyan-500"
              />
            </div>

            {/* Right Tools - HUD Toggle, Back, etc */}
            <div className="absolute top-6 right-6 flex gap-2 pointer-events-auto z-20">
              <button
                onClick={() => setShowHud(!showHud)}
                className="p-2 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors"
                title="Toggle HUD"
              >
                {showHud ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
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
                onClick={() => setUseTilt(!useTilt)}
                className={`p-2 border rounded-lg transition-colors ${useTilt ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-black/50 border-white/10 text-white'}`}
                title="Tilt Controls"
              >
                <Smartphone size={18} />
              </button>
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
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`text-sm ${msg.role === 'fire' ? 'text-orange-400' : 'text-cyan-400'}`}>
                      <span className="font-bold opacity-50">{msg.role}: </span>
                      {msg.message} {msg.emoji}
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
                className="absolute inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4"
              >
                <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl">
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

        {/* Right Side Control (Landscape) */}
        {isMobile && (
          <div className="hidden landscape:flex p-4 z-20">
            <motion.button
              drag
              dragConstraints={{ left: -200, right: 0, top: -200, bottom: 200 }}
              dragElastic={0.1}
              dragMomentum={false}
              whileDrag={{ scale: 1.1, cursor: "grabbing" }}
              onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
              onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
              className="w-24 h-24 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/30 active:bg-white/50 shadow-xl pointer-events-auto touch-none"
            >
              <span className="text-4xl text-white">↑</span>
            </motion.button>
          </div>
        )}

        {/* Bottom Controls (Portrait) */}
        {isMobile && (
          <div className="flex landscape:hidden w-full items-center justify-between px-8 py-4 z-20 pointer-events-none">
            <div className="flex gap-6 pointer-events-auto">
              <motion.button
                drag
                dragConstraints={{ left: 0, right: 200, top: -200, bottom: 0 }}
                dragElastic={0.1}
                dragMomentum={false}
                whileDrag={{ scale: 1.1, cursor: "grabbing" }}
                onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
                onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowLeft' : 'KeyA'); }}
                className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl touch-none"
              >
                <span className="text-3xl text-white">←</span>
              </motion.button>
              <motion.button
                drag
                dragConstraints={{ left: -100, right: 100, top: -200, bottom: 0 }}
                dragElastic={0.1}
                dragMomentum={false}
                whileDrag={{ scale: 1.1, cursor: "grabbing" }}
                onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
                onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowRight' : 'KeyD'); }}
                className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/20 active:bg-white/40 shadow-xl touch-none"
              >
                <span className="text-3xl text-white">→</span>
              </motion.button>
            </div>
            <div className="pointer-events-auto">
              <motion.button
                drag
                dragConstraints={{ left: -200, right: 0, top: -200, bottom: 0 }}
                dragElastic={0.1}
                dragMomentum={false}
                whileDrag={{ scale: 1.1, cursor: "grabbing" }}
                onTouchStart={(e) => { e.preventDefault(); keys.current.add(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
                onTouchEnd={(e) => { e.preventDefault(); keys.current.delete(role === 'water' ? 'ArrowUp' : 'KeyW'); }}
                className="w-24 h-24 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white/30 active:bg-white/50 shadow-xl touch-none"
              >
                <span className="text-4xl text-white">↑</span>
              </motion.button>
            </div>
          </div>
        )}
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
