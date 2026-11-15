// App Store screenshots of Party List with made-up demo guests: iPhone 6.9" (1320x2868),
// iPad 13" (2064x2752), and the paywall shot App Review needs for the in-app purchase.
//   SITE=<copy of app/ with an empty config.js> OUT=<folder> node make-ios-screenshots.js <chrome.exe>
// An empty config.js hides the sign-in screen so the demo list shows.
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const SITE = process.env.SITE, OUT = process.env.OUT;
fs.copyFileSync(path.join(__dirname, 'frame-ios.html'), path.join(SITE, 'frame-ios.html'));
fs.mkdirSync(path.join(SITE, 'raw'), { recursive: true });
for (const d of ['iphone', 'ipad']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const f = path.join(SITE, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
}).listen(5199);

// same demo guests as the Play screenshots (make-screenshots.js)
let n = 0; const id = () => 'p' + (++n);
const people = [];
const add = (name, code, email = '', phone = '', notes = '', plusOf = null) => { const p = { id: id(), name, code, email, phone, notes, plusOf }; people.push(p); return p; };
const amara = add('Amara Okafor', '4821', 'amara.okafor@example.com', '07700 900123', 'Bringing the cake');
add('Leo Okafor', '1937', '', '', '', amara.id);
add('Sofia Rossi', '7604', 'sofia.r@example.com', '07700 900456');
const jamie = add('Jamie Chen', '3158', 'jamie.chen@example.com', '', 'Vegetarian');
add('Priya Shah', '9042', '', '', '', jamie.id);
add('Tom Fletcher', '2276', '', '07700 900789');
add('Hannah Kowalski', '6513', 'hannah.k@example.com');
add('Marcus Bell', '8390', 'marcus.bell@example.com', '07700 900321', 'DJ for the night');
add('Zara Ahmed', '5127', '', '07700 900654');
add('Oliver Grant', '4469', 'oliver.g@example.com');
const ev = (id, title, date, time, place, list, s) => ({ id, title, date, time, place, sort: 'custom', nameSort: 'first', codeLen: 4, plusCap: 2, people: list, createdAt: s });
const doc = { v: 2, currentId: 'e1', savedAt: Date.now(), events: [
  ev('e1', "Maya's 21st", '2026-12-12', '20:00', 'The Loft, 14 Market Street, Leeds', people, 1),
  ev('e2', "New Year's Eve", '2026-12-31', '21:00', '', people.slice(2, 7).map(p => ({ ...p, id: p.id + 'b', plusOf: null })), 2),
  ev('e3', 'Summer BBQ', '2027-07-04', '14:00', '', people.slice(5, 9).map(p => ({ ...p, id: p.id + 'c', plusOf: null })), 3) ] };

const DEVICES = {
  iphone: { view: { width: 440, height: 956, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, w: 1320, h: 2868, device: 'phone' },
  ipad: { view: { width: 1032, height: 1376, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, w: 2064, h: 2752, device: 'tablet' },
};
const SHOTS = [
  ['1-list-light', 'light', null, 'Your guest list, sorted', 'Names, contacts, notes and +1s'],
  ['2-guest', 'light', p => p.click('#list li.row .main'), 'An entry code for everyone', 'Text or email it in one tap'],
  ['3-list-dark', 'dark', p => p.click('button[data-sort="az"]'), 'Sort it your way', 'Your own order, or A to Z by first or last name'],
  ['4-events', 'dark', p => p.click('#eventsBtn'), 'A list for every party', 'Switch events in a tap, swipe to delete'],
];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.argv[2], headless: true, args: ['--no-first-run'] });
  const raw = async (name, d, theme, act) => {
    const page = await browser.newPage();
    await page.setViewport(DEVICES[d].view);
    await page.evaluateOnNewDocument(() => { window.ReactNativeWebView = { postMessage() {} }; });   // look like the phone app
    await page.goto('http://localhost:5199/index.html');
    await page.evaluate((x, t) => { localStorage.clear(); localStorage.setItem('partylist.v1', JSON.stringify(x)); localStorage.setItem('partylist.v1.theme', t); }, doc, theme);
    await page.reload({ waitUntil: 'networkidle0' }); await wait(600);
    if (act) { await act(page); await wait(700); await page.evaluate(() => document.activeElement && document.activeElement.blur()); }
    const file = path.join(SITE, 'raw', `${d}-${name}.png`);
    await page.screenshot({ path: file }); await page.close();
    return file;
  };
  for (const d of Object.keys(DEVICES)) {
    const { w, h, device } = DEVICES[d];
    for (const [name, theme, act, head, sub] of SHOTS) {
      await raw(name, d, theme, act);
      const fp = await browser.newPage();
      await fp.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      const qs = new URLSearchParams({ w, ht: h, device, theme, h: head, s: sub, img: `raw/${d}-${name}.png` });
      await fp.goto('http://localhost:5199/frame-ios.html?' + qs, { waitUntil: 'networkidle0' });
      await fp.screenshot({ path: path.join(OUT, d, name + '.png') }); await fp.close();
      console.log('saved', d, name);
    }
  }
  // the purchase sheet as the app shows it (App Review screenshot for partylist_premium_lifetime)
  const pay = await raw('paywall', 'iphone', 'light', async p => { await p.click('#settingsBtn'); await wait(500); await p.click('#premBtn'); });
  fs.copyFileSync(pay, path.join(OUT, 'iap-review-paywall.png'));
  console.log('saved paywall');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
