/**
 * 原型逻辑：五个页面 + 三个浮层 + 一套揭示动效
 *
 * 零构建、零依赖，浏览器直接跑；数据全部来自本机 /api，画面全是真照片。
 * 动效原则：只做「揭示」（擦入、错位升起、缓慢推近、视差），且一律可被
 * 系统的「减少动态效果」偏好关掉。
 */
/* global IntersectionObserver */

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('zh-CN');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 能力探测：v3 的新效果全部是渐进增强，不支持就当没这个功能，不留坑
 * canVT    同文档 View Transition（共享元素放大、方向感知路由）
 * canSDA   滚动驱动动画（揭示交给合成器，不占主线程）
 * canAnchor CSS 锚点定位（放大镜跟着小图走，边缘自动翻边）
 */
const canVT = typeof document.startViewTransition === 'function' && !reduceMotion;
const canSDA = CSS.supports('animation-timeline', 'view()');
const canAnchor = CSS.supports('anchor-name', '--hp');
/** 触屏没有真正的 hover，放大镜与封面翻书只在鼠标设备上开 */
const finePointer = window.matchMedia('(pointer: fine)').matches;

/** /api/site 的结果，多处共用 */
let SITE = null;

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
}

function query(params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      q.set(k, v);
    }
  });
  return getJson(`/api/media?${q}`);
}

/** 指定位宽的缩略图地址（拼贴、横幅这类大图不想用默认的 480） */
function thumbAt(item, width) {
  return `/thumb?p=${encodeURIComponent(item.path)}&w=${width}`;
}

function humanSize(bytes) {
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
}

function cnDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;
}

function cnMonth(iso) {
  const [y, m] = iso.split('-');
  return `${y} 年 ${Number(m)} 月`;
}

function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 图片元素：真实文件名做 alt，屏幕阅读器念出来是「婚纱照，2021 年 5 月 20 日：DSC_0132.JPG」 */
function pic(item, src, eager) {
  const img = document.createElement('img');
  img.src = src || item.thumb;
  img.alt = `${item.album}，${cnDate(item.date)}：${item.name}`;
  img.loading = eager ? 'eager' : 'lazy';
  img.decoding = 'async';
  return img;
}

/**
 * 照片的揭示方式：浏览器支持滚动时间线就用 .scrub（合成器驱动，拖滚动条也不卡），
 * 否则退回原来的 .rv，由 IntersectionObserver 加 .in
 */
function revealClass() {
  return canSDA ? 'scrub' : 'rv';
}

/** 页面自带的定时器/监听器，换页时必须清掉，不然切了页还在背地里转 */
let pageCleanups = [];
function onPageCleanup(fn) {
  pageCleanups.push(fn);
}
function runCleanups() {
  const list = pageCleanups;
  pageCleanups = [];
  list.forEach((fn) => {
    try {
      fn();
    } catch { /* 收尾失败不拦住下一页 */ }
  });
}

function skeleton(count, where) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const d = document.createElement('div');
    d.className = 'skeleton';
    frag.append(d);
  }
  if (where) {
    where.innerHTML = '';
    where.append(frag);
  }
  return frag;
}

function stateBlock(message, withRetry) {
  const box = document.createElement('div');
  box.className = 'state';
  box.innerHTML = `<p class="h3">${esc(message)}</p><p>${withRetry ? '这个站只读本机目录，检查一下服务还开着没有。' : ''}</p>`;
  if (withRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '重新载入';
    btn.addEventListener('click', () => window.location.reload());
    box.append(btn);
  }
  return box;
}

// ---------------------------------------------------------------------------
// 动效
// ---------------------------------------------------------------------------
let io = null;

function watchReveals(root = document) {
  if (reduceMotion) {
    root.querySelectorAll('.rv,.wipe,.fade,.scrub').forEach((n) => n.classList.add('in'));
    // 计数器直接落终值：动画可以省，数字不能不给（初始写法就是终值，这里只是防万一）
    root.querySelectorAll('[data-count]').forEach((n) => { n.textContent = nf.format(Number(n.dataset.count)); });
    return;
  }
  if (!io) {
    io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        if (entry.target.hasAttribute('data-count')) {
          // 到眼前才归零起滚：没被交叉到的永远是模板里的终值，
          // 动画链路整条失灵也不会把 0 留在屏幕上
          entry.target.dataset.from = entry.target.textContent.replace(/[,\s]/g, '');
          entry.target.textContent = '0';
          countUp(entry.target);
          io.unobserve(entry.target);
          return;
        }
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
  }
  // .scrub 在有滚动时间线的浏览器里交给 CSS，这里不插一杠
  const selector = canSDA ? '.rv:not(.in),.wipe:not(.in),.fade:not(.in)' : '.rv:not(.in),.wipe:not(.in),.fade:not(.in),.scrub:not(.in)';
  root.querySelectorAll(selector).forEach((n) => io.observe(n));
  // 计数器自己是一条轨道：包在 .facts 这类没有动画名的容器里也得被看到
  root.querySelectorAll('[data-count]').forEach((n) => io.observe(n));
}

function countUp(node) {
  if (node.dataset.counting === '1') {
    // 滚过的节点再被碰到（重复观察、外部改脏）：直接落终值，不重播也不停在 0
    node.textContent = nf.format(Number(node.dataset.count)) + (node.dataset.suffix || '');
    return;
  }
  node.dataset.counting = '1';
  const target = Number(node.dataset.count);
  // 起点：交叉时存进 data-from 的模板终值（带千分位，Number 解出 NaN 就退到 0）
  const from = Number(node.dataset.from) || 0;
  const suffix = node.dataset.suffix || '';
  const started = performance.now();
  const dur = 1100;
  function frame(now) {
    const t = Math.min(1, (now - started) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = nf.format(Math.round(from + (target - from) * eased)) + suffix;
    if (t < 1) {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
}

/** 视差：只在滚动时改一个 CSS 变量，交给合成层，不碰布局 */
let parallaxNodes = [];
let ticking = false;

function updateProgress() {
  const doc = document.documentElement;
  const max = doc.scrollHeight - window.innerHeight;
  doc.style.setProperty('--p', max > 40 ? Math.min(1, window.scrollY / max).toFixed(4) : '0');
}

function parallaxTick() {
  ticking = false;
  updateProgress();
  if (reduceMotion) {
    return;
  }
  const mid = window.innerHeight / 2;
  parallaxNodes.forEach((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < -200 || rect.top > window.innerHeight + 200) {
      return;
    }
    const offset = (rect.top + rect.height / 2 - mid) * Number(node.dataset.par);
    node.style.setProperty('--shift', `${(-offset).toFixed(1)}px`);
  });
}

function bindParallax() {
  parallaxNodes = [...document.querySelectorAll('[data-par]')];
  updateProgress();
  if (reduceMotion || !parallaxNodes.length) {
    return;
  }
  parallaxTick();
}

window.addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(parallaxTick);
  }
}, { passive: true });
window.addEventListener('resize', () => {
  requestAnimationFrame(updateProgress);
});

// ---------------------------------------------------------------------------
// 联动：小图放大镜 / 相册封面翻书 / 放映厅追光
// ---------------------------------------------------------------------------

/**
 * 悬停小图 → 旁边浮出一张大的。
 * 位置交给 CSS 锚点定位：谁被悬停谁就是锚点，靠边缘时 position-try 自动翻边；
 * 不支持锚点的浏览器退回跟指针坐标
 */
function bindLoupe(cell, item, img) {
  if (!finePointer || reduceMotion) {
    return;
  }
  const node = el('loupe');
  let raf = 0;
  const show = () => {
    node.querySelector('img').src = thumbAt(item, 620);
    node.querySelector('.t').textContent = `${item.folder || item.album} · ${cnDate(item.date)}`;
    node.classList.add('on');
    if (canAnchor) {
      img.style.setProperty('anchor-name', '--hp');
    } else {
      const r = cell.getBoundingClientRect();
      node.style.left = `${Math.round(r.right + 12)}px`;
      node.style.top = `${Math.round(Math.min(r.top, window.innerHeight - 240))}px`;
    }
  };
  const hide = () => {
    node.classList.remove('on');
    img.style.removeProperty('anchor-name');
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  cell.addEventListener('pointerenter', show);
  cell.addEventListener('pointerleave', hide);
  if (!canAnchor) {
    bindLoupeScrollHide();
  }
  onPageCleanup(hide);
}

/** JS 兜底分支里 loupe 不跟着锚点走，一滚动就先收起（只绑一次，不每格绑一个） */
let loupeScrollBound = false;
function bindLoupeScrollHide() {
  if (loupeScrollBound) {
    return;
  }
  loupeScrollBound = true;
  window.addEventListener('scroll', () => {
    const node = el('loupe');
    if (node.classList.contains('on')) {
      node.classList.remove('on');
    }
  }, { passive: true });
}

/** 相册格子的「翻书」：鼠标停上去，封面自己换这本里的下一张 */
function bindTilePreview(tile, album) {
  if (!finePointer || reduceMotion) {
    return;
  }
  const box = tile.querySelector('.mount');
  let layers = [];
  let timer = null;
  let idx = 0;
  let asked = false;
  const fetchOnce = () => {
    if (asked) {
      return;
    }
    asked = true;
    query({ album: album.name, pageSize: 5 }).then((res) => {
      const extra = res.items.filter((it) => !album.cover || it.path !== album.cover.path).slice(0, 3);
      // 横幅那格相片铺满整行，换片还取 760 宽就会小一大圈（相片不放大，按自己的尺寸摆）
      const layerWidth = tile.classList.contains('span12') ? 1400 : 760;
      layers = extra.map((it) => {
        // 悬停才取，取到了就得马上开始加载：相片在 mount 里是绝对居中的，
        // 没量出尺寸之前盒子只有一圈白边那么大，懒加载会把它当成「还没滚进来」
        const img = pic(it, thumbAt(it, layerWidth), true);
        img.className = 'layer';
        box.append(img);
        return img;
      });
    }).catch(() => {});
  };
  const cycle = () => {
    if (!layers.length || document.hidden) {
      return;
    }
    layers.forEach((l, i) => l.classList.toggle('on', i === idx % layers.length));
    idx += 1;
  };
  tile.addEventListener('pointerenter', () => {
    fetchOnce();
    cycle();
    clearInterval(timer);
    timer = setInterval(cycle, 2100);
  });
  const stop = () => {
    clearInterval(timer);
    timer = null;
    layers.forEach((l) => l.classList.remove('on'));
  };
  tile.addEventListener('pointerleave', stop);
  tile.addEventListener('focus', cycle);
  tile.addEventListener('blur', stop);
  onPageCleanup(() => clearInterval(timer));
}

/** 影像页的追光：一小片亮区跟着鼠标走，强化「放映厅」 */
function bindSpotlight(scope) {
  if (!finePointer || reduceMotion) {
    return;
  }
  let raf = 0;
  let last = null;
  const onMove = (e) => {
    last = e;
    if (raf) {
      return;
    }
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = scope.getBoundingClientRect();
      scope.style.setProperty('--mx', `${(((last.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      scope.style.setProperty('--my', `${(((last.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    });
  };
  scope.addEventListener('pointermove', onMove);
  onPageCleanup(() => {
    scope.removeEventListener('pointermove', onMove);
    if (raf) {
      cancelAnimationFrame(raf);
    }
  });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const routes = {
  '/': renderHome,
  '/albums': renderAlbums,
  '/timeline': renderTimeline,
  '/films': renderFilms,
  '/about': renderAbout
};

function currentPath() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  return hash === '/' || routes[hash] ? hash : '/';
}

/** 导航顺序，用来判断这一页是「往前翻」还是「往后退」 */
const ORDER = ['/', '/albums', '/timeline', '/films', '/about'];
let lastRoute = null;

function transitionType(from, to) {
  if (!from || from === to) {
    return '';
  }
  return ORDER.indexOf(to) >= ORDER.indexOf(from) ? 'nav-forward' : 'nav-back';
}

/**
 * 共享元素过渡：让一个元素自己飞到另一个的位置上去
 * 关键是同一刻只能有一个元素叫这个名字：旧状态给 from 命名，
 * DOM 改完后立即把名字从 from 摘下来给 to，否则浏览器报「多个同名元素」直接放弃动画
 */
async function morph(from, resolveTo, update) {
  if (!canVT || !from || !document.contains(from)) {
    await update();
    return;
  }
  from.style.viewTransitionName = 'lb-focus';
  const t = document.startViewTransition(async () => {
    await update();
    const target = typeof resolveTo === 'function' ? resolveTo() : resolveTo;
    from.style.viewTransitionName = '';
    if (target) {
      target.style.viewTransitionName = 'lb-focus';
    }
  });
  t.ready.catch(() => {});
  t.finished.catch(() => {});
  await t.updateCallbackDone.catch(() => {});
  await t.finished.catch(() => {});
  // 过渡被中止时回调里的清理不一定跑到，扫一遍兼漏：
  // 残留个同名元素会让下一次过渡直接报错不播
  document.querySelectorAll('[style*="lb-focus"]').forEach((n) => { n.style.viewTransitionName = ''; });
}

let switching = false;
let queued = false;

async function navigate() {
  if (switching) {
    // 过渡期间又点了导航：不能吞掉，记下来这一轮结束再跑一次
    queued = true;
    return;
  }
  switching = true;
  try {
    await paintRoute();
  } finally {
    switching = false;
    if (queued) {
      queued = false;
      navigate();
    }
  }
}

async function paintRoute() {
  const path = currentPath();
  const page = el('page');
  const type = transitionType(lastRoute, path);
  lastRoute = path;

  const paint = async () => {
    runCleanups();
    document.title = `${({ '/': '家', '/albums': '相册', '/timeline': '时间', '/films': '影像', '/about': '关于' })[path]} · 我们的家`;
    page.innerHTML = '';
    await routes[path](page);
    // 手机上点完导航，抽屉得自己收回去，不然新页面被盖在半屏菜单底下
    el('topnav').classList.remove('open');
    el('btnMenu').setAttribute('aria-expanded', 'false');
    el('btnMenu').setAttribute('aria-label', '打开菜单');
    document.querySelectorAll('nav.top a').forEach((a) => {
      const on = a.getAttribute('href') === `#${path}`;
      a.classList.toggle('on', on);
      if (on) {
        a.setAttribute('aria-current', 'page');
      } else {
        a.removeAttribute('aria-current');
      }
    });
    window.scrollTo({ top: 0, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
    watchReveals(page);
    bindParallax();
  };

  const root = document.documentElement;
  if (canVT) {
    // 回调有没有真跑过要同步记一笔，并且等 updateCallbackDone：
    // ViewTransition 上并没有 done 这个属性，await undefined 会立刻返回，
    // 于是兜底又补一次 paint —— 同一个 page 里就会长出两套内容
    let ran = false;
    if (type) {
      root.dataset.vt = type;
    }
    const t = document.startViewTransition(() => {
      ran = true;
      return paint();
    });
    // 页面在后台时过渡会被中止，这两个 Promise 的 reject 是预期内的，
    // 不接住就是控制台一整条 Uncaught
    t.ready.catch(() => {});
    t.finished.catch(() => {});
    t.finished.finally(() => { delete root.dataset.vt; }).catch(() => {});
    await t.updateCallbackDone.catch(() => {});
    if (!ran) {
      delete root.dataset.vt;
      await paint();
    }
    return;
  }

  if (type) {
    page.dataset.vt = type;
  }
  page.classList.add('leaving');
  await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 180));
  page.classList.remove('leaving');
  await paint();
  if (!reduceMotion) {
    page.classList.add('entering');
    // 方向标记要活到这段入场动画结束（不然 [data-vt] 的选择器匹不上），但一定要抹掉，
    // 不然下一次同页重绘会承接到上一次的进出方向
    setTimeout(() => page.classList.remove('entering'), 600);
    setTimeout(() => delete page.dataset.vt, 620);
  } else {
    delete page.dataset.vt;
  }
}

window.addEventListener('hashchange', navigate);

// ---------------------------------------------------------------------------
// 页面：家
// ---------------------------------------------------------------------------
async function renderHome(page) {
  const site = SITE || await getJson('/api/site');
  page.append(heroSection(site));

  const rail = document.createElement('section');
  rail.className = 'wrap rv';
  rail.innerHTML = `<div class="head"><h2 class="h2">最新的日子<span>RECENT</span></h2>
    <a class="link" href="#/timeline">按时间翻 →</a></div>
    <div class="rail" id="recentRail"><div class="rail-track"></div></div>`;
  page.append(rail);
  skeleton(5, rail.querySelector('#recentRail .rail-track'));
  const latest = await query({ pageSize: 14, kind: 'photo' });
  drawRail(rail.querySelector('#recentRail'), latest.items);

  page.append(bandSection(latest.items[3] || latest.items[0]));
  page.append(albumsTeaser(site.albums));
  page.append(yearSnippet());
}

/** 首屏：左边大字，右边三张「活的照片」拼贴 */
function heroSection(site) {
  const section = document.createElement('section');
  section.className = 'hero wrap';
  const years = site.years.map((y) => y.year).sort();
  const pinned = site.pinned || [];
  // 没配精选时的选材：置顶相册优先，其次按张数多的（首屏要给「内容最多」的那几本门面）
  const rank = (name) => { const i = pinned.indexOf(name); return i < 0 ? 1e6 : i; };
  const byAlbumOrder = [...site.albums].sort((a, b) => (rank(a.name) - rank(b.name)) || (b.count - a.count));
  section.innerHTML = `
    <div class="hero-grid">
      <div>
        <p class="eyebrow">Family Archive · <span class="num">${years[0] || ''} — ${years[years.length - 1] || ''}</span></p>
        <h1 class="display">我们的家<em>，</em><br>一起走过的日子</h1>
        <p class="lede">这台电脑里 ${nf.format(site.stats.photos)} 张照片、${nf.format(site.stats.videos)} 段视频，
          按文件夹自动分成 ${site.stats.albums} 本相册。不用登录，家里任何一台设备打开都能看。</p>
        <div class="facts">
          <a href="#/albums"><span class="k num"><span data-count="${site.stats.photos}">${nf.format(site.stats.photos)}</span></span><span class="v">张照片</span></a>
          <a href="#/films"><span class="k num"><span data-count="${site.stats.videos}">${nf.format(site.stats.videos)}</span></span><span class="v">段影像</span></a>
          <a href="#/about"><span class="k num">${humanSize(site.stats.totalBytes)}</span><span class="v">素材体积</span></a>
          <a href="#/timeline"><span class="k num"><span data-count="${years.length}">${years.length}</span></span><span class="v">个年份</span></a>
        </div>
        <a class="cta" href="#/albums">从相册开始看
          <svg viewBox="0 0 24 8" aria-hidden="true"><path d="M0 4h22M18 1l4 3-4 3"/></svg></a>
      </div>
      <div class="collage" data-par="0.06" id="collage">
        <div class="shot a fade" style="--i:0"></div>
        <div class="shot b fade" style="--i:1"></div>
        <div class="shot c fade" style="--i:2"></div>
      </div>
    </div>`;

  const slots = [...section.querySelectorAll('.shot')];
  // 卡纸尺寸取决于格子的像素大小，窗口一变就得重量（媒体查询也在改格子尺寸）
  const collage = section.querySelector('.collage');
  const resize = new ResizeObserver(() => fitPrints(collage));
  resize.observe(collage);
  onPageCleanup(() => resize.disconnect());
  // 宽度取预热过的档位（760/620），不然首次打开在现成生成会卡一下
  const widthOf = (i) => (i === 0 ? 760 : 620);
  const fromAlbums = () => slots.forEach((slot, i) => {
    const album = byAlbumOrder[i];
    if (!album) {
      slot.remove();
      return;
    }
    query({ album: album.name, pageSize: 3 }).then((res) => {
      livingShot(slot, res.items, widthOf(i), i * 1700);
      watchReveals(section);
    }).catch(() => {});
  });

  // 每一格都是「活的照片」：格内几张照片轮流当主角，看久了像一张会动的照片。
  // 写了精选清单就用清单里的照片（三格均分），否则一本相册占一格
  if (!site.featured) {
    fromAlbums();
    return section;
  }
  getJson('/api/featured?limit=9').then((res) => {
    const items = res.items || [];
    if (items.length < slots.length) {
      fromAlbums();
      return;
    }
    const per = Math.ceil(items.length / slots.length);
    slots.forEach((slot, i) => {
      const group = items.slice(i * per, (i + 1) * per);
      if (!group.length) {
        slot.remove();
        return;
      }
      livingShot(slot, group, widthOf(i), i * 1700);
    });
    watchReveals(section);
  }).catch(fromAlbums);
  return section;
}

/**
 * 「活的照片」：一个格子里叠几张独立装裱的相片，每层跑自己的呼吸运镜，
 * 到点就与下一层交叉溶解。
 *
 * 相片不直接拿格子尺寸当尺寸：等图片量出真实比例后由 fitPrints 算，
 * 所以卡纸刚好包住照片、横竖构图都不裁。说明也写成每张一份，
 * 跟着相片一起淡入淡出，不再需要一个元素担“当前这张”的文案
 */
function livingShot(slot, items, width, startDelay) {
  if (!items || items.length === 0) {
    return;
  }
  const collage = slot.parentElement;
  const prints = items.map((item, i) => {
    const print = document.createElement('figure');
    print.className = 'print';
    if (i === 0) {
      print.classList.add('on');
    }
    // 三层都是会轮到上台的主角，不能懒加载：卡纸在量出尺寸前是 0 大的盒子，
    // 懒加载会把它当成「还在屏外」而一直不取图，那一层就永远空着
    const img = pic(item, thumbAt(item, width), true);
    img.addEventListener('load', () => {
      const ar = img.naturalWidth / img.naturalHeight;
      if (ar > 0) {
        print.__ar = ar;
        fitPrints(collage);
      }
    }, { once: true });
    const cap = document.createElement('figcaption');
    cap.className = 'cap';
    // 日期用 2019.10.20 而不是「2019 年 10 月 20 日」：窄一点的卡纸只有照片那么宽
    //（一张竖构图能瘦到 90px），中文日期写上去会被省略号截掉一半
    cap.innerHTML = `<span>${esc(item.folder || item.album)}</span><span class="num">${item.date.replace(/-/g, '.')}</span>`;
    print.append(img, cap);
    slot.append(print);
    return print;
  });
  if (prints.length < 2 || reduceMotion) {
    return;
  }
  let idx = 0;
  const timer = setInterval(() => {
    // 标签页看不到的时候别转，省电也省流量
    if (document.hidden) {
      return;
    }
    const next = (idx + 1) % prints.length;
    prints[idx].classList.remove('on');
    prints[next].classList.add('on');
    idx = next;
  }, 5400 + startDelay % 1400);
  onPageCleanup(() => clearInterval(timer));
}

/**
 * 重算首屏每张相片的尺寸：卡纸要 hug 住照片，又不能顶破格子。
 * 可用区 = 格子扣掉卡纸边距，再按照片比例取“能塞下的那个边”。
 * 边距只以 CSS 的 --mat-* 为准（媒体查询会改它），所以这里现读而不是写死。
 * @param {Element} collage 拼贴容器
 */
function fitPrints(collage) {
  if (!collage) {
    return;
  }
  const cs = getComputedStyle(collage);
  const px = (name, fallback) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const matX = px('--mat-x', 11);
  const matT = px('--mat-t', 11);
  const matB = px('--mat-b', 44);
  collage.querySelectorAll('.shot').forEach((slot) => {
    const availW = Math.max(0, slot.clientWidth - matX * 2);
    const availH = Math.max(0, slot.clientHeight - matT - matB);
    slot.querySelectorAll('.print').forEach((print) => {
      if (!print.__ar) {
        return;
      }
      const h = Math.min(availH, availW / print.__ar);
      // 先取整照片的边长、再加卡纸边距：反过来四舍五入会让内窗比例偏掉近 3%，
      // 那几像素的缝在 object-fit:contain 下就成了一圈白边
      print.style.width = `${Math.round(h * print.__ar) + matX * 2}px`;
      print.style.height = `${Math.round(h) + matT + matB}px`;
    });
  });
}

/** 一条横幅大图 + 一句话，负责「温馨」那一半 */
function bandSection(item) {
  const band = document.createElement('div');
  band.className = 'bleed band fade';
  // 能用滚动时间线驱动的话就别占 JS，两者只选一个
  if (!canSDA) {
    band.dataset.par = '0.09';
  }
  band.innerHTML = `<div class="veil"></div>
    <div class="say">
      <p class="who">为什么做这个</p>
      <p class="quote">照片存在硬盘里只是存着，<br>让家里人随时翻得动，才叫留着。</p>
    </div>`;
  if (item) {
    band.prepend(pic(item, thumbAt(item, 1600), true));
  }
  return band;
}

/** 跑马灯的速度（px/秒）：慢到随手点得中，又快到看得出在动 */
const RAIL_SPEED = 60;

/**
 * 「最新的日子」那条轨道：自己往左跑的跑马灯，不用手拖。
 * 同一批照片摆两份接在一条轨道上，CSS 跑到 -50%（正好一份）时回到起点，
 * 画面完全接得上。时长按一份的实际宽度换算，照片多少、屏幕宽窄都不会
 * 让它跑得快起来。
 * 第二份是替身：点得动（它和原件是同一件事），但读屏与 Tab 不该重复看见它。
 * 不开跑马灯（prefers-reduced-motion）时 CSS 会把它退回手拖，两份都留着。
 */
function drawRail(box, items) {
  box.innerHTML = '';
  const track = document.createElement('div');
  track.className = 'rail-track';
  const make = (item, i, echo) => {
    const plate = document.createElement('article');
    plate.className = 'plate';
    const picBox = document.createElement('div');
    picBox.className = 'pic';
    const img = pic(item, thumbAt(item, 620));
    picBox.append(img);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b>${item.date.slice(5).replace('-', ' / ')}</b><span>${esc(item.album)}</span>`;
    plate.append(picBox, meta);
    plate.tabIndex = echo ? -1 : 0;
    plate.setAttribute('role', 'button');
    plate.setAttribute('aria-label', `放大 ${item.name}，${cnDate(item.date)}`);
    if (echo) {
      plate.setAttribute('aria-hidden', 'true');
    }
    // 把这张小图交给灯箱，它就能从原地“长”成大图；关掉时再缩回来
    const open = () => player.open(items, i, img);
    plate.addEventListener('click', open);
    plate.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    return plate;
  };
  items.forEach((item, i) => track.append(make(item, i, false)));
  items.forEach((item, i) => track.append(make(item, i, true)));
  box.append(track);
  // 直接量（不等一帧）：每块照片的宽是 flex-basis 定死的，不等图片加载，
  // 读 offsetWidth 会强制一次布局，背着的标签页里也能拿到值
  const one = track.offsetWidth / 2;
  if (one > 0) {
    track.style.setProperty('--rail-dur', `${Math.round(one / RAIL_SPEED)}s`);
  }
}

function albumsTeaser(albums) {
  const section = document.createElement('section');
  section.className = 'wrap';
  section.innerHTML = `<div class="head rv"><h2 class="h2">相册<span>ALBUMS</span></h2>
    <a class="link" href="#/albums">全部 ${albums.length} 本 →</a></div>
    <div class="sheet-grid" id="teaser"></div>`;
  const grid = section.querySelector('#teaser');
  albums.slice(0, 3).forEach((album, i) => {
    grid.append(albumTile(album, i === 0 ? 'span12' : '', i));
  });
  return section;
}

/** 最近三个月的小片段，让首页有个「时间的样子」 */
function yearSnippet() {
  const section = document.createElement('section');
  section.className = 'wrap rv';
  section.innerHTML = `<div class="head"><h2 class="h2">这个月的日子<span>THIS MONTH</span></h2>
    <a class="link" href="#/timeline">完整时间线 →</a></div>
    <div class="strip" id="snippet"></div>`;
  const strip = section.querySelector('#snippet');
  skeleton(4, strip);
  getJson('/api/timeline').then((data) => {
    const bucket = data.months[0];
    if (!bucket) {
      strip.innerHTML = '';
      return;
    }
    section.querySelector('.head h2').innerHTML = `${cnMonth(bucket.month)}<span>${nf.format(bucket.count)} 项</span>`;
    return query({ month: bucket.month, pageSize: 8 }).then((res) => {
      strip.innerHTML = '';
      res.items.forEach((item, i) => {
        const cell = document.createElement('div');
        cell.className = `pic ${revealClass()}`;
        cell.style.setProperty('--i', String(i));
        const img = pic(item, thumbAt(item, 620));
        cell.append(img);
        cell.addEventListener('click', () => player.open(res.items, i, img));
        strip.append(cell);
      });
      watchReveals(strip);
    });
  }).catch(() => {
    strip.innerHTML = '';
  });
  return section;
}

// ---------------------------------------------------------------------------
// 页面：相册
// ---------------------------------------------------------------------------
async function renderAlbums(page) {
  const site = SITE || await getJson('/api/site');
  const head = document.createElement('section');
  head.className = 'wrap';
  head.innerHTML = `<div style="padding:var(--s6) 0 var(--s4)">
      <p class="eyebrow rv">Albums · ${site.stats.albums}</p>
      <h1 class="display rv" style="--i:1;margin:var(--s2) 0 var(--s3)">相册</h1>
      <p class="lede rv" style="--i:2">一个文件夹就是一本相册。点开是全部照片，瀑布流按时间倒着排，
        往上翻就是更早的日子。</p>
    </div>
    <div class="sheet-grid" id="grid"></div>`;
  page.append(head);
  const grid = head.querySelector('#grid');
  site.albums.forEach((album, i) => {
    const tile = albumTile(album, i === 0 ? 'span12' : '', i);
    grid.append(tile);
  });
  watchReveals(page);
}

function albumTile(album, extraClass, order) {
  const tile = document.createElement('article');
  tile.className = `tile rv ${extraClass}`;
  tile.style.setProperty('--i', String(order % 4));
  const picBox = document.createElement('div');
  picBox.className = 'pic';
  // 相片是「贴」在封面上的，不是铺满封面：mount 划出贴相片的那块地方，
  // 悬停换片也往这里放，几张图才会不偏不倚叠在同一处
  const mount = document.createElement('div');
  mount.className = 'mount';
  if (album.cover) {
    // 横幅那张要铺满整行（最宽约 1300px），所以要 1600 宽；普通格 1000 宽，
    // 缓存键带宽度所以两者不会互相顶掉
    const cover = pic(album.cover, thumbAt(album.cover, extraClass === 'span12' ? 1600 : 1000));
    mount.append(cover);
    if (extraClass === 'span12') fitRowToCover(tile, cover);
  } else {
    picBox.classList.add('skeleton');
  }
  // 这行提示是贴在封面下沿的标签，得钉在封面盒子里：
  // 它要跟着封面一起翻走，而且挂到 tile 上就不归封面管了
  const float = document.createElement('div');
  float.className = 'float';
  float.textContent = `${nf.format(album.folderCount)} 个子文件夹 · 最近 ${album.latest ? cnDate(new Date(album.latest).toISOString().slice(0, 10)) : '—'}`;
  picBox.append(mount, float);
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = `<div><span class="name">${esc(album.name)}</span>
    <span class="tags">${album.years.join(' · ')}</span></div>
    <span class="count num">${nf.format(album.count)} 项 · ${nf.format(album.photos)} 照片${album.videos ? ` / ${nf.format(album.videos)} 视频` : ''}</span>`;
  // 名字在上、封面在下：先报“这本是谁”，再给你看封面
  tile.append(body, picBox);
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-label', `打开相册 ${album.name}，${album.count} 项`);
  bindTilePreview(tile, album);
  const open = () => {
    const chips = [{ label: '全部', params: {}, count: album.count, active: true }]
      .concat(album.folders
        // '全部' 是相册根下那些没子文件夹的文件，和第一个筛选项重复，不单独成列
        .filter((f) => f.count > 0 && f.name !== '全部' && f.name !== album.name)
        .slice(0, 10)
        .map((f) => ({ label: f.name, params: { folder: `${album.name}/${f.name}` }, count: f.count })));
    sheetView.open(album.name, `${nf.format(album.count)} 项 · ${album.years.join('、')}`, { album: album.name }, chips);
  };
  tile.addEventListener('click', () => flipOpen(tile, open));
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flipOpen(tile, open);
    }
  });
  return tile;
}

/**
 * 让横幅那一格的高跟着封面相片走。
 * 索引里没有尺寸（服务端不探图），所以只能等图加载完量一下 naturalWidth；
 * 量完写进 --cover-ar，CSS 拿它往 aspect-ratio 上一填，相片就能铺满整行。
 * 上下各夹一道：下限 1.45 防竖构图把这一格顶到一人多高（内容最宽 1360px，
 * 所以最多约 890px）；上限 2.4 防一张全景把行压成一条缝。
 * 夹了边界就不会与画面等宽，相片仍旧按原比例摆，只是两边留点空 —— 不裁。
 */
function fitRowToCover(tile, img) {
  const set = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const ar = Math.min(Math.max(img.naturalWidth / img.naturalHeight, 1.45), 2.4);
    tile.style.setProperty('--cover-ar', String(ar));
  };
  if (img.complete) set();
  else img.addEventListener('load', set, { once: true });
}

/**
 * 点下去先把这沓相片最上面那张抽走，再让浮层从中间摊开接上。
 * 浮层不等抽完：抽到三成就起页，两段动画叠着走——接得太快看不出是“抽”，
 * 等它抽完再开又像在等机器。
 * 开了「减少动态效果」就别拖这一拍，直接开。
 */
function flipOpen(tile, then) {
  if (reduceMotion) {
    then();
    return;
  }
  tile.classList.add('opening');
  setTimeout(then, 300);
  setTimeout(() => tile.classList.remove('opening'), 1100);
}

// ---------------------------------------------------------------------------
// 页面：时间
// ---------------------------------------------------------------------------
async function renderTimeline(page) {
  const data = await getJson('/api/timeline');
  const head = document.createElement('section');
  head.className = 'wrap';
  head.innerHTML = `<div style="padding:var(--s6) 0 var(--s5)">
      <p class="eyebrow rv">Timeline · ${data.years.length} years</p>
      <h1 class="display rv" style="--i:1;margin:var(--s2) 0 var(--s3)">时间</h1>
      <p class="lede rv" style="--i:2">日期是从文件名、导出时间戳和文件夹名里推断的，
        拿不准的就用文件的修改时间。点月份看整月。</p>
    </div>`;
  const tl = document.createElement('div');
  tl.className = 'wrap tl';
  tl.innerHTML = `<div class="years" id="yearList" role="tablist" aria-label="按年份筛选"></div>
    <div class="months" id="monthList"></div>`;
  page.append(head, tl);

  const yearList = tl.querySelector('#yearList');
  const monthList = tl.querySelector('#monthList');

  function drawMonths(year) {
    monthList.innerHTML = '';
    const months = data.months.filter((m) => m.year === year);
    months.forEach((bucket, i) => {
      const row = document.createElement('article');
      row.className = 'month rv';
      row.style.setProperty('--i', String(i % 3));
      row.innerHTML = `<div class="lab">
          <span class="num">${cnMonth(bucket.month)}</span>
          <span>${nf.format(bucket.count)} 项 · ${bucket.photos} 照片${bucket.videos ? ` / ${bucket.videos} 视频` : ''}</span>
          <span class="go">打开整月 →</span>
        </div><div class="strip" data-month="${bucket.month}"></div>`;
      const strip = row.querySelector('.strip');
      skeleton(4, strip);
      monthList.append(row);

      const openMonth = () => sheetView.open(cnMonth(bucket.month), `${nf.format(bucket.count)} 项`, { month: bucket.month });
      row.querySelector('.lab').addEventListener('click', (e) => {
        e.stopPropagation();
        openMonth();
      });
      row.addEventListener('click', (e) => {
        if (!e.target.closest('.pic')) {
          openMonth();
        }
      });

      query({ month: bucket.month, pageSize: 4 }).then((res) => {
        strip.innerHTML = '';
        res.items.forEach((item, idx) => {
          const cell = document.createElement('div');
          cell.className = `pic ${revealClass()}`;
          cell.style.setProperty('--i', String(idx));
          const img = pic(item, thumbAt(item, 620));
          cell.append(img);
          cell.addEventListener('click', (e) => {
            e.stopPropagation();
            player.open(res.items, idx, img);
          });
          // 联动：鼠标停在任意小图上，旁边浮出这张的大号预览
          bindLoupe(cell, item, img);
          strip.append(cell);
        });
        if (bucket.count > res.items.length) {
          const more = document.createElement('div');
          more.className = 'pic more wipe';
          more.dataset.more = `+${nf.format(bucket.count - res.items.length)}`;
          more.tabIndex = 0;
          more.setAttribute('role', 'button');
          more.setAttribute('aria-label', `打开 ${cnMonth(bucket.month)} 的全部素材`);
          more.addEventListener('click', (e) => {
            e.stopPropagation();
            openMonth();
          });
          strip.append(more);
        }
        watchReveals(monthList.parentElement);
      }).catch(() => {
        strip.innerHTML = '';
      });
    });
    if (!months.length) {
      monthList.append(stateBlock('这一年没有素材'));
    }
  }

  data.years.forEach((year, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = i === 0 ? 'on' : '';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    btn.innerHTML = `<span>${year.year}</span><span class="num">${nf.format(year.count)}</span>`;
    btn.addEventListener('click', () => {
      yearList.querySelectorAll('button').forEach((b) => {
        b.classList.remove('on');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('on');
      btn.setAttribute('aria-selected', 'true');
      drawMonths(year.year);
      monthList.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    });
    yearList.append(btn);
  });
  drawMonths(data.years[0] ? data.years[0].year : null);
  watchReveals(page);
}

// ---------------------------------------------------------------------------
// 页面：影像
// ---------------------------------------------------------------------------
async function renderFilms(page) {
  const wrap = document.createElement('div');
  wrap.className = 'night';
  wrap.innerHTML = `<div class="spot" aria-hidden="true"></div>
    <div class="wrap" style="padding-top:var(--s6)">
      <p class="eyebrow rv" style="color:var(--on-night-muted)">Moving pictures</p>
      <h1 class="display rv" style="--i:1;color:#fff;margin:var(--s2) 0 var(--s3)">影像</h1>
      <p class="lede rv" style="--i:2;color:var(--on-night-muted)">点开就能播，进度条可以随便拖——
        视频没有被「上传」或转码，浏览器是直接从硬盘上读的那个大文件。</p>
    </div>
    <div class="wrap" style="padding:var(--s5) 0 var(--s7)">
      <div id="feature"></div>
      <div class="head" style="margin-top:var(--s6)"><h2 class="h2" style="color:#fff">最近的几段<span style="color:var(--on-night-muted)">RECENT CLIPS</span></h2>
        <button class="link" id="allVideos">看全部 →</button></div>
      <div class="vgrid" id="videoGrid"></div>
    </div>`;
  page.append(wrap);

  const data = await query({ kind: 'video', pageSize: 12 });
  const featureBox = wrap.querySelector('#feature');
  featureBox.innerHTML = '';
  if (!data.items.length) {
    featureBox.append(stateBlock('素材目录里还没有可播放的视频'));
    watchReveals(page);
    return;
  }
  const first = data.items[0];
  const feature = document.createElement('div');
  feature.className = 'feature rv';
  feature.innerHTML = `<div class="screen" role="button" tabindex="0" aria-label="播放 ${esc(first.name)}">
      <span class="play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l12 7-12 7z"/></svg></span>
    </div>
    <div class="say"><h2>${esc(first.name)}</h2>
      <p>${esc(first.folder || first.album)} · ${cnDate(first.date)} · ${humanSize(first.size)}</p></div>`;
  const screen = feature.querySelector('.screen');
  const featImg = pic(first, thumbAt(first, 1400), true);
  screen.prepend(featImg);
  const start = () => player.open(data.items, 0, featImg);
  screen.addEventListener('click', start);
  screen.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      start();
    }
  });
  featureBox.append(feature);

  const grid = wrap.querySelector('#videoGrid');
  grid.innerHTML = '';
  data.items.slice(1).forEach((item, i) => {
    grid.append(videoCard(item, data.items, i + 1));
  });
  wrap.querySelector('#allVideos').addEventListener('click', () => {
    sheetView.open('全部影像', `${nf.format(SITE ? SITE.stats.videos : data.total)} 段`, { kind: 'video' });
  });
  fillDurations(grid);
  bindSpotlight(wrap);
  watchReveals(page);
}

function videoCard(item, list, index) {
  const card = document.createElement('article');
  card.className = `vcard ${revealClass()}`;
  card.style.setProperty('--i', String(index % 4));
  const box = document.createElement('div');
  box.className = 'pic';
  const img = pic(item, thumbAt(item, 620));
  box.append(img);
  // 时长得 ffprobe 才知道，先占个空位，fillDurations 拿到数据再填
  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.dataset.path = item.path;
  dur.dataset.empty = '';
  box.append(dur);
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = `<b>${esc(item.name)}</b><span class="num">${item.date}</span>`;
  card.append(box, body);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `播放 ${item.name}`);
  const open = () => player.open(list, index, img);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  bindLoupe(box, item, img);
  return card;
}

/** 时长要 ffprobe 才知道，问服务端顺便把封面也提前抽出来 */
function fillDurations(scope) {
  scope.querySelectorAll('.dur[data-empty]').forEach(async (node) => {
    try {
      const info = await getJson(`/api/video-info?p=${encodeURIComponent(node.dataset.path)}`);
      if (info.duration) {
        node.textContent = mmss(info.duration);
        delete node.dataset.empty;
      }
    } catch {
      /* 没装 ffmpeg 就一直空着，不挡画面 */
    }
  });
}

// ---------------------------------------------------------------------------
// 页面：关于
// ---------------------------------------------------------------------------
async function renderAbout(page) {
  const site = SITE || await getJson('/api/site');
  const wrap = document.createElement('section');
  wrap.className = 'wrap';
  wrap.style.padding = 'var(--s6) 0 var(--s7)';
  wrap.innerHTML = `<p class="eyebrow rv">About</p>
    <h1 class="display rv" style="--i:1;margin:var(--s2) 0 var(--s5)">关于这个网站</h1>
    <div class="prose">
      <div class="side rv" style="--i:2">
        <p class="note">一句话：把硬盘里的照片视频，变成一个只有家里人能打开的网站。</p>
        <p class="note" style="margin-top:var(--s3)">没有账号、没有上传、没有数据库，
          关掉这个进程，网站就不存在了，素材一张也没动过。</p>
      </div>
      <dl>
        <div class="row rv"><dt>照片从哪来</dt><dd>直接读 <code>${esc(site.rootName)}</code> 这个文件夹，
          不复制、不改名、不转码。原图还是原图。</dd></div>
        <div class="row rv" style="--i:1"><dt>怎么加照片</dt><dd>把文件丢进那个文件夹（或它的任何子文件夹），
          点页眉右上角的圆形刷新按钮，十几秒后新照片就在里面了。</dd></div>
        <div class="row rv" style="--i:2"><dt>相册怎么分的</dt><dd>一级文件夹就是一本相册：
          ${site.albums.map((a) => esc(a.name)).join('、')}。子文件夹在相册里当筛选用。</dd></div>
        <div class="row rv" style="--i:3"><dt>日期怎么定的</dt><dd>先认文件名里的 <code>20191006</code> 这类日期，
          再认微信导出名里的 13 位时间戳，然后看上级文件夹名，最后才用文件修改时间。
          目前 ${nf.format(site.stats.photos + site.stats.videos)} 个素材里，约七成能从文件名直接认出来。</dd></div>
        <div class="row rv" style="--i:4"><dt>哪些不显示</dt><dd>根目录的 <code>.galleryignore</code> 里写着要排除的文件夹
          （废片、待修改、素材包这些），一行一个，改完刷新即可。</dd></div>
        <div class="row rv" style="--i:5"><dt>别人能看到吗</dt><dd>只有连到家里同一个路由器的设备能打开，
          地址是 <code>http://这台电脑的IP:8123</code>。它没有任何登录保护，别把端口映射到公网。</dd></div>
        <div class="row rv" style="--i:6"><dt>技术上</dt><dd>一个 Node 进程：Express 提供接口与静态文件，
          sharp 按需生成 webp 缩略图并永久缓存，视频靠 ffmpeg 抽一帧当封面。前端零构建，一个 HTML、一个 JS。</dd></div>
      </dl>
    </div>`;
  page.append(wrap);
  watchReveals(page);
}

// ---------------------------------------------------------------------------
// 浮层：相册 / 月份筛选
// ---------------------------------------------------------------------------
const sheetView = {
  open(title, sub, params, chips = []) {
    el('sheetTitle').textContent = title;
    el('sheetSub').textContent = sub;
    el('sheetView').classList.add('open');
    document.body.style.overflow = 'hidden';
    this.renderChips(chips, params);
    this.load({ ...params, page: 1 }, false);
    el('sheetView').querySelector('.close').focus();
  },
  close() {
    el('sheetView').classList.remove('open');
    document.body.style.overflow = '';
    if (this.lastFocus) {
      this.lastFocus.focus();
    }
  },
  renderChips(chips, base) {
    const box = el('sheetChips');
    box.innerHTML = '';
    chips.forEach((chip) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chip${chip.active ? ' on' : ''}`;
      btn.textContent = `${chip.label}${chip.count ? ` · ${nf.format(chip.count)}` : ''}`;
      btn.addEventListener('click', () => {
        this.open(el('sheetTitle').textContent, el('sheetSub').textContent,
          { ...base, ...chip.params },
          chips.map((c) => ({ ...c, active: c.label === chip.label })));
      });
      box.append(btn);
    });
    box.hidden = chips.length === 0;
  },
  async load(params, append) {
    const body = el('sheetBody');
    let grid;
    if (!append) {
      body.innerHTML = '';
      body.setAttribute('aria-busy', 'true');
      grid = document.createElement('div');
      grid.className = 'masonry';
      body.append(grid);
      grid.append(skeleton(9));
    } else {
      grid = body.querySelector('.masonry');
      body.querySelectorAll('.more').forEach((n) => n.remove());
      grid.append(skeleton(6));
    }
    try {
      const data = await query({ ...params, pageSize: 48 });
      grid.innerHTML = '';
      if (!data.items.length) {
        body.append(stateBlock('这一批里没有素材'));
        return;
      }
      data.items.forEach((item, i) => grid.append(masonryFigure(item, data.items, i)));
      if (params.kind === 'video') {
        fillDurations(grid);
      }
      if (data.hasMore) {
        const more = document.createElement('div');
        more.className = 'more';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `再看 48 项（共 ${nf.format(data.total)}）`;
        btn.addEventListener('click', () => this.load({ ...params, page: (params.page || 1) + 1 }, true));
        more.append(btn);
        body.append(more);
      }
      watchReveals(grid);
    } catch (err) {
      grid.innerHTML = '';
      body.append(stateBlock(`载入失败：${err.message}`, true));
    } finally {
      body.setAttribute('aria-busy', 'false');
    }
  }
};

function masonryFigure(item, list, index) {
  const figure = document.createElement('figure');
  figure.className = revealClass();
  figure.style.setProperty('--i', String(index % 8));
  const img = pic(item, thumbAt(item, 760));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sr';
  btn.textContent = `放大 ${item.name}，${cnDate(item.date)}`;
  btn.addEventListener('click', () => player.open(list, index, img));
  figure.append(btn, img);
  const cap = document.createElement('figcaption');
  cap.textContent = `${item.folder || item.album} · ${cnDate(item.date)}`;
  figure.append(cap);
  figure.addEventListener('click', (e) => {
    if (!e.target.closest('button')) {
      player.open(list, index, img);
    }
  });
  return figure;
}

// ---------------------------------------------------------------------------
// 浮层：灯箱
// ---------------------------------------------------------------------------
const player = {
  list: [],
  index: 0,
  lastFocus: null,
  origin: null,
  current: null,
  gifUrl: null,
  gifOn: false,

  open(items, start, origin) {
    this.list = items;
    this.index = start;
    this.lastFocus = document.activeElement;
    this.origin = origin && origin.tagName === 'IMG' ? origin : (origin ? origin.querySelector('img') : null);
    this.gifUrl = null;
    this.gifOn = false;
    const item = items[start];
    const photo = item && item.kind !== 'video';
    const reveal = () => {
      el('player').classList.add('open');
      document.body.style.overflow = 'hidden';
      this.show('first');
      el('lbClose').focus();
    };
    // 照片才做共享元素：视频那边是个 <video>，快照时第一帧没出来会闪一下黑
    if (photo && this.origin) {
      morph(this.origin, () => el('stage').querySelector('.lay:not(.out) img'), reveal);
    } else {
      reveal();
    }
  },
  close(skipMorph) {
    const item = this.list[this.index];
    const hide = () => {
      el('player').classList.remove('open');
      el('stage').innerHTML = '';
      document.body.style.overflow = '';
      if (this.lastFocus) {
        this.lastFocus.focus();
      }
    };
    // 原路退回：把大图缩回它来时的格子，关闭就不再是「一弹一走」
    // skipMorph：手势滑走的时候图已经被扔到屏外了，再拿它做共享元素只会抽一下
    if (!skipMorph && item && item.kind !== 'video' && this.current && this.origin && document.contains(this.origin)) {
      morph(this.current, () => this.origin, hide);
    } else {
      hide();
    }
  },
  step(delta) {
    if (!this.list.length) {
      return;
    }
    this.index = (this.index + delta + this.list.length) % this.list.length;
    this.gifOn = false;
    this.show(delta > 0 ? 'next' : 'prev');
  },
  /** 当前这一格的画面：照片用预览尺寸，视频直接读本地大文件 */
  content(item) {
    if (item.kind === 'video') {
      if (this.gifOn && this.gifUrl) {
        const img = document.createElement('img');
        img.src = this.gifUrl;
        img.alt = `${item.name} 的循环动图`;
        return img;
      }
      const v = document.createElement('video');
      v.src = item.url;
      v.poster = thumbAt(item, 1000);
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      return v;
    }
    return pic(item, item.preview || item.thumb, true);
  },
  show(mode = 'first') {
    const item = this.list[this.index];
    if (!item) {
      return;
    }
    const stage = el('stage');
    let host = stage.querySelector('.stage-in');
    if (!host) {
      stage.innerHTML = '';
      host = document.createElement('div');
      host.className = 'stage-in';
      stage.append(host);
    }
    const outgoing = host.querySelector('.lay:not(.out)');
    const lay = document.createElement('div');
    lay.className = 'lay';
    lay.style.setProperty('--from', mode === 'prev' ? '-30px' : '30px');
    const node = this.content(item);
    lay.append(node);
    host.append(lay);
    if (outgoing) {
      outgoing.classList.add('out');
      setTimeout(() => outgoing.remove(), mode === 'first' ? 0 : 520);
    }
    this.current = node;

    el('lbIndex').textContent = `${this.index + 1} / ${this.list.length}`;
    el('lbName').textContent = item.name;
    el('lbMeta').textContent = this.gifOn
      ? '循环动图 · 再点一次「动图」回到原片'
      : `${item.folder || item.album} · ${cnDate(item.date)} · ${humanSize(item.size)}`;
    el('lbOpen').href = item.url;
    const gif = el('lbGif');
    gif.classList.toggle('show', item.kind === 'video' && !!(SITE && SITE.anim));
    gif.textContent = this.gifOn ? '看原片' : '动图';

    const strip = el('lbStrip');
    strip.innerHTML = '';
    const from = Math.max(0, this.index - 6);
    this.list.slice(from, from + 13).forEach((entry, i) => {
      const abs = from + i;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = abs === this.index ? 'on' : '';
      btn.setAttribute('aria-label', `第 ${abs + 1} 个：${entry.name}`);
      btn.append(pic(entry));
      btn.addEventListener('click', () => {
        const dir = abs >= this.index ? 'next' : 'prev';
        this.gifOn = false;
        this.index = abs;
        this.show(dir);
      });
      // 联动：在胶片条上滑过，上面那张就先替你看一眼，不改变当前序号
      btn.addEventListener('pointerenter', () => this.peek(abs));
      btn.addEventListener('pointerleave', () => this.peek(null));
      btn.addEventListener('focus', () => this.peek(abs));
      btn.addEventListener('blur', () => this.peek(null));
      strip.append(btn);
    });
  },
  /** 胶片条上的“偷看”：多一个浮层，离开就抽掉 */
  peek(abs) {
    const host = el('stage').querySelector('.stage-in');
    if (!host) {
      return;
    }
    const old = host.querySelector('.lay.peek');
    if (old) {
      old.remove();
    }
    if (abs === null || abs === this.index) {
      return;
    }
    const item = this.list[abs];
    if (!item || item.kind === 'video') {
      return;
    }
    const lay = document.createElement('div');
    lay.className = 'lay peek';
    lay.style.setProperty('--from', '0px');
    lay.append(pic(item, thumbAt(item, 1000), true));
    host.append(lay);
  },
  /** 把这段视频的前几秒抽成一张循环动图（服务端 ffmpeg，结果常驻缓存） */
  async makeGif() {
    const item = this.list[this.index];
    if (!item || item.kind !== 'video') {
      return;
    }
    if (this.gifOn) {
      this.gifOn = false;
      this.show('next');
      return;
    }
    if (this.gifUrl) {
      this.gifOn = true;
      this.show('next');
      return;
    }
    const btn = el('lbGif');
    btn.textContent = '制作中…';
    try {
      const res = await getJson(`/api/anim?p=${encodeURIComponent(item.path)}`);
      this.gifUrl = res.url;
      this.gifOn = true;
      this.show('next');
    } catch (err) {
      toast(`动图没做成：${err.message}`);
      btn.textContent = '动图';
    }
  }
};

el('lbClose').addEventListener('click', () => player.close());
el('lbPrev').addEventListener('click', () => player.step(-1));
el('lbNext').addEventListener('click', () => player.step(1));
el('lbGif').addEventListener('click', () => player.makeGif());

// ---------------------------------------------------------------------------
// 灯箱手势：左右滑换张、向下滑关掉；双指捏合 / 双击放大，放大后可拖动平移
// 手机上箭头在两边摸不到、胶片条又占着下面，拖一下就换才是自然的手势。
// 只接触摸屏：鼠标继续交给箭头与键盘，不抢普通点击。
// 放大态（scale>1）下单指改成平移，左右滑/下滑关闭暂时让位；捏回 1x 或双击还原后恢复。
// 每张的缩放状态挂在它自己的节点上（show 会新建），换张自然复位。
// ---------------------------------------------------------------------------
const SWIPE_MIN = 44;   // 慢拖的位移阈值（px）
const FLICK_MIN = 18;   // 甩一下：短而快也算
const FLICK_MS = 300;
const FLIP_MIN = 90;    // 向下滑多少就关
const ZOOM_MAX = 4;      // 双指最多放这么大
const ZOOM_DBL = 2.5;    // 双击放到的倍数
const ZOOM_EPS = 0.02;   // 离 1x 差一点就算没放大
const TAP_MS = 260;      // 一次「轻点」的最长时长
const TAP_SLOP = 12;     // 轻点允许的位移（px），超过就是拖不是点
const TAP_GAP = 320;     // 两次轻点的最大间隔，才算双击
const TAP_DIST = 30;     // 两次轻点落点的最大距离

/** 取/建某个节点的缩放状态（缩放倍率与平移量，均相对未变换时的中心） */
function zoomState(node) {
  if (!node.__zoom) {
    node.__zoom = { s: 1, tx: 0, ty: 0 };
  }
  return node.__zoom;
}

function applyZoom(node) {
  const z = zoomState(node);
  node.style.transform = `translate3d(${Math.round(z.tx)}px,${Math.round(z.ty)}px,0) scale(${z.s.toFixed(3)})`;
}

/** 夹住缩放倍率并据此限制平移：不把图拖离视野中心，回到 1x 就彻底复位 */
function clampZoom(node, stage) {
  const z = zoomState(node);
  z.s = Math.min(ZOOM_MAX, Math.max(1, z.s));
  if (z.s - 1 < ZOOM_EPS) {
    z.s = 1;
    z.tx = 0;
    z.ty = 0;
    return;
  }
  const overX = Math.max(0, (z.s * node.offsetWidth - stage.clientWidth) / 2);
  const overY = Math.max(0, (z.s * node.offsetHeight - stage.clientHeight) / 2);
  z.tx = Math.max(-overX, Math.min(overX, z.tx));
  z.ty = Math.max(-overY, Math.min(overY, z.ty));
}

(function bindGestures() {
  const stage = el('stage');
  const pointers = new Map();   // pointerId -> {x,y}
  let mode = 'none';            // none | swipe | pan | pinch
  let node = null;
  let lay = null;
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  let dx = 0;
  let dy = 0;
  let panLast = null;           // 平移：上一次单指位置
  let pinch = null;             // 捏合：起始快照
  let lastTapAt = 0;            // 双击：上一次轻点
  let lastTap = null;

  const currentLay = () => stage.querySelector('.lay:not(.out):not(.peek)');
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // --- 换张 / 关闭的甩动（沿用原有观感）---
  const settle = () => {
    if (node) {
      node.style.transition = reduceMotion ? 'none' : 'transform .26s var(--ease-out),opacity .26s';
      applyZoom(node);          // 回到这张当前的缩放态（未放大时即清掉滑动位移）
      node.style.opacity = '';
    }
  };
  const fling = (tx, ty, then) => {
    const gone = lay;
    const media = node;
    if (media) {
      media.style.transition = reduceMotion ? 'none' : 'transform .24s var(--ease),opacity .24s';
      media.style.transform = `translate3d(${tx}px,${ty}px,0)`;
      media.style.opacity = '0';
    }
    if (gone) {
      // 标上 out：它已经不是「当前那张」了，不该再被交叉溶解当成底图；
      // 再加 flung 把入场/出场动画关掉，不然动画会盖过我们刚写上去的位移
      gone.classList.add('out', 'flung');
      setTimeout(() => gone.remove(), reduceMotion ? 0 : 300);
    }
    node = null;
    lay = null;
    mode = 'none';
    setTimeout(then, reduceMotion ? 0 : 110);
  };

  const beginPinch = () => {
    // 从滑动切到捏合：先把当前缩放态写回去，抹掉单指滑动的视觉位移
    applyZoom(node);
    node.style.opacity = '';
    const [p, q] = [...pointers.values()];
    const z = zoomState(node);
    const rect = node.getBoundingClientRect();
    // 未变换时的中心 O：当前屏幕中心 = O + t（scale 不移动原点）
    pinch = {
      d0: dist(p, q),
      m0: mid(p, q),
      s0: z.s,
      tx0: z.tx,
      ty0: z.ty,
      ox: rect.left + rect.width / 2 - z.tx,
      oy: rect.top + rect.height / 2 - z.ty,
    };
    mode = 'pinch';
  };

  const onPinch = () => {
    const [p, q] = [...pointers.values()];
    const z = zoomState(node);
    const k = pinch.s0 ? Math.min(ZOOM_MAX, Math.max(1, pinch.s0 * dist(p, q) / pinch.d0)) / pinch.s0 : 1;
    const m1 = mid(p, q);
    // 让起始中点下的那个图像点跟着移到当前中点：缩放 + 平移一次算完
    z.s = pinch.s0 * k;
    z.tx = (m1.x - pinch.ox) - k * (pinch.m0.x - pinch.ox - pinch.tx0);
    z.ty = (m1.y - pinch.oy) - k * (pinch.m0.y - pinch.oy - pinch.ty0);
    clampZoom(node, stage);
    applyZoom(node);
  };

  const onPan = (x, y) => {
    const z = zoomState(node);
    z.tx += x - panLast.x;
    z.ty += y - panLast.y;
    panLast = { x, y };
    clampZoom(node, stage);
    applyZoom(node);
  };

  const onSwipe = (x, y) => {
    dx = x - x0;
    dy = y - y0;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
      return;
    }
    // 带一点阻尼：越拖越沉，拖到一半松手也不会被当成确定换张
    if (Math.abs(dx) > Math.abs(dy)) {
      node.style.transform = `translate3d(${Math.round(dx * 0.72)}px,0,0)`;
      node.style.opacity = String(Math.max(0.45, 1 - Math.abs(dx) / stage.clientWidth));
    } else {
      node.style.transform = `translate3d(0,${Math.round(dy * 0.6)}px,0)`;
      node.style.opacity = String(Math.max(0.4, 1 - Math.abs(dy) / (stage.clientHeight || 1)));
    }
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') {
      return;
    }
    // 视频要把手势留给自己的控件（进度条、全屏），按钮与链接也一样
    if (e.target.closest('video,button,a')) {
      return;
    }
    if (pointers.size === 0) {
      const current = currentLay();
      if (!current || !current.firstElementChild) {
        return;
      }
      lay = current;
      node = current.firstElementChild;
      mode = 'pending';
      node.style.transition = 'none';
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      beginPinch();
    } else if (pointers.size === 1) {
      x0 = e.clientX;
      y0 = e.clientY;
      t0 = performance.now();
      dx = 0;
      dy = 0;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch') {
      if (pointers.size >= 2) {
        onPinch();
      }
      return;
    }
    if (mode === 'pending') {
      const moved = Math.hypot(e.clientX - x0, e.clientY - y0);
      if (moved < 4) {
        return;
      }
      mode = zoomState(node).s - 1 >= ZOOM_EPS ? 'pan' : 'swipe';
      panLast = { x: x0, y: y0 };
    }
    if (mode === 'pan') {
      onPan(e.clientX, e.clientY);
    } else if (mode === 'swipe') {
      onSwipe(e.clientX, e.clientY);
    }
  });

  const finish = (e) => {
    if (!pointers.has(e.pointerId)) {
      return;
    }
    const up = pointers.get(e.pointerId);
    const remaining = pointers.size - 1;
    pointers.delete(e.pointerId);
    if (e.cancelable) {
      e.preventDefault();   // 别让浏览器把双指点变成缩放/滚动
    }

    if (mode === 'pinch') {
      if (remaining >= 1) {
        // 还剩一根手指：从捏合顺滑接到平移
        const rest = [...pointers.values()][0];
        panLast = { x: rest.x, y: rest.y };
        mode = zoomState(node).s - 1 >= ZOOM_EPS ? 'pan' : 'swipe';
        return;
      }
      clampZoom(node, stage);
      node.style.transition = reduceMotion ? 'none' : 'transform .2s var(--ease-out)';
      applyZoom(node);
      mode = 'none';
      return;
    }

    if (mode === 'pan') {
      if (remaining === 0) {
        clampZoom(node, stage);
        node.style.transition = reduceMotion ? 'none' : 'transform .2s var(--ease-out)';
        applyZoom(node);
        mode = 'none';
      } else {
        const rest = [...pointers.values()][0];
        panLast = { x: rest.x, y: rest.y };
      }
      return;
    }

    // ——轻点（可能凑成双击）——
    const ms = performance.now() - t0;
    const moved = Math.hypot((up ? up.x : e.clientX) - x0, (up ? up.y : e.clientY) - y0);
    if (mode === 'pending' && ms < TAP_MS && moved < TAP_SLOP) {
      const now = performance.now();
      const spot = lastTap && now - lastTapAt < TAP_GAP && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < TAP_DIST;
      if (spot) {
        dblTapTo({ x: e.clientX, y: e.clientY });
        lastTap = null;
      } else {
        lastTapAt = now;
        lastTap = { x: e.clientX, y: e.clientY };
      }
      mode = 'none';
      return;
    }
    lastTap = null;

    if (mode !== 'swipe') {
      mode = 'none';
      return;
    }
    // ——滑动的收尾：够远或够快就换张/关闭，否则弹回——
    const flick = ms < FLICK_MS;
    const horiz = Math.abs(dx) >= Math.abs(dy);
    const hit = Math.abs(dx);
    const down = dy;
    if (horiz && (hit > SWIPE_MIN || (flick && hit > FLICK_MIN))) {
      const dir = dx < 0 ? 1 : -1;
      const w = stage.clientWidth || window.innerWidth;
      // 往左拖看下一张，这一张就跟着往左出屏
      fling(dx < 0 ? -w : w, 0, () => player.step(dir));
      return;
    }
    if (!horiz && (down > FLIP_MIN || (flick && down > 40))) {
      const h = stage.clientHeight || window.innerHeight;
      fling(0, h, () => player.close(true));
      return;
    }
    settle();
    mode = 'none';
  };

  /** 双击：以点击处为锚，在 1x 与 ZOOM_DBL 之间来回，再点还原 */
  function dblTapTo(f) {
    const z = zoomState(node);
    const rect = node.getBoundingClientRect();
    const ox = rect.left + rect.width / 2 - z.tx;
    const oy = rect.top + rect.height / 2 - z.ty;
    const ns = z.s - 1 >= ZOOM_EPS ? 1 : ZOOM_DBL;
    const k = ns / z.s;
    z.s = ns;
    z.tx = (f.x - ox) * (1 - k) + k * z.tx;
    z.ty = (f.y - oy) * (1 - k) + k * z.ty;
    clampZoom(node, stage);
    node.style.transition = reduceMotion ? 'none' : 'transform .28s var(--ease-out)';
    applyZoom(node);
  }

  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (mode === 'pinch' || mode === 'pan') {
      node.style.transition = reduceMotion ? 'none' : 'transform .2s var(--ease-out)';
      clampZoom(node, stage);
      applyZoom(node);
    } else {
      settle();
    }
    mode = pointers.size ? mode : 'none';
  });
})();

// ---------------------------------------------------------------------------
// 浮层：搜索
// ---------------------------------------------------------------------------
const search = {
  timer: null,
  open() {
    el('searchView').classList.add('open');
    document.body.style.overflow = 'hidden';
    el('searchInput').focus();
  },
  close() {
    el('searchView').classList.remove('open');
    document.body.style.overflow = '';
  },
  run(term) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const body = el('searchBody');
      if (!term.trim()) {
        body.innerHTML = '<p class="hint">搜索范围是本机素材目录里的文件名与文件夹名。</p>';
        return;
      }
      body.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'masonry';
      body.append(grid);
      grid.append(skeleton(6));
      try {
        const data = await query({ q: term.trim(), pageSize: 48 });
        grid.innerHTML = '';
        // 输入四个数字就当年份看：文件名没命中不要紧，时间线里一定命中
        const jump = yearJump(term);
        if (!data.items.length) {
          body.innerHTML = `<p class="hint">没有找到包含「${esc(term)}」的文件。试试 2020、婚纱照、IMG_ 这样的词。</p>`;
          if (jump) {
            body.append(jump);
          }
          return;
        }
        if (jump) {
          body.append(jump);
        }
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = `命中 ${nf.format(data.total)} 项，显示前 ${data.items.length} 项`;
        body.prepend(hint);
        data.items.forEach((item, i) => grid.append(masonryFigure(item, data.items, i)));
        if (data.items.some((i) => i.kind === 'video')) {
          fillDurations(grid);
        }
      } catch (err) {
        body.innerHTML = `<p class="hint">搜索失败：${esc(err.message)}</p>`;
      }
    }, 260);
  }
};

el('btnSearch').addEventListener('click', () => search.open());
el('searchInput').addEventListener('input', (e) => search.run(e.target.value));

/** 搜 2020 这类四位数时，给一条「按年份看全年」的旁路 */
function yearJump(term) {
  if (!/^(19|20)\d{2}$/.test(term.trim())) {
    return null;
  }
  const year = term.trim();
  const box = document.createElement('p');
  box.className = 'hint';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link';
  btn.textContent = `直接看 ${year} 全年 →`;
  btn.addEventListener('click', () => {
    search.close();
    sheetView.open(`${year} 年`, '按年份筛选', { year });
  });
  box.append(btn);
  return box;
}

// ---------------------------------------------------------------------------
// 全局
// ---------------------------------------------------------------------------
document.querySelectorAll('[data-close]').forEach((node) => {
  node.addEventListener('click', () => {
    sheetView.close();
    search.close();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (el('player').classList.contains('open')) {
      player.close();
    } else if (el('searchView').classList.contains('open')) {
      search.close();
    } else if (el('sheetView').classList.contains('open')) {
      sheetView.close();
    }
    return;
  }
  const playerOpen = el('player').classList.contains('open');
  if (playerOpen) {
    if (e.key === 'ArrowRight') {
      player.step(1);
    } else if (e.key === 'ArrowLeft') {
      player.step(-1);
    } else if (e.key === 'Tab') {
      const focusables = [...el('player').querySelectorAll('button,a,video')].filter((n) => n.offsetParent !== null);
      if (!focusables.length) {
        return;
      }
      e.preventDefault();
      const idx = focusables.indexOf(document.activeElement);
      focusables[(idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length].focus();
    }
    return;
  }
  if (e.key === '/' && !e.target.closest('input') && !searchTimerBusy()) {
    e.preventDefault();
    search.open();
  }
});

function searchTimerBusy() {
  return document.activeElement === el('searchInput');
}

el('btnMenu').addEventListener('click', () => {
  const open = el('topnav').classList.toggle('open');
  el('btnMenu').setAttribute('aria-expanded', String(open));
  el('btnMenu').setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
});

el('btnScan').addEventListener('click', async () => {
  const btn = el('btnScan');
  btn.style.transition = 'transform .9s var(--ease)';
  btn.style.transform = 'rotate(360deg)';
  setTimeout(() => {
    btn.style.transition = '';
    btn.style.transform = '';
  }, 950);
  try {
    const res = await getJson('/api/refresh', { method: 'POST' });
    toast(`开始重新扫描，${res.message || '十几秒后再刷新页面就能看到新素材'}`);
  } catch (err) {
    toast(`扫描请求失败：${err.message}`);
  }
});

let toastTimer = null;
function toast(text) {
  const t = el('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}

// ---------------------------------------------------------------------------
// 背景音乐：把 bgm 文件夹整夹循环播放
// 默认打开：浏览器不允许无手势外放，所以首次交互（点一下、按一下）即起播；
// 用户显式暂停过后，下次进页不再自动起。音量、选曲等偏好记在 localStorage。
// 播放坞在 #page 之外，路由切换不会把它重渲染掉，声音也不会断。
// ---------------------------------------------------------------------------
const bgm = {
  tracks: [],
  index: 0,
  audio: null,
  box: null,
  ready: false,
  consecutiveErrors: 0,
  pref: { i: 0, v: null, m: false, want: true },

  init() {
    this.box = el('bgm');
    this.audio = el('bgmAudio');
    try {
      const saved = JSON.parse(localStorage.getItem('bgm.pref') || '{}') || {};
      // v2 之前的版本会把「默认关」也存成 want:false，分不清是没建文件夹还是用户真按过暂停；
      // 没有 v2 标记的一律当新访客处理：回到「默认打开」，音量、选曲照旧保留
      if (!saved.v2 && 'want' in saved) {
        delete saved.want;
      }
      Object.assign(this.pref, saved);
    } catch { /* 读不到就用默认 */ }
    getJson('/api/bgm').then((data) => {
      if (!data || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        return;   // 没建文件夹或里面没音频：不展示播放控件
      }
      this.tracks = data.tracks;
      this.index = Math.min(Math.max(0, this.pref.i | 0), this.tracks.length - 1);
      if (this.pref.v === null) {
        this.pref.v = typeof data.defaultVolume === 'number' ? data.defaultVolume : 0.5;
      }
      this.ready = true;
      this.wire();
      this.box.hidden = false;
      this.applyVolume();
      this.load(this.index, false);
      // 默认想听（或上次没关）的话，等一个用户手势再接上（不能凭空外放）
      if (this.pref.want) {
        this.armAutoplay();
      }
    }).catch(() => { /* 接口没通就不放音乐，不影响看照片 */ });
  },

  wire() {
    const a = this.audio;
    a.addEventListener('ended', () => this.step(1, true));
    a.addEventListener('play', () => this.setPlaying(true));
    a.addEventListener('pause', () => this.setPlaying(false));
    a.addEventListener('error', () => this.onError());
    el('bgmToggle').addEventListener('click', () => this.toggle());
    el('bgmPrev').addEventListener('click', () => this.step(-1, false));
    el('bgmNext').addEventListener('click', () => this.step(1, false));
    el('bgmMute').addEventListener('click', () => this.toggleMute());
    const vol = el('bgmVol');
    vol.value = String(this.pref.v);
    vol.addEventListener('input', () => {
      this.pref.v = Number(vol.value);
      this.applyVolume();
      this.save();
    });
  },

  applyVolume() {
    const v = Math.min(1, Math.max(0, Number(this.pref.v)));
    this.audio.volume = v;
    this.audio.muted = !!this.pref.m;
    el('bgmVol').value = String(v);
    el('bgmMute').classList.toggle('muted', this.audio.muted);
    el('bgmMute').setAttribute('aria-label', this.audio.muted ? '取消静音' : '静音');
  },

  /** 载入第 n 首（循环取模）；autoplay 为 true 则立即播 */
  load(n, autoplay) {
    if (!this.tracks.length) {
      return;
    }
    this.index = ((n % this.tracks.length) + this.tracks.length) % this.tracks.length;
    const track = this.tracks[this.index];
    if (this.audio.src !== new URL(track.url, location.origin).href) {
      this.audio.src = track.url;
    }
    const title = el('bgmTitle');
    title.textContent = track.title;
    title.title = track.name;
    this.save();
    this.sessionMeta(track);
    if (autoplay) {
      this.play();
    }
  },

  play() {
    const p = this.audio.play();
    if (p && p.catch) {
      p.catch(() => { /* 还是被拦了（无手势），等下次点击 */ });
    }
  },

  toggle() {
    if (!this.ready) {
      return;
    }
    if (this.audio.paused) {
      this.pref.want = true;
      this.play();
    } else {
      this.pref.want = false;
      this.audio.pause();
    }
    this.save();
  },

  step(dir, auto) {
    this.consecutiveErrors = 0;
    this.load(this.index + dir, auto || !this.audio.paused);
  },

  toggleMute() {
    this.pref.m = !this.audio.muted;
    this.applyVolume();
    this.save();
  },

  onError() {
    // 坏文件、格式不支持：自动跳下一首；整夹都坏就停下，不要无限循环
    this.consecutiveErrors = (this.consecutiveErrors || 0) + 1;
    if (this.consecutiveErrors >= this.tracks.length) {
      this.consecutiveErrors = 0;
      this.audio.removeAttribute('src');
      this.setPlaying(false);
      toast('背景音乐的文件都播不了，可能格式不支持');
      return;
    }
    this.step(1, true);
  },

  setPlaying(on) {
    this.box.classList.toggle('playing', on);
    const btn = el('bgmToggle');
    btn.setAttribute('aria-label', on ? '暂停背景音乐' : '播放背景音乐');
    if (this.ready && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
      } catch { /* 老浏览器不支持就算了 */ }
    }
  },

  /** 系统锁屏/耳机上的播放控件（支持的话），也顺带把歌名交给系统展示 */
  sessionMeta(track) {
    if (!('mediaSession' in navigator)) {
      return;
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: SITE ? SITE.title : '背景音乐', album: '家庭相册' });
      navigator.mediaSession.setActionHandler('previoustrack', () => this.step(-1, true));
      navigator.mediaSession.setActionHandler('nexttrack', () => this.step(1, true));
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => { this.pref.want = false; this.audio.pause(); this.save(); });
    } catch { /* 部分字段不支持时忽略，不影响页内控件 */ }
  },

  /** 首次真实手势时把上次想要的外接上，之后不再自动弹声 */
  armAutoplay() {
    const resume = () => {
      detach();
      if (this.pref.want && this.audio.paused) {
        this.play();
      }
    };
    const detach = () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
    this._detachAutoplay = detach;
  },

  save() {
    try {
      // v2：「默认打开」之后的存档标记，见 init 里的迁移说明
      localStorage.setItem('bgm.pref', JSON.stringify({ v2: 1, i: this.index, v: this.pref.v, m: this.pref.m, want: this.pref.want }));
    } catch { /* 隐私模式下写不了不影响使用 */ }
  }
};

async function boot() {
  SITE = await getJson('/api/site');
  const years = SITE.years.map((y) => y.year).sort();
  el('footRoot').textContent = SITE.rootName;
  el('footNote').textContent = `${SITE.subtitle} · 最早的素材在 ${SITE.stats.firstDate}，最新在 ${SITE.stats.lastDate || '—'}`;
  el('footTime').textContent = new Date(SITE.generatedAt).toLocaleString('zh-CN', { hour12: false });
  bgm.init();
  await navigate();
}

boot().catch((err) => {
  el('page').append(stateBlock(`读不到本机索引：${err.message}`, true));
});

// ---------------------------------------------------------------------------
// 可安装：manifest 与图标在局域网 http 下照常生效（iOS/Android 的「添加到
// 主屏幕」不看 service worker）；SW 只在安全上下文里注册——http://192.168.x.x
// 下浏览器会直接拒绝注册，与其在控制台留一条红字，不如压根不试。
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 装不上也不影响看照片 */ });
  });
}
