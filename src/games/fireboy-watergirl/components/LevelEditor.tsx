import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Entity, Level, Vector } from '../types';
import { getLevels } from '../game/levels';
import { Save, Download, Upload, Trash2, Plus, Play, MousePointer2, Grid, Layers, Square, Circle, Triangle, RefreshCw, Undo2, Redo2, Globe, Lock, Unlock, Eye, EyeOff } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

type Tool = 'select' | 'platform' | 'box' | 'circle' | 'triangle' | 'floor' | 'fire-hazard' | 'water-hazard' | 'acid-hazard' | 'door-fire' | 'door-water' | 'gem-fire' | 'gem-water' | 'trigger' | 'moving-platform' | 'fire-start' | 'water-start' | 'world-tool' | 'cannon';

interface EditorState {
  entities: Entity[];
  fireStart: Vector;
  waterStart: Vector;
  worldSettings: {
    darkMode: boolean;
    lightRadius: number;
    gravityMultiplier?: number;
    speedMultiplier?: number;
    jumpMultiplier?: number;
    windX?: number;
    windY?: number;
    backgroundTheme?: string;
    timeScale?: number;
    bloomIntensity?: number;
    particleDensity?: number;
    screenShake?: number;
    mirrorWorld?: boolean;
    invertColors?: boolean;
    pixelate?: number;
    chaosMode?: boolean;
  };
}

export default function LevelEditor({ onBack, onPlay, initialLevel }: { onBack: () => void, onPlay: (level: Level, fromEditor?: boolean) => void, initialLevel?: Level | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [entities, setEntities] = useState<Entity[]>(initialLevel?.entities || []);
  const [fireStart, setFireStart] = useState<Vector>(initialLevel?.fireStart || { x: 50, y: 500 });
  const [waterStart, setWaterStart] = useState<Vector>(initialLevel?.waterStart || { x: 100, y: 500 });
  const [worldSettings, setWorldSettings] = useState(initialLevel?.worldSettings || { 
    darkMode: false, 
    lightRadius: 150,
    gravityMultiplier: 1,
    speedMultiplier: 1,
    jumpMultiplier: 1,
    windX: 0,
    windY: 0,
    backgroundTheme: 'default',
    timeScale: 1,
    bloomIntensity: 0,
    particleDensity: 1,
    screenShake: 0,
    mirrorWorld: false,
    invertColors: false,
    pixelate: 0,
    chaosMode: false
  });
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([]);
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [levelName, setLevelName] = useState(initialLevel?.name || 'Custom Level');
  const [levelId, setLevelId] = useState<number | null>(initialLevel?.id || null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [gridSize, setGridSize] = useState(20);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isDraggingTarget, setIsDraggingTarget] = useState(false);
  const [targetDragEntityId, setTargetDragEntityId] = useState<string | null>(null);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<Vector>({ x: 0, y: 0 });
  const [rotationStartAngle, setRotationStartAngle] = useState(0);
  const [editorMode, setEditorMode] = useState<'select' | 'edit'>(initialLevel ? 'edit' : 'select');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' | 'info' } | null>(null);
  const [isSelectingTarget, setIsSelectingTarget] = useState(false);
  const [isPreview, setIsPreview] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{ start: Vector, end: Vector } | null>(null);
  const [clipboard, setClipboard] = useState<Entity[]>([]);

  const [history, setHistory] = useState<EditorState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const levels = useMemo(() => getLevels(), []);

  const pushHistory = (newEntities: Entity[], newFireStart: Vector, newWaterStart: Vector, newWorldSettings: typeof worldSettings) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push({
      entities: JSON.parse(JSON.stringify(newEntities)),
      fireStart: { ...newFireStart },
      waterStart: { ...newWaterStart },
      worldSettings: { ...newWorldSettings }
    });
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const updateEntities = (newEntities: Entity[]) => {
    setEntities(newEntities);
    pushHistory(newEntities, fireStart, waterStart, worldSettings);
  };

  const undo = () => {
    if (historyIndex > 0) {
      const prevState = history[historyIndex - 1];
      setEntities(JSON.parse(JSON.stringify(prevState.entities)));
      setFireStart({ ...prevState.fireStart });
      setWaterStart({ ...prevState.waterStart });
      setWorldSettings({ ...prevState.worldSettings });
      setHistoryIndex(historyIndex - 1);
      setSelectedEntityIds([]);
    }
  };

  const redo = () => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1];
      setEntities(JSON.parse(JSON.stringify(nextState.entities)));
      setFireStart({ ...nextState.fireStart });
      setWaterStart({ ...nextState.waterStart });
      setWorldSettings({ ...nextState.worldSettings });
      setHistoryIndex(historyIndex + 1);
      setSelectedEntityIds([]);
    }
  };

  const startEditing = (newEntities: Entity[], newFireStart: Vector, newWaterStart: Vector, newWorldSettings: typeof worldSettings, name: string, id: number | null) => {
    setEntities(newEntities);
    setFireStart(newFireStart);
    setWaterStart(newWaterStart);
    setWorldSettings(newWorldSettings || { 
      darkMode: false, 
      lightRadius: 150,
      gravityMultiplier: 1,
      speedMultiplier: 1,
      jumpMultiplier: 1,
      windX: 0,
      windY: 0,
      backgroundTheme: 'default'
    });
    setLevelName(name);
    setLevelId(id);
    setEditorMode('edit');
    
    const initialState = {
      entities: JSON.parse(JSON.stringify(newEntities)),
      fireStart: { ...newFireStart },
      waterStart: { ...newWaterStart },
      worldSettings: { ...(newWorldSettings || { darkMode: false, lightRadius: 150 }) }
    };
    setHistory([initialState]);
    setHistoryIndex(0);
  };

  useEffect(() => {
    if (initialLevel) {
      startEditing(initialLevel.entities, initialLevel.fireStart, initialLevel.waterStart, initialLevel.worldSettings || { darkMode: false, lightRadius: 150 }, initialLevel.name, initialLevel.id);
    }
  }, [initialLevel]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') {
           e.preventDefault();
           if (e.shiftKey) redo();
           else undo();
        } else if (e.key === 'y') {
           e.preventDefault();
           redo();
        } else if (e.key === 'c') {
           if (selectedEntityIds.length > 0) {
             const toCopy = entities.filter(en => selectedEntityIds.includes(en.id));
             setClipboard(JSON.parse(JSON.stringify(toCopy)));
           }
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEntityIds.length > 0) {
          const newEntities = entities.filter(en => !selectedEntityIds.includes(en.id));
          updateEntities(newEntities);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEntityIds, entities]);

  const snap = (val: number) => snapToGrid ? Math.round(val / gridSize) * gridSize : val;
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const time = Date.now();
      const timeSec = time / 1000;
      ctx.save();
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      
      if (isPreview) {
        const theme = worldSettings.backgroundTheme || 'default';
        ctx.fillStyle = theme === 'default' ? '#0b1a3f' : '#050510';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      } else {
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        if (snapToGrid) {
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            for (let i = 0; i <= CANVAS_WIDTH; i += gridSize) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_HEIGHT); ctx.stroke(); }
            for (let i = 0; i <= CANVAS_HEIGHT; i += gridSize) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_WIDTH, i); ctx.stroke(); }
        }
      }

      entities.forEach(entity => {
        const isSelected = selectedEntityIds.includes(entity.id);
        ctx.save();
        ctx.translate(entity.x + entity.width/2, entity.y + entity.height/2);
        if (entity.rotation) ctx.rotate((entity.rotation * Math.PI)/180);
        ctx.translate(-(entity.x + entity.width/2), -(entity.y + entity.height/2));

        if (isSelected && !isPreview) { ctx.shadowBlur = 10; ctx.shadowColor = '#00ccff'; ctx.strokeStyle = '#00ccff'; ctx.lineWidth = 2; ctx.strokeRect(entity.x, entity.y, entity.width, entity.height); }

        if (entity.type === 'platform') { ctx.fillStyle = '#333'; ctx.fillRect(entity.x, entity.y, entity.width, entity.height); }
        else if (entity.type === 'hazard') { ctx.fillStyle = entity.hazardType === 'fire' ? '#ff4400' : '#00ccff'; ctx.fillRect(entity.x, entity.y, entity.width, entity.height); }
        else if (entity.type === 'gem') { ctx.fillStyle = entity.color || '#fff'; ctx.beginPath(); ctx.moveTo(entity.x + entity.width/2, entity.y); ctx.lineTo(entity.x + entity.width, entity.y + entity.height/2); ctx.lineTo(entity.x + entity.width/2, entity.y + entity.height); ctx.lineTo(entity.x, entity.y + entity.height/2); ctx.fill(); }
        
        ctx.restore();
      });

      // Character Starts
      ctx.fillStyle = '#ff4400'; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(fireStart.x + 15, fireStart.y + 20, 10, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#00ccff'; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(waterStart.x + 15, waterStart.y + 20, 10, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.restore();
      requestAnimationFrame(render);
    };
    render();
  }, [entities, selectedEntityIds, isPreview, fireStart, waterStart, worldSettings, snapToGrid, gridSize]);

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = snap(e.clientX - rect.left);
    const y = snap(e.clientY - rect.top);
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;

    if (activeTool === 'select') {
      let clicked = entities.find(en => 
        !en.locked && rawX >= en.x && rawX <= en.x + en.width && rawY >= en.y && rawY <= en.y + en.height
      );

      if (!clicked) clicked = entities.find(en => rawX >= en.x && rawX <= en.x + en.width && rawY >= en.y && rawY <= en.y + en.height);

      if (isSelectingTarget && selectedEntityIds.length === 1 && clicked && clicked.id !== selectedEntityIds[0]) {
        const newEntities = entities.map(en => en.id === selectedEntityIds[0] ? { ...en, targetId: clicked.id } : en);
        updateEntities(newEntities);
        setIsSelectingTarget(false);
        showToast('Target linked!', 'success');
        return;
      }

      if (selectedEntityIds.length === 1) {
        const selected = entities.find(en => en.id === selectedEntityIds[0]);
        if (selected) {
          const handleSize = 10;
          if (rawX >= selected.x + selected.width - handleSize && rawY >= selected.y + selected.height - handleSize) {
              setIsResizing(true);
              setResizeHandle('br');
              return;
          }
          const rotateHandleX = selected.x + selected.width/2;
          const rotateHandleY = selected.y - 20;
          if (rawX >= rotateHandleX - handleSize && rawX <= rotateHandleX + handleSize && rawY >= rotateHandleY - handleSize && rawY <= rotateHandleY + handleSize) {
            setIsRotating(true);
            const centerX = selected.x + selected.width/2;
            const centerY = selected.y + selected.height/2;
            setRotationStartAngle(Math.atan2(rawY - centerY, rawX - centerX) - (selected.rotation || 0) * Math.PI / 180);
            return;
          }
        }
      }

      if (clicked) {
        if (e.shiftKey) {
          setSelectedEntityIds(prev => prev.includes(clicked!.id) ? prev.filter(id => id !== clicked!.id) : [...prev, clicked!.id]);
        } else {
          if (!selectedEntityIds.includes(clicked.id)) setSelectedEntityIds([clicked.id]);
          setIsDragging(true);
          setDragOffset({ x: rawX, y: rawY });
        }
      } else {
        if (!e.shiftKey) setSelectedEntityIds([]);
        setSelectionBox({ start: { x: rawX, y: rawY }, end: { x: rawX, y: rawY } });
      }
    } else {
      const newEntity: Entity = {
        id: Math.random().toString(36).substr(2, 9),
        x, y, width: 40, height: 40, type: 'platform', shape: 'rect', active: false
      };
      if (activeTool.includes('hazard')) { newEntity.type = 'hazard'; newEntity.hazardType = activeTool.split('-')[0] as any; }
      else if (activeTool.includes('gem')) { newEntity.type = 'gem'; newEntity.color = activeTool.includes('fire') ? '#ff4400' : '#00ccff'; }
      updateEntities([...entities, newEntity]);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    const x = snap(rawX);
    const y = snap(rawY);

    if (selectionBox) { setSelectionBox({ ...selectionBox, end: { x: rawX, y: rawY } }); return; }
    if (isDragging) {
        const dx = rawX - dragOffset.x;
        const dy = rawY - dragOffset.y;
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
            const snappedDx = snap(dx); const snappedDy = snap(dy);
            if (snappedDx !== 0 || snappedDy !== 0) {
                setEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, x: en.x + snappedDx, y: en.y + snappedDy } : en));
                setDragOffset({ x: dragOffset.x + snappedDx, y: dragOffset.y + snappedDy });
            }
        }
    }
  };

  const handleMouseUp = () => {
    if (selectionBox) { /* Selection Logic Here */ setSelectionBox(null); }
    setIsDragging(false); setIsResizing(false); setIsRotating(false);
  };

  const saveToLocal = () => {
    const level: Level = { id: levelId || Date.now(), name: levelName, fireStart, waterStart, entities, worldSettings };
    if (levelId && levelId <= 15) {
      const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{}');
      overrides[levelId] = level;
      localStorage.setItem('main_level_overrides', JSON.stringify(overrides));
    } else {
      const saved = JSON.parse(localStorage.getItem('custom_levels') || '[]');
      const idx = saved.findIndex((l: Level) => l.id === level.id);
      if (idx >= 0) saved[idx] = level; else saved.push(level);
      localStorage.setItem('custom_levels', JSON.stringify(saved));
    }
    showToast('State recorded to local archive', 'success');
  };

  if (editorMode === 'select') {
    const customLevels = JSON.parse(localStorage.getItem('custom_levels') || '[]');
    const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{}');

    return (
      <div className="flex flex-col h-screen bg-[#050505] text-white font-mono overflow-hidden">
        <div className="p-8 border-b border-white/5 flex justify-between items-center bg-black/40 backdrop-blur-md">
          <h2 className="text-2xl font-black italic">LEVEL <span className="text-cyan-500">TERMINAL</span></h2>
          <div className="flex gap-4">
            <button onClick={() => setEditorMode('edit')} className="px-6 py-2 bg-cyan-600 rounded-lg font-bold hover:bg-cyan-500">NEW_ARCHIVE</button>
            <button onClick={onBack} className="px-6 py-2 bg-zinc-900 border border-white/10 rounded-lg hover:bg-zinc-800">DISCONNECT</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 custom-scrollbar">
           {levels.map(lvl => (
             <motion.div key={lvl.id} onClick={() => startEditing(lvl.entities, lvl.fireStart, lvl.waterStart, lvl.worldSettings || { darkMode: false, lightRadius: 150 }, lvl.name, lvl.id)} className="p-6 bg-zinc-900/40 border border-white/5 rounded-2xl hover:border-cyan-500 transition-all cursor-pointer">
                <div className="flex justify-between items-center mb-4">
                  <span className="text-[10px] text-zinc-500 font-black tracking-widest uppercase">Sector {lvl.id}</span>
                  {overrides[lvl.id] && <span className="px-2 py-0.5 bg-orange-500/10 text-orange-500 border border-orange-500/20 text-[8px] font-bold rounded">OVERRIDDEN</span>}
                </div>
                <h3 className="text-lg font-black italic mb-2 uppercase tracking-tighter">{lvl.name}</h3>
                <p className="text-zinc-600 text-[10px] uppercase font-bold tracking-widest">{lvl.entities.length} Modules Registered</p>
             </motion.div>
           ))}
        </div>
      </div>
    );
  }

  const selectedEntities = entities.filter(e => selectedEntityIds.includes(e.id));
  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null;

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white font-mono overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-zinc-900 border-b border-white/5">
        <div className="flex items-center gap-4">
          <button onClick={() => setEditorMode('select')} className="text-zinc-500 hover:text-white transition-colors">← CLOSE</button>
          <div className="flex flex-col">
            <input 
              value={levelName} 
              onChange={e => setLevelName(e.target.value)}
              className="bg-transparent border-b border-zinc-700 focus:border-cyan-500 outline-none px-2 py-1 font-bold text-lg"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={undo} disabled={historyIndex <= 0} className="p-2 bg-zinc-800 rounded-lg hover:bg-zinc-700"><Undo2 size={20} /></button>
          <button onClick={redo} disabled={historyIndex >= history.length - 1} className="p-2 bg-zinc-800 rounded-lg hover:bg-zinc-700"><Redo2 size={20} /></button>
          <button onClick={saveToLocal} className="px-4 py-2 bg-zinc-800 rounded-lg flex items-center gap-2"><Save size={18} /> SAVE</button>
          <button onClick={() => setIsPreview(!isPreview)} className={`px-4 py-2 rounded-lg font-bold ${isPreview ? 'bg-orange-500/20 text-orange-500 border border-orange-500' : 'bg-zinc-800'}`}>
            {isPreview ? <EyeOff size={18} /> : <Eye size={18} />} {isPreview ? 'EDITOR' : 'PREVIEW'}
          </button>
          <button onClick={() => onPlay({ id: levelId || 0, name: levelName, fireStart, waterStart, entities, worldSettings }, true)} className="px-6 py-2 bg-cyan-600 rounded-lg font-bold hover:bg-cyan-500">PLAY TEST</button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-64 bg-zinc-900 border-r border-white/5 flex flex-col p-4 gap-6">
          <section>
            <h3 className="text-xs text-zinc-500 uppercase tracking-widest mb-4">Tools</h3>
            <div className="grid grid-cols-4 gap-2">
              <ToolBtn active={activeTool === 'select'} onClick={() => setActiveTool('select')} icon={<MousePointer2 size={12} />} label="Select" />
              <ToolBtn active={activeTool === 'platform'} onClick={() => setActiveTool('platform')} icon={<Layers size={12} />} label="Plat" />
              <ToolBtn active={activeTool === 'hazard'} onClick={() => setActiveTool('hazard')} icon={<span className="text-orange-500 text-[10px]">🔥</span>} label="Haz" />
              <ToolBtn active={activeTool === 'gem'} onClick={() => setActiveTool('gem')} icon={<Gem size={12} className="text-cyan-500" />} label="Gem" />
            </div>
          </section>

          {selectedEntity && (
            <section className="flex-1 overflow-y-auto">
              <h3 className="text-xs text-zinc-500 uppercase tracking-widest mb-4">Properties</h3>
              <div className="space-y-4">
                 <div className="flex justify-between items-center text-xs">
                    <span>Width</span>
                    <input type="number" value={selectedEntity.width} onChange={e => {
                        const val = parseInt(e.target.value);
                        updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, width: val } : en));
                    }} className="w-20 bg-zinc-800 border border-white/5 rounded px-2 py-1 outline-none focus:border-cyan-500" />
                 </div>
                 <div className="flex justify-between items-center text-xs">
                    <span>Height</span>
                    <input type="number" value={selectedEntity.height} onChange={e => {
                        const val = parseInt(e.target.value);
                        updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, height: val } : en));
                    }} className="w-20 bg-zinc-800 border border-white/5 rounded px-2 py-1 outline-none focus:border-cyan-500" />
                 </div>
                 <button onClick={() => {
                    updateEntities(entities.filter(en => en.id !== selectedEntity.id));
                    setSelectedEntityIds([]);
                 }} className="w-full py-2 bg-red-900/20 text-red-500 border border-red-500/20 rounded-lg text-[10px] font-bold mt-4">DELETE MODULE</button>
              </div>
            </section>
          )}

          <section className="border-t border-white/5 pt-4">
             <div className="flex justify-between items-center mb-4">
                <span className="text-[10px] text-zinc-500 font-bold">GRID SNAPPING</span>
                <button onClick={() => setSnapToGrid(!snapToGrid)} className={`w-10 h-5 rounded-full relative transition-colors ${snapToGrid ? 'bg-cyan-500' : 'bg-zinc-800'}`}>
                   <div className={`absolute top-1 left-1 w-3 h-3 rounded-full bg-white transition-transform ${snapToGrid ? 'translate-x-5' : ''}`} />
                </button>
             </div>
             <div className="flex justify-between items-center">
                <span className="text-[10px] text-zinc-500 font-bold">DARK MODE</span>
                <button onClick={() => setWorldSettings({ ...worldSettings, darkMode: !worldSettings.darkMode })} className={`w-10 h-5 rounded-full relative transition-colors ${worldSettings.darkMode ? 'bg-orange-500' : 'bg-zinc-800'}`}>
                   <div className={`absolute top-1 left-1 w-3 h-3 rounded-full bg-white transition-transform ${worldSettings.darkMode ? 'translate-x-5' : ''}`} />
                </button>
             </div>
          </section>
        </div>

        {/* Viewport */}
        <div className="flex-1 bg-black flex items-center justify-center p-8 overflow-hidden">
          <div className="relative shadow-[0_0_100px_rgba(0,0,0,0.5)] border border-white/5 bg-zinc-950">
            <canvas 
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              className="cursor-crosshair block"
            />
            {isSelectingTarget && (
                <div className="absolute inset-0 bg-cyan-500/10 pointer-events-none flex items-center justify-center border-2 border-cyan-500 animate-pulse">
                    <span className="text-cyan-500 font-black text-2xl drop-shadow-2xl">SELECT TARGET MODULE</span>
                </div>
            )}
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }} className={`fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full font-bold shadow-2xl z-50 flex items-center gap-3 bg-zinc-900 border border-white/10 ${toast.type === 'success' ? 'text-green-500' : 'text-cyan-500'}`}>
            <div className={`w-2 h-2 rounded-full ${toast.type === 'success' ? 'bg-green-500' : 'bg-cyan-500'} animate-ping`} />
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToolBtn({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center justify-center p-2 rounded-xl border transition-all ${
        active ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-zinc-800 border-transparent hover:border-white/5'
      }`}
    >
      <div className="mb-1">{icon}</div>
      <span className="text-[10px] font-bold uppercase tracking-tighter">{label}</span>
    </button>
  );
}

