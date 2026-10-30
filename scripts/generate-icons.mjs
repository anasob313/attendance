// Renders the app icon (SVG) to the PNG sizes iOS and the manifest need.
//   npm run icons
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const glyph = (size, pad) => {
  const s = size, c = s / 2, r = (s / 2) - pad;
  const stroke = r * 0.16;
  // clock-face ring with a check-mark "hand"
  return `
  <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#fafafa" stroke-opacity="0.18" stroke-width="${stroke}"/>
  <path d="M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - r * 0.866} ${c - r * 0.5}" fill="none" stroke="#34d399" stroke-width="${stroke}" stroke-linecap="round"/>
  <path d="M ${c - r * 0.38} ${c + r * 0.02} L ${c - r * 0.08} ${c + r * 0.32} L ${c + r * 0.42} ${c - r * 0.24}" fill="none" stroke="#fafafa" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
};
const svg = (size, { pad, radius }) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#09090b"/>${glyph(size, pad)}</svg>`);

mkdirSync('public/icons', { recursive: true });
const out = [
  ['icon-192.png', 192, { pad: 44, radius: 0 }],
  ['icon-512.png', 512, { pad: 118, radius: 0 }],
  ['icon-maskable-512.png', 512, { pad: 150, radius: 0 }],
  ['apple-touch-icon.png', 180, { pad: 42, radius: 0 }],
  ['badge-72.png', 72, { pad: 12, radius: 0 }],
];
for (const [name, size, o] of out) {
  await sharp(svg(size, o)).png().toFile(`public/icons/${name}`);
  console.log('wrote', name);
}
