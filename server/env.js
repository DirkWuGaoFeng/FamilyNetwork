/**
 * 极简 .env 加载：让不懂命令行环境变量的家人也能改配置
 *
 * 为什么不用 dotenv：整个项目的原则是零构建、少依赖，而这里需要的只是
 * 「KEY=VALUE、# 注释、引号可选」这一小截语法，三十行写完。
 *
 * 规则：
 * - 读仓库根目录的 .env（不存在就什么都不做，环境变量照常生效）
 * - 已经在环境里的变量**不会被覆盖**（`PORT=9000 npm start` 优先于 .env）
 * - 改完 .env 要重启服务才生效（config 只在启动时读一次）
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '.env');

/** 已解析过就不再读文件；测试里可以直接调用 load() 强制重来 */
let loaded = false;
/** 本次从 .env 读进来的键，启动日志里要报一句，免得改了文件没生效还找不到原因 */
let appliedKeys = [];

/**
 * 解析 .env 文本
 * @param {string} text 文件内容
 * @returns {Array<[string, string]>} 键值对（已去掉注释与引号）
 */
function parse(text) {
  const pairs = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 整体被引号包住的，脱掉引号；其余情况引号按字面量留着
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      // 未加引号时，空格后的 # 是行内注释
      value = value.replace(/\s+#.*$/, '').trim();
    }
    pairs.push([key, value]);
  }
  return pairs;
}

/**
 * 把 .env 写进 process.env（不覆盖已有值）
 * @param {boolean} [force] 忽略「已加载」标记，重新读文件（测试用）
 * @returns {Array<string>} 本次真正生效的键，方便启动时提示
 */
function load(force = false) {
  if (loaded && !force) {
    return [];
  }
  loaded = true;
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  const applied = [];
  for (const [key, value] of parse(text)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  appliedKeys = applied;
  return applied;
}

/** .env 里真正被采纳的键（命令行已给的不在这里） */
function applied() {
  return appliedKeys;
}

module.exports = { load, parse, applied, file: FILE };
