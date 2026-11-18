// Renders the Party List icon (person outline + ticked list on purple-pink) to every size the site and apps use.
//   NODE_PATH=<puppeteer-core> node store-assets/make-icons.js <chrome.exe>
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..');

const art = `
  <g fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="33" cy="33" r="9"/><path d="M17 60c0-9 7-15 16-15s16 6 16 15"/></g>
  <g fill="none" stroke="#fde047" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M55 31l3 3 6-6"/><path d="M55 47l3 3 6-6"/></g>
  <g fill="#fff"><rect x="68" y="28" width="16" height="5" rx="2.5"/><rect x="68" y="44" width="16" height="5" rx="2.5"/>
    <rect x="17" y="70" width="67" height="5" rx="2.5" opacity=".9"/><rect x="17" y="80" width="44" height="5" rx="2.5" opacity=".6"/></g>`;
const grad = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>`;
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${grad}${inner}</svg>`;

const icons = {
  rounded: svg(`<rect width="100" height="100" rx="22" fill="url(#bg)"/>${art}`),      // site / splash
  square: svg(`<rect width="100" height="100" fill="url(#bg)"/>${art}`),                // stores round the corners themselves
  fg: svg(`<g transform="translate(17 17) scale(.66)">${art}</g>`),                       // Android adaptive: art inside the safe zone
  bgOnly: svg(`<rect width="100" height="100" fill="url(#bg)"/>`),
};
const out = [
  ['app/icon.svg', null, 'rounded'],
  ['app/icon-512.png', 512, 'square'], ['app/icon-192.png', 192, 'square'], ['app/apple-touch-icon.png', 180, 'square'],
  ['mobile/assets/icon.png', 1024, 'square'], ['mobile/assets/adaptive-icon.png', 1024, 'fg'],
  ['mobile/assets/adaptive-bg.png', 1024, 'bgOnly'], ['mobile/assets/splash-icon.png', 1024, 'rounded'],
  ['store-assets/play/app-icon-512.png', 512, 'square'],
];

(async () => {
  const b = await puppeteer.launch({ executablePath: process.argv[2], headless: true });
  const p = await b.newPage();
  for (const [file, size, kind] of out) {
    const dest = path.join(ROOT, file);
    if (!size) { fs.writeFileSync(dest, icons[kind] + '\n'); console.log('wrote', file); continue; }
    await p.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await p.setContent(`<html><body style="margin:0;background:transparent">${icons[kind].replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await p.screenshot({ path: dest, omitBackground: true });
    console.log('wrote', file, size);
  }
  await b.close();
})();
