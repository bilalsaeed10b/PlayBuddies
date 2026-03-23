// Bilal Saeed xxxxx
import type { Fish } from "../types";

export class GameEngine {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private bgImage: HTMLImageElement;
  private fishBodyImg: HTMLImageElement;
  private fishTailImg: HTMLImageElement;
  private sharkImg: HTMLImageElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    
    this.bgImage = new Image();
    this.bgImage.src = "./assets/ocean_bg.png";
    
    this.fishBodyImg = new Image();
    this.fishBodyImg.src = "./assets/player_fish_body.png";
    
    this.fishTailImg = new Image();
    this.fishTailImg.src = "./assets/player_fish_tail.png";
    
    this.sharkImg = new Image();
    this.sharkImg.src = "./assets/enemy_shark.png";
  }

  public drawBackground() {
    this.ctx.drawImage(this.bgImage, 0, 0, this.canvas.width, this.canvas.height);
  }

  public drawFish(fish: Fish, time: number) {
    if (fish.isDead) return;

    this.ctx.save();
    this.ctx.translate(fish.x, fish.y);
    
    // Rotate towards direction
    this.ctx.rotate(fish.angle);
    
    // Scale based on radius/size
    const baseRadius = 20;
    const scale = fish.radius / baseRadius;
    this.ctx.scale(scale, scale);

    // Tail animation (simple wobble)
    const tailWobble = Math.sin(time / 100) * 0.3;
    this.ctx.save();
    this.ctx.translate(-15, 0);
    this.ctx.rotate(tailWobble);
    this.ctx.drawImage(this.fishTailImg, -10, -10, 20, 20);
    this.ctx.restore();

    // Body
    if (fish.radius > 50) {
      // Large fish use shark image
      this.ctx.drawImage(this.sharkImg, -20, -20, 40, 40);
    } else {
      this.ctx.drawImage(this.fishBodyImg, -15, -15, 30, 30);
    }
    
    this.ctx.restore();
    
    // Draw Name
    if (fish.displayName) {
      this.ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      this.ctx.font = "bold 14px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.fillText(fish.displayName, fish.x, fish.y - fish.radius - 10);
    }
  }

  public updateFish(fish: Fish, dt: number) {
    // Movement logic
    const dx = Math.cos(fish.angle) * fish.speed * dt;
    const dy = Math.sin(fish.angle) * fish.speed * dt;
    
    fish.x += dx;
    fish.y += dy;

    // Constrain to canvas
    if (fish.x < 0) fish.x = 0;
    if (fish.x > this.canvas.width) fish.x = this.canvas.width;
    if (fish.y < 0) fish.y = 0;
    if (fish.y > this.canvas.height) fish.y = this.canvas.height;
  }

  public spawnEnemy(minRadius: number, maxRadius: number): Fish {
    const side = Math.floor(Math.random() * 4);
    let x = 0, y = 0;
    
    if (side === 0) { x = Math.random() * this.canvas.width; y = -50; }
    else if (side === 1) { x = this.canvas.width + 50; y = Math.random() * this.canvas.height; }
    else if (side === 2) { x = Math.random() * this.canvas.width; y = this.canvas.height + 50; }
    else { x = -50; y = Math.random() * this.canvas.height; }

    const radius = minRadius + Math.random() * (maxRadius - minRadius);
    const targetX = Math.random() * this.canvas.width;
    const targetY = Math.random() * this.canvas.height;
    const angle = Math.atan2(targetY - y, targetX - x);

    return {
      id: "enemy-" + Math.random().toString(36).substr(2, 9),
      x, y, radius, angle, speed: 0.1 + Math.random() * 0.1,
      color: "red", type: "enemy", isDead: false, score: 0
    };
  }

  public checkCollision(a: Fish, b: Fish) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const distanceSq = dx * dx + dy * dy;
    const radiusSum = a.radius + b.radius;
    return distanceSq < radiusSum * radiusSum;
  }
}
// Bilal Saeed xxxxx
