import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_CONNECTION_RESET|Failed to fetch|status of 404/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

await page.goto('http://127.0.0.1:8777/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
console.log('tagline:', await page.textContent('#tagline'));

async function ask(q) {
  await page.fill('#nlq', '');
  await page.waitForTimeout(400);
  await page.fill('#nlq', q);
  await page.waitForTimeout(1500);
  const chips = await page.$$eval('#nlq-understood .chip', (n) => n.map((x) => x.textContent));
  const head = await page.textContent('.results-head').catch(() => null);
  const blockers = await page.$$eval('.blocker p', (n) => n.map((x) => x.textContent.trim()));
  const results = await page.$$eval('.result', (n) =>
    n.slice(0, 4).map((x) => `${x.querySelector('.name').textContent} ${x.querySelector('.km').textContent}`),
  );
  console.log(`\n« ${q} »`);
  console.log('  compris :', chips.join(' | ') || '—');
  console.log('  entête  :', head ?? '(aucune)');
  if (blockers.length) console.log('  verrou  :', blockers.join(' // '));
  console.log('  top     :', results.join(' · ') || '—');
  return results.length;
}

await ask('Depuis Namur, 40 km de voie verte lisse, retour en train');
// Le bouton du verrou doit relancer le calcul avec la contrainte levée.
if (await page.$('.blocker button')) {
  await page.click('.blocker button');
  await page.waitForTimeout(1200);
  console.log('  après levée du verrou :', await page.textContent('.results-head').catch(() => 'aucune'));
}

await ask('Aller-retour de 30 km depuis Tournai en famille');
const n = await ask('3h depuis Liege-Guillemins, revêtement roulant');

if (n) {
  await page.click('.result');
  await page.waitForTimeout(1500);
  console.log('\ndétail:', (await page.textContent('#detail')).replace(/\s+/g, ' ').slice(0, 260));
  const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.click('#gpx');
  const download = await dl;
  if (download) {
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const gpx = readFileSync(path, 'utf8');
    console.log('GPX:', download.suggestedFilename(), gpx.length, 'octets,', (gpx.match(/<trkpt/g) || []).length, 'points');
    console.log('GPX entête:', gpx.split('\n').slice(0, 6).join(' ').slice(0, 200));
  } else {
    console.log('GPX: aucun téléchargement');
  }
}

await page.screenshot({ path: 'shot-plan.png' });
await page.click('[data-tab="explore"]');
await page.waitForTimeout(600);
await page.screenshot({ path: 'shot-explore.png' });
await page.click('[data-tab="about"]');
await page.waitForTimeout(400);
await page.screenshot({ path: 'shot-about.png' });

console.log('\nERREURS:', errors.length ? errors : 'aucune');
await browser.close();
