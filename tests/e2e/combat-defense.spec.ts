import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 60_000;
type RuntimePlayer = { x:number; y:number; hp:number; iframesUntil:number; flipX:boolean; lastDamageWasGuarded:boolean; anims:{currentAnim?:{key?:string}|null}; damage(amount:number,now:number,sourceX?:number):boolean; };
type RuntimeEnemy = { active:boolean; dead:boolean; x:number; y:number; isStaggered:boolean; stagger(durationMs:number):void; body?:{setVelocity(x:number,y:number):unknown}; };
type RuntimeScene = { player:RuntimePlayer; enemyGroup:{getChildren():RuntimeEnemy[];remove(enemy:RuntimeEnemy,removeFromScene?:boolean,destroyChild?:boolean):unknown}; spawner:{stopped:boolean}; spawnEnemy(kind:string,x:number,y:number):boolean; overlayOpen:boolean; };
type RuntimeGame = { scene:{getScene(key:string):unknown;isActive(key:string):boolean} };
type RuntimeWindow = Window & { __tss?:RuntimeGame };

async function startWarriorRun(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?lang=en&ysdk=mock');
  await expect(page.locator('#game canvas')).toBeVisible({ timeout: startupTimeout });
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: startupTimeout });
  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('Menu') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);

  await page.evaluate(() => {
    localStorage.removeItem('tss-meta2');
    localStorage.removeItem('tss-hints');
    const game = (window as RuntimeWindow).__tss!;
    const menu = game.scene.getScene('Menu') as {
      selectedHero?: string;
      selectedDiff?: string;
      scene: { start(key: string, data: { hero: string; diff: string }): void };
    };
    menu.scene.start('Game', {
      hero: 'warrior',
      diff: menu.selectedDiff ?? 'normal',
    });
  });

  await expect.poll(
    () => page.evaluate(() => (window as RuntimeWindow).__tss?.scene.isActive('Game') ?? false),
    { timeout: startupTimeout },
  ).toBe(true);
  const bounds = await page.locator('#game canvas').boundingBox();
  if (!bounds) throw new Error('Game canvas has no layout bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect.poll(
    () => page.evaluate(() => {
      const scene = (window as RuntimeWindow).__tss?.scene.getScene('Game') as RuntimeScene | undefined;
      return scene ? !scene.overlayOpen : false;
    }),
    { timeout: 10_000 },
  ).toBe(true);
}

function slashCount(scene: RuntimeScene): number {
  return scene.children.list.filter((child) => child.texture?.key === 'slash').length;
}

function clearEnemies(scene: RuntimeScene): void {
  for (const enemy of [...scene.enemyGroup.getChildren()]) {
    scene.enemyGroup.remove(enemy, true, true);
  }
}


test('warrior guard reduces frontal damage and not damage from behind', async ({page}) => {
  await startWarriorRun(page);
  const result=await page.evaluate(()=>{
    const scene=(window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    const p=scene.player;
    p.hp=100;p.iframesUntil=0;p.flipX=false;
    p.damage(40,1,p.x+80);
    const front={hp:p.hp,guarded:p.lastDamageWasGuarded,animation:p.anims.currentAnim?.key??''};
    p.hp=100;p.iframesUntil=0;p.flipX=false;
    p.damage(40,2,p.x-80);
    return {front,back:{hp:p.hp,guarded:p.lastDamageWasGuarded}};
  });
  expect(result.front.guarded).toBe(true);
  expect(result.front.animation).toBe('player-guard');
  expect(result.front.hp).toBe(86);
  expect(result.back.guarded).toBe(false);
  expect(result.back.hp).toBe(60);
});

test('staggered enemy cannot counterattack during recovery', async ({page}) => {
  await startWarriorRun(page);
  const before=await page.evaluate(()=>{
    const scene=(window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    scene.spawner.stopped=true;
    for(const e of [...scene.enemyGroup.getChildren()]) scene.enemyGroup.remove(e,true,true);
    const p=scene.player;p.hp=100;p.iframesUntil=0;
    if(!scene.spawnEnemy('goblin',p.x+30,p.y))throw new Error('Could not spawn test enemy');
    const e=scene.enemyGroup.getChildren().find(x=>x.active&&!x.dead);
    if(!e)throw new Error('Spawned enemy missing');
    e.body?.setVelocity(0,0);e.stagger(600);
    return {hp:p.hp,staggered:e.isStaggered};
  });
  expect(before.staggered).toBe(true);
  await page.waitForTimeout(250);
  const after=await page.evaluate(()=>((window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene).player.hp);
  expect(after).toBe(before.hp);
});
