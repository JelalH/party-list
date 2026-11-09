// Takes Play Store phone screenshots of Party List with made-up demo guests.
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const SITE = path.join(__dirname, '..', 'site');
const OUT = path.join(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const f = path.join(SITE, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
}).listen(5199);

let n = 0; const id = () => 'p' + (++n);
const P = (name, code, email = '', phone = '', notes = '', plusOf = null) => ({ id: id(), name, code, email, phone, notes, plusOf });
const people = [];
const add = (...a) => { const p = P(...a); people.push(p); return p; };
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
const ev1 = { id: 'e1', title: "Maya's 21st", date: '2026-12-12', time: '20:00', place: 'The Loft, 14 Market Street, Leeds', sort: 'custom', nameSort: 'first', codeLen: 4, plusCap: 2, people, createdAt: 1 };
const ev2 = { id: 'e2', title: "New Year's Eve", date: '2026-12-31', time: '21:00', place: '', sort: 'custom', nameSort: 'first', codeLen: 4, plusCap: 2, people: people.slice(2, 7).map(p => ({ ...p, id: p.id + 'b', plusOf: null })), createdAt: 2 };
const ev3 = { id: 'e3', title: 'Summer BBQ', date: '2027-07-04', time: '14:00', place: '', sort: 'custom', nameSort: 'first', codeLen: 4, plusCap: 2, people: people.slice(5, 9).map(p => ({ ...p, id: p.id + 'c', plusOf: null })), createdAt: 3 };
const doc = { v: 2, events: [ev1, ev2, ev3], currentId: 'e1', savedAt: Date.now() };

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.argv[2], headless: true, args: ['--no-first-run'] });
  const shot = async (name, theme, act) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 732, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
    await page.goto('http://localhost:5199/index.html');
    await page.evaluate((d, t) => { localStorage.clear(); localStorage.setItem('partylist.v1', JSON.stringify(d)); localStorage.setItem('partylist.v1.theme', t); }, doc, theme);
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 600));
    if (act) { await act(page); await new Promise(r => setTimeout(r, 700)); await page.evaluate(() => document.activeElement && document.activeElement.blur()); }
    fs.mkdirSync(path.join(SITE, 'raw'), { recursive: true }); await page.screenshot({ path: path.join(SITE, 'raw', name + '.png') });
    await page.close();
    console.log('saved', name);
  };
  await shot('1-list-light', 'light');
  await shot('2-guest', 'light', p => p.click('#list li.row .main'));
  await shot('3-list-dark', 'dark', p => p.click('button[data-sort="az"]'));
  await shot('4-events', 'dark', p => p.click('#eventsBtn'));
  const fp = await browser.newPage();
  await fp.setViewport({ width: 1024, height: 500, deviceScaleFactor: 1 });
  await fp.goto('http://localhost:5199/feature.html', { waitUntil: 'networkidle0' });
  await fp.screenshot({ path: path.join(OUT, 'feature-graphic.png') });
  fs.copyFileSync(path.join(SITE, 'icon-512.png'), path.join(OUT, 'app-icon-512.png'));
  console.log('saved feature-graphic + icon');
  const frames = [
    ['1-list-light', 'light', 'Your guest list, sorted', 'Names, contacts, notes and +1s'],
    ['2-guest', 'light', 'An entry code for everyone', 'Text or email it in one tap'],
    ['3-list-dark', 'dark', 'Sort it your way', 'Your own order, or A to Z by first or last name'],
    ['4-events', 'dark', 'A list for every party', 'Switch events in a tap, swipe to delete'],
  ];
  for (const [name, theme, h, s] of frames) {
    const fp2 = await browser.newPage();
    await fp2.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    const qs = new URLSearchParams({ theme, h, s, img: 'raw/' + name + '.png' });
    await fp2.goto('http://localhost:5199/frame.html?' + qs, { waitUntil: 'networkidle0' });
    await fp2.screenshot({ path: path.join(OUT, name + '.png') });
    await fp2.close(); console.log('framed', name);
  }
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });


