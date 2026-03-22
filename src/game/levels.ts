import { Level } from '../types/game';

export const DEFAULT_LEVELS: Level[] = [
  {
    id: 1,
    name: "The Beginning",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'wall-l', x: 0, y: 0, width: 20, height: 600, type: 'platform' },
      { id: 'wall-r', x: 780, y: 0, width: 20, height: 600, type: 'platform' },
      { id: 'fire-pool', x: 200, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'fire' },
      { id: 'water-pool', x: 400, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'water' },
      { id: 'p1', x: 300, y: 480, width: 200, height: 20, type: 'platform' },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 650, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
      { id: 'gem-1', x: 350, y: 430, width: 20, height: 20, type: 'gem', color: '#ff4400' },
      { id: 'gem-2', x: 400, y: 430, width: 20, height: 20, type: 'gem', color: '#00ccff' },
    ]
  },
  {
    id: 2,
    name: "Cooperation",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 50, y: 400 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'p-mid', x: 0, y: 350, width: 400, height: 20, type: 'platform' },
      { id: 'lever-1', x: 350, y: 320, width: 20, height: 30, type: 'lever', targetId: 'm-p1' },
      { id: 'm-p1', x: 450, y: 450, width: 100, height: 20, type: 'moving-platform', startPos: { x: 450, y: 450 }, endPos: { x: 450, y: 200 }, speed: 2, active: false },
      { id: 'acid-pool', x: 200, y: 540, width: 400, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'door-fire', x: 700, y: 130, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 650, y: 130, width: 40, height: 70, type: 'door', color: '#00ccff' },
      { id: 'p-top', x: 600, y: 200, width: 200, height: 20, type: 'platform' },
      { id: 'gem-3', x: 450, y: 400, width: 20, height: 20, type: 'gem', color: '#ff4400' },
      { id: 'gem-4', x: 500, y: 150, width: 20, height: 20, type: 'gem', color: '#00ccff' },
    ]
  },
  {
    id: 3,
    name: "The Pit",
    fireStart: { x: 50, y: 100 },
    waterStart: { x: 100, y: 100 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'p1', x: 0, y: 150, width: 200, height: 20, type: 'platform' },
      { id: 'p2', x: 300, y: 250, width: 200, height: 20, type: 'platform' },
      { id: 'p3', x: 600, y: 350, width: 200, height: 20, type: 'platform' },
      { id: 'acid-1', x: 200, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'fire-1', x: 300, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'fire' },
      { id: 'water-1', x: 400, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'water' },
      { id: 'btn-1', x: 700, y: 320, width: 30, height: 10, type: 'pressure-plate', targetId: 'lift-1' },
      { id: 'lift-1', x: 50, y: 500, width: 100, height: 20, type: 'moving-platform', startPos: { x: 50, y: 500 }, endPos: { x: 50, y: 200 }, speed: 3, active: false },
      { id: 'door-fire', x: 50, y: 130, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 100, y: 130, width: 40, height: 70, type: 'door', color: '#00ccff' },
      { id: 'gem-5', x: 350, y: 200, width: 20, height: 20, type: 'gem', color: '#ff4400' },
      { id: 'gem-6', x: 650, y: 300, width: 20, height: 20, type: 'gem', color: '#00ccff' },
    ]
  },
  {
    id: 4,
    name: "The Switch",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 700, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'wall-l', x: 0, y: 0, width: 20, height: 600, type: 'platform' },
      { id: 'wall-r', x: 780, y: 0, width: 20, height: 600, type: 'platform' },
      { id: 'acid-mid', x: 300, y: 540, width: 200, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'lever-fire', x: 100, y: 520, width: 20, height: 30, type: 'lever', targetId: 'plat-water' },
      { id: 'lever-water', x: 680, y: 520, width: 20, height: 30, type: 'lever', targetId: 'plat-fire' },
      { id: 'plat-fire', x: 150, y: 400, width: 150, height: 20, type: 'moving-platform', startPos: { x: 150, y: 400 }, endPos: { x: 150, y: 400 }, speed: 0, active: false },
      { id: 'plat-water', x: 500, y: 400, width: 150, height: 20, type: 'moving-platform', startPos: { x: 500, y: 400 }, endPos: { x: 500, y: 400 }, speed: 0, active: false },
      { id: 'mid-1', x: 350, y: 300, width: 100, height: 20, type: 'platform' },
      { id: 'top-l', x: 50, y: 150, width: 200, height: 20, type: 'platform' },
      { id: 'top-r', x: 550, y: 150, width: 200, height: 20, type: 'platform' },
      { id: 'door-fire', x: 100, y: 80, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 650, y: 80, width: 40, height: 70, type: 'door', color: '#00ccff' },
      { id: 'gem-7', x: 400, y: 250, width: 20, height: 20, type: 'gem', color: '#ff4400' },
      { id: 'gem-8', x: 400, y: 350, width: 20, height: 20, type: 'gem', color: '#00ccff' },
    ]
  },
  {
    id: 5,
    name: "Elemental Divide",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 50, y: 250 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'mid-floor', x: 0, y: 300, width: 800, height: 20, type: 'platform' },
      { id: 'fire-hazard-1', x: 200, y: 540, width: 150, height: 10, type: 'hazard', hazardType: 'water' },
      { id: 'fire-hazard-2', x: 450, y: 540, width: 150, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'fire-btn', x: 700, y: 540, width: 30, height: 10, type: 'pressure-plate', targetId: 'water-gate' },
      { id: 'water-hazard-1', x: 200, y: 290, width: 150, height: 10, type: 'hazard', hazardType: 'fire' },
      { id: 'water-hazard-2', x: 450, y: 290, width: 150, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'water-gate', x: 600, y: 200, width: 20, height: 100, type: 'moving-platform', startPos: { x: 600, y: 200 }, endPos: { x: 600, y: 50 }, speed: 2, active: false },
      { id: 'climb-1', x: 750, y: 0, width: 50, height: 600, type: 'platform' },
      { id: 'door-fire', x: 50, y: 50, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 120, y: 50, width: 40, height: 70, type: 'door', color: '#00ccff' },
      { id: 'top-plat', x: 0, y: 120, width: 200, height: 20, type: 'platform' },
      { id: 'gem-9', x: 300, y: 450, width: 20, height: 20, type: 'gem', color: '#ff4400' },
      { id: 'gem-10', x: 300, y: 200, width: 20, height: 20, type: 'gem', color: '#00ccff' },
    ]
  },
  {
    id: 6,
    name: "The Gauntlet",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'acid-main', x: 150, y: 540, width: 500, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'p1', x: 200, y: 450, width: 60, height: 20, type: 'platform' },
      { id: 'p2', x: 350, y: 400, width: 60, height: 20, type: 'platform' },
      { id: 'p3', x: 500, y: 450, width: 60, height: 20, type: 'platform' },
      { id: 'mp1', x: 650, y: 500, width: 80, height: 20, type: 'moving-platform', startPos: { x: 650, y: 500 }, endPos: { x: 650, y: 200 }, speed: 2, active: true },
      { id: 'mp2', x: 500, y: 200, width: 80, height: 20, type: 'moving-platform', startPos: { x: 500, y: 200 }, endPos: { x: 200, y: 200 }, speed: 2, active: true },
      { id: 'fire-top', x: 300, y: 190, width: 100, height: 10, type: 'hazard', hazardType: 'fire' },
      { id: 'water-top', x: 400, y: 190, width: 100, height: 10, type: 'hazard', hazardType: 'water' },
      { id: 'door-fire', x: 50, y: 130, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 100, y: 130, width: 40, height: 70, type: 'door', color: '#00ccff' },
      { id: 'final-plat', x: 0, y: 200, width: 200, height: 20, type: 'platform' },
      { id: 'gem-11', x: 380, y: 350, width: 20, height: 20, type: 'gem', color: '#ff4400' },
      { id: 'gem-12', x: 380, y: 150, width: 20, height: 20, type: 'gem', color: '#00ccff' },
    ]
  },
  {
    id: 7,
    name: "Symmetry",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 720, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'p1', x: 200, y: 400, width: 100, height: 20, type: 'platform' },
      { id: 'p2', x: 500, y: 400, width: 100, height: 20, type: 'platform' },
      { id: 'fire-1', x: 200, y: 390, width: 100, height: 10, type: 'hazard', hazardType: 'water' },
      { id: 'water-1', x: 500, y: 390, width: 100, height: 10, type: 'hazard', hazardType: 'fire' },
      { id: 'door-fire', x: 350, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 410, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 8,
    name: "The Climb",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'p1', x: 200, y: 450, width: 100, height: 20, type: 'platform' },
      { id: 'p2', x: 400, y: 350, width: 100, height: 20, type: 'platform' },
      { id: 'p3', x: 200, y: 250, width: 100, height: 20, type: 'platform' },
      { id: 'p4', x: 400, y: 150, width: 100, height: 20, type: 'platform' },
      { id: 'door-fire', x: 410, y: 80, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 450, y: 80, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 9,
    name: "Acid Maze",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'acid-1', x: 200, y: 540, width: 400, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'p1', x: 250, y: 450, width: 50, height: 20, type: 'platform' },
      { id: 'p2', x: 350, y: 350, width: 50, height: 20, type: 'platform' },
      { id: 'p3', x: 450, y: 450, width: 50, height: 20, type: 'platform' },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 750, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 10,
    name: "Double Trouble",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'fire-1', x: 200, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'fire' },
      { id: 'water-1', x: 400, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'water' },
      { id: 'acid-1', x: 600, y: 540, width: 100, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 750, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 11,
    name: "The Bridge",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'btn-1', x: 200, y: 540, width: 30, height: 10, type: 'pressure-plate', targetId: 'bridge' },
      { id: 'bridge', x: 300, y: 400, width: 200, height: 20, type: 'moving-platform', startPos: { x: 300, y: 400 }, endPos: { x: 300, y: 400 }, speed: 0, active: false },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 750, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 12,
    name: "Leap of Faith",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 200, height: 50, type: 'platform' },
      { id: 'floor-end', x: 600, y: 550, width: 200, height: 50, type: 'platform' },
      { id: 'acid-pit', x: 200, y: 580, width: 400, height: 20, type: 'hazard', hazardType: 'acid' },
      { id: 'p1', x: 350, y: 400, width: 100, height: 20, type: 'platform' },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 750, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 13,
    name: "Synchronized",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'mp1', x: 200, y: 500, width: 100, height: 20, type: 'moving-platform', startPos: { x: 200, y: 500 }, endPos: { x: 200, y: 200 }, speed: 2, active: true },
      { id: 'mp2', x: 500, y: 500, width: 100, height: 20, type: 'moving-platform', startPos: { x: 500, y: 500 }, endPos: { x: 500, y: 200 }, speed: 2, active: true },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 750, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 14,
    name: "The Maze",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'wall1', x: 200, y: 300, width: 20, height: 250, type: 'platform' },
      { id: 'wall2', x: 400, y: 0, width: 20, height: 250, type: 'platform' },
      { id: 'wall3', x: 600, y: 300, width: 20, height: 250, type: 'platform' },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 750, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  },
  {
    id: 15,
    name: "Final Chamber",
    fireStart: { x: 50, y: 500 },
    waterStart: { x: 100, y: 500 },
    entities: [
      { id: 'floor', x: 0, y: 550, width: 800, height: 50, type: 'platform' },
      { id: 'acid-all', x: 150, y: 540, width: 500, height: 10, type: 'hazard', hazardType: 'acid' },
      { id: 'p1', x: 200, y: 400, width: 50, height: 20, type: 'platform' },
      { id: 'p2', x: 300, y: 300, width: 50, height: 20, type: 'platform' },
      { id: 'p3', x: 400, y: 200, width: 50, height: 20, type: 'platform' },
      { id: 'p4', x: 500, y: 300, width: 50, height: 20, type: 'platform' },
      { id: 'p5', x: 600, y: 400, width: 50, height: 20, type: 'platform' },
      { id: 'door-fire', x: 700, y: 480, width: 40, height: 70, type: 'door', color: '#ff4400' },
      { id: 'door-water', x: 750, y: 480, width: 40, height: 70, type: 'door', color: '#00ccff' },
    ]
  }
];

export function getLevels(): Level[] {
  const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{}');
  return DEFAULT_LEVELS.map(level => overrides[level.id] || level);
}
