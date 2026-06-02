import express from 'express';
import multer from 'multer';
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = process.env.PUBLIC_DIR || rootDir;
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'runtime');
const uploadDir = process.env.UPLOAD_DIR || path.join(dataDir, 'uploads');
const dataFile = process.env.DATA_FILE || path.join(dataDir, 'budget-data.json');
const port = Number(process.env.PORT || 3000);
const appUsername = process.env.APP_USERNAME || 'gbyh';
const appPassword = process.env.APP_PASSWORD || 'qwe123';

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadDir, { recursive: true });
await ensureDataFile();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(uploadDir, { maxAge: '30d', immutable: true }));
app.use(express.static(publicDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = safeExt(file.originalname, file.mimetype);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/check', requireEditor, (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/data', async (_req, res, next) => {
  try {
    res.json(await readData());
  } catch (err) {
    next(err);
  }
});

app.put('/api/data', requireEditor, async (req, res, next) => {
  try {
    validateData(req.body);
    await backupDataFile();
    await writeJsonAtomic(dataFile, req.body);
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', requireEditor, upload.single('image'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传图片文件' });
    return;
  }
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/api/fetch-product', requireEditor, async (req, res) => {
  const input = String(req.body?.url || req.body?.text || '').trim();
  if (!input) {
    res.status(400).json({ error: '请提供商品链接或分享文案' });
    return;
  }
  const result = parseProductText(input);
  const url = firstUrl(input);
  if (url) {
    result.url = url;
    try {
      const fetched = await fetchProductPage(url);
      Object.assign(result, compact({ ...fetched, ...result }));
      if (jdSkuFromUrl(url) && result.name && !result.price) {
        result.warning = '京东价格接口可能被拦截，价格请手填。';
      }
    } catch (err) {
      result.warning = '服务器无法稳定解析该链接，可使用分享文案或手动填写。';
    }
  }
  res.json(result);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || '服务器错误' });
});

app.listen(port, () => {
  console.log(`Renovation budget server listening on ${port}`);
});

async function ensureDataFile() {
  try {
    await fs.access(dataFile);
  } catch {
    await writeJsonAtomic(dataFile, { version: 2, categories: [], selections: {}, items: [], plans: [] });
  }
}

async function readData() {
  const text = await fs.readFile(dataFile, 'utf8');
  return JSON.parse(text);
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  if (process.platform === 'win32') {
    await fs.rm(file, { force: true });
  }
  await fs.rename(temp, file);
}

function validateData(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items) || !Array.isArray(value.plans)) {
    const err = new Error('数据格式不正确');
    err.status = 400;
    throw err;
  }
  const criticalText = [
    value.appTitle,
    ...(Array.isArray(value.categories) ? value.categories : []),
    ...value.items.flatMap(item => [item?.name, item?.category]),
    ...value.plans.flatMap(plan => [plan?.name, plan?.category])
  ].filter(text => typeof text === 'string');
  if (criticalText.some(text => /\?{2,}/.test(text))) {
    const err = new Error('检测到疑似乱码数据，已拒绝保存');
    err.status = 400;
    throw err;
  }
}

async function backupDataFile() {
  try {
    await fs.access(dataFile);
  } catch {
    return;
  }
  const backupDir = path.join(dataDir, 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.copyFile(dataFile, path.join(backupDir, `budget-data-${stamp}.json`));
}

function safeExt(name, mime) {
  const ext = path.extname(name || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

function requireEditor(req, res, next) {
  if (!appPassword) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return authRequired(res);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  const username = split >= 0 ? decoded.slice(0, split) : '';
  const password = split >= 0 ? decoded.slice(split + 1) : '';
  if (username !== appUsername || password !== appPassword) return authRequired(res);
  next();
}

function authRequired(res) {
  res.status(401).json({ error: '请先登录编辑账号' });
}

function firstUrl(text) {
  return (String(text).match(/https?:\/\/[^\s，。"'<>]+/i) || [])[0] || '';
}

function jdSkuFromUrl(url) {
  const value = String(url || '');
  return value.match(/item\.jd\.com\/(\d+)\.html/i)?.[1]
    || value.match(/item\.m\.jd\.com\/product\/(\d+)\.html/i)?.[1]
    || value.match(/[?&]sku(?:Id)?=(\d+)/i)?.[1]
    || '';
}

function parseProductText(text) {
  return compact({
    name: parseName(text),
    price: parsePrice(text),
    image: parseImageUrl(text)
  });
}

function parsePrice(text) {
  const match = String(text).match(/(?:¥|￥|RMB|CNY)\s*([0-9]+(?:\.[0-9]{1,2})?)/i)
    || String(text).match(/([0-9]+(?:\.[0-9]{1,2})?)\s*元/);
  return match ? Number(match[1]) : undefined;
}

function parseImageUrl(text) {
  return (String(text).match(/https?:\/\/[^\s，。"'<>]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s，。"'<>]*)?/i) || [])[0];
}

function absoluteImageUrl(value) {
  const image = String(value || '').trim();
  if (!image) return '';
  if (image.startsWith('//')) return 'https:' + image;
  if (image.startsWith('jfs/')) return 'https://img11.360buyimg.com/n1/s720x720_' + image;
  return image;
}

function parseName(text) {
  const raw = String(text || '');
  const quoted = [...raw.matchAll(/[「《【]([^「」《》【】]{4,100})[」》】]/g)]
    .map(match => match[1].trim())
    .find(part => !/淘宝|天猫|京东|复制|打开|分享|链接/.test(part));
  if (quoted) return quoted;
  return raw
    .replace(/https?:\/\/[^\s，。"'<>]+/ig, ' ')
    .replace(/(?:¥|￥|RMB|CNY)\s*[0-9]+(?:\.[0-9]{1,2})?/ig, ' ')
    .replace(/[0-9]+(?:\.[0-9]{1,2})?\s*元/g, ' ')
    .split(/[\n\r，。；;]/)
    .map(part => part.trim())
    .filter(part => part.length >= 4)
    .sort((a, b) => b.length - a.length)[0];
}

async function fetchProductPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const scriptName = html.match(/name\s*:\s*'([^']{5,})'/)?.[1]
      || html.match(/name\s*:\s*"([^"]{5,})"/)?.[1];
    const rawName = $('meta[property="og:title"]').attr('content')
      || $('title').text().trim()
      || scriptName
      || $('#spec-img').attr('alt')
      || $('meta[name="description"]').attr('content');
    const specImage = $('#spec-img').attr('data-origin') || $('#spec-img').attr('src');
    const listImage = html.match(/imageList\s*:\s*\[\s*"([^"]+)"/)?.[1];
    const image = absoluteImageUrl($('meta[property="og:image"]').attr('content') || specImage || listImage || $('img').first().attr('src'));
    const price = parsePrice(html) || await fetchJdPrice(jdSkuFromUrl(url)).catch(() => undefined);
    return compact({
      name: cleanProductName(rawName),
      image,
      price
    });
  } finally {
    clearTimeout(timeout);
  }
}

function cleanProductName(name) {
  let value = String(name || '').replace(/\s+/g, ' ').trim();
  value = value.replace(/【行情 报价 价格 评测】[-_ ]*京东.*$/i, '');
  value = value.replace(/[-_ ]*京东\(JD\.COM\).*$/i, '');
  value = value.replace(/[-_ ]+京东.*$/i, '');
  value = value.replace(/^【[^】]{1,80}】/, '');
  value = value.replace(/^京东JD\.COM提供[^，,]+[，,]/i, '');
  return value.trim();
}

async function fetchJdPrice(sku) {
  if (!sku) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://p.3.cn/prices/mgets?skuIds=J_${encodeURIComponent(sku)}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36',
        'Referer': `https://item.jd.com/${sku}.html`,
        'Accept': 'application/json, text/plain, */*'
      }
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    const json = JSON.parse(text);
    const value = Number(json?.[0]?.p || 0);
    return value > 0 ? value : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}
