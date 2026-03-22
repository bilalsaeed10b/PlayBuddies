/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import Game from './components/Game/Game';
import LevelEditor from './components/Editor/LevelEditor';
import { Level } from './types';
import { getLevels } from './game/levels';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Plus, Layout, Lock, Unlock, ChevronRight, ArrowLeft, Edit3, Star, Monitor, Smartphone, Users } from 'lucide-react';

export default function App() {
  const [view, setView] = useState<'menu' | 'level-select' | 'game' | 'editor' | 'multiplayer-menu' | 'join-room'>('menu');
  const [customLevel, setCustomLevel] = useState<Level | null>(null);
  const [cameFromEditor, setCameFromEditor] = useState(false);
  const [startLevelIndex, setStartLevelIndex] = useState(0);
  const [gameMode, setGameMode] = useState<'single' | 'multi'>('single');
  const [roomId, setRoomId] = useState<string>('');
  const [isHost, setIsHost] = useState(false);
  const [profile, setProfile] = useState<{ displayName: string, photoURL: string }>({ displayName: '', photoURL: '' });
  const [unlockedLevels, setUnlockedLevels] = useState<number>(() => {
    const saved = localStorage.getItem('unlocked_levels');
    return saved ? parseInt(saved, 10) : 1;
  });

  const levels = useMemo(() => getLevels(), [view]); // Refresh levels when returning to menu/select

  const handleLevelComplete = (levelId: number) => {
    if (levelId >= unlockedLevels && levelId < levels.length) {
      const nextLevel = levelId + 1;
      setUnlockedLevels(nextLevel);
      localStorage.setItem('unlocked_levels', nextLevel.toString());
    }
  };

  const handlePlayStory = (index: number) => {
    setCustomLevel(null);
    setCameFromEditor(false);
    setStartLevelIndex(index);
    setView('game');
  };

  const handlePlayCustom = (level: Level, fromEditor: boolean = false) => {
    setCustomLevel(level);
    setCameFromEditor(fromEditor);
    setView('game');
  };

  const handleEditLevel = (level: Level) => {
    setCustomLevel(level);
    setView('editor');
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const hostParam = params.get('host');
    if (roomParam) {
      setRoomId(roomParam.toUpperCase().trim());
      setGameMode('multi');
      setIsHost(hostParam === 'true');
      setProfile({
        displayName: params.get('displayName') || '',
        photoURL: params.get('photoURL') || ''
      });
      setView('game');
      // Remove the parameter from the URL so it doesn't trigger again on refresh
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  return (
    <div className="min-h-screen bg-black text-white font-mono overflow-hidden">
      <AnimatePresence mode="wait">
        {view === 'menu' && (
          <motion.div 
            key="menu"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className="flex flex-col items-center justify-center h-screen gap-8"
          >
            <div className="text-center">
              <h1 className="text-6xl font-black tracking-tighter mb-2 bg-gradient-to-r from-orange-500 to-cyan-500 bg-clip-text text-transparent">
                NEON ELEMENTS
              </h1>
              <p className="text-zinc-500 uppercase tracking-[0.3em] text-sm">Fire & Water Cooperative Adventure</p>
            </div>

            <div className="flex flex-col gap-4 w-64">
              <MenuBtn 
                onClick={() => {
                  setGameMode('single');
                  setView('level-select');
                }} 
                icon={<Monitor size={20} />} 
                label="SINGLE PLAYER" 
                color="bg-white text-black hover:bg-zinc-200"
              />
              <MenuBtn 
                onClick={() => {
                  setGameMode('multi');
                  setView('multiplayer-menu');
                }} 
                icon={<Smartphone size={20} />} 
                label="MULTIPLAYER" 
                color="bg-orange-500 text-white hover:bg-orange-600"
              />
              <MenuBtn 
                onClick={() => {
                  setCustomLevel(null);
                  setView('editor');
                }} 
                icon={<Plus size={20} />} 
                label="LEVEL EDITOR" 
                color="bg-zinc-900 border border-white/10 hover:bg-zinc-800"
              />
            </div>
          </motion.div>
        )}

        {view === 'multiplayer-menu' && (
          <motion.div 
            key="multiplayer-menu"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className="flex flex-col items-center justify-center h-screen gap-8"
          >
            <div className="text-center">
              <h1 className="text-6xl font-black tracking-tighter mb-2 bg-gradient-to-r from-orange-500 to-cyan-500 bg-clip-text text-transparent">
                MULTIPLAYER
              </h1>
              <p className="text-zinc-500 uppercase tracking-[0.3em] text-sm">Co-op Mission Control</p>
            </div>

            <div className="flex flex-col gap-4 w-64">
              <MenuBtn 
                onClick={() => {
                  setIsHost(true);
                  setGameMode('multi');
                  const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                  setRoomId(newRoomId);
                  setView('level-select');
                }} 
                icon={<Plus size={20} />} 
                label="CREATE ROOM" 
                color="bg-white text-black hover:bg-zinc-200"
              />
              <MenuBtn 
                onClick={() => {
                  setIsHost(false);
                  setRoomId('');
                  setView('join-room');
                }} 
                icon={<Play size={20} />} 
                label="JOIN ROOM" 
                color="bg-zinc-900 border border-white/10 hover:bg-zinc-800"
              />
              <button 
                onClick={() => setView('menu')}
                className="mt-4 text-zinc-500 hover:text-white text-xs uppercase tracking-widest font-bold transition-colors"
              >
                Back to Menu
              </button>
            </div>
          </motion.div>
        )}

        {view === 'join-room' && (
          <motion.div 
            key="join-room"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className="flex flex-col items-center justify-center h-screen gap-8"
          >
            <div className="text-center">
              <h1 className="text-6xl font-black tracking-tighter mb-2 bg-gradient-to-r from-orange-500 to-cyan-500 bg-clip-text text-transparent">
                JOIN ROOM
              </h1>
              <p className="text-zinc-500 uppercase tracking-[0.3em] text-sm">Enter Lobby Code</p>
            </div>

            <div className="flex flex-col gap-4 w-64">
              <input
                type="text"
                value={roomId || ''}
                placeholder="ROOM CODE"
                className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-4 text-center text-xl font-bold uppercase tracking-widest focus:outline-none focus:border-cyan-500 transition-colors"
                onChange={(e) => setRoomId(e.target.value.toUpperCase().trim())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && roomId) {
                    setGameMode('multi');
                    setIsHost(false);
                    setView('game');
                  }
                }}
              />
              <MenuBtn 
                onClick={() => {
                  if (roomId) {
                    setGameMode('multi');
                    setIsHost(false);
                    setView('game');
                  }
                }} 
                icon={<Play size={20} />} 
                label="JOIN" 
                color="bg-cyan-500 text-white hover:bg-cyan-600"
              />
              <button 
                onClick={() => setView('multiplayer-menu')}
                className="mt-4 text-zinc-500 hover:text-white text-xs uppercase tracking-widest font-bold transition-colors"
              >
                Back
              </button>
            </div>
          </motion.div>
        )}

        {view === 'level-select' && (
          <motion.div 
            key="level-select"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col h-screen bg-[#050505] overflow-y-auto selection:bg-orange-500/30"
          >
            {/* Background Grid Accent */}
            <div className="fixed inset-0 pointer-events-none opacity-20">
              <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:40px_40px]" />
              <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent" />
            </div>

            <div className="max-w-7xl mx-auto w-full p-8 lg:p-12 flex flex-col gap-16 relative z-10">
              {/* Header Section */}
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-white/10 pb-12">
                <div className="space-y-4">
                  <button 
                    onClick={() => setView('menu')}
                    className="flex items-center gap-2 text-zinc-500 hover:text-orange-500 transition-colors text-[10px] font-bold tracking-[0.2em] uppercase"
                  >
                    <ArrowLeft size={14} /> RETURN TO TERMINAL
                  </button>
                  <div>
                    <h2 className="text-7xl font-black tracking-tighter leading-none italic font-serif">
                      SECTOR <span className="text-orange-500">SELECT</span>
                    </h2>
                    <p className="text-zinc-500 text-xs uppercase tracking-[0.5em] mt-4 font-mono">Mission Control // Level Authorization Required</p>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2 font-mono">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-widest">System Status</div>
                  <div className="flex items-center gap-3 bg-zinc-900/50 border border-white/5 px-4 py-2 rounded-full">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
                      <span className="text-xs font-bold text-white">{unlockedLevels}/{levels.length}</span>
                    </div>
                    <div className="w-px h-4 bg-white/10" />
                    <div className="text-[10px] text-zinc-500 uppercase font-bold">Authorized</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-16">
                {/* Main Story Grid */}
                <div className="xl:col-span-8 space-y-8">
                  <div className="flex items-center justify-between">
                    <h3 className="text-zinc-500 uppercase tracking-[0.3em] text-[10px] font-bold flex items-center gap-3">
                      <div className="w-8 h-px bg-orange-500" /> 01 // CORE CAMPAIGN
                    </h3>
                  </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                      {levels.map((level, idx) => {
                        const isUnlocked = level.id <= unlockedLevels;
                        const isCurrent = level.id === unlockedLevels;
                        const isCompleted = level.id < unlockedLevels;

                        return (
                          <motion.div
                            key={level.id}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: idx * 0.03 }}
                            whileHover={isUnlocked ? { 
                              scale: 1.02, 
                              backgroundColor: 'rgba(255,255,255,0.05)',
                              boxShadow: isCurrent ? '0 0 30px rgba(249,115,22,0.2)' : '0 0 20px rgba(255,255,255,0.05)'
                            } : {}}
                            onClick={isUnlocked ? () => handlePlayStory(idx) : undefined}
                            role="button"
                            tabIndex={isUnlocked ? 0 : -1}
                            onKeyDown={(e) => {
                              if (isUnlocked && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault();
                                handlePlayStory(idx);
                              }
                            }}
                            className={`
                              group relative aspect-[4/5] rounded-lg border flex flex-col items-start p-4 transition-all overflow-hidden text-left
                              ${isUnlocked 
                                ? 'border-white/10 bg-zinc-900/20 hover:border-orange-500/50 cursor-pointer' 
                                : 'border-white/5 bg-transparent opacity-20 grayscale cursor-not-allowed'}
                              ${isCurrent ? 'border-orange-500/50 bg-orange-500/5 shadow-[0_0_40px_rgba(249,115,22,0.1)]' : ''}
                            `}
                          >
                            {/* Pulse for current level */}
                            {isCurrent && (
                              <motion.div 
                                className="absolute inset-0 border-2 border-orange-500/30 rounded-lg"
                                animate={{ opacity: [0.2, 0.5, 0.2], scale: [1, 1.02, 1] }}
                                transition={{ duration: 2, repeat: Infinity }}
                              />
                            )}

                            {/* Background Number */}
                            <div className={`absolute -bottom-4 -right-4 text-8xl font-black italic opacity-[0.03] pointer-events-none transition-all group-hover:opacity-[0.08] ${isUnlocked ? 'text-white' : 'text-zinc-500'}`}>
                              {level.id.toString().padStart(2, '0')}
                            </div>

                          <div className="flex justify-between items-start w-full mb-auto">
                            <span className={`text-xs font-mono font-bold ${isUnlocked ? 'text-orange-500' : 'text-zinc-700'}`}>
                              {level.id.toString().padStart(2, '0')}
                            </span>
                            {isCompleted && <Star size={12} className="text-orange-500 fill-orange-500" />}
                            {!isUnlocked && <Lock size={12} className="text-zinc-800" />}
                          </div>

                          <div className="mt-auto space-y-1 text-left">
                            <h4 className={`text-sm font-bold tracking-tight uppercase ${isUnlocked ? 'text-white' : 'text-zinc-700'}`}>
                              {level.name}
                            </h4>
                            <div className="flex items-center gap-2">
                              <div className={`h-1 rounded-full transition-all duration-500 ${isUnlocked ? 'bg-orange-500 w-8' : 'bg-zinc-800 w-4'}`} />
                              <span className="text-[8px] text-zinc-600 uppercase font-bold tracking-widest">
                                {isCompleted ? 'Verified' : isCurrent ? 'Active' : 'Locked'}
                              </span>
                            </div>
                          </div>

                          {isUnlocked && (
                            <div 
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEditLevel(level);
                              }}
                              className="absolute top-4 right-4 p-2 bg-zinc-800/50 rounded-md opacity-0 group-hover:opacity-100 hover:bg-orange-500 transition-all cursor-pointer"
                              title="Override Level"
                            >
                              <Edit3 size={12} />
                            </div>
                          )}
                        </motion.div>
                      );
                    })}
                  </div>
                </div>

                {/* Custom Levels Sidebar */}
                <div className="xl:col-span-4 space-y-8">
                  <div className="flex items-center justify-between">
                    <h3 className="text-zinc-500 uppercase tracking-[0.3em] text-[10px] font-bold flex items-center gap-3">
                      <div className="w-8 h-px bg-cyan-500" /> 02 // USER DATA
                    </h3>
                  </div>

                  <div className="bg-zinc-900/20 border border-white/5 rounded-2xl p-6 space-y-6">
                    <div className="flex flex-col gap-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                      {JSON.parse(localStorage.getItem('custom_levels') || '[]').map((level: Level, idx: number) => (
                        <motion.div 
                          key={level.id}
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          className="group relative bg-zinc-900/40 border border-white/5 p-5 rounded-xl flex items-center justify-between hover:border-cyan-500/50 hover:bg-zinc-900/60 transition-all"
                        >
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono text-cyan-500 font-bold">USR_{idx.toString().padStart(3, '0')}</span>
                              <div className="w-1 h-1 rounded-full bg-zinc-700" />
                              <span className="text-[8px] text-zinc-500 uppercase tracking-widest font-bold">{level.entities.length} OBJECTS</span>
                            </div>
                            <h4 className="font-bold text-base text-white group-hover:text-cyan-400 transition-colors">{level.name}</h4>
                          </div>

                          <div className="flex gap-2">
                            <button 
                              onClick={() => handleEditLevel(level)}
                              className="p-3 bg-zinc-800/50 rounded-xl hover:bg-zinc-700 text-zinc-500 hover:text-white transition-all"
                            >
                              <Edit3 size={18} />
                            </button>
                            <button 
                              onClick={() => handlePlayCustom(level)}
                              className="p-3 bg-cyan-600 text-white rounded-xl hover:bg-cyan-500 transition-all shadow-lg shadow-cyan-900/20"
                            >
                              <Play size={18} fill="currentColor" />
                            </button>
                          </div>
                        </motion.div>
                      ))}

                      {JSON.parse(localStorage.getItem('custom_levels') || '[]').length === 0 && (
                        <div className="py-16 flex flex-col items-center justify-center border-2 border-dashed border-white/5 rounded-2xl bg-black/20">
                          <Layout size={32} className="text-zinc-800 mb-4" />
                          <p className="text-zinc-600 text-xs font-mono uppercase tracking-widest">No custom data detected</p>
                          <button 
                            onClick={() => setView('editor')}
                            className="mt-6 px-6 py-2 bg-zinc-800 text-cyan-500 text-[10px] font-bold rounded-full hover:bg-zinc-700 transition-all uppercase tracking-widest"
                          >
                            Initialize Editor
                          </button>
                        </div>
                      )}
                    </div>

                    <button 
                      onClick={() => {
                        setCustomLevel(null);
                        setView('editor');
                      }}
                      className="w-full py-4 bg-zinc-900 border border-white/10 rounded-xl flex items-center justify-center gap-3 text-xs font-bold hover:bg-zinc-800 hover:border-cyan-500/50 transition-all group"
                    >
                      <Plus size={16} className="text-cyan-500 group-hover:scale-125 transition-transform" />
                      CREATE NEW ARCHIVE
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {view === 'game' && (
          <motion.div 
            key="game"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-screen"
          >
            {console.log(`[App] Rendering Game component. roomId: [${roomId}], isHost: ${isHost}`)}
            <Game 
              customLevel={customLevel} 
              startLevelIndex={startLevelIndex}
              onBack={() => {
                if (cameFromEditor) {
                  setView('editor');
                } else {
                  setView('menu');
                }
              }} 
              onComplete={handleLevelComplete}
              initialGameMode={gameMode}
              initialRoomId={roomId}
              isHost={isHost}
              displayName={profile.displayName}
              photoURL={profile.photoURL}
            />
          </motion.div>
        )}

        {view === 'editor' && (
          <motion.div 
            key="editor"
            initial={{ opacity: 0, x: 100 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -100 }}
            className="h-screen"
          >
            <LevelEditor 
              initialLevel={customLevel}
              onBack={() => setView('level-select')} 
              onPlay={handlePlayCustom}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuBtn({ onClick, icon, label, color }: { onClick: () => void, icon: React.ReactNode, label: string, color: string }) {
  return (
    <button 
      onClick={onClick}
      className={`flex items-center justify-center gap-3 py-4 rounded-xl font-bold transition-all transform hover:scale-105 active:scale-95 ${color}`}
    >
      {icon} {label}
    </button>
  );
}
