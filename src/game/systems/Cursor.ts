// ============ Курсор в стиле Tiny Swords ============
//
// Системная стрелка над игрой выглядит чужеродно, а Phaser поверх своего
// курсора всё равно не даёт подставить свой: useHandCursor пишет в канвас
// инлайновый `cursor: pointer`. Поэтому состояние курсора ведём сами —
// переключаем класс на элементе canvas, а в CSS стоит !important, который
// перебивает инлайновый стиль.
//
// Четыре состояния — все четыре курсора из набора ui/cursors:
//   обычный (стрелка), наведение (ладонь), запрет (заблокировано),
// перетаскивание (уголок). Точки привязки измерены по непрозрачным
// пикселям, см. scripts/probe-cursors.mjs.

import Phaser from 'phaser';

export type CursorKind = 'default' | 'pointer' | 'disabled' | 'active';

/** Классы, которые вешаются на canvas: см. styles.css. */
const CLASS: Record<CursorKind, string | null> = {
  default: null,
  pointer: 'cur-pointer',
  disabled: 'cur-disabled',
  active: 'cur-active',
};

/** Ключ данных на игровом объекте, помечающий заблокированный элемент. */
export const CURSOR_DATA = 'cursor';

export class Cursor {
  /** Состояние под наведением мыши, без учёта перетаскивания */
  private hover: CursorKind = 'default';
  private dragging = false;
  private readonly canvas: HTMLCanvasElement | null;

  constructor(private readonly scene: Phaser.Scene) {
    this.canvas = (scene.game.canvas as HTMLCanvasElement) ?? null;
    scene.input.on(Phaser.Input.Events.GAMEOBJECT_OVER, this.onOver, this);
    scene.input.on(Phaser.Input.Events.GAMEOBJECT_OUT, this.onOut, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.apply();
  }

  /**
   * Взяли джойстик мышью: пока тянем, уголок вместо любого другого
   * курсора — так видно, что персонаж едет и отпускать надо мышь.
   */
  setDragging(on: boolean): void {
    if (this.dragging === on) return;
    this.dragging = on;
    this.apply();
  }

  private onOver(_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject): void {
    this.hover = obj.getData(CURSOR_DATA) === 'disabled' ? 'disabled' : 'pointer';
    this.apply();
  }

  private onOut(): void {
    this.hover = 'default';
    this.apply();
  }

  private apply(): void {
    const cv = this.canvas;
    if (!cv) return;
    for (const cls of Object.values(CLASS)) {
      if (cls) cv.classList.remove(cls);
    }
    const kind: CursorKind = this.dragging ? 'active' : this.hover;
    const active = CLASS[kind];
    if (active) cv.classList.add(active);
  }

  /**
   * Сцена гаснет — курсор обязан вернуться к обычному, иначе на
   * следующем экране он останется в состоянии наведения.
   */
  private onShutdown(): void {
    this.scene.input.off(Phaser.Input.Events.GAMEOBJECT_OVER, this.onOver, this);
    this.scene.input.off(Phaser.Input.Events.GAMEOBJECT_OUT, this.onOut, this);
    this.canvas?.classList.remove('cur-pointer', 'cur-disabled', 'cur-active');
  }
}