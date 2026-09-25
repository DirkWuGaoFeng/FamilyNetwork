/**
 * .env 解析：语法只有一小截，但家人真要改配置就全靠它
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const env = require('../server/env');

test('parse 支持注释、空行、引号与行内注释', () => {
  const pairs = env.parse([
    '# 整行注释',
    '',
    '   ',
    'A=1',
    'B = 2 ',
    'C="三个 词"',
    "D='原样'",
    'E=5 # 行内注释',
    'F="带 # 号的值"',
    'G=',
    'H=a=b=c',
    '=跳过',
    '没等号的一行',
    '  # 缩进后的注释'
  ].join('\n'));

  const map = Object.fromEntries(pairs);
  assert.equal(map.A, '1');
  assert.equal(map.B, '2', '等号两侧空格要脱掉');
  assert.equal(map.C, '三个 词', '引号包住的值里可以有空格');
  assert.equal(map.D, '原样');
  assert.equal(map.E, '5', '未加引号时空格后的 # 是注释');
  assert.equal(map.F, '带 # 号的值', '加引号时 # 按字面量留着');
  assert.equal(map.G, '', '空值保留键，让 config 的默认值接管');
  assert.equal(map.H, 'a=b=c', '值里可以有等号');
  assert.deepEqual(pairs.map(([k]) => k), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], '坏行安静跳过，不炸启动');
});

test('load 不覆盖命令行已有的环境变量', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-env-'));
  const file = path.join(dir, '.env');
  await fsp.writeFile(file, 'PORT=9099\nSITE_TITLE=测试之家\n', 'utf8');

  // 换掉模块里写死的文件路径：重新 require 一个实例，指到临时文件
  const source = await fsp.readFile(require.resolve('../server/env'), 'utf8');
  const patched = source.replace(
    "path.join(__dirname, '..', '.env')",
    JSON.stringify(file)
  );
  const tmpModule = path.join(dir, 'env.js');
  await fsp.writeFile(tmpModule, patched, 'utf8');

  process.env.PORT = '8123';
  delete process.env.SITE_TITLE;
  const mod = require(tmpModule);
  const applied = mod.load(true);

  assert.equal(process.env.PORT, '8123', '命令行优先级高于 .env');
  assert.equal(process.env.SITE_TITLE, '测试之家');
  assert.deepEqual(applied, ['SITE_TITLE'], '只报真正从 .env 采纳的键');
  assert.deepEqual(mod.applied(), ['SITE_TITLE']);

  await fsp.rm(dir, { recursive: true, force: true });
  delete process.env.PORT;
});

test('没有 .env 时 load 什么都不做', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-env-'));
  const source = await fsp.readFile(require.resolve('../server/env'), 'utf8');
  const missing = path.join(dir, 'does-not-exist.env');
  const tmpModule = path.join(dir, 'env.js');
  await fsp.writeFile(tmpModule, source.replace(
    "path.join(__dirname, '..', '.env')",
    JSON.stringify(missing)
  ), 'utf8');

  const before = { ...process.env };
  const mod = require(tmpModule);
  assert.deepEqual(mod.load(true), [], '文件不存在时不报错，只返回空列表');
  assert.deepEqual(mod.applied(), []);
  // 脱成普通对象再比：process.env 的原型和字面量不同，直接会比原型差出问题
  assert.deepEqual({ ...process.env }, before, '不该动任何环境变量');

  await fsp.rm(dir, { recursive: true, force: true });
});
