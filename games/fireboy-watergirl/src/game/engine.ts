import { Entity, Level, PlayerState, Vector } from '../types';

export const GRAVITY = 0.5;
export const JUMP_FORCE = -11;
export const MOVE_SPEED = 4.5;
export const ACCELERATION = 0.8;
export const DECELERATION = 1;
export const STOPPING_POWER = 0.75; // 1 means instant stop, 0 means infinite slide
export const AIR_RESISTANCE = 0.95;

export class GameEngine {
  level: Level;
  player1: PlayerState;
  player2: PlayerState;
  startTime: number;
  projectiles: { x: number, y: number, vx: number, vy: number, radius: number }[] = [];
  onEvent?: (event: 'jump' | 'collect' | 'death' | 'win', data?: any) => void;
  private collidingEntities: Set<string> = new Set();
  private lastFireTime: Record<string, number> = {};
  private fireCounters: Record<string, number> = {};

  constructor(level: Level) {
    this.level = JSON.parse(JSON.stringify(level));
    this.startTime = Date.now();
    this.player1 = {
      x: level.fireStart.x,
      y: level.fireStart.y,
      vx: 0,
      vy: 0,
      role: 'fire',
      isGrounded: false,
      isDead: false,
      atDoor: false,
      animFrame: 0,
      animState: 'idle',
      facing: 'right',
      score: 0,
    };
    this.player2 = {
      x: level.waterStart.x,
      y: level.waterStart.y,
      vx: 0,
      vy: 0,
      role: 'water',
      isGrounded: false,
      isDead: false,
      atDoor: false,
      animFrame: 0,
      animState: 'idle',
      facing: 'right',
      score: 0,
    };
  }

  update(keys: Set<string>) {
    if (this.player1.isDead || this.player2.isDead) return;

    // Reset pressure plates at the start of update
    for (const entity of this.level.entities) {
      if (entity.type === 'pressure-plate' && entity.plateType !== 'toggle') {
        entity.active = false;
      }
    }

    const currentCollisions = new Set<string>();
    this.updatePlayer(this.player1, keys, 'KeyW', 'KeyA', 'KeyD', currentCollisions);
    this.updatePlayer(this.player2, keys, 'ArrowUp', 'ArrowLeft', 'ArrowRight', currentCollisions);
    
    // Update collidingEntities for next frame
    this.collidingEntities = currentCollisions;

    // Update projectiles
    this.projectiles = this.projectiles.filter(p => {
      p.x += p.vx;
      p.y += p.vy;

      // Check collision with players
      const players = [this.player1, this.player2];
      for (const player of players) {
        const dx = (player.x + 15) - p.x;
        const dy = (player.y + 20) - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < p.radius + 15) {
          player.isDead = true;
          if (this.onEvent) this.onEvent('death', player);
        }
      }

      // Keep if within bounds
      return p.x > -100 && p.x < 900 && p.y > -100 && p.y < 700;
    });

    // Sync targets
    for (const entity of this.level.entities) {
      if (entity.type === 'pressure-plate') {
        // Check if any box is on this plate
        const boxOnPlate = this.level.entities.some(e => 
          e.type === 'box' && 
          e.x < entity.x + entity.width &&
          e.x + e.width > entity.x &&
          e.y < entity.y + entity.height &&
          e.y + e.height > entity.y
        );
        if (boxOnPlate) {
          entity.active = true;
        }
      }
      if ((entity.type === 'pressure-plate' || entity.type === 'lever') && entity.targetId) {
        const target = this.level.entities.find(e => e.id === entity.targetId);
        if (target) {
          target.active = entity.active;
        }
      }
    }

    this.updateEntities();
  }

  updatePlayer(player: PlayerState, keys: Set<string>, up: string, left: string, right: string, currentCollisions: Set<string>) {
    const world = this.level.worldSettings;
    const speedMult = world?.speedMultiplier || 1;
    const jumpMult = world?.jumpMultiplier || 1;
    const gravMult = world?.gravityMultiplier || 1;
    const windX = world?.windX || 0;
    const windY = world?.windY || 0;

    // Movement
    if (keys.has(left)) {
      player.vx -= ACCELERATION * speedMult;
      if (player.vx < -MOVE_SPEED * speedMult) player.vx = -MOVE_SPEED * speedMult;
      player.facing = 'left';
    }
    else if (keys.has(right)) {
      player.vx += ACCELERATION * speedMult;
      if (player.vx > MOVE_SPEED * speedMult) player.vx = MOVE_SPEED * speedMult;
      player.facing = 'right';
    }
    else {
      if (player.isGrounded) {
        player.vx *= (1 - STOPPING_POWER);
      } else {
        player.vx *= AIR_RESISTANCE;
      }
      if (Math.abs(player.vx) < 0.1) player.vx = 0;
    }

    // Apply wind
    player.vx += windX;
    player.vy += windY;

    // Jump
    if (keys.has(up) && player.isGrounded) {
      player.vy = JUMP_FORCE * jumpMult;
      player.isGrounded = false;
      if (this.onEvent) this.onEvent('jump', player);
    }

    // Animation state
    if (!player.isGrounded) {
      player.animState = 'jump';
    } else if (Math.abs(player.vx) > 0.5) {
      player.animState = 'run';
    } else {
      player.animState = 'idle';
    }

    // Frame counter
    player.animFrame += 0.15;
    if (player.animFrame >= 4) player.animFrame = 0;

    // Gravity
    player.vy += GRAVITY * gravMult;
    player.x += player.vx;
    player.y += player.vy;

    // Collisions
    player.isGrounded = false;
    player.atDoor = false;

    for (const entity of this.level.entities) {
      if (this.checkCollision(player, entity)) {
        if (entity.type === 'platform' || entity.type === 'moving-platform' || entity.type === 'box') {
          this.resolvePlatformCollision(player, entity);
        } else if (entity.type === 'hazard') {
          if (entity.hazardType === 'acid') { player.isDead = true; if (this.onEvent) this.onEvent('death', player); }
          if (entity.hazardType === 'fire' && player.role === 'water') { player.isDead = true; if (this.onEvent) this.onEvent('death', player); }
          if (entity.hazardType === 'water' && player.role === 'fire') { player.isDead = true; if (this.onEvent) this.onEvent('death', player); }
        } else if (entity.type === 'door') {
          if ((entity.color === '#ff4400' && player.role === 'fire') || 
              (entity.color === '#00ccff' && player.role === 'water')) {
            player.atDoor = true;
          }
        } else if (entity.type === 'pressure-plate') {
          entity.active = true;
        } else if (entity.type === 'lever') {
          const collisionKey = `${player.role}-${entity.id}`;
          currentCollisions.add(collisionKey);
          
          // Toggle on initial touch
          if (!this.collidingEntities.has(collisionKey)) {
            entity.active = !entity.active;
          }
        } else if (entity.type === 'gem' && !entity.collected) {
          if ((entity.color === '#ff4400' && player.role === 'fire') || 
              (entity.color === '#00ccff' && player.role === 'water')) {
            entity.collected = true;
            player.score += 10;
            if (this.onEvent) this.onEvent('collect', entity);
          }
        }
      }
    }

    // Screen bounds
    if (player.x < 0) player.x = 0;
    if (player.x > 800 - 30) player.x = 800 - 30;
    if (player.y > 600) {
      if (!player.isDead) {
        player.isDead = true;
        if (this.onEvent) this.onEvent('death', player);
      }
    }
  }

  updateEntities() {
    const now = Date.now();
    for (const entity of this.level.entities) {
      // Handle cannon firing
      if (entity.type === 'cannon') {
        let angle = (entity.rotation || 0) * Math.PI / 180;
        let maxDist = 1200;
        
        // If it has a target position and is NOT automatically rotating, use the target
        if (entity.endPos && !entity.rotating) {
          const centerX = entity.x + entity.width / 2;
          const centerY = entity.y + entity.height / 2;
          angle = Math.atan2(entity.endPos.y - centerY, entity.endPos.x - centerX);
          maxDist = Math.hypot(entity.endPos.x - centerX, entity.endPos.y - centerY);
          // Update rotation for rendering consistency
          entity.rotation = angle * 180 / Math.PI;
        }

        if (entity.cannonType === 'laser') {
          // Calculate laser end point
          let lx = entity.x + entity.width / 2;
          let ly = entity.y + entity.height / 2;
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          const step = 5;
          let hit = false;
          let currentDist = 0;
          
          for (let i = 0; i < maxDist; i += step) {
            lx += dx * step;
            ly += dy * step;
            currentDist += step;
            
            if (lx < 0 || lx > 800 || ly < 0 || ly > 600) break;
            
            // Check collision with solid entities
            for (const ent of this.level.entities) {
              if (ent.id !== entity.id && (ent.type === 'platform' || ent.type === 'box' || ent.type === 'moving-platform')) {
                if (lx >= ent.x && lx <= ent.x + ent.width && ly >= ent.y && ly <= ent.y + ent.height) {
                  hit = true;
                  break;
                }
              }
            }
            
            if (hit) break;
            
            // Check collision with players
            const pWidth = 30;
            const pHeight = 40;
            if (!this.player1.isDead && lx >= this.player1.x && lx <= this.player1.x + pWidth && ly >= this.player1.y && ly <= this.player1.y + pHeight) {
              this.player1.isDead = true;
              if (this.onEvent) this.onEvent('death', this.player1);
              hit = true;
              break;
            }
            if (!this.player2.isDead && lx >= this.player2.x && lx <= this.player2.x + pWidth && ly >= this.player2.y && ly <= this.player2.y + pHeight) {
              this.player2.isDead = true;
              if (this.onEvent) this.onEvent('death', this.player2);
              hit = true;
              break;
            }
          }
          
          entity.laserEnd = { x: lx, y: ly };
        } else {
          const fireRate = entity.fireRate || 60;
          if (!this.fireCounters[entity.id]) this.fireCounters[entity.id] = 0;
          
          this.fireCounters[entity.id]++;
          
          if (this.fireCounters[entity.id] >= fireRate) {
            this.fireCounters[entity.id] = 0;
            const speed = (entity.projectileSpeed || 5) * 0.2;
            this.projectiles.push({
              x: entity.x + entity.width / 2,
              y: entity.y + entity.height / 2,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              radius: 8
            });
          }
        }
      }

      // Handle automatic rotation
      if (entity.rotating) {
        const speed = (entity.rotationSpeed || 1) * 0.2;
        entity.rotation = (entity.rotation || 0) + speed;
        if (entity.rotation >= 360) entity.rotation -= 360;
        if (entity.rotation < 0) entity.rotation += 360;
      }

      if (entity.type === 'moving-platform' && entity.startPos && entity.endPos) {
        const target = entity.active ? entity.endPos : entity.startPos;
        const dx = target.x - entity.x;
        const dy = target.y - entity.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist > 1) {
          const speed = (entity.speed || 2) * 0.2;
          const vx = (dx / dist) * speed;
          const vy = (dy / dist) * speed;
          
          entity.x += vx;
          entity.y += vy;
          entity.vx = vx;
          entity.vy = vy;
        } else {
          entity.vx = 0;
          entity.vy = 0;
          // Toggle active state for patrolling platforms
          if (entity.patrol) {
            entity.active = !entity.active;
          }
        }
      }
    }
  }

  checkCollision(player: PlayerState, entity: Entity) {
    const pWidth = 30;
    const pHeight = 40;

    if (entity.shape === 'circle') {
      // Simple AABB vs Circle
      const centerX = entity.x + entity.width / 2;
      const centerY = entity.y + entity.height / 2;
      const radius = Math.min(entity.width, entity.height) / 2;

      const closestX = Math.max(player.x, Math.min(centerX, player.x + pWidth));
      const closestY = Math.max(player.y, Math.min(centerY, player.y + pHeight));

      const distanceX = centerX - closestX;
      const distanceY = centerY - closestY;
      const distanceSquared = (distanceX * distanceX) + (distanceY * distanceY);
      return distanceSquared < (radius * radius);
    }

    if (entity.shape === 'triangle') {
      // Simple AABB vs Triangle (bounding box check first)
      const inBounds = (
        player.x < entity.x + entity.width &&
        player.x + pWidth > entity.x &&
        player.y < entity.y + entity.height &&
        player.y + pHeight > entity.y
      );
      if (!inBounds) return false;

      // More precise check for triangle (slope)
      // Assuming triangle is pointing up (isosceles)
      const relX = (player.x + pWidth / 2) - entity.x;
      const normalizedX = relX / entity.width;
      const triangleTopY = entity.y + (Math.abs(normalizedX - 0.5) * 2) * entity.height;
      return player.y + pHeight > triangleTopY;
    }

    return (
      player.x < entity.x + entity.width &&
      player.x + pWidth > entity.x &&
      player.y < entity.y + entity.height &&
      player.y + pHeight > entity.y
    );
  }

  resolvePlatformCollision(player: PlayerState, entity: Entity) {
    const pWidth = 30;
    const pHeight = 40;
    
    if (entity.shape === 'triangle') {
      // Slope logic
      const relX = (player.x + pWidth / 2) - entity.x;
      const normalizedX = Math.max(0, Math.min(1, relX / entity.width));
      const slopeY = entity.y + (Math.abs(normalizedX - 0.5) * 2) * entity.height;
      
      if (player.y + pHeight > slopeY && player.vy >= 0) {
        player.y = slopeY - pHeight;
        player.vy = 0;
        player.isGrounded = true;
      }
      return;
    }

    const overlapX = Math.min(player.x + pWidth, entity.x + entity.width) - Math.max(player.x, entity.x);
    const overlapY = Math.min(player.y + pHeight, entity.y + entity.height) - Math.max(player.y, entity.y);

    if (overlapX > overlapY) {
      if (player.y < entity.y) {
        player.y = entity.y - pHeight;
        player.vy = 0;
        player.isGrounded = true;
        // Inherit platform velocity
        if (entity.type === 'moving-platform' && entity.vx !== undefined) {
          player.x += entity.vx;
        }
      } else {
        player.y = entity.y + entity.height;
        player.vy = 0;
      }
    } else {
      if (player.x < entity.x) {
        player.x = entity.x - pWidth;
      } else {
        player.x = entity.x + entity.width;
      }
    }
  }
}
