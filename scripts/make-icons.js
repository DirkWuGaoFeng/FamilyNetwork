/**
 * 生成应用图标：一份 SVG 源，导出 png 各尺寸
 *
 * 用法：npm run icons
 * 只在改设计的时候需要跑一次，产物直接进仓库，部署机不必装 sharp 也能跑站。
 *
 * 图形是「一个屋顶 + 一张相框」，全部用 path/rect 画，不用文字：
 * SVG 转 png 时字体在谁机器上、有没有装，全凭运气，纯几何图形到哪都一样。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');

const PAPER = '#f6f1e9';
const SURFACE = '#fffdf9';
const INK = '#221c18';
const BRASS = '#a98a5b';
const CLAY = '#b8654a';

/**
 * 画在 512x512 的格子上
 * @param {object} o
 * @param {boolean} o.full  满幅纸底（maskable 用，边缘不留白，随便怎么裁都好看）
 */
function svg({ full }) {
  // maskable 会被系统裁成圆/方/水滴，安全区只有中间的 80%，所以图形要缩一圈
  const s = full ? 0.78 : 1;
  const t = `translate(256 256) scale(${s}) translate(-256 -256)`;
  // 两种都是满幅纸底：留透明边的话，在不同启动器的圆角遮罩下会露出一圈缺口
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${PAPER}"/>
  <g transform="${t}" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="256" cy="256" r="196" stroke="${BRASS}" stroke-width="7" opacity="0.85"/>
    <path d="M138 244 L256 138 L374 244" stroke="${CLAY}" stroke-width="20"/>
    <rect x="176" y="244" width="160" height="132" rx="6" fill="${SURFACE}" stroke="${INK}" stroke-width="14"/>
    <path d="M196 366 l42-52 30 32 28-30 34 50z" fill="${BRASS}" stroke="none" opacity="0.55"/>
    <circle cx="300" cy="278" r="13" fill="${CLAY}" stroke="none"/>
  </g>
</svg>`;
}

async function png(markup, size, file) {
  await sharp(Buffer.from(markup), { density: 300 })
    .resize(size, size)
    .png()
    .toFile(path.join(OUT, file));
  console.log(`  ${file} (${size}x${size})`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const any = svg({ full: false });
  const maskable = svg({ full: true });

  fs.writeFileSync(path.join(OUT, 'icon.svg'), any);
  console.log('  icon.svg');

  await png(any, 192, 'icon-192.png');
  await png(any, 512, 'icon-512.png');
  // iOS 的「添加到主屏幕」只认这个尺寸，而且它自己会加圆角遮罩
  await png(any, 180, 'apple-touch-icon.png');
  await png(maskable, 512, 'maskable-512.png');
}

main().catch((err) => {
  console.error('图标生成失败：', err.message);
  process.exit(1);
});
