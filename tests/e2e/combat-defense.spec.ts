import { expect, test, type Page } from '@playwright/test';

const startupTimeout = 60_000;
type RuntimePlayer = { x:number; y:number; hp:number; iframesUntil:number; flipX:boolean; lastDamageWasGuarded:boolean; anims:{currentAnim?:{key?:string}|null}; damage(amount:number,now:number,sourceX?:number):boolean; };
type RuntimeEnemy = { active:boolean; dead:boolean; x:number; y:number; hp:number; isStaggered:boolean; anims:{currentAnim?:{key?:string}|null}; stagger(durationMs:number):void; body?:{setVelocity(x:number,y:number):unknown}; };
type RuntimeScene = { player:RuntimePlayer; weapons:{swordSwing(angle:number,dmg:number,evolved?:boolean,followUp?:boolean,candidates?:RuntimeEnemy[]):void}; enemyGroup:{getChildren():RuntimeEnemy[];remove(enemy:RuntimeEnemy,removeFromScene?:boolean,destroyChild?:boolean):unknown}; spawner:{stopped:boolean}; spawnEnemy(kind:string,x:number,y:number):boolean; damageEnemy(e:RuntimeEnemy,dmg:number,kx:number,ky:number,force:number,src?:string,byHero?:boolean):void; overlayOpen:boolean; };
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
    e.body?.setVelocity(0,0);scene.damageEnemy(e,10,0,0,190,'sword');
    return {hp:p.hp,staggered:e.isStaggered};
  });
  expect(before.staggered).toBe(true);
  await page.waitForTimeout(250);
  const after=await page.evaluate(()=>((window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene).player.hp);
  expect(after).toBe(before.hp);
});

test('sword damage lands on the attack animation impact frame', async ({page}) => {
  await startWarriorRun(page);
  const before = await page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    scene.spawner.stopped = true;
    for (const enemy of [...scene.enemyGroup.getChildren()]) {
      scene.enemyGroup.remove(enemy, true, true);
    }
    const p = scene.player;
    if (!scene.spawnEnemy('goblin', p.x + 50, p.y)) throw new Error('Could not spawn sword target');
    const enemy = scene.enemyGroup.getChildren().find(e => e.active && !e.dead);
    if (!enemy) throw new Error('Sword target missing');
    const hp = enemy.hp;
    scene.weapons.swordSwing(0, 12);
    return {hp, afterImmediate: enemy.hp, animation: p.anims.currentAnim?.key ?? ''};
  });
  expect(before.animation).toBe('player-atk1');
  expect(before.afterImmediate).toBe(before.hp);

  // player-atk1 has four frames at 16 FPS; frame 2 is reached before animation completion.
  await page.waitForTimeout(175);
  const after = await page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    return scene.enemyGroup.getChildren().find(e => e.active && !e.dead)?.hp ?? 99999;
  });
  expect(after).toBeLessThan(before.hp);
});


test('staggered enemies switch from running to idle and resume running afterwards', async ({page}) => {
  await startWarriorRun(page);
  await page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    scene.spawner.stopped = true;
    for (const enemy of [...scene.enemyGroup.getChildren()]) {
      scene.enemyGroup.remove(enemy, true, true);
    }
    const p = scene.player;
    if (!scene.spawnEnemy('goblin', p.x + 280, p.y)) throw new Error('Could not spawn animation target');
  });

  const animationKey = () => page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    return scene.enemyGroup.getChildren().find(e => e.active && !e.dead)?.anims.currentAnim?.key ?? 'missing';
  });

  // Ensure the goblin was visibly chasing first; it has no dedicated goblin-hit animation.
  await expect.poll(animationKey, { timeout: 5_000 }).toBe('goblin-run');
  await page.evaluate(() => {
    const scene = (window as RuntimeWindow).__tss!.scene.getScene('Game') as RuntimeScene;
    const enemy = scene.enemyGroup.getChildren().find(e => e.active && !e.dead);
    if (!enemy) throw new Error('Animation target disappeared before hit');
    scene.damageEnemy(enemy, 10, 0, 0, 190, 'sword');
  });

  await expect.poll(animationKey, { timeout: 1_000 }).toBe('goblin-idle');
  await page.waitForTimeout(380);
  await expect.poll(animationKey, { timeout: 2_000 }).toBe('goblin-run');
});
