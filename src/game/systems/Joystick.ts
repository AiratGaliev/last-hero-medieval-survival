import Phaser from 'phaser';

// ============ Виртуальный джойстик для мобильных ============

export class Joystick {
  readonly active = false;
  private scene: Phaser.Scene;
  private base!: Phaser.GameObjects.Graphics;
  private knob!: Phaser.GameObjects.Graphics;
  private baseX = 0;
  private baseY = 0;
  private pointerId = -1;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.base = scene.add.graphics().setDepth(3000).setVisible(false);
    this.knob = scene.add.graphics().setDepth(3001).setVisible(false);
    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.pointerId !== -1) return;
      // Игнорируем клики по верхней зоне (кнопка паузы) и правому нижнему углу
      const { width } = scene.scale;
      if (p.x > width - 90 && p.y < 120) return;
      this.pointerId = p.id;
      this.baseX = p.x; this.baseY = p.y;
      this.show();
    });
    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (p.id !== this.pointerId) return;
      const dx = p.x - this.baseX, dy = p.y - this.baseY;
      const len = Math.hypot(dx, dy);
      const R = 56;
      const k = len > R ? R / len : 1;
      this.vx = (dx * k) / R;
      this.vy = (dy * k) / R;
      this.draw(dx * k, dy * k);
    });
    const release = (p: Phaser.Input.Pointer) => {
      if (p.id !== this.pointerId) return;
      this.pointerId = -1;
      this.vx = 0; this.vy = 0;
      this.base.setVisible(false);
      this.knob.setVisible(false);
    };
    scene.input.on('pointerup', release);
    scene.input.on('pointerupoutside', release);
  }

  private show(): void {
    this.base.setVisible(true);
    this.knob.setVisible(true);
    this.draw(0, 0);
  }

  private draw(kx: number, ky: number): void {
    this.base.clear();
    this.base.fillStyle(0x000000, 0.25).fillCircle(this.baseX, this.baseY, 56);
    this.base.lineStyle(3, 0xffffff, 0.5).strokeCircle(this.baseX, this.baseY, 56);
    this.knob.clear();
    this.knob.fillStyle(0xffffff, 0.55).fillCircle(this.baseX + kx, this.baseY + ky, 26);
    this.knob.lineStyle(3, 0x223322, 0.6).strokeCircle(this.baseX + kx, this.baseY + ky, 26);
  }

  get vector(): { x: number; y: number } {
    return { x: this.vx, y: this.vy };
  }
}
