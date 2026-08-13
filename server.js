'use strict';

/**
 * QuickShare - PC를 파일 공유 서버로 만드는 최소 구성 서버
 *
 * 외부 서비스를 전혀 거치지 않고, 같은 네트워크에서 브라우저만으로
 * 태블릿/폰 <-> PC 사이에 파일을 주고받는다.
 *
 * 의존성 없음 (Node 내장 모듈만 사용)
 *   node server.js
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 4000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const INBOX = path.join(ROOT, 'received'); // 태블릿 -> PC
const OUTBOX = path.join(ROOT, 'share'); // PC -> 태블릿

// PIN 은 실행할 때마다 새로 만든다. 고정하고 싶으면 PIN=1234 node server.js
const PIN = String(process.env.PIN || crypto.randomInt(1000, 10000));

const TOKEN_COOKIE = 'qs_token';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12시간

/** token -> 만료 시각 */
const tokens = new Map();
/** ip -> { count, blockedUntil } */
const authAttempts = new Map();
const MAX_ATTEMPTS = 10;
const BLOCK_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- 유틸

/** 업로드된 이름에서 경로 요소와 Windows 금지 문자를 제거한다. */
function safeName(raw) {
  const base = path.basename(String(raw ?? '').trim());
  const cleaned = base
    .replace(/[<>:"/\\|?*]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || `file-${Date.now()}`;
}

/** 같은 이름이 있으면 "sample (1).jpg" 처럼 번호를 붙인다. */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
    const full = path.join(dir, candidate);
    try {
      await fsp.access(full);
    } catch {
      return full; // 없으므로 사용 가능
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

/** IPv4-mapped IPv6 (::ffff:10.0.0.1) 를 평범한 IPv4 로 되돌린다. */
function normalizeIp(ip) {
  return String(ip ?? '').replace(/^::ffff:/, '');
}

let ownAddresses = null;

/**
 * 요청이 서버를 돌리는 PC 자신에게서 왔는지.
 * 이 경우 '보내기/받기' 의 방향이 반대가 되고, 코드도 묻지 않는다.
 */
function isHost(req) {
  if (!ownAddresses) ownAddresses = new Set(['127.0.0.1', '::1', ...lanAddresses()]);
  return ownAddresses.has(normalizeIp(req.socket.remoteAddress));
}

function isAuthed(req) {
  // PC 앞에 앉아 있는 사람에게 코드를 묻는 것은 의미가 없다.
  if (isHost(req)) return true;

  const token = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
  if (!token) return false;
  const expires = tokens.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function clientIp(req) {
  return normalizeIp(req.socket.remoteAddress) || 'unknown';
}

/**
 * 어떤 기기가 붙었는지 한 번씩만 남긴다.
 * UA 는 브라우저가 '데스크톱 버전으로 보기' 로 위장할 수 있어 판별에는 쓰지 않는다.
 * 화면 구성은 접속 IP 로 가른 host/guest 하나로 충분하다.
 */
const loggedClients = new Set();

function logClient(req) {
  const ip = clientIp(req);
  if (loggedClients.has(ip)) return;
  loggedClients.add(ip);
  const role = isHost(req) ? 'host ' : 'guest';
  console.log(`  [접속] ${ip}  ${role}  ${req.headers['user-agent'] ?? '(UA 없음)'}`);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- 핸들러

async function handleAuth(req, res) {
  const ip = clientIp(req);
  const record = authAttempts.get(ip);
  if (record?.blockedUntil > Date.now()) {
    const seconds = Math.ceil((record.blockedUntil - Date.now()) / 1000);
    return sendJson(res, 429, { ok: false, error: `시도 횟수 초과. ${seconds}초 후 다시 시도하세요.` });
  }

  let pin = '';
  try {
    pin = String(JSON.parse(await readBody(req))?.pin ?? '');
  } catch {
    return sendJson(res, 400, { ok: false, error: '잘못된 요청입니다.' });
  }

  // 길이가 달라도 타이밍이 새지 않도록 해시를 비교한다.
  const given = crypto.createHash('sha256').update(pin).digest();
  const expected = crypto.createHash('sha256').update(PIN).digest();
  if (!crypto.timingSafeEqual(given, expected)) {
    const count = (record?.count ?? 0) + 1;
    authAttempts.set(ip, {
      count,
      blockedUntil: count >= MAX_ATTEMPTS ? Date.now() + BLOCK_MS : 0,
    });
    console.log(`  [인증 실패] ${ip} (${count}/${MAX_ATTEMPTS})`);
    return sendJson(res, 401, { ok: false, error: '코드가 올바르지 않습니다.' });
  }

  authAttempts.delete(ip);
  const token = issueToken();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `${TOKEN_COOKIE}=${token}; Path=/; Max-Age=${TOKEN_TTL_MS / 1000}; SameSite=Lax`,
  });
  res.end(JSON.stringify({ ok: true }));
  console.log(`  [인증 성공] ${ip}`);
}

async function handleUpload(req, res, url) {
  // PC 에서 올린 파일은 태블릿이 가져갈 share/ 로, 태블릿에서 올린 파일은 received/ 로 간다.
  const host = isHost(req);
  const targetDir = host ? OUTBOX : INBOX;

  const name = safeName(url.searchParams.get('name'));
  const dest = await uniquePath(targetDir, name);

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    req.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('전송이 중단되었습니다.')));
  }).catch(async (err) => {
    await fsp.rm(dest, { force: true });
    throw err;
  });

  const { size } = await fsp.stat(dest);
  const label = host ? '[내보냄]' : '[수신]';
  console.log(`  ${label} ${path.basename(dest)} (${formatSize(size)}) <- ${clientIp(req)}`);
  sendJson(res, 200, { ok: true, name: path.basename(dest), size });
}

/** ?box= 로 지정한 폴더. 허용된 이름만 실제 경로로 바꾼다. */
const BOXES = { share: OUTBOX, received: INBOX };

function resolveBox(url) {
  return BOXES[url.searchParams.get('box') ?? 'share'] ?? null;
}

async function handleList(res, dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return sendJson(res, 200, { ok: true, files: [] });
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fsp.stat(path.join(dir, entry.name));
    files.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  sendJson(res, 200, { ok: true, files });
}

async function handleDownload(req, res, url, dir) {
  const name = safeName(url.searchParams.get('name'));
  const full = path.join(dir, name);

  // safeName 이 경로 요소를 제거하지만, 한 번 더 확인한다.
  if (path.dirname(full) !== dir) {
    return sendJson(res, 400, { ok: false, error: '잘못된 파일명입니다.' });
  }

  let stat;
  try {
    stat = await fsp.stat(full);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return sendJson(res, 404, { ok: false, error: '파일을 찾을 수 없습니다.' });
  }

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  fs.createReadStream(full).pipe(res);
  console.log(`  [송신] ${name} -> ${clientIp(req)}`);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);

  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(400).end('bad path');
    return;
  }

  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// ---------------------------------------------------------------- 라우팅

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = url.pathname;

  try {
    // 인증 없이 접근 가능한 경로
    if (route === '/api/session') {
      const host = isHost(req);
      logClient(req);
      return sendJson(res, 200, {
        ok: true,
        authed: isAuthed(req),
        role: host ? 'host' : 'guest',
        // 연결 정보는 PC 화면에만 보여준다. 코드가 들어 있기 때문이다.
        connect: host ? { url: connectUrl(), address: `${lanAddress()}:${PORT}`, pin: PIN } : null,
      });
    }

    // QR 은 코드를 담고 있으므로 PC 자신에게만 내준다.
    if (route === '/api/qr') {
      if (!isHost(req)) return sendJson(res, 403, { ok: false, error: '허용되지 않습니다.' });
      const svg = await QRCode.toString(connectUrl(), {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 4, // 규격상 최소 4모듈. 좁으면 스캐너가 코드를 못 찾는다.
        width: 370, // 고유 크기를 명시해야 <img> 가 또렷하게 그린다

        color: { dark: '#000000', light: '#ffffff' },
      });
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(svg);
    }
    if (route === '/api/auth' && req.method === 'POST') {
      return await handleAuth(req, res);
    }
    if (!route.startsWith('/api/')) {
      return await serveStatic(res, route);
    }

    // 여기부터는 인증 필요
    if (!isAuthed(req)) {
      return sendJson(res, 401, { ok: false, error: '인증이 필요합니다.' });
    }

    if (route === '/api/upload' && req.method === 'PUT') return await handleUpload(req, res, url);

    if (route === '/api/files' || route === '/api/download') {
      const dir = resolveBox(url);
      if (!dir) return sendJson(res, 400, { ok: false, error: '알 수 없는 폴더입니다.' });
      if (route === '/api/files' && req.method === 'GET') return await handleList(res, dir);
      if (route === '/api/download' && req.method === 'GET') return await handleDownload(req, res, url, dir);
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error('  [오류]', err.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    else res.end();
  }
});

// ---------------------------------------------------------------- 시작

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/** QR 과 안내에 쓸 대표 주소. 랜 주소가 없으면 루프백으로 떨어진다. */
function lanAddress() {
  return lanAddresses()[0] ?? '127.0.0.1';
}

/** 이 주소를 열면 코드 입력 없이 바로 연결된다. */
function connectUrl() {
  return `http://${lanAddress()}:${PORT}/?code=${PIN}`;
}

/**
 * 서버를 새로 켤 때 주고받은 파일을 지운다.
 *
 * 실행할 때마다 새 코드와 새 QR 로 새 세션이 시작되므로,
 * 이 두 폴더는 저장소가 아니라 그 세션 동안만 쓰는 임시 공간이다.
 * 남길 파일은 서버를 끄기 전에 다른 곳으로 옮겨두어야 한다.
 */
async function clearTransferFolders() {
  let removed = 0;

  for (const dir of [INBOX, OUTBOX]) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 아직 폴더가 없으면 지울 것도 없다
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue; // 하위 폴더는 건드리지 않는다
      await fsp.rm(path.join(dir, entry.name), { force: true });
      removed++;
    }
  }

  if (removed) console.log(`  이전 세션에서 남은 파일 ${removed}개를 지웠습니다.`);
}

async function main() {
  await fsp.mkdir(INBOX, { recursive: true });
  await fsp.mkdir(OUTBOX, { recursive: true });
  await clearTransferFolders();

  server.listen(PORT, '0.0.0.0', async () => {
    const line = '='.repeat(52);
    console.log(`\n${line}`);
    console.log('  QuickShare 실행 중');
    console.log(line);
    console.log('\n  폰·태블릿 카메라로 아래 QR 을 찍으면 바로 열립니다.\n');
    try {
      console.log(await QRCode.toString(connectUrl(), { type: 'terminal', errorCorrectionLevel: 'M' }));
    } catch (err) {
      console.log(`  (QR 생성 실패: ${err.message})`);
    }
    console.log(`\n  주소:      http://${lanAddress()}:${PORT}`);
    console.log(`  접속 코드:  ${PIN}\n`);
    console.log(line);
    console.log(`  받은 파일  ->  ${INBOX}`);
    console.log(`  보낼 파일  ->  ${OUTBOX} 에 넣어두면 태블릿에서 받을 수 있습니다`);
    console.log(`${line}\n  종료하려면 Ctrl+C\n`);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  포트 ${PORT} 이(가) 이미 사용 중입니다.`);
    console.error(`  다른 포트로 실행하세요:  $env:PORT=5000; node server.js\n`);
    process.exit(1);
  }
  throw err;
});

main();
