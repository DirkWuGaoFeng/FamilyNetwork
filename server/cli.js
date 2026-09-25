/**
 * 命令行重新扫描：改了 .galleryignore 或刚拷完照片时，想看结果又不想开网页就用这个
 * 用法：npm run rescan
 */
const config = require('./config');
const scan = require('./scan');

(async () => {
  console.log(`扫描 ${config.mediaRoot} …`);
  await scan.rescan({ force: true });
  const index = scan.getIndex();
  const gb = (index.stats.totalBytes / 1024 / 1024 / 1024).toFixed(2);
  console.log(`照片 ${index.stats.photos} 张，视频 ${index.stats.videos} 个，合计 ${gb} GB，用时 ${index.stats.scanMs}ms`);
  console.log('');
  console.log('相册：');
  for (const album of index.albums) {
    console.log(`  ${album.name.padEnd(14, ' ')} ${String(album.count).padStart(5)} 项  `
      + `${album.photos} 照片 / ${album.videos} 视频  ${album.years.join('、')}`);
  }
  console.log('');
  console.log('最近的 6 个日子：');
  for (const bucket of index.timeline.slice(0, 6)) {
    console.log(`  ${bucket.month}  ${bucket.count} 项`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('扫描失败:', err);
  process.exit(1);
});
