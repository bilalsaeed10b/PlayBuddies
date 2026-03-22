import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Entity, Level, Vector } from '../../types';
import { getLevels } from '../../game/levels';
import { Save, Download, Upload, Trash2, Plus, Play, MousePointer2, Grid, Layers, Square, Circle, Triangle, RefreshCw, Undo2, Redo2, Globe, Lock, Unlock, Eye, EyeOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

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
    backgroundTheme?: 'default' | 'neon' | 'void' | 'matrix';
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

  // Update state if initialLevel changes
  useEffect(() => {
    if (initialLevel) {
      startEditing(initialLevel.entities, initialLevel.fireStart, initialLevel.waterStart, initialLevel.worldSettings || { darkMode: false, lightRadius: 150 }, initialLevel.name, initialLevel.id);
    }
  }, [initialLevel]);

  // Keyboard shortcuts
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
            showToast(`Copied ${selectedEntityIds.length} entities`, 'info');
          }
        } else if (e.key === 'v') {
          if (clipboard.length > 0) {
            const newEntities = [...entities];
            const newIds: string[] = [];
            clipboard.forEach(en => {
              const newEn = { 
                ...en, 
                id: Math.random().toString(36).substr(2, 9),
                x: en.x + gridSize,
                y: en.y + gridSize
              };
              newEntities.push(newEn);
              newIds.push(newEn.id);
            });
            updateEntities(newEntities);
            setSelectedEntityIds(newIds);
            showToast(`Pasted ${clipboard.length} entities`, 'success');
          }
        } else if (e.key === 'a') {
          e.preventDefault();
          setSelectedEntityIds(entities.map(en => en.id));
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEntityIds.length > 0) {
          const newEntities = entities.filter(en => !selectedEntityIds.includes(en.id) || en.locked);
          updateEntities(newEntities);
          setSelectedEntityIds(selectedEntityIds.filter(id => entities.find(e => e.id === id)?.locked));
        }
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (selectedEntityIds.length > 0) {
          e.preventDefault();
          const step = e.shiftKey ? gridSize : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          
          const newEntities = entities.map(en => {
            if (selectedEntityIds.includes(en.id) && !en.locked) {
              return { ...en, x: en.x + dx, y: en.y + dy };
            }
            return en;
          });
          setEntities(newEntities);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (selectedEntityIds.length > 0) {
          pushHistory(entities, fireStart, waterStart, worldSettings);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [history, historyIndex, selectedEntityIds, entities, fireStart, waterStart, clipboard]);

  // Snap to grid helper
  const snap = (val: number) => snapToGrid ? Math.round(val / gridSize) * gridSize : val;

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const time = Date.now();
      const timeSec = time / 1000;
      
      ctx.save();
      
      // Screen Shake in Preview
      if (isPreview && worldSettings.chaosMode) {
        const shake = worldSettings.screenShake || 5;
        ctx.translate(Math.random() * shake - shake/2, Math.random() * shake - shake/2);
      }

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Mirror World in Preview
      if (isPreview && worldSettings.mirrorWorld) {
        ctx.translate(CANVAS_WIDTH, 0);
        ctx.scale(-1, 1);
      }
      
      if (isPreview) {
        // Draw Background Theme
        const theme = worldSettings.backgroundTheme || 'default';
        
        if (theme === 'default') {
          const bgGradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
          bgGradient.addColorStop(0, '#2b0b3f'); // Purple
          bgGradient.addColorStop(1, '#0b1a3f'); // Blue
          ctx.fillStyle = bgGradient;
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          // Stars
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
        } else if (theme === 'neon') {
          ctx.fillStyle = '#050510';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          ctx.strokeStyle = '#ff00ff22';
          ctx.lineWidth = 1;
          for (let i = 0; i < CANVAS_WIDTH; i += 40) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_HEIGHT); ctx.stroke();
          }
          for (let i = 0; i < CANVAS_HEIGHT; i += 40) {
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_WIDTH, i); ctx.stroke();
          }
        } else if (theme === 'void') {
          const grad = ctx.createRadialGradient(CANVAS_WIDTH/2, CANVAS_HEIGHT/2, 0, CANVAS_WIDTH/2, CANVAS_HEIGHT/2, CANVAS_WIDTH);
          grad.addColorStop(0, '#1a0033');
          grad.addColorStop(1, '#000000');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        } else if (theme === 'matrix') {
          ctx.fillStyle = '#000800';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          ctx.fillStyle = '#00ff0011';
          ctx.font = '10px monospace';
          for (let i = 0; i < 20; i++) {
            const x = (i * 40) % CANVAS_WIDTH;
            const y = (timeSec * 100 + i * 50) % CANVAS_HEIGHT;
            ctx.fillText('10101010', x, y);
          }
        } else if (theme === 'cyberpunk') {
          ctx.fillStyle = '#120458';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          ctx.fillStyle = '#ff00c122';
          ctx.fillRect(0, CANVAS_HEIGHT * 0.7, CANVAS_WIDTH, CANVAS_HEIGHT * 0.3);
          ctx.strokeStyle = '#00fff944';
          for (let i = 0; i < 5; i++) {
            ctx.beginPath();
            ctx.moveTo(0, CANVAS_HEIGHT * 0.6 + i * 20);
            ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT * 0.6 + i * 20);
            ctx.stroke();
          }
        } else if (theme === 'sunset') {
          const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
          grad.addColorStop(0, '#ff5f6d');
          grad.addColorStop(1, '#ffc371');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        } else if (theme === 'nebula') {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          for (let i = 0; i < 3; i++) {
            const x = (Math.sin(i + timeSec * 0.1) * 0.5 + 0.5) * CANVAS_WIDTH;
            const y = (Math.cos(i + timeSec * 0.1) * 0.5 + 0.5) * CANVAS_HEIGHT;
            const grad = ctx.createRadialGradient(x, y, 0, x, y, 300);
            const colors = ['rgba(255, 0, 255, 0.1)', 'rgba(0, 255, 255, 0.1)', 'rgba(0, 0, 255, 0.1)'];
            grad.addColorStop(0, colors[i]);
            grad.addColorStop(1, 'transparent');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          }
        } else if (theme === 'glitch') {
          ctx.fillStyle = '#111';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          if (Math.random() > 0.9) {
            ctx.fillStyle = Math.random() > 0.5 ? '#ff000022' : '#00ffff22';
            ctx.fillRect(Math.random() * CANVAS_WIDTH, 0, Math.random() * 50, CANVAS_HEIGHT);
          }
        } else if (theme === 'underwater') {
          ctx.fillStyle = '#003366';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          // Light rays
          ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
          for (let i = 0; i < 5; i++) {
            const angle = Math.sin(timeSec * 0.5 + i) * 0.2;
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
          ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
          for (let i = 0; i < 10; i++) {
            const x = (Math.sin(i + timeSec * 0.5) * 0.5 + 0.5) * CANVAS_WIDTH;
            const y = (CANVAS_HEIGHT - (timeSec * 50 + i * 100) % CANVAS_HEIGHT);
            ctx.beginPath(); ctx.arc(x, y, 2 + Math.random() * 5, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else {
        // Background
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        // Grid
        if (snapToGrid) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
          ctx.lineWidth = 1;
          for (let i = 0; i <= CANVAS_WIDTH; i += gridSize) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_HEIGHT); ctx.stroke();
          }
          for (let i = 0; i <= CANVAS_HEIGHT; i += gridSize) {
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_WIDTH, i); ctx.stroke();
          }
        }
      }

      // Draw Entities
      entities.forEach(entity => {
        const isSelected = selectedEntityIds.includes(entity.id);
        const time = Date.now();
        ctx.save();
        
        // Apply rotation
        ctx.translate(entity.x + entity.width / 2, entity.y + entity.height / 2);
        if (entity.rotation) {
          ctx.rotate((entity.rotation * Math.PI) / 180);
        }
        ctx.translate(-(entity.x + entity.width / 2), -(entity.y + entity.height / 2));

        if (entity.hidden && !isPreview) ctx.globalAlpha = 0.3;
        if (entity.hidden && isPreview) return; // Don't draw hidden entities in preview
        
        ctx.shadowBlur = (isSelected && !isPreview) ? 20 : 0;
        ctx.shadowColor = (isSelected && !isPreview) ? '#00ccff' : 'transparent';
        
        const drawShape = () => {
          const shape = entity.shape || 'rect';
          if (shape === 'circle') {
            ctx.beginPath();
            ctx.arc(entity.x + entity.width / 2, entity.y + entity.height / 2, Math.min(entity.width, entity.height) / 2, 0, Math.PI * 2);
            ctx.fill();
          } else if (shape === 'triangle') {
            ctx.beginPath();
            ctx.moveTo(entity.x + entity.width / 2, entity.y);
            ctx.lineTo(entity.x + entity.width, entity.y + entity.height);
            ctx.lineTo(entity.x, entity.y + entity.height);
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.fillRect(entity.x, entity.y, entity.width, entity.height);
          }
        };

        if (entity.type === 'platform') {
          ctx.fillStyle = isPreview ? '#222' : '#333';
          if (isPreview) {
            ctx.shadowColor = '#000';
            ctx.shadowBlur = 5;
          }
          drawShape();
          if (isPreview && (!entity.shape || entity.shape === 'rect')) {
            ctx.fillStyle = '#444';
            ctx.fillRect(entity.x, entity.y, entity.width, 4);
          }
        } else if (entity.type === 'box') {
          ctx.fillStyle = '#8B4513';
          if (isPreview) {
            ctx.shadowColor = '#000';
            ctx.shadowBlur = 10;
          }
          drawShape();
          ctx.strokeStyle = '#5C2E0B';
          ctx.lineWidth = 2;
          ctx.strokeRect(entity.x + 2, entity.y + 2, entity.width - 4, entity.height - 4);
          ctx.beginPath();
          ctx.moveTo(entity.x + 2, entity.y + 2);
          ctx.lineTo(entity.x + entity.width - 2, entity.y + entity.height - 2);
          ctx.moveTo(entity.x + entity.width - 2, entity.y + 2);
          ctx.lineTo(entity.x + 2, entity.y + entity.height - 2);
          ctx.stroke();
        } else if (entity.type === 'moving-platform') {
          ctx.fillStyle = isPreview ? '#2a2a35' : '#444';
          if (isPreview) {
            ctx.shadowColor = '#00ccff';
            ctx.shadowBlur = 10;
          }
          drawShape();
          if (!isPreview) {
            ctx.strokeStyle = '#00ccff';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(entity.x, entity.y, entity.width, entity.height);
            ctx.setLineDash([]);
          }
        } else if (entity.type === 'hazard') {
          if (entity.hazardType === 'fire') {
            ctx.fillStyle = '#ff4400';
            if (isPreview) {
              ctx.shadowColor = '#ff4400';
              ctx.shadowBlur = 15;
            }
            drawShape();
            if (isPreview) {
              ctx.fillStyle = '#ffcc00';
              for (let i = 0; i < entity.width; i += 10) {
                ctx.beginPath();
                ctx.moveTo(entity.x + i, entity.y + entity.height);
                const flameHeight = 15 + Math.sin(time * 0.01 + i) * 5;
                ctx.lineTo(entity.x + i + 5, entity.y + entity.height - flameHeight);
                ctx.lineTo(entity.x + i + 10, entity.y + entity.height);
                ctx.fill();
              }
            }
          } else if (entity.hazardType === 'water') {
            ctx.fillStyle = isPreview ? 'rgba(0, 150, 255, 0.7)' : '#00ccff';
            if (isPreview) {
              ctx.shadowColor = '#00ccff';
              ctx.shadowBlur = 15;
            }
            drawShape();
            if (isPreview) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
              ctx.beginPath();
              for (let i = 0; i <= entity.width; i += 10) {
                const waveY = Math.sin(time * 0.005 + i * 0.1) * 3;
                if (i === 0) ctx.moveTo(entity.x + i, entity.y + waveY);
                else ctx.lineTo(entity.x + i, entity.y + waveY);
              }
              ctx.lineTo(entity.x + entity.width, entity.y + 5);
              ctx.lineTo(entity.x, entity.y + 5);
              ctx.fill();
            }
          } else {
            ctx.fillStyle = isPreview ? 'rgba(0, 255, 50, 0.7)' : '#00ff00';
            if (isPreview) {
              ctx.shadowColor = '#00ff00';
              ctx.shadowBlur = 15;
            }
            drawShape();
            if (isPreview) {
              ctx.fillStyle = 'rgba(200, 255, 200, 0.4)';
              ctx.beginPath();
              for (let i = 0; i <= entity.width; i += 10) {
                const waveY = Math.sin(time * 0.003 + i * 0.15) * 2;
                if (i === 0) ctx.moveTo(entity.x + i, entity.y + waveY);
                else ctx.lineTo(entity.x + i, entity.y + waveY);
              }
              ctx.lineTo(entity.x + entity.width, entity.y + 3);
              ctx.lineTo(entity.x, entity.y + 3);
              ctx.fill();
            }
          }
        } else if (entity.type === 'door') {
          const doorColor = entity.color || '#fff';
          ctx.strokeStyle = doorColor;
          if (isPreview) {
            ctx.shadowColor = doorColor;
            ctx.shadowBlur = 20;
          }
          ctx.lineWidth = 3;
          ctx.strokeRect(entity.x, entity.y, entity.width, entity.height);
          ctx.fillStyle = doorColor;
          ctx.globalAlpha = 0.2;
          ctx.fillRect(entity.x, entity.y, entity.width, entity.height);
          ctx.globalAlpha = 1;
          if (isPreview) {
            ctx.lineWidth = 1;
            ctx.beginPath();
            for(let i = 10; i < entity.width; i += 10) {
               ctx.moveTo(entity.x + i, entity.y);
               ctx.lineTo(entity.x + i, entity.y + entity.height);
            }
            for(let i = 10; i < entity.height; i += 10) {
               ctx.moveTo(entity.x, entity.y + i);
               ctx.lineTo(entity.x + entity.width, entity.y + i);
            }
            ctx.stroke();
          }
        } else if (entity.type === 'gem') {
          const gemColor = entity.color || '#fff';
          ctx.fillStyle = gemColor;
          if (isPreview) {
            ctx.shadowColor = gemColor;
            ctx.shadowBlur = 15;
          }
          ctx.beginPath();
          ctx.moveTo(entity.x + entity.width/2, entity.y);
          ctx.lineTo(entity.x + entity.width, entity.y + entity.height/2);
          ctx.lineTo(entity.x + entity.width/2, entity.y + entity.height);
          ctx.lineTo(entity.x, entity.y + entity.height/2);
          ctx.fill();
        } else if (entity.type === 'lever' || entity.type === 'pressure-plate') {
          if (isPreview) {
            if (entity.type === 'lever') {
              ctx.fillStyle = '#222';
              ctx.fillRect(entity.x, entity.y + entity.height - 10, entity.width, 10);
              ctx.strokeStyle = '#ff0000';
              ctx.shadowColor = '#ff0000';
              ctx.shadowBlur = 10;
              ctx.lineWidth = 4;
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(entity.x + entity.width / 2, entity.y + entity.height - 10);
              ctx.lineTo(entity.x + 8, entity.y + 5);
              ctx.stroke();
              ctx.fillStyle = '#ff0000';
              ctx.beginPath();
              ctx.arc(entity.x + 8, entity.y + 5, 4, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.fillStyle = '#222';
              ctx.fillRect(entity.x, entity.y + entity.height - 5, entity.width, 5);
              ctx.fillStyle = '#ff0000';
              ctx.shadowColor = '#ff0000';
              ctx.shadowBlur = 10;
              ctx.fillRect(entity.x + 4, entity.y + entity.height - 11, entity.width - 8, 6);
            }
          } else {
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(entity.x, entity.y, entity.width, entity.height);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.strokeRect(entity.x, entity.y, entity.width, entity.height);
          }
        } else if (entity.type === 'cannon') {
          ctx.fillStyle = '#333';
          ctx.beginPath();
          ctx.arc(entity.x + entity.width/2, entity.y + entity.height/2, entity.width/2, 0, Math.PI * 2);
          ctx.fill();
          
          // Draw barrel
          ctx.save();
          ctx.translate(entity.x + entity.width/2, entity.y + entity.height/2);
          // No second rotation here, it's already rotated at the entity level
          ctx.fillStyle = entity.cannonType === 'laser' ? '#ff0044' : '#ff8800';
          ctx.fillRect(0, -6, entity.width/2 + 10, 12);
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 1;
          ctx.strokeRect(0, -6, entity.width/2 + 10, 12);
          ctx.restore();
        }

        if (isSelected && !isPreview) {
          ctx.strokeStyle = '#00ccff';
          ctx.lineWidth = 2;
          ctx.strokeRect(entity.x - 2, entity.y - 2, entity.width + 4, entity.height + 4);
          
          if (entity.locked) {
            ctx.fillStyle = '#ff4400';
            ctx.font = '10px Arial';
            ctx.fillText('🔒', entity.x + 2, entity.y + 12);
          }
          
          // Draw resize handles (only if single selection for clarity, or for all)
          if (selectedEntityIds.length === 1) {
            ctx.fillStyle = '#fff';
            const handleSize = 6;
            // TL
            ctx.fillRect(entity.x - handleSize/2, entity.y - handleSize/2, handleSize, handleSize);
            // TR
            ctx.fillRect(entity.x + entity.width - handleSize/2, entity.y - handleSize/2, handleSize, handleSize);
            // BL
            ctx.fillRect(entity.x - handleSize/2, entity.y + entity.height - handleSize/2, handleSize, handleSize);
            // BR
            ctx.fillRect(entity.x + entity.width - handleSize/2, entity.y + entity.height - handleSize/2, handleSize, handleSize);
            
            // Rotation handle
            ctx.fillStyle = '#00ccff';
            ctx.beginPath();
            ctx.arc(entity.x + entity.width / 2, entity.y - 20, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(entity.x + entity.width / 2, entity.y - 20);
            ctx.lineTo(entity.x + entity.width / 2, entity.y);
            ctx.strokeStyle = '#00ccff';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
        // Draw connections for triggers
        if ((isSelected || selectedEntityIds.length === 0) && (entity.type === 'lever' || entity.type === 'pressure-plate') && entity.targetId) {
          const target = entities.find(e => e.id === entity.targetId);
          if (target) {
            ctx.beginPath();
            ctx.strokeStyle = isSelected ? 'rgba(0, 204, 255, 0.8)' : 'rgba(255, 255, 255, 0.2)';
            ctx.setLineDash([5, 5]);
            ctx.moveTo(entity.x + entity.width/2, entity.y + entity.height/2);
            ctx.lineTo(target.x + target.width/2, target.y + target.height/2);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }

        ctx.restore();

        // Draw cannon target marker (outside of rotation context)
        if (!isPreview && isSelected && entity.type === 'cannon' && entity.endPos) {
          ctx.beginPath();
          ctx.strokeStyle = entity.cannonType === 'laser' ? 'rgba(255, 0, 68, 0.5)' : 'rgba(255, 136, 0, 0.5)';
          ctx.setLineDash([5, 5]);
          ctx.moveTo(entity.x + entity.width/2, entity.y + entity.height/2);
          ctx.lineTo(entity.endPos.x, entity.endPos.y);
          ctx.stroke();
          ctx.setLineDash([]);
          
          ctx.fillStyle = entity.cannonType === 'laser' ? 'rgba(255, 0, 68, 0.8)' : 'rgba(255, 136, 0, 0.8)';
          ctx.beginPath();
          ctx.arc(entity.endPos.x, entity.endPos.y, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      // Draw Player Starts
      if (isPreview) {
        const drawPlayerPreview = (pos: Vector, color: string, role: 'fire' | 'water') => {
          ctx.save();
          ctx.translate(pos.x + 15, pos.y + 20);
          ctx.shadowBlur = 10;
          ctx.shadowColor = color;
          ctx.fillStyle = color;
          
          if (role === 'fire') {
            ctx.beginPath();
            ctx.moveTo(-15, 0);
            ctx.quadraticCurveTo(-15, -25, 0, -35);
            ctx.quadraticCurveTo(15, -25, 15, 0);
            ctx.lineTo(-15, 0);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(0, -10, 18, 0, Math.PI * 2);
            ctx.fill();
          }
          
          // Eyes
          ctx.fillStyle = '#000';
          ctx.beginPath(); ctx.arc(-5, -15, 2, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(5, -15, 2, 0, Math.PI * 2); ctx.fill();
          
          ctx.restore();
        };
        drawPlayerPreview(fireStart, '#ff5500', 'fire');
        drawPlayerPreview(waterStart, '#00ddff', 'water');
      } else {
        ctx.fillStyle = '#ff4400';
        ctx.beginPath(); ctx.arc(fireStart.x + 15, fireStart.y + 20, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#00ccff';
        ctx.beginPath(); ctx.arc(waterStart.x + 15, waterStart.y + 20, 10, 0, Math.PI * 2); ctx.fill();
      }

      // Dark Mode Preview in Editor
      if (worldSettings.darkMode) {
        const radius = worldSettings.lightRadius;
        ctx.save();
        
        // Create a temporary canvas for the mask
        const lightCanvas = document.createElement('canvas');
        lightCanvas.width = CANVAS_WIDTH;
        lightCanvas.height = CANVAS_HEIGHT;
        const lctx = lightCanvas.getContext('2d');
        
        if (lctx) {
          lctx.fillStyle = isPreview ? 'black' : 'rgba(0, 0, 0, 0.7)'; 
          lctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          
          lctx.globalCompositeOperation = 'destination-out';
          
          const drawLight = (pos: Vector) => {
            const x = pos.x + 15;
            const y = pos.y + 20;
            const gradient = lctx.createRadialGradient(x, y, 0, x, y, radius);
            gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
            gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
            lctx.fillStyle = gradient;
            lctx.beginPath();
            lctx.arc(x, y, radius, 0, Math.PI * 2);
            lctx.fill();
          };
          
          drawLight(fireStart);
          drawLight(waterStart);
          
          if (isPreview) {
            ctx.globalCompositeOperation = 'multiply';
          }
          ctx.drawImage(lightCanvas, 0, 0);
        }
        ctx.restore();
      }

      ctx.restore(); // Restore from mirror/shake/etc
      
      // Target selection mode indicator (outside of preview transforms)
      if (isSelectingTarget) {
        ctx.fillStyle = 'rgba(0, 204, 255, 0.1)';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.fillStyle = '#00ccff';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('SELECT TARGET ENTITY', CANVAS_WIDTH / 2, 30);
      }

      // Selection box
      if (selectionBox) {
        ctx.strokeStyle = '#00ccff';
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(
          selectionBox.start.x,
          selectionBox.start.y,
          selectionBox.end.x - selectionBox.start.x,
          selectionBox.end.y - selectionBox.start.y
        );
        ctx.fillStyle = 'rgba(0, 204, 255, 0.1)';
        ctx.fillRect(
          selectionBox.start.x,
          selectionBox.start.y,
          selectionBox.end.x - selectionBox.start.x,
          selectionBox.end.y - selectionBox.start.y
        );
        ctx.setLineDash([]);
      }

      // Post-processing for preview
      if (isPreview) {
        if (worldSettings.invertColors) {
          ctx.save();
          ctx.globalCompositeOperation = 'difference';
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          ctx.restore();
        }

        if (worldSettings.pixelate && worldSettings.pixelate > 0) {
          const size = Math.max(1, worldSettings.pixelate);
          const w = CANVAS_WIDTH / size;
          const h = CANVAS_HEIGHT / size;
          
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = w;
          tempCanvas.height = h;
          const tctx = tempCanvas.getContext('2d');
          if (tctx) {
            tctx.imageSmoothingEnabled = false;
            tctx.drawImage(canvas, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 0, 0, w, h);
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
            ctx.drawImage(tempCanvas, 0, 0, w, h, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          }
        }
      }

      requestAnimationFrame(render);
    };

    const animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [entities, selectedEntityIds, snapToGrid, fireStart, waterStart, gridSize, worldSettings, isPreview]);

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

      if (!clicked) {
        clicked = entities.find(en => 
          rawX >= en.x && rawX <= en.x + en.width && rawY >= en.y && rawY <= en.y + en.height
        );
      }

      if (isSelectingTarget && selectedEntityIds.length === 1 && clicked && clicked.id !== selectedEntityIds[0]) {
        const newEntities = entities.map(en => 
          en.id === selectedEntityIds[0] ? { ...en, targetId: clicked.id } : en
        );
        updateEntities(newEntities);
        setIsSelectingTarget(false);
        showToast('Target linked!', 'success');
        return;
      }

      if (selectedEntityIds.length === 1) {
        const selected = entities.find(en => en.id === selectedEntityIds[0]);
        if (selected) {
          // Check for resize handles
          const handleSize = 10;
          const handles = [
            { id: 'tl', x: selected.x, y: selected.y },
            { id: 'tr', x: selected.x + selected.width, y: selected.y },
            { id: 'bl', x: selected.x, y: selected.y + selected.height },
            { id: 'br', x: selected.x + selected.width, y: selected.y + selected.height }
          ];

          for (const h of handles) {
            if (rawX >= h.x - handleSize && rawX <= h.x + handleSize &&
                rawY >= h.y - handleSize && rawY <= h.y + handleSize) {
              setIsResizing(true);
              setResizeHandle(h.id);
              return;
            }
          }

          // Check for rotation handle
          const rotateHandleX = selected.x + selected.width / 2;
          const rotateHandleY = selected.y - 20;
          if (rawX >= rotateHandleX - handleSize && rawX <= rotateHandleX + handleSize &&
              rawY >= rotateHandleY - handleSize && rawY <= rotateHandleY + handleSize) {
            setIsRotating(true);
            const centerX = selected.x + selected.width / 2;
            const centerY = selected.y + selected.height / 2;
            const angle = Math.atan2(rawY - centerY, rawX - centerX);
            setRotationStartAngle(angle - (selected.rotation || 0) * Math.PI / 180);
            return;
          }

          // Check for target marker (endPos)
          if (selected.endPos) {
            const isCannon = selected.type === 'cannon';
            const hitX = isCannon ? selected.endPos.x : selected.endPos.x + selected.width / 2;
            const hitY = isCannon ? selected.endPos.y : selected.endPos.y + selected.height / 2;
            const hitRadius = isCannon ? handleSize : Math.max(selected.width, selected.height) / 2;
            
            if (rawX >= hitX - hitRadius && rawX <= hitX + hitRadius &&
                rawY >= hitY - hitRadius && rawY <= hitY + hitRadius) {
              setIsDraggingTarget(true);
              setTargetDragEntityId(selected.id);
              setResizeHandle('endPos');
              return;
            }
          }

          // Check for start marker (startPos)
          if (selected.startPos) {
            const hitX = selected.startPos.x + selected.width / 2;
            const hitY = selected.startPos.y + selected.height / 2;
            const hitRadius = Math.max(selected.width, selected.height) / 2;
            
            if (rawX >= hitX - hitRadius && rawX <= hitX + hitRadius &&
                rawY >= hitY - hitRadius && rawY <= hitY + hitRadius) {
              setIsDraggingTarget(true);
              setTargetDragEntityId(selected.id);
              setResizeHandle('startPos');
              return;
            }
          }
        }
      }

      if (clicked) {
        if (e.shiftKey) {
          if (selectedEntityIds.includes(clicked.id)) {
            setSelectedEntityIds(selectedEntityIds.filter(id => id !== clicked.id));
          } else {
            setSelectedEntityIds([...selectedEntityIds, clicked.id]);
          }
        } else {
          if (!selectedEntityIds.includes(clicked.id)) {
            setSelectedEntityIds([clicked.id]);
          }
          setIsDragging(true);
          setDragOffset({ x: rawX, y: rawY });
        }
      } else {
        if (!e.shiftKey) {
          setSelectedEntityIds([]);
        }
        setSelectionBox({ start: { x: rawX, y: rawY }, end: { x: rawX, y: rawY } });
      }
    } else {
      // Create new entity
      const newEntity: Entity = {
        id: Math.random().toString(36).substr(2, 9),
        x, y,
        width: gridSize * 2,
        height: gridSize * 2,
        type: 'platform',
        shape: 'rect',
        active: false,
        targetId: undefined
      };

      if (activeTool === 'platform') {
        newEntity.type = 'platform';
        newEntity.width = gridSize * 4;
        newEntity.height = gridSize;
      } else if (activeTool === 'box') {
        newEntity.type = 'platform';
        newEntity.width = gridSize * 2;
        newEntity.height = gridSize * 2;
      } else if (activeTool === 'circle') {
        newEntity.type = 'platform';
        newEntity.shape = 'circle';
      } else if (activeTool === 'triangle') {
        newEntity.type = 'platform';
        newEntity.shape = 'triangle';
      } else if (activeTool === 'floor') {
        newEntity.type = 'platform';
        newEntity.x = 0;
        newEntity.y = y;
        newEntity.width = CANVAS_WIDTH;
        newEntity.height = gridSize;
      } else if (activeTool.includes('hazard')) {
        newEntity.type = 'hazard';
        newEntity.hazardType = activeTool.split('-')[0] as any;
        newEntity.height = gridSize / 2;
      } else if (activeTool.includes('door')) {
        newEntity.type = 'door';
        newEntity.color = activeTool.includes('fire') ? '#ff4400' : '#00ccff';
        newEntity.width = 40;
        newEntity.height = 70;
      } else if (activeTool.includes('gem')) {
        newEntity.type = 'gem';
        newEntity.color = activeTool.includes('fire') ? '#ff4400' : '#00ccff';
        newEntity.width = 20;
        newEntity.height = 20;
      } else if (activeTool === 'moving-platform') {
        newEntity.type = 'moving-platform';
        newEntity.width = gridSize * 4;
        newEntity.height = gridSize;
        newEntity.startPos = { x, y };
        newEntity.endPos = { x: x + 100, y };
        newEntity.speed = 2;
      } else if (activeTool === 'cannon') {
        newEntity.type = 'cannon';
        newEntity.width = 40;
        newEntity.height = 40;
        newEntity.rotation = 0;
        newEntity.fireRate = 60;
        newEntity.projectileSpeed = 5;
        newEntity.rotating = false;
        newEntity.rotationSpeed = 1;
        newEntity.cannonType = 'fireball';
        newEntity.endPos = { x: x + newEntity.width + 60, y: y + newEntity.height / 2 };
      } else if (activeTool === 'trigger') {
        newEntity.type = 'lever';
        newEntity.width = 20;
        newEntity.height = 20;
      } else if (activeTool === 'fire-start') {
        setFireStart({ x, y });
        pushHistory(entities, { x, y }, waterStart, worldSettings);
        return;
      } else if (activeTool === 'water-start') {
        setWaterStart({ x, y });
        pushHistory(entities, fireStart, { x, y }, worldSettings);
        return;
      }

      const newEntities = [...entities, newEntity];
      updateEntities(newEntities);
      setSelectedEntityIds([newEntity.id]);
      setActiveTool('select');
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = snap(e.clientX - rect.left);
    const y = snap(e.clientY - rect.top);
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;

    if (selectionBox) {
      setSelectionBox({ ...selectionBox, end: { x: rawX, y: rawY } });
      return;
    }

    if (isResizing && selectedEntityIds.length === 1) {
      setEntities(entities.map(en => {
        if (en.id === selectedEntityIds[0]) {
          if (en.locked) return en;
          const newEntity = { ...en };
          if (resizeHandle === 'br') {
            newEntity.width = Math.max(gridSize, x - en.x);
            newEntity.height = Math.max(gridSize, y - en.y);
          } else if (resizeHandle === 'tr') {
            const bottom = en.y + en.height;
            newEntity.y = Math.min(bottom - gridSize, y);
            newEntity.height = bottom - newEntity.y;
            newEntity.width = Math.max(gridSize, x - en.x);
          } else if (resizeHandle === 'bl') {
            const right = en.x + en.width;
            newEntity.x = Math.min(right - gridSize, x);
            newEntity.width = right - newEntity.x;
            newEntity.height = Math.max(gridSize, y - en.y);
          } else if (resizeHandle === 'tl') {
            const right = en.x + en.width;
            const bottom = en.y + en.height;
            newEntity.x = Math.min(right - gridSize, x);
            newEntity.y = Math.min(bottom - gridSize, y);
            newEntity.width = right - newEntity.x;
            newEntity.height = bottom - newEntity.y;
          }
          return newEntity;
        }
        return en;
      }));
      return;
    }
    
    if (isRotating && selectedEntityIds.length === 1) {
      setEntities(entities.map(en => {
        if (en.id === selectedEntityIds[0]) {
          if (en.locked) return en;
          const centerX = en.x + en.width / 2;
          const centerY = en.y + en.height / 2;
          const angle = Math.atan2(rawY - centerY, rawX - centerX);
          let newRotation = (angle - rotationStartAngle) * 180 / Math.PI;
          
          // Snap rotation to 15 degree increments if shift is held
          if (e.shiftKey) {
            newRotation = Math.round(newRotation / 15) * 15;
          }
          
          const updated = { ...en, rotation: newRotation };
          
          // Sync endPos if it exists
          if (updated.type === 'cannon' && updated.endPos) {
            const rad = newRotation * Math.PI / 180;
            const dist = Math.hypot(updated.endPos.x - centerX, updated.endPos.y - centerY);
            updated.endPos = {
              x: centerX + Math.cos(rad) * dist,
              y: centerY + Math.sin(rad) * dist
            };
          }
          
          return updated;
        }
        return en;
      }));
      return;
    }

    if (isDraggingTarget && targetDragEntityId) {
      setEntities(entities.map(en => {
        if (en.id === targetDragEntityId) {
          if (en.locked) return en;
          
          if (resizeHandle === 'startPos') {
            return { ...en, startPos: { x, y } };
          }
          
          if (en.type === 'cannon') {
            const newEndPos = { x, y };
            const centerX = en.x + en.width / 2;
            const centerY = en.y + en.height / 2;
            const angle = Math.atan2(newEndPos.y - centerY, newEndPos.x - centerX);
            let newRotation = angle * 180 / Math.PI;
            if (e.shiftKey) {
              newRotation = Math.round(newRotation / 15) * 15;
              // If snapped, update endPos to match the snapped rotation
              const rad = newRotation * Math.PI / 180;
              const dist = Math.hypot(newEndPos.y - centerY, newEndPos.x - centerX);
              newEndPos.x = centerX + Math.cos(rad) * dist;
              newEndPos.y = centerY + Math.sin(rad) * dist;
            }
            return { ...en, endPos: newEndPos, rotation: newRotation };
          }
          
          const newEndPos = { x, y };
          return { ...en, endPos: newEndPos };
        }
        return en;
      }));
      return;
    }

    if (!isDragging || selectedEntityIds.length === 0) return;
    
    const dx = rawX - dragOffset.x;
    const dy = rawY - dragOffset.y;

    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
      const snappedDx = snap(dx);
      const snappedDy = snap(dy);

      if (snappedDx !== 0 || snappedDy !== 0) {
        setEntities(entities.map(en => {
          if (selectedEntityIds.includes(en.id) && !en.locked) {
            const updated = { ...en, x: en.x + snappedDx, y: en.y + snappedDy };
            if (updated.startPos) {
              updated.startPos = { x: updated.startPos.x + snappedDx, y: updated.startPos.y + snappedDy };
            }
            if (updated.endPos) {
              updated.endPos = { x: updated.endPos.x + snappedDx, y: updated.endPos.y + snappedDy };
            }
            return updated;
          }
          return en;
        }));
        setDragOffset({ x: dragOffset.x + snappedDx, y: dragOffset.y + snappedDy });
      }
    }
  };

  const handleMouseUp = () => {
    if (selectionBox) {
      const x1 = Math.min(selectionBox.start.x, selectionBox.end.x);
      const y1 = Math.min(selectionBox.start.y, selectionBox.end.y);
      const x2 = Math.max(selectionBox.start.x, selectionBox.end.x);
      const y2 = Math.max(selectionBox.start.y, selectionBox.end.y);

      const inBox = entities.filter(en => {
        // Intersect check
        return !(en.x > x2 || 
                 en.x + en.width < x1 || 
                 en.y > y2 || 
                 en.y + en.height < y1);
      }).map(en => en.id);

      if (inBox.length > 0) {
        setSelectedEntityIds(inBox);
      }
      setSelectionBox(null);
    }

    if (isDragging || isResizing || isRotating || isDraggingTarget) {
      pushHistory(entities, fireStart, waterStart, worldSettings);
    }
    setIsDragging(false);
    setIsResizing(false);
    setIsRotating(false);
    setIsDraggingTarget(false);
    setTargetDragEntityId(null);
  };

  const deleteSelected = () => {
    if (selectedEntityIds.length === 0) return;
    const newEntities = entities.filter(en => !selectedEntityIds.includes(en.id) || en.locked);
    updateEntities(newEntities);
    setSelectedEntityIds(selectedEntityIds.filter(id => entities.find(e => e.id === id)?.locked));
  };

  const clearAll = () => {
    setShowClearConfirm(true);
  };

  const exportLevel = () => {
    const level: Level = {
      id: levelId || Date.now(),
      name: levelName,
      fireStart,
      waterStart,
      entities,
      worldSettings
    };
    const blob = new Blob([JSON.stringify(level, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${levelName.replace(/\s+/g, '_')}.json`;
    a.click();
  };

  const saveToLocal = () => {
    const level: Level = {
      id: levelId || Date.now(),
      name: levelName,
      fireStart,
      waterStart,
      entities,
      worldSettings
    };

    if (levelId && levelId <= 15) {
      // Main level override
      const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{}');
      overrides[levelId] = level;
      localStorage.setItem('main_level_overrides', JSON.stringify(overrides));
      showToast('Main level override saved!', 'success');
    } else {
      // Custom level
      const saved = JSON.parse(localStorage.getItem('custom_levels') || '[]');
      const existingIndex = saved.findIndex((l: Level) => l.id === level.id || l.name === levelName);
      if (existingIndex >= 0) {
        saved[existingIndex] = level;
      } else {
        saved.push(level);
      }
      localStorage.setItem('custom_levels', JSON.stringify(saved));
      showToast('Custom level saved!', 'success');
    }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const level = JSON.parse(ev.target?.result as string) as Level;
        startEditing(level.entities, level.fireStart, level.waterStart, level.worldSettings || { darkMode: false, lightRadius: 150 }, level.name, level.id);
        showToast('Level imported successfully', 'success');
      } catch (err) {
        showToast('Invalid level file', 'error');
      }
    };
    reader.readAsText(file);
  };

  const exportAllCampaign = () => {
    const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{}');
    const campaignData = levels.map(l => overrides[l.id] || l);
    const blob = new Blob([JSON.stringify(campaignData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'campaign_sectors_backup.json';
    a.click();
    showToast('Campaign sectors exported', 'success');
  };

  const importAllCampaign = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target?.result as string);
        if (Array.isArray(imported)) {
          const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{}');
          imported.forEach((lvl: Level) => {
            if (lvl.id >= 1 && lvl.id <= 15) {
              overrides[lvl.id] = lvl;
            }
          });
          localStorage.setItem('main_level_overrides', JSON.stringify(overrides));
          showToast('Campaign overrides imported', 'success');
          window.location.reload();
        }
      } catch (err) {
        showToast('Invalid backup file', 'error');
      }
    };
    reader.readAsText(file);
  };

  const exportAllCustom = () => {
    const custom = localStorage.getItem('custom_levels') || '[]';
    const blob = new Blob([custom], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'user_archives_backup.json';
    a.click();
    showToast('User archives exported', 'success');
  };

  const importAllCustom = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target?.result as string);
        if (Array.isArray(imported)) {
          const existing = JSON.parse(localStorage.getItem('custom_levels') || '[]');
          const merged = [...existing, ...imported];
          // Remove duplicates by ID if necessary, but here we just append
          localStorage.setItem('custom_levels', JSON.stringify(merged));
          showToast('User archives imported', 'success');
          window.location.reload();
        }
      } catch (err) {
        showToast('Invalid backup file', 'error');
      }
    };
    reader.readAsText(file);
  };

  if (editorMode === 'select') {
    const customLevels = JSON.parse(localStorage.getItem('custom_levels') || '[]');
    const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{}');

    return (
      <div className="flex flex-col h-screen bg-[#050505] text-white font-mono overflow-hidden relative">
        {/* Background Accents */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_-20%,rgba(0,204,255,0.1),transparent)]" />
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        </div>

        {/* Header */}
        <div className="relative z-10 flex items-center justify-between p-8 border-b border-white/5 bg-black/40 backdrop-blur-md">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-2 h-2 bg-cyan-500 animate-pulse" />
              <h1 className="text-3xl font-black tracking-tighter">SECTOR SELECT</h1>
            </div>
            <p className="text-zinc-500 text-[10px] uppercase tracking-[0.3em]">Level Architecture & Override Terminal</p>
          </div>
          <div className="flex gap-4">
            <button 
              onClick={() => {
                startEditing([], { x: 50, y: 500 }, { x: 100, y: 500 }, { darkMode: false, lightRadius: 150 }, 'USR_ARCHIVE_' + Date.now().toString().slice(-4), null);
              }}
              className="group relative px-6 py-3 bg-cyan-600 rounded-lg font-bold overflow-hidden transition-all hover:bg-cyan-500 active:scale-95"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
              <span className="relative flex items-center gap-2">
                <Plus size={18} /> INITIALIZE NEW ARCHIVE
              </span>
            </button>
            <button 
              onClick={onBack}
              className="px-6 py-3 bg-zinc-900/50 rounded-lg font-bold border border-white/10 hover:bg-zinc-800 transition-all active:scale-95"
            >
              RETURN TO TERMINAL
            </button>
          </div>
        </div>

        <div className="relative z-10 flex-1 overflow-y-auto p-8 custom-scrollbar">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12">
            {/* Main Story Section */}
            <section>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xs font-bold text-orange-500 uppercase tracking-widest flex items-center gap-2">
                  <Layers size={14} /> CORE CAMPAIGN SECTORS
                </h2>
                <div className="flex items-center gap-3">
                  <div className="flex gap-2">
                    <input type="file" id="import-all-campaign" hidden accept=".json" onChange={importAllCampaign} />
                    <button 
                      onClick={() => document.getElementById('import-all-campaign')?.click()}
                      className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900 border border-white/5 rounded text-[9px] font-bold text-zinc-400 hover:text-white hover:border-orange-500/30 transition-all"
                    >
                      <Upload size={10} /> IMPORT ALL
                    </button>
                    <button 
                      onClick={exportAllCampaign}
                      className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900 border border-white/5 rounded text-[9px] font-bold text-zinc-400 hover:text-white hover:border-orange-500/30 transition-all"
                    >
                      <Download size={10} /> EXPORT ALL
                    </button>
                  </div>
                  <div className="px-2 py-1 bg-orange-500/10 border border-orange-500/20 rounded text-[8px] text-orange-500 font-bold">
                    SYSTEM STATUS: STABLE
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                {levels.map(level => {
                  const isOverridden = !!overrides[level.id];
                  return (
                    <button 
                      key={level.id}
                      onClick={() => {
                        const data = overrides[level.id] || level;
                        startEditing(data.entities, data.fireStart, data.waterStart, data.worldSettings || { darkMode: false, lightRadius: 150 }, data.name, level.id);
                      }}
                      className="group relative p-5 bg-zinc-900/40 rounded-xl border border-white/5 hover:border-orange-500/50 transition-all text-left overflow-hidden"
                    >
                      {/* Background Number */}
                      <div className="absolute -bottom-4 -right-4 text-7xl font-black italic opacity-[0.03] group-hover:opacity-[0.07] transition-opacity">
                        {level.id.toString().padStart(2, '0')}
                      </div>
                      
                      <div className="relative z-10 flex flex-col h-full">
                        <div className="flex justify-between items-start mb-2">
                          <span className="text-[10px] text-zinc-500 font-bold">SEC_{level.id.toString().padStart(2, '0')}</span>
                          {isOverridden && (
                            <span className="text-[8px] bg-orange-500 text-black px-1 font-bold rounded">OVERRIDDEN</span>
                          )}
                        </div>
                        <div className="font-bold text-lg group-hover:text-orange-400 transition-colors truncate">{level.name}</div>
                        <div className="mt-4 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="w-1 h-1 bg-orange-500 rounded-full animate-ping" />
                          <span className="text-[9px] text-orange-500 font-bold">OVERRIDE LEVEL ARCHITECTURE</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Custom Levels Section */}
            <section>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xs font-bold text-cyan-500 uppercase tracking-widest flex items-center gap-2">
                  <Plus size={14} /> USER DATA ARCHIVES
                </h2>
                <div className="flex items-center gap-3">
                  <div className="flex gap-2">
                    <input type="file" id="import-all-custom" hidden accept=".json" onChange={importAllCustom} />
                    <button 
                      onClick={() => document.getElementById('import-all-custom')?.click()}
                      className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900 border border-white/5 rounded text-[9px] font-bold text-zinc-400 hover:text-white hover:border-cyan-500/30 transition-all"
                    >
                      <Upload size={10} /> IMPORT ALL
                    </button>
                    <button 
                      onClick={exportAllCustom}
                      className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900 border border-white/5 rounded text-[9px] font-bold text-zinc-400 hover:text-white hover:border-cyan-500/30 transition-all"
                    >
                      <Download size={10} /> EXPORT ALL
                    </button>
                  </div>
                  <div className="px-2 py-1 bg-cyan-500/10 border border-cyan-500/20 rounded text-[8px] text-cyan-500 font-bold">
                    STORAGE: {customLevels.length}/50
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {customLevels.map((level: Level) => (
                  <button 
                    key={level.id}
                    onClick={() => {
                      startEditing(level.entities, level.fireStart, level.waterStart, level.worldSettings || { darkMode: false, lightRadius: 150 }, level.name, level.id);
                    }}
                    className="w-full group relative p-5 bg-zinc-900/40 rounded-xl border border-white/5 hover:border-cyan-500/50 transition-all text-left overflow-hidden flex items-center justify-between"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center border border-white/5 group-hover:border-cyan-500/30 transition-colors">
                        <Layers size={18} className="text-zinc-600 group-hover:text-cyan-500 transition-colors" />
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-500 font-bold mb-0.5">USR_{level.id.toString().slice(-6)}</div>
                        <div className="font-bold text-lg group-hover:text-cyan-400 transition-colors">{level.name}</div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-[10px] text-zinc-500 font-bold mb-1 uppercase tracking-tighter">Entity Count</div>
                      <div className="text-xl font-black text-zinc-700 group-hover:text-cyan-500/50 transition-colors">{level.entities.length}</div>
                    </div>
                  </button>
                ))}

                {customLevels.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-white/5 rounded-3xl bg-zinc-900/10">
                    <div className="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center mb-4 border border-white/5">
                      <Plus size={24} className="text-zinc-700" />
                    </div>
                    <p className="text-zinc-500 text-sm italic mb-6">No user archives detected in local storage</p>
                    <button 
                      onClick={() => {
                        startEditing([], { x: 50, y: 500 }, { x: 100, y: 500 }, { darkMode: false, lightRadius: 150 }, 'USR_ARCHIVE_' + Date.now().toString().slice(-4), null);
                      }}
                      className="px-6 py-2 bg-zinc-800 rounded-lg text-xs font-bold hover:bg-zinc-700 transition-colors border border-white/5"
                    >
                      INITIALIZE EDITOR
                    </button>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  const selectedEntities = entities.filter(e => selectedEntityIds.includes(e.id));
  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null;

  const alignEntities = (type: 'top' | 'bottom' | 'left' | 'right' | 'center-h' | 'center-v') => {
    if (selectedEntityIds.length < 2) return;
    const selected = entities.filter(en => selectedEntityIds.includes(en.id));
    
    let targetVal = 0;
    if (type === 'top') targetVal = Math.min(...selected.map(e => e.y));
    if (type === 'bottom') targetVal = Math.max(...selected.map(e => e.y + e.height));
    if (type === 'left') targetVal = Math.min(...selected.map(e => e.x));
    if (type === 'right') targetVal = Math.max(...selected.map(e => e.x + e.width));
    if (type === 'center-h') {
      const minX = Math.min(...selected.map(e => e.x));
      const maxX = Math.max(...selected.map(e => e.x + e.width));
      targetVal = minX + (maxX - minX) / 2;
    }
    if (type === 'center-v') {
      const minY = Math.min(...selected.map(e => e.y));
      const maxY = Math.max(...selected.map(e => e.y + e.height));
      targetVal = minY + (maxY - minY) / 2;
    }

    const newEntities = entities.map(en => {
      if (selectedEntityIds.includes(en.id)) {
        if (type === 'top') return { ...en, y: targetVal };
        if (type === 'bottom') return { ...en, y: targetVal - en.height };
        if (type === 'left') return { ...en, x: targetVal };
        if (type === 'right') return { ...en, x: targetVal - en.width };
        if (type === 'center-h') return { ...en, x: targetVal - en.width / 2 };
        if (type === 'center-v') return { ...en, y: targetVal - en.height / 2 };
      }
      return en;
    });
    updateEntities(newEntities);
  };

  const distributeEntities = (type: 'horizontal' | 'vertical') => {
    if (selectedEntityIds.length < 3) return;
    const selected = entities.filter(en => selectedEntityIds.includes(en.id))
      .sort((a, b) => type === 'horizontal' ? a.x - b.x : a.y - b.y);
    
    const first = selected[0];
    const last = selected[selected.length - 1];
    
    if (type === 'horizontal') {
      const totalDist = last.x - first.x;
      const step = totalDist / (selected.length - 1);
      const newEntities = entities.map(en => {
        const idx = selected.findIndex(s => s.id === en.id);
        if (idx !== -1) {
          return { ...en, x: first.x + idx * step };
        }
        return en;
      });
      updateEntities(newEntities);
    } else {
      const totalDist = last.y - first.y;
      const step = totalDist / (selected.length - 1);
      const newEntities = entities.map(en => {
        const idx = selected.findIndex(s => s.id === en.id);
        if (idx !== -1) {
          return { ...en, y: first.y + idx * step };
        }
        return en;
      });
      updateEntities(newEntities);
    }
  };

  const changeZOrder = (direction: 'front' | 'back') => {
    if (selectedEntityIds.length === 0) return;
    const selected = entities.filter(en => selectedEntityIds.includes(en.id));
    const remaining = entities.filter(en => !selectedEntityIds.includes(en.id));
    
    if (direction === 'front') {
      updateEntities([...remaining, ...selected]);
    } else {
      updateEntities([...selected, ...remaining]);
    }
  };

  const duplicateSelected = () => {
    if (selectedEntityIds.length === 0) return;
    const toCopy = entities.filter(en => selectedEntityIds.includes(en.id));
    const newEntities = [...entities];
    const newIds: string[] = [];
    toCopy.forEach(en => {
      const newEn = { 
        ...en, 
        id: Math.random().toString(36).substr(2, 9),
        x: en.x + gridSize,
        y: en.y + gridSize
      };
      newEntities.push(newEn);
      newIds.push(newEn.id);
    });
    updateEntities(newEntities);
    setSelectedEntityIds(newIds);
    showToast(`Duplicated ${toCopy.length} entities`, 'success');
  };

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
            {levelId && levelId <= 15 && <span className="text-[10px] text-orange-500 font-bold uppercase ml-2">Editing Main Level {levelId}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={undo} disabled={historyIndex <= 0} className={`p-2 rounded-lg ${historyIndex > 0 ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-600 cursor-not-allowed'}`} title="Undo (Ctrl+Z)">
            <Undo2 size={20} />
          </button>
          <button onClick={redo} disabled={historyIndex >= history.length - 1} className={`p-2 rounded-lg ${historyIndex < history.length - 1 ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-600 cursor-not-allowed'}`} title="Redo (Ctrl+Y)">
            <Redo2 size={20} />
          </button>
          <div className="w-px h-6 bg-zinc-800 mx-2" />
          <div className="flex items-center gap-2 bg-zinc-800 px-3 py-1 rounded-lg">
            <span className="text-[10px] text-zinc-500 font-bold">GRID</span>
            <input 
              type="range" min="5" max="100" step="5" 
              value={gridSize} 
              onChange={e => setGridSize(parseInt(e.target.value))}
              className="w-24 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
            />
            <span className="text-[10px] font-bold w-4">{gridSize}</span>
          </div>
          <button onClick={() => setSnapToGrid(!snapToGrid)} className={`p-2 rounded-lg ${snapToGrid ? 'bg-cyan-500/20 text-cyan-500' : 'bg-zinc-800'}`}>
            <Grid size={20} />
          </button>
          <button onClick={saveToLocal} className="flex items-center gap-2 px-4 py-2 bg-zinc-800 rounded-lg hover:bg-zinc-700">
            <Save size={18} /> SAVE
          </button>
          <button onClick={exportLevel} className="flex items-center gap-2 px-4 py-2 bg-zinc-800 rounded-lg hover:bg-zinc-700">
            <Download size={18} /> EXPORT
          </button>
          <label className="flex items-center gap-2 px-4 py-2 bg-zinc-800 rounded-lg hover:bg-zinc-700 cursor-pointer">
            <Upload size={18} /> IMPORT
            <input type="file" hidden onChange={handleImport} accept=".json" />
          </label>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setIsPreview(!isPreview)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold transition-all ${isPreview ? 'bg-orange-500/20 text-orange-500 border border-orange-500/50' : 'bg-zinc-800 text-zinc-400 hover:text-white'}`}
            >
              {isPreview ? <EyeOff size={18} /> : <Eye size={18} />}
              {isPreview ? 'EDITOR' : 'PREVIEW'}
            </button>
            <button 
              onClick={() => onPlay({ id: levelId || 0, name: levelName, fireStart, waterStart, entities, worldSettings }, true)}
              className="flex items-center gap-2 px-6 py-2 bg-cyan-600 rounded-lg hover:bg-cyan-500 font-bold"
            >
              <Play size={18} /> PLAY TEST
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Tools */}
        <div className="w-64 bg-zinc-900 border-r border-white/5 flex flex-col overflow-hidden">
          <section className="p-4 border-b border-white/5 flex-shrink-0">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs text-zinc-500 uppercase tracking-widest">Tools</h3>
              <button 
                onClick={() => setShowClearConfirm(true)}
                className="p-1.5 text-zinc-600 hover:text-red-500 transition-colors"
                title="Clear All"
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              <ToolBtn active={activeTool === 'select'} onClick={() => setActiveTool('select')} icon={<MousePointer2 size={12} />} label="Select" />
              <ToolBtn active={activeTool === 'platform'} onClick={() => setActiveTool('platform')} icon={<Layers size={12} />} label="Plat" />
              <ToolBtn active={activeTool === 'box'} onClick={() => setActiveTool('box')} icon={<Square size={12} />} label="Box" />
              <ToolBtn active={activeTool === 'circle'} onClick={() => setActiveTool('circle')} icon={<Circle size={12} />} label="Circle" />
              <ToolBtn active={activeTool === 'triangle'} onClick={() => setActiveTool('triangle')} icon={<Triangle size={12} />} label="Tri" />
              <ToolBtn active={activeTool === 'floor'} onClick={() => setActiveTool('floor')} icon={<div className="w-2.5 h-0.5 bg-zinc-400" />} label="Floor" />
              <ToolBtn active={activeTool === 'fire-hazard'} onClick={() => setActiveTool('fire-hazard')} icon={<span className="text-orange-500 text-[10px]">🔥</span>} label="Fire" />
              <ToolBtn active={activeTool === 'water-hazard'} onClick={() => setActiveTool('water-hazard')} icon={<span className="text-cyan-500 text-[10px]">Wtr</span>} label="Water" />
              <ToolBtn active={activeTool === 'acid-hazard'} onClick={() => setActiveTool('acid-hazard')} icon={<span className="text-green-500 text-[10px]">Acd</span>} label="Acid" />
              <ToolBtn active={activeTool === 'door-fire'} onClick={() => setActiveTool('door-fire')} icon={<div className="w-1.5 h-2.5 border border-orange-500" />} label="F Dr" />
              <ToolBtn active={activeTool === 'door-water'} onClick={() => setActiveTool('door-water')} icon={<div className="w-1.5 h-2.5 border border-cyan-500" />} label="W Dr" />
              <ToolBtn active={activeTool === 'gem-fire'} onClick={() => setActiveTool('gem-fire')} icon={<div className="w-1.5 h-1.5 bg-orange-500 rotate-45" />} label="F Gm" />
              <ToolBtn active={activeTool === 'gem-water'} onClick={() => setActiveTool('gem-water')} icon={<div className="w-1.5 h-1.5 bg-cyan-500 rotate-45" />} label="W Gm" />
              <ToolBtn active={activeTool === 'trigger'} onClick={() => setActiveTool('trigger')} icon={<div className="w-2.5 h-0.5 bg-zinc-500 relative"><div className="absolute top-[-2px] left-1/2 -translate-x-1/2 w-0.5 h-1.5 bg-zinc-400 rotate-12" /></div>} label="Trig" />
              <ToolBtn active={activeTool === 'moving-platform'} onClick={() => setActiveTool('moving-platform')} icon={<div className="w-2.5 h-1 bg-zinc-600 border-x border-cyan-500" />} label="Move" />
              <ToolBtn active={activeTool === 'cannon'} onClick={() => setActiveTool('cannon')} icon={<Play size={12} className="rotate-90 text-red-500" />} label="Can" />
              <ToolBtn active={activeTool === 'fire-start'} onClick={() => setActiveTool('fire-start')} icon={<div className="w-2.5 h-2.5 rounded-full bg-orange-500" />} label="F St" />
              <ToolBtn active={activeTool === 'water-start'} onClick={() => setActiveTool('water-start')} icon={<div className="w-2.5 h-2.5 rounded-full bg-cyan-500" />} label="W St" />
              <ToolBtn active={activeTool === 'world-tool'} onClick={() => setActiveTool('world-tool')} icon={<Globe size={12} />} label="World" />
            </div>
          </section>

          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {activeTool === 'world-tool' && (
              <section>
                <h3 className="text-xs text-zinc-500 uppercase tracking-widest mb-4">World Settings</h3>
                <div className="space-y-6">
                <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-xl border border-white/5">
                  <span className="text-xs font-bold text-zinc-300">DARK MODE</span>
                  <button 
                    onClick={() => {
                      const newSettings = { ...worldSettings, darkMode: !worldSettings.darkMode };
                      setWorldSettings(newSettings);
                      pushHistory(entities, fireStart, waterStart, newSettings);
                    }}
                    className={`w-10 h-5 rounded-full transition-colors relative ${worldSettings.darkMode ? 'bg-cyan-500' : 'bg-zinc-700'}`}
                  >
                    <div className={`absolute top-1 left-1 w-3 h-3 rounded-full bg-white transition-transform ${worldSettings.darkMode ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
                
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase">Light Radius</span>
                    <span className="text-[10px] font-bold text-cyan-500">{worldSettings.lightRadius}px</span>
                  </div>
                  <input 
                    type="range" min="50" max="400" step="10" 
                    value={worldSettings.lightRadius} 
                    onChange={e => {
                      const val = parseInt(e.target.value);
                      const newSettings = { ...worldSettings, lightRadius: val };
                      setWorldSettings(newSettings);
                    }}
                    onMouseUp={() => pushHistory(entities, fireStart, waterStart, worldSettings)}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase">Gravity Multiplier</span>
                    <span className="text-[10px] font-bold text-orange-500">{worldSettings.gravityMultiplier}x</span>
                  </div>
                  <input 
                    type="range" min="0.1" max="3" step="0.1" 
                    value={worldSettings.gravityMultiplier || 1} 
                    onChange={e => {
                      const val = parseFloat(e.target.value);
                      setWorldSettings({ ...worldSettings, gravityMultiplier: val });
                    }}
                    onMouseUp={() => pushHistory(entities, fireStart, waterStart, worldSettings)}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase">Speed Multiplier</span>
                    <span className="text-[10px] font-bold text-green-500">{worldSettings.speedMultiplier}x</span>
                  </div>
                  <input 
                    type="range" min="0.5" max="5" step="0.1" 
                    value={worldSettings.speedMultiplier || 1} 
                    onChange={e => {
                      const val = parseFloat(e.target.value);
                      setWorldSettings({ ...worldSettings, speedMultiplier: val });
                    }}
                    onMouseUp={() => pushHistory(entities, fireStart, waterStart, worldSettings)}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-green-500"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase">Jump Multiplier</span>
                    <span className="text-[10px] font-bold text-blue-500">{worldSettings.jumpMultiplier}x</span>
                  </div>
                  <input 
                    type="range" min="0.5" max="3" step="0.1" 
                    value={worldSettings.jumpMultiplier || 1} 
                    onChange={e => {
                      const val = parseFloat(e.target.value);
                      setWorldSettings({ ...worldSettings, jumpMultiplier: val });
                    }}
                    onMouseUp={() => pushHistory(entities, fireStart, waterStart, worldSettings)}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase">Wind X</span>
                    <span className="text-[10px] font-bold text-white">{worldSettings.windX}</span>
                  </div>
                  <input 
                    type="range" min="-1" max="1" step="0.05" 
                    value={worldSettings.windX || 0} 
                    onChange={e => {
                      const val = parseFloat(e.target.value);
                      setWorldSettings({ ...worldSettings, windX: val });
                    }}
                    onMouseUp={() => pushHistory(entities, fireStart, waterStart, worldSettings)}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-white"
                  />
                </div>

                <div className="space-y-2">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase">Background Theme</span>
                  <select 
                    value={worldSettings.backgroundTheme || 'default'}
                    onChange={e => {
                      const val = e.target.value as any;
                      const newSettings = { ...worldSettings, backgroundTheme: val };
                      setWorldSettings(newSettings);
                      pushHistory(entities, fireStart, waterStart, newSettings);
                    }}
                    className="w-full bg-zinc-800 border border-white/10 rounded-lg px-2 py-1 text-xs text-white"
                  >
                    <option value="default">Default Space</option>
                    <option value="neon">Neon Grid</option>
                    <option value="void">Deep Void</option>
                    <option value="matrix">Matrix Code</option>
                    <option value="cyberpunk">Cyberpunk City</option>
                    <option value="sunset">Retro Sunset</option>
                    <option value="nebula">Cosmic Nebula</option>
                    <option value="glitch">Glitch Reality</option>
                    <option value="underwater">Deep Ocean</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase">Time Scale</span>
                    <span className="text-[10px] font-bold text-yellow-500">{worldSettings.timeScale}x</span>
                  </div>
                  <input 
                    type="range" min="0.1" max="2" step="0.1" 
                    value={worldSettings.timeScale || 1} 
                    onChange={e => setWorldSettings({ ...worldSettings, timeScale: parseFloat(e.target.value) })}
                    onMouseUp={() => pushHistory(entities, fireStart, waterStart, worldSettings)}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-yellow-500"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase">Pixelate</span>
                    <span className="text-[10px] font-bold text-purple-500">{worldSettings.pixelate}px</span>
                  </div>
                  <input 
                    type="range" min="0" max="20" step="1" 
                    value={worldSettings.pixelate || 0} 
                    onChange={e => setWorldSettings({ ...worldSettings, pixelate: parseInt(e.target.value) })}
                    onMouseUp={() => pushHistory(entities, fireStart, waterStart, worldSettings)}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button 
                    onClick={() => {
                      const newSettings = { ...worldSettings, mirrorWorld: !worldSettings.mirrorWorld };
                      setWorldSettings(newSettings);
                      pushHistory(entities, fireStart, waterStart, newSettings);
                    }}
                    className={`p-2 rounded text-[10px] font-bold border transition-all ${worldSettings.mirrorWorld ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-zinc-800 border-white/5 text-zinc-500'}`}
                  >
                    MIRROR
                  </button>
                  <button 
                    onClick={() => {
                      const newSettings = { ...worldSettings, invertColors: !worldSettings.invertColors };
                      setWorldSettings(newSettings);
                      pushHistory(entities, fireStart, waterStart, newSettings);
                    }}
                    className={`p-2 rounded text-[10px] font-bold border transition-all ${worldSettings.invertColors ? 'bg-orange-500/20 border-orange-500 text-orange-500' : 'bg-zinc-800 border-white/5 text-zinc-500'}`}
                  >
                    INVERT
                  </button>
                </div>

                <button 
                  onClick={() => {
                    const newSettings = { ...worldSettings, chaosMode: !worldSettings.chaosMode };
                    setWorldSettings(newSettings);
                    pushHistory(entities, fireStart, waterStart, newSettings);
                  }}
                  className={`w-full p-2 rounded text-[10px] font-bold border transition-all ${worldSettings.chaosMode ? 'bg-red-500/20 border-red-500 text-red-500 animate-pulse' : 'bg-zinc-800 border-white/5 text-zinc-500'}`}
                >
                  CHAOS MODE
                </button>
                
                <div className="p-3 bg-cyan-500/5 border border-cyan-500/10 rounded-lg">
                  <p className="text-[9px] text-zinc-500 leading-relaxed">
                    Experiment with these settings to create unique gameplay experiences!
                  </p>
                </div>
              </div>
            </section>
          )}

          {selectedEntityIds.length > 0 && (
            <section className="pt-6 border-t border-white/5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs text-zinc-500 uppercase tracking-widest">
                  {selectedEntityIds.length > 1 ? `${selectedEntityIds.length} Selected` : 'Properties'}
                </h3>
                <div className="flex gap-1">
                  <button onClick={duplicateSelected} className="p-1 text-zinc-500 hover:text-cyan-500" title="Duplicate">
                    <Undo2 size={12} className="rotate-180" />
                  </button>
                  <button onClick={deleteSelected} className="p-1 text-zinc-500 hover:text-red-500" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {selectedEntityIds.length > 1 && (
                <div className="space-y-4">
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold">Alignment</span>
                    <div className="grid grid-cols-3 gap-1">
                      <button onClick={() => alignEntities('top')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">TOP</button>
                      <button onClick={() => alignEntities('center-v')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">C-V</button>
                      <button onClick={() => alignEntities('bottom')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">BTM</button>
                      <button onClick={() => alignEntities('left')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">LFT</button>
                      <button onClick={() => alignEntities('center-h')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">C-H</button>
                      <button onClick={() => alignEntities('right')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">RGT</button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold">Distribution</span>
                    <div className="grid grid-cols-2 gap-1">
                      <button onClick={() => distributeEntities('horizontal')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">HORIZ</button>
                      <button onClick={() => distributeEntities('vertical')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">VERT</button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold">Layering</span>
                    <div className="grid grid-cols-2 gap-1">
                      <button onClick={() => changeZOrder('front')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">TO FRONT</button>
                      <button onClick={() => changeZOrder('back')} className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[10px] font-bold">TO BACK</button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 pt-4 border-t border-white/5">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold">Bulk Properties</span>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-zinc-400">Width</span>
                        <input 
                          type="number" 
                          placeholder="Multiple"
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            if (!isNaN(val)) updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, width: val } : en));
                          }}
                          className="w-20 bg-zinc-800 rounded px-2 py-1 text-xs outline-none"
                        />
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-zinc-400">Height</span>
                        <input 
                          type="number" 
                          placeholder="Multiple"
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            if (!isNaN(val)) updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, height: val } : en));
                          }}
                          className="w-20 bg-zinc-800 rounded px-2 py-1 text-xs outline-none"
                        />
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-zinc-400">Rotation</span>
                        <input 
                          type="number" 
                          placeholder="Multiple"
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            if (!isNaN(val)) updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, rotation: val } : en));
                          }}
                          className="w-20 bg-zinc-800 rounded px-2 py-1 text-xs outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-1 mt-2">
                        <button 
                          onClick={() => updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, shape: 'rect' } : en))}
                          className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[8px] font-bold"
                        >RECT</button>
                        <button 
                          onClick={() => updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, shape: 'circle' } : en))}
                          className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[8px] font-bold"
                        >CIRCLE</button>
                        <button 
                          onClick={() => updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, shape: 'triangle' } : en))}
                          className="p-2 bg-zinc-800 rounded hover:bg-zinc-700 text-[8px] font-bold"
                        >TRI</button>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold">Bulk Actions</span>
                    <div className="grid grid-cols-2 gap-1">
                      <button 
                        onClick={() => updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, locked: !en.locked } : en))}
                        className="py-2 bg-zinc-800 rounded text-[10px] font-bold hover:bg-zinc-700"
                      >
                        TOGGLE LOCK
                      </button>
                      <button 
                        onClick={() => updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, hidden: !en.hidden } : en))}
                        className="py-2 bg-zinc-800 rounded text-[10px] font-bold hover:bg-zinc-700"
                      >
                        TOGGLE HIDE
                      </button>
                    </div>
                    <button 
                      onClick={() => updateEntities(entities.map(en => selectedEntityIds.includes(en.id) ? { ...en, type: 'platform' } : en))}
                      className="w-full py-2 bg-zinc-800 rounded text-[10px] font-bold hover:bg-zinc-700"
                    >
                      CONVERT TO PLATFORMS
                    </button>
                  </div>
                </div>
              )}

              {selectedEntity && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-zinc-400">Width</span>
                    <input 
                      type="number" 
                      value={selectedEntity.width} 
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, width: val } : en));
                      }}
                      className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-zinc-400">Height</span>
                    <input 
                      type="number" 
                      value={selectedEntity.height} 
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, height: val } : en));
                      }}
                      className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-zinc-400">Rotation</span>
                    <input 
                      type="number" 
                      value={selectedEntity.rotation || 0} 
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        updateEntities(entities.map(en => {
                          if (en.id === selectedEntity.id) {
                            const updated = { ...en, rotation: val };
                            if (updated.type === 'cannon' && updated.endPos) {
                              const rad = val * Math.PI / 180;
                              const centerX = updated.x + updated.width / 2;
                              const centerY = updated.y + updated.height / 2;
                              const dist = Math.hypot(updated.endPos.x - centerX, updated.endPos.y - centerY);
                              updated.endPos = {
                                x: centerX + Math.cos(rad) * dist,
                                y: centerY + Math.sin(rad) * dist
                              };
                            }
                            return updated;
                          }
                          return en;
                        }));
                      }}
                      className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-2 pt-2 border-t border-white/5">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-zinc-400">Rotating</span>
                      <button 
                        onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, rotating: !en.rotating } : en))}
                        className={`px-3 py-1 rounded text-[10px] font-bold transition-all ${selectedEntity.rotating ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
                      >
                        {selectedEntity.rotating ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    {selectedEntity.rotating && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">Rot Speed</span>
                        <input 
                          type="number" 
                          step="0.1"
                          value={selectedEntity.rotationSpeed || 1} 
                          onChange={e => {
                            const val = parseFloat(e.target.value);
                            updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, rotationSpeed: val } : en));
                          }}
                          className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm text-zinc-400">Shape</span>
                    <div className="grid grid-cols-3 gap-1">
                      <button 
                        onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, shape: 'rect' } : en))}
                        className={`flex flex-col items-center py-2 rounded border transition-all ${selectedEntity.shape === 'rect' || !selectedEntity.shape ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-zinc-800 border-white/5 text-zinc-500'}`}
                      >
                        <Square size={14} />
                        <span className="text-[8px] mt-1">RECT</span>
                      </button>
                      <button 
                        onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, shape: 'circle' } : en))}
                        className={`flex flex-col items-center py-2 rounded border transition-all ${selectedEntity.shape === 'circle' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-zinc-800 border-white/5 text-zinc-500'}`}
                      >
                        <Circle size={14} />
                        <span className="text-[8px] mt-1">CIRCLE</span>
                      </button>
                      <button 
                        onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, shape: 'triangle' } : en))}
                        className={`flex flex-col items-center py-2 rounded border transition-all ${selectedEntity.shape === 'triangle' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-zinc-800 border-white/5 text-zinc-500'}`}
                      >
                        <Triangle size={14} />
                        <span className="text-[8px] mt-1">TRI</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-sm text-zinc-400">State</span>
                    <div className="grid grid-cols-2 gap-1">
                      <button 
                        onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, locked: !en.locked } : en))}
                        className={`py-2 rounded text-[10px] font-bold transition-all ${selectedEntity.locked ? 'bg-orange-500/20 border border-orange-500 text-orange-500' : 'bg-zinc-800 border border-transparent text-zinc-500'}`}
                      >
                        {selectedEntity.locked ? 'LOCKED' : 'LOCK'}
                      </button>
                      <button 
                        onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, hidden: !en.hidden } : en))}
                        className={`py-2 rounded text-[10px] font-bold transition-all ${selectedEntity.hidden ? 'bg-cyan-500/20 border border-cyan-500 text-cyan-500' : 'bg-zinc-800 border border-transparent text-zinc-500'}`}
                      >
                        {selectedEntity.hidden ? 'HIDDEN' : 'HIDE'}
                      </button>
                    </div>
                  </div>

                  {/* Moving Platform Controls */}
                  {selectedEntity.type === 'moving-platform' && (
                    <div className="space-y-3 pt-4 border-t border-white/5">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">Speed</span>
                        <input 
                          type="number" 
                          step="0.1"
                          value={selectedEntity.speed || 2} 
                          onChange={e => {
                            const val = parseFloat(e.target.value);
                            updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, speed: val } : en));
                          }}
                          className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                        />
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">Patrol</span>
                        <button 
                          onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, patrol: !en.patrol } : en))}
                          className={`px-3 py-1 rounded text-[10px] font-bold transition-all ${selectedEntity.patrol ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
                        >
                          {selectedEntity.patrol ? 'ON' : 'OFF'}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button 
                          onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, startPos: { x: en.x, y: en.y } } : en))}
                          className="py-2 bg-cyan-500/10 border border-cyan-500/30 text-cyan-500 rounded text-[10px] font-bold hover:bg-cyan-500/20"
                        >
                          SET START
                        </button>
                        <button 
                          onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, endPos: { x: en.x, y: en.y } } : en))}
                          className="py-2 bg-orange-500/10 border border-orange-500/30 text-orange-500 rounded text-[10px] font-bold hover:bg-orange-500/20"
                        >
                          SET END
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Cannon Controls */}
                  {selectedEntity.type === 'cannon' && (
                    <div className="space-y-3 pt-4 border-t border-white/5">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">Type</span>
                        <div className="flex gap-1 bg-zinc-800 p-1 rounded">
                          <button
                            onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, cannonType: 'fireball' } : en))}
                            className={`px-2 py-1 rounded text-[10px] font-bold ${(!selectedEntity.cannonType || selectedEntity.cannonType === 'fireball') ? 'bg-orange-500 text-white' : 'text-zinc-500 hover:text-white'}`}
                          >
                            FIREBALL
                          </button>
                          <button
                            onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, cannonType: 'laser' } : en))}
                            className={`px-2 py-1 rounded text-[10px] font-bold ${selectedEntity.cannonType === 'laser' ? 'bg-red-500 text-white' : 'text-zinc-500 hover:text-white'}`}
                          >
                            LASER
                          </button>
                        </div>
                      </div>
                      <button 
                        onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, endPos: { x: en.x + en.width + 60, y: en.y + en.height / 2 } } : en))}
                        className="w-full py-2 bg-red-500/10 border border-red-500/30 text-red-500 rounded text-[10px] font-bold hover:bg-red-500/20"
                      >
                        RESET TARGET MARKER
                      </button>
                      {(!selectedEntity.cannonType || selectedEntity.cannonType === 'fireball') && (
                        <>
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-zinc-400">Fire Rate</span>
                            <input 
                              type="number" 
                              value={selectedEntity.fireRate || 60} 
                              onChange={e => {
                                const val = parseInt(e.target.value);
                                updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, fireRate: val } : en));
                              }}
                              className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                            />
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-zinc-400">Proj Speed</span>
                            <input 
                              type="number" 
                              step="0.1"
                              value={selectedEntity.projectileSpeed || 5} 
                              onChange={e => {
                                const val = parseFloat(e.target.value);
                                updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, projectileSpeed: val } : en));
                              }}
                              className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                            />
                          </div>
                        </>
                      )}
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">Auto-Rotate</span>
                        <button 
                          onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, rotating: !en.rotating } : en))}
                          className={`px-3 py-1 rounded text-[10px] font-bold transition-all ${selectedEntity.rotating ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
                        >
                          {selectedEntity.rotating ? 'ON' : 'OFF'}
                        </button>
                      </div>
                      {selectedEntity.rotating && (
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-zinc-400">Rot Speed</span>
                          <input 
                            type="number" 
                            step="0.1"
                            value={selectedEntity.rotationSpeed || 1} 
                            onChange={e => {
                              const val = parseFloat(e.target.value);
                              updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, rotationSpeed: val } : en));
                            }}
                            className="w-20 bg-zinc-800 rounded px-2 py-1 text-sm outline-none"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Target Selection for Switches/Buttons */}
                  {(selectedEntity.type === 'lever' || selectedEntity.type === 'pressure-plate') && (
                    <div className="space-y-3 pt-4 border-t border-white/5">
                      <div className="flex flex-col gap-1">
                        <span className="text-sm text-zinc-400">Trigger Type</span>
                        <div className="grid grid-cols-2 gap-1">
                          <button 
                            onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, type: 'lever', width: 20, height: 20, plateType: undefined } : en))}
                            className={`py-1 rounded text-[10px] font-bold transition-all ${selectedEntity.type === 'lever' ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
                          >LEVER</button>
                          <button 
                            onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, type: 'pressure-plate', width: 30, height: 10, plateType: 'momentary' } : en))}
                            className={`py-1 rounded text-[10px] font-bold transition-all ${selectedEntity.type === 'pressure-plate' ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
                          >PLATE</button>
                        </div>
                      </div>

                      {selectedEntity.type === 'pressure-plate' && (
                        <div className="flex flex-col gap-1">
                          <span className="text-sm text-zinc-400">Plate Mode</span>
                          <div className="grid grid-cols-2 gap-1">
                            <button 
                              onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, plateType: 'momentary' } : en))}
                              className={`py-1 rounded text-[10px] font-bold transition-all ${(!selectedEntity.plateType || selectedEntity.plateType === 'momentary') ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
                            >MOMENTARY</button>
                            <button 
                              onClick={() => updateEntities(entities.map(en => en.id === selectedEntity.id ? { ...en, plateType: 'toggle' } : en))}
                              className={`py-1 rounded text-[10px] font-bold transition-all ${selectedEntity.plateType === 'toggle' ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
                            >TOGGLE</button>
                          </div>
                        </div>
                      )}
                      <div className="flex flex-col gap-1">
                        <span className="text-sm text-zinc-400">Target ID</span>
                        <div className="flex gap-2">
                          <input 
                            readOnly
                            value={selectedEntity.targetId || 'None'} 
                            className="flex-1 bg-zinc-800 rounded px-2 py-1 text-xs outline-none text-zinc-500"
                          />
                          <button 
                            onClick={() => setIsSelectingTarget(!isSelectingTarget)}
                            className={`px-3 py-1 rounded text-[10px] font-bold transition-all ${isSelectingTarget ? 'bg-red-500 text-white' : 'bg-cyan-600 text-white'}`}
                          >
                            {isSelectingTarget ? 'CANCEL' : 'LINK'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <button 
                    onClick={deleteSelected}
                    className="w-full flex items-center justify-center gap-2 py-2 bg-red-900/20 text-red-500 rounded-lg hover:bg-red-900/40 transition-colors mt-4"
                  >
                    <Trash2 size={16} /> DELETE
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

        <AnimatePresence>
          {showClearConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-zinc-900 border border-white/10 p-8 rounded-2xl max-w-md w-full shadow-2xl"
              >
                <h2 className="text-2xl font-black mb-4 flex items-center gap-3">
                  <RefreshCw className="text-red-500" /> WIPE ARCHIVE?
                </h2>
                <p className="text-zinc-400 mb-8 leading-relaxed">
                  This will permanently delete all entities in the current architecture. This action cannot be undone.
                </p>
                <div className="flex gap-4">
                  <button 
                    onClick={() => {
                      updateEntities([]);
                      setSelectedEntityIds([]);
                      setShowClearConfirm(false);
                    }}
                    className="flex-1 py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl transition-colors"
                  >
                    CONFIRM WIPE
                  </button>
                  <button 
                    onClick={() => setShowClearConfirm(false)}
                    className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 text-white font-bold rounded-xl transition-colors"
                  >
                    CANCEL
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Canvas Area */}
        <div className="flex-1 bg-black flex items-center justify-center p-8 overflow-auto">
          <div className="relative shadow-2xl border border-white/10">
            <canvas 
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              className="cursor-crosshair"
            />
          </div>
        </div>

        {/* Right Sidebar - Objects Panel */}
        <div className="w-64 bg-zinc-900 border-l border-white/5 flex flex-col overflow-hidden">
          <section className="p-4 border-b border-white/5 flex-shrink-0">
            <h3 className="text-xs text-zinc-500 uppercase tracking-widest">Scene Objects</h3>
          </section>
          <div className="flex-1 overflow-y-auto p-2 custom-scrollbar space-y-1">
            {[...entities].reverse().map((entity, reverseIndex) => {
              const index = entities.length - 1 - reverseIndex;
              return (
              <div 
                key={entity.id}
                className={`w-full text-left px-3 py-2 rounded flex items-center justify-between text-xs cursor-pointer ${
                  selectedEntityIds.includes(entity.id) 
                    ? 'bg-cyan-500/20 text-cyan-500 border border-cyan-500/50' 
                    : 'text-zinc-400 hover:bg-zinc-800 border border-transparent'
                }`}
                onClick={(e) => {
                  if (e.shiftKey) {
                    if (selectedEntityIds.includes(entity.id)) {
                      setSelectedEntityIds(selectedEntityIds.filter(id => id !== entity.id));
                    } else {
                      setSelectedEntityIds([...selectedEntityIds, entity.id]);
                    }
                  } else {
                    setSelectedEntityIds([entity.id]);
                  }
                }}
              >
                <div className="flex items-center gap-2 overflow-hidden flex-1">
                  <span className="opacity-50 text-[10px] w-4 text-right">{index + 1}</span>
                  <div className="w-4 flex justify-center">{getEntityIcon(entity)}</div>
                  <div className="flex flex-col overflow-hidden">
                    <span className="truncate font-bold uppercase leading-tight">{entity.type}</span>
                    <span className="text-[9px] text-zinc-500 truncate leading-tight">
                      {Math.round(entity.x)}, {Math.round(entity.y)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      updateEntities(entities.map(en => en.id === entity.id ? { ...en, hidden: !en.hidden } : en));
                    }}
                    className="p-1 hover:bg-zinc-700 rounded transition-colors"
                  >
                    {entity.hidden ? <EyeOff size={12} className="text-zinc-500" /> : <Eye size={12} className="text-zinc-400" />}
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      updateEntities(entities.map(en => en.id === entity.id ? { ...en, locked: !en.locked } : en));
                    }}
                    className="p-1 hover:bg-zinc-700 rounded transition-colors"
                  >
                    {entity.locked ? <Lock size={12} className="text-orange-500" /> : <Unlock size={12} className="text-zinc-400" />}
                  </button>
                </div>
              </div>
            )})}
            {entities.length === 0 && (
              <div className="text-center p-4 text-zinc-600 text-xs">
                No objects in scene
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className={`fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full font-bold shadow-2xl z-[100] flex items-center gap-3 border ${
              toast.type === 'success' ? 'bg-green-500/20 border-green-500 text-green-500' :
              toast.type === 'error' ? 'bg-red-500/20 border-red-500 text-red-500' :
              'bg-cyan-500/20 border-cyan-500 text-cyan-500'
            }`}
          >
            <div className={`w-2 h-2 rounded-full ${
              toast.type === 'success' ? 'bg-green-500' :
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

function ToolBtn({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border transition-all ${
        active ? 'bg-cyan-500/20 border-cyan-500 text-cyan-500' : 'bg-zinc-800 border-transparent hover:border-zinc-600'
      }`}
    >
      <div className="mb-0.5">{icon}</div>
      <span className="text-[9px] font-bold uppercase leading-tight">{label}</span>
    </button>
  );
}

function getEntityIcon(entity: Entity) {
  switch (entity.type) {
    case 'platform': return <Layers size={12} />;
    case 'box': return <Square size={12} />;
    case 'hazard': 
      if (entity.hazardType === 'fire') return <span className="text-orange-500 text-[10px]">🔥</span>;
      if (entity.hazardType === 'water') return <span className="text-cyan-500 text-[10px]">Wtr</span>;
      if (entity.hazardType === 'acid') return <span className="text-green-500 text-[10px]">Acd</span>;
      return <Triangle size={12} />;
    case 'door':
      return <div className={`w-1.5 h-2.5 border ${entity.color === '#ff4400' ? 'border-orange-500' : 'border-cyan-500'}`} />;
    case 'gem':
      return <div className={`w-1.5 h-1.5 rotate-45 ${entity.color === '#ff4400' ? 'bg-orange-500' : 'bg-cyan-500'}`} />;
    case 'lever':
    case 'pressure-plate':
      return <div className="w-2.5 h-0.5 bg-zinc-500 relative"><div className="absolute top-[-2px] left-1/2 -translate-x-1/2 w-0.5 h-1.5 bg-zinc-400 rotate-12" /></div>;
    case 'moving-platform':
      return <div className="w-2.5 h-1 bg-zinc-600 border-x border-cyan-500" />;
    case 'cannon':
      return <Play size={12} className="rotate-90 text-red-500" />;
    default:
      if (entity.shape === 'circle') return <Circle size={12} />;
      if (entity.shape === 'triangle') return <Triangle size={12} />;
      return <Square size={12} />;
  }
}
