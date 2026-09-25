/**
 * 家庭相册网站 · 启动器
 *
 * 一个进程搞定：扫描素材目录 → 提供查询接口 → 出缩略图 → 放原图/视频 → 托管前端页面。
 * 没有数据库、没有登录、没有构建步骤（前端就是 public/ 下两个文件）。
 *
 * 路由与响应行为在 app.js，这里只负责「把服务立起来」：先把环境查一遍，
 * 有问题说人话，不要让家人对着一个 stack trace 猜。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const config = require('./config'); // 里面已经把 .env 读进 process.env 了
const env = require('./env');
const scan = require('./scan');
const { detectFfmpeg, hasFfmpeg } = require('./thumbs');
const app = require('./app');

/** 行首统一标记，方便在混杂的终端里认出来 */
const say = (...args) => console.log(' ', ...args);
const warn = (...args) => console.warn(' ', ...args);

/**
 * 启动前自检：素材目录、缓存目录、Node 版本、.env
 * @returns {Promise<boolean>} 能不能继续
 */
async function preflight() {
  let blocked = false;

  if (Number(process.versions.node.split('.')[0]) < 20) {
    warn(`Node 版本偏低（当前 ${process.version}），建议 20 以上：缩略图与新语法都依赖较新的运行时`);
  }

  try {
    const stat = await fsp.stat(config.mediaRoot);
    if (!stat.isDirectory()) {
      throw new Error('不是目录');
    }
  } catch (err) {
    console.error(`启动失败：素材目录不可用 -> ${config.mediaRoot}（${err.message}）`);
    console.error('  改目录：编辑 .env 里的 MEDIA_ROOT，或者直接 $env:MEDIA_ROOT = "d:\\照片"; npm start');
    blocked = true;
  }

  try {
    await fsp.mkdir(config.cacheDir, { recursive: true });
    await fsp.access(config.cacheDir, fs.constants.W_OK);
  } catch (err) {
    console.error(`启动失败：缓存目录写不了 -> ${config.cacheDir}（${err.message}）`);
    console.error('  这个目录存缩略图缓存，几 GB 很正常；换位置就设 CACHE_DIR。');
    blocked = true;
  }

  const fromEnv = env.applied();
  if (fromEnv.length) {
    say(`.env 已生效：${fromEnv.join('、')}`);
  }
  return !blocked;
}

/** 局域网上能被家里其他设备访问的地址 */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => `http://${net.address}:${config.port}`);
}

(async () => {
  if (!(await preflight())) {
    process.exit(1);
  }

  const { loadFeatured, auditFeaturedRules } = app.__internals;
  await loadFeatured();
  await scan.init();
  await detectFfmpeg();

  const server = app.listen(config.port, config.host, () => {
    const index = scan.getIndex();
    console.log('');
    say(`${config.siteTitle} · 家庭相册已就绪`);
    say(`本机访问   http://localhost:${config.port}`);
    if (config.host === '0.0.0.0') {
      const lan = lanAddresses();
      say(`手机/平板  ${lan.join('  ') || '(未找到局域网地址，检查 WiFi 或以太网)'}`);
      say('           前提：设备与这台电脑在同一个 WiFi；站点没有登录，不要把端口映射到公网。');
    } else {
      say(`只监听 ${config.host}（其他设备访问不了，HOST=0.0.0.0 才对家里开放）`);
    }
    say(`素材目录   ${config.mediaRoot}`);
    say(`索引       ${index.items.length} 个素材 / ${index.albums.length} 本相册`);
    // featured.txt 里的规则有落空的就说一声。人手改的文件，改完页面上没动静时，
    // 得有个地方直接告诉你到底是路径打错了还是相册名对不上
    for (const line of auditFeaturedRules()) {
      warn(`featured.txt  ${line}`);
    }
    if (!hasFfmpeg()) {
      warn('未启用 ffmpeg：视频只有占位封面，也做不了循环动图（npm i ffmpeg-static 后重启即可）');
    }
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 被占用了。`);
      console.error('  多半是已经有一个相册服务在跑：直接打开 http://localhost:' + config.port + ' 看看。');
      console.error('  确实要再起一个：在 .env 里改 PORT=8081。');
    } else if (err.code === 'EACCES') {
      console.error(`没有权限监听 ${config.host}:${config.port}（1024 以下的端口要管理员权限，换个端口即可）。`);
    } else {
      console.error('监听失败:', err.message);
    }
    process.exit(1);
  });

  /**
   * 一个坏文件不该让整个站消失：服务已经起来了，之后遇到任何没接住的
   * 异常都只记一行日志，继续服务剩下的请求。
   */
  let dying = false;
  const bail = (label) => {
    if (dying) {
      return;
    }
    dying = true;
    console.error(`\n正在关闭…（${label}）`);
    server.close(() => process.exit(0));
    // 挂着keep-alive 的视频Range请求不会自己结束，三秒后强制走人
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => bail('Ctrl+C'));
  process.on('SIGTERM', () => bail('收到终止信号'));
  process.on('unhandledRejection', (reason) => {
    console.error('[process] 未处理的 Promise 拒绝:', (reason && reason.stack) || reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[process] 未捕获异常（已忽略，服务继续）:', err.stack || err.message);
  });
})().catch((err) => {
  console.error('启动失败:', err.stack || err.message);
  process.exit(1);
});
