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
const appPassword = process.env.APP_PASSWORD || '';

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadDir, { recursive: true });
await ensureDataFile();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use(basicAuth);
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

app.get('/api/data', async (_req, res, next) => {
  try {
    res.json(await readData());
  } catch (err) {
    next(err);
  }
});

app.put('/api/data', async (req, res, next) => {
  try {
    validateData(req.body);
    await writeJsonAtomic(dataFile, req.body);
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传图片文件' });
    return;
  }
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/api/fetch-product', async (req, res) => {
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
}

function safeExt(name, mime) {
  const ext = path.extname(name || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

function basicAuth(req, res, next) {
  if (!appPassword) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return authRequired(res);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  const password = split >= 0 ? decoded.slice(split + 1) : '';
  if (password !== appPassword) return authRequired(res);
  next();
}

function authRequired(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Renovation Budget"');
  res.status(401).send('Authentication required');
}

function firstUrl(text) {
  return (String(text).match(/https?:\/\/[^\s，。"'<>]+/i) || [])[0] || '';
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
    return compact({
      name: $('meta[property="og:title"]').attr('content') || $('title').text().trim(),
      image: $('meta[property="og:image"]').attr('content') || $('img').first().attr('src'),
      price: parsePrice(html)
    });
  } finally {
    clearTimeout(timeout);
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}
