import { chromium } from '@playwright/test';

const lang = process.argv[2] ?? 'ru';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', (m) => { const t = m.text(); if (!t.includes('GL Driver')) logs.push(`[${m.type()}] ${t}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 8).join('\n')}`));
page.on('crash', () => logs.push('[CRASH] renderer crashed'));

await page.addInitScript(() => {
  if (localStorage.getItem('__seeded') === '1') return;
  localStorage.clear();
  localStorage.setItem('__seeded', '1');
  localStorage.setItem('tss-meta2', JSON.stringify({ matchesPlayed: 5 }));
});

try {
  await page.goto(`http://127.0.0.1:3000/?lang=${lang}&ysdk=mock`, { waitUntil: 'load' });
  await page.waitForSelector('#game canvas', { timeout: 60000 });
  await page.waitForFunction(() => window.__tss?.scene.isActive('Menu'), null, { timeout: 60000 });

  // Navigate to the SKINS tab (what the test does)
  await page.evaluate(() => {
    const g = window.__tss;
    g.scene.getScene('Menu').scene.launch('Shop', { tab: 'skins' });
  });
  await page.waitForFunction(() => window.__tss?.scene.isActive('Shop'), null, { timeout: 30000 });
  await page.waitForTimeout(3000);

  const texts = await page.evaluate(() => {
    const g = window.__tss;
    const s = g.scene.getScene('Shop');
    const out = [];
    const visit = (o) => { for (const x of o) { out.push([x.type, typeof x.text === 'string' ? x.text : '']); if (Array.isArray(x.list)) visit(x.list); } };
    visit(s.sys.displayList.list);
    return out;
  });
  console.log('--- TEXTS ---');
  console.log(texts.filter(([, t]) => t).map(([, t]) => t).join(' | '));
} catch (err) {
  logs.push(`[fatal] ${err.message}`);
}
console.log('--- LOGS ---');
console.log(logs.join('\n'));
await browser.close();