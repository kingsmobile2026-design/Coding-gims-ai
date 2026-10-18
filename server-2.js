/**
 * Gims AI Server (MongoDB + Virtual Sandbox)
 * Node 18+  ·  npm install mongodb
 *
 * 실행: node server.js
 *
 * 환경변수:
 *   MONGODB_URI   – 기본값으로 사용자가 제공한 Atlas URI 사용
 *   PORT          – 기본 3000
 *   ADMIN_IPS     – 쉼표 구분 관리자 IP
 *   DAILY_LIMIT   – 기본 20
 *   TRUST_PROXY   – '1' 이면 x-forwarded-* 신뢰
 *   GEMINI_BASE   – 기본 https://generativelanguage.googleapis.com
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const vm = require('vm');
const { MongoClient, ObjectId } = require('mongodb');
const block = require('./block');
const sandbox = require('./sandbox');

const PORT = process.env.PORT || 3000;
const ADMIN_IPS = (process.env.ADMIN_IPS || '211.233.75.204').split(',').map(s => s.trim()).filter(Boolean);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 20;
const VERIFY_BONUS = 30;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';

const MONGODB_URI = process.env.MONGODB_URI ||
  'mongodb+srv://kingsmobile2026_db_user:A20140205g@cluster0.ux498h7.mongodb.net/?retryWrites=true&w=majority&authSource=admin';
const DB_NAME = process.env.MONGODB_DB || 'gims_ai';

let db = null;
let client = null;

async function connectMongo() {
  client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000
  });
  await client.connect();
  db = client.db(DB_NAME);
  // indexes
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
  await db.collection('usage').createIndex({ day: 1, key: 1 }, { unique: true });
  await db.collection('rooms').createIndex({ user: 1 });
  console.log('[mongo] connected →', DB_NAME);
}

// ---------- helpers ----------
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]));
const ip = req => (TRUST_PROXY && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isAdminIP = req => ADMIN_IPS.includes(ip(req));

const send = (res, code, obj, h = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h });
  res.end(JSON.stringify(obj));
};
const fail = (res, code, message, h) => send(res, code, { error: { message } }, h);

const body = req => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => {
    b += c;
    if (b.length > 20e6) { no(new Error('요청이 너무 큽니다.')); req.destroy(); }
  });
  req.on('end', () => {
    try { ok(JSON.parse(b || '{}')); } catch { no(new Error('잘못된 JSON입니다.')); }
  });
});

const readBody = async (req, res, opts) => {
  const raw = await body(req);
  const clean = block.sanitizeObject(raw);
  if (block.guard(req, res, clean, opts || {})) return null;
  return clean;
};

// ---------- auth ----------
async function auth(req) {
  if (isAdminIP(req)) return { user: 'admin', admin: true };
  const t = cookie(req).sid;
  if (!t) return null;
  const s = await db.collection('sessions').findOne({ tokenHash: sha(t) });
  if (!s || s.exp < Date.now()) return null;
  const u = await db.collection('users').findOne({ username: s.user });
  if (!u || u.banned) return null;
  const isAdminUser = s.user === 'admin' || !!u.isAdmin;
  return { user: s.user, admin: isAdminUser };
}

async function usedOf(a, req) {
  if (a.admin) return 0;
  const day = today();
  const uKey = 'u:' + a.user;
  const iKey = 'ip:' + ip(req);
  const [uDoc, iDoc] = await Promise.all([
    db.collection('usage').findOne({ day, key: uKey }),
    db.collection('usage').findOne({ day, key: iKey })
  ]);
  return Math.max(uDoc?.n || 0, iDoc?.n || 0);
}

async function limitOf(a) {
  if (a.admin) return Infinity;
  const u = await db.collection('users').findOne({ username: a.user });
  if (u && typeof u.dailyLimit === 'number' && u.dailyLimit >= 0) return u.dailyLimit;
  const bonus = (u && u.emailVerified) ? VERIFY_BONUS : 0;
  return DAILY_LIMIT + bonus;
}

async function bump(key, delta) {
  const day = today();
  await db.collection('usage').updateOne(
    { day, key },
    { $inc: { n: delta }, $setOnInsert: { day, key } },
    { upsert: true }
  );
}

// ---------- admin seed ----------
async function ensureAdmin() {
  const ADMIN_USER = 'admin';
  const ADMIN_PASS = 'A20140205G';
  const exists = await db.collection('users').findOne({ username: ADMIN_USER });
  if (!exists) {
    const salt = crypto.randomBytes(16).toString('hex');
    await db.collection('users').insertOne({
      username: ADMIN_USER,
      salt,
      hash: hashPw(ADMIN_PASS, salt),
      isAdmin: true,
      email: '',
      emailVerified: true,
      createdAt: new Date()
    });
    console.log('관리자 계정이 생성되었습니다: admin / A20140205G');
  }
}

// ---------- system prompt ----------
const SYSTEM_INSTRUCTION = {
  parts: [{
    text: `너는 Gims AI야. 사용자가 정체(누구야, 어떤 AI야 등)를 물으면 반드시 "저는 Gims AI입니다."라고만 답하고 다른 AI 이름은 말하지 마.

## 핵심 태도 (의도 파악 + 선제 제안)
1) 진짜 목적 파악: 표면 요청 뒤의 목표를 짧게 추론한다. 모호하면 한두 문장만 확인하고, 분명하면 바로 실행한다.
2) 예측·선제 제안: 사용자가 다음에 원할 법한 작업을 2~4개 제안한다. (예: RPG면 파티/밸런스/모바일 UI 등)
3) 한계 명시: 샌드박스에서 불가한 것(실 WebSocket 동시접속, Three.js GPU 렌더, 실 Mongo 데이터)은 솔직히 말하고, 가능한 검증(문법·라우트·모의 HTTP·정적 분석)은 반드시 한다.

## 코드·게임·서버
- HTML/Three.js: 저장 후 프리뷰 경로 안내. 대형 단일 HTML 허용.
- server.js (http/Express/ws/mongodb): sandbox_run_project 또는 node 모의 실행.
  Express·순수 http 라우트는 모의 요청으로 테스트 가능. WebSocket·실 Mongo·멀티플레이 동시성은 스텁(로드·문법·구조만).
- 가능하면 tests로 expectStatus/expectIncludes 검증 후 결과 보고.
- 대형 RPG면: 역할 요약 → 로드 결과 → 라우트/리스크 → 다음 우선순위 제안.

## 도구
sandbox_write_file, sandbox_run_project, sandbox_terminal, sandbox_http_test, sandbox_read_file
경로 /project/ 권장. 일반 질문에는 도구 없이 답한다.`
  }]
};

// ---------- main server ----------
async function main() {
  await connectMongo();
  await ensureAdmin();

  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;

    try {
      block.securityHeaders(res);
      const clientIp = ip(req);
      if (block.rateLimit(clientIp, { windowMs: 60_000, max: 180 })) {
        return fail(res, 429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      }

      // static
      if (m === 'GET' && (p === '/' || p === '/index.html')) {
        const htmlPath = path.join(__dirname, 'public', 'index.html');
        if (fs.existsSync(htmlPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return fs.createReadStream(htmlPath).pipe(res);
        }
        // fallback to artifacts root
        const alt = path.join(__dirname, 'index.html');
        if (fs.existsSync(alt)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return fs.createReadStream(alt).pipe(res);
        }
        return fail(res, 404, 'index.html not found');
      }

      if (block.guard(req, res)) return;
      const a = await auth(req);

      // ----- /api/me -----
      if (p === '/api/me' && m === 'GET') {
        if (!a) return send(res, 200, { user: null });
        const u = await db.collection('users').findOne({ username: a.user }) || {};
        if (u.banned) return send(res, 200, { user: null });
        const lim = await limitOf(a);
        const used = await usedOf(a, req);
        const cfgDoc = await db.collection('config').findOne({ _id: 'main' }) || {};
        return send(res, 200, {
          user: a.user,
          admin: a.admin,
          limit: lim === Infinity ? 0 : lim,
          used,
          hasKey: !!cfgDoc.apiKey,
          email: u.email || '',
          emailVerified: !!u.emailVerified,
          mailReady: true
        });
      }

      // ----- register / login -----
      if ((p === '/api/register' || p === '/api/login') && m === 'POST') {
        const failsCol = db.collection('login_fails');
        const I = clientIp;
        const fDoc = await failsCol.findOne({ ip: I }) || { n: 0, t: Date.now() };
        if (Date.now() - fDoc.t > 600e3) { fDoc.n = 0; fDoc.t = Date.now(); }
        if (fDoc.n >= 10) return fail(res, 429, '시도가 너무 많습니다. 10분 뒤에 다시 시도하세요.');

        const _b = await readBody(req, res); if (!_b) return;
        const { username, password } = _b;
        const name = String(username || '').trim().toLowerCase();
        if (!block.isSafeId(name) || name.length < 2 || name.length > 20) {
          return fail(res, 400, '아이디는 2~20자의 한글·영문·숫자·_ 만 쓸 수 있습니다.');
        }
        if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
          return fail(res, 400, '비밀번호는 6자 이상이어야 합니다.');
        }

        if (p === '/api/register') {
          if (name === 'admin' || name === '관리자') return fail(res, 409, '이미 사용 중인 아이디입니다.');
          const exists = await db.collection('users').findOne({ username: name });
          if (exists) return fail(res, 409, '이미 사용 중인 아이디입니다.');
          const regCount = await usedOf({ user: 'reg:' + I, admin: false }, req); // reuse helper loosely
          // simple daily reg limit via usage
          const day = today();
          const regDoc = await db.collection('usage').findOne({ day, key: 'reg:' + I });
          if ((regDoc?.n || 0) >= 10) return fail(res, 429, '오늘 가입 가능 횟수를 초과했습니다.');
          const salt = crypto.randomBytes(16).toString('hex');
          await db.collection('users').insertOne({
            username: name,
            salt,
            hash: hashPw(password, salt),
            email: '',
            emailVerified: false,
            createdAt: new Date()
          });
          await bump('reg:' + I, 1);
        } else {
          const u = await db.collection('users').findOne({ username: name });
          const ok = u && crypto.timingSafeEqual(
            Buffer.from(hashPw(password, u.salt), 'hex'),
            Buffer.from(u.hash, 'hex')
          );
          if (!ok) {
            await failsCol.updateOne(
              { ip: I },
              { $inc: { n: 1 }, $set: { t: Date.now() } },
              { upsert: true }
            );
            return fail(res, 401, '아이디 또는 비밀번호가 올바르지 않습니다.');
          }
          if (u.banned) return fail(res, 403, '차단된 계정입니다. 관리자에게 문의하세요.');
        }

        const tok = crypto.randomBytes(32).toString('hex');
        const exp = Date.now() + 30 * 864e5;
        await db.collection('sessions').insertOne({
          tokenHash: sha(tok),
          user: name,
          exp,
          createdAt: new Date()
        });
        // cleanup old sessions occasionally
        await db.collection('sessions').deleteMany({ exp: { $lt: Date.now() } });

        const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`
        });
      }

      if (p === '/api/logout' && m === 'POST') {
        const t = cookie(req).sid;
        if (t) await db.collection('sessions').deleteOne({ tokenHash: sha(t) });
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
      }

      if (!a) return fail(res, 401, '로그인이 필요합니다.');

      // ----- account / email -----
      if (p === '/api/account' && m === 'PUT') {
        const _b = await readBody(req, res); if (!_b) return;
        const em = String(_b.email || '').trim().toLowerCase();
        if (em && !block.isSafeEmail(em)) return fail(res, 400, '올바른 이메일 형식이 아닙니다.');
        const u = await db.collection('users').findOne({ username: a.user });
        if (!u) return fail(res, 404, '사용자를 찾을 수 없습니다.');
        const update = { email: em };
        if (!em || em !== (u.email || '')) {
          update.emailVerified = false;
          update.verifyCode = null;
          update.verifyExp = null;
        }
        await db.collection('users').updateOne({ username: a.user }, { $set: update });
        return send(res, 200, { ok: true, email: em, emailVerified: false });
      }

      if (p === '/api/verify/request' && m === 'POST') {
        const u = await db.collection('users').findOne({ username: a.user });
        if (!u) return fail(res, 404, '사용자를 찾을 수 없습니다.');
        if (!u.email) return fail(res, 400, '먼저 이메일을 등록해 주세요.');
        if (u.emailVerified) return fail(res, 400, '이미 인증된 이메일입니다.');
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await db.collection('users').updateOne(
          { username: a.user },
          { $set: { verifyCode: sha(code), verifyExp: Date.now() + 15 * 60 * 1000 } }
        );
        console.log(`[이메일 인증] 사용자=${a.user} 이메일=${u.email} 코드=${code}`);
        return send(res, 200, {
          ok: true,
          message: '인증 코드가 생성되었습니다. (데모: 실제 메일 발송 없음 — 아래 코드를 입력하세요)',
          demoCode: code
        });
      }

      if (p === '/api/verify/confirm' && m === 'POST') {
        const _b = await readBody(req, res); if (!_b) return;
        const u = await db.collection('users').findOne({ username: a.user });
        if (!u) return fail(res, 404, '사용자를 찾을 수 없습니다.');
        if (u.emailVerified) return send(res, 200, { ok: true, emailVerified: true });
        if (!u.verifyCode || !u.verifyExp || u.verifyExp < Date.now()) {
          return fail(res, 400, '인증 코드가 만료되었거나 없습니다. 다시 요청해 주세요.');
        }
        if (sha(String(_b.code || '').trim()) !== u.verifyCode) {
          return fail(res, 400, '인증 코드가 올바르지 않습니다.');
        }
        await db.collection('users').updateOne(
          { username: a.user },
          { $set: { emailVerified: true }, $unset: { verifyCode: '', verifyExp: '' } }
        );
        return send(res, 200, { ok: true, emailVerified: true, limit: await limitOf(a) });
      }

      // ----- config (API key) -----
      if (p === '/api/config') {
        const cfgDoc = await db.collection('config').findOne({ _id: 'main' }) || {};
        if (m === 'GET') {
          return send(res, 200, a.admin
            ? { hasKey: !!cfgDoc.apiKey, key: cfgDoc.apiKey || '' }
            : { hasKey: !!cfgDoc.apiKey });
        }
        if (!a.admin) return fail(res, 403, 'API 키는 관리자만 변경할 수 있습니다.');
        if (m === 'PUT') {
          const _b = await readBody(req, res); if (!_b) return;
          const apiKey = String(_b.apiKey || '').trim();
          if (!/^\S{20,}$/.test(apiKey)) return fail(res, 400, '올바른 API 키 형식이 아닙니다.');
          await db.collection('config').updateOne(
            { _id: 'main' },
            { $set: { apiKey, updatedAt: new Date() } },
            { upsert: true }
          );
          return send(res, 200, { ok: true });
        }
        if (m === 'DELETE') {
          await db.collection('config').updateOne(
            { _id: 'main' },
            { $set: { apiKey: '', updatedAt: new Date() } },
            { upsert: true }
          );
          return send(res, 200, { ok: true });
        }
      }

      // ----- admin users -----
      if (p === '/api/admin/users' && m === 'GET') {
        if (!a.admin) return fail(res, 403, '관리자만 접근할 수 있습니다.');
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));

        const filter = { username: { $ne: 'admin' }, isAdmin: { $ne: true } };
        if (q) {
          filter.$or = [
            { username: { $regex: q, $options: 'i' } },
            { email: { $regex: q, $options: 'i' } }
          ];
        }
        const total = await db.collection('users').countDocuments(filter);
        const cursor = db.collection('users').find(filter).sort({ username: 1 }).skip(offset).limit(limit);
        const list = [];
        for await (const u of cursor) {
          const custom = typeof u.dailyLimit === 'number' && u.dailyLimit >= 0;
          const base = custom ? u.dailyLimit : (DAILY_LIMIT + (u.emailVerified ? VERIFY_BONUS : 0));
          const usedDoc = await db.collection('usage').findOne({ day: today(), key: 'u:' + u.username });
          list.push({
            username: u.username,
            email: u.email || '',
            emailVerified: !!u.emailVerified,
            banned: !!u.banned,
            dailyLimit: custom ? u.dailyLimit : null,
            effectiveLimit: base,
            used: usedDoc?.n || 0
          });
        }
        return send(res, 200, { total, offset, limit, users: list });
      }

      if (p === '/api/admin/users' && m === 'PUT') {
        if (!a.admin) return fail(res, 403, '관리자만 접근할 수 있습니다.');
        const _b = await readBody(req, res); if (!_b) return;
        const name = String(_b.username || '').trim().toLowerCase();
        if (!name || !block.isSafeId(name)) return fail(res, 404, '사용자를 찾을 수 없습니다.');
        const u = await db.collection('users').findOne({ username: name });
        if (!u || u.isAdmin || name === 'admin') return fail(res, 403, '관리자 계정은 변경할 수 없습니다.');

        const update = {};
        if (_b.dailyLimit !== undefined) {
          if (_b.dailyLimit === null || _b.dailyLimit === '') {
            update.$unset = { dailyLimit: '' };
          } else {
            const n = Number(_b.dailyLimit);
            if (!Number.isFinite(n) || n < 0 || n > 100000) return fail(res, 400, '한도는 0~100000 사이여야 합니다.');
            update.$set = { ...(update.$set || {}), dailyLimit: Math.floor(n) };
          }
        }
        if (_b.banned !== undefined) {
          update.$set = { ...(update.$set || {}), banned: !!_b.banned };
          if (_b.banned) {
            await db.collection('sessions').deleteMany({ user: name });
          }
        }
        if (Object.keys(update).length) await db.collection('users').updateOne({ username: name }, update);

        const updated = await db.collection('users').findOne({ username: name });
        const custom = typeof updated.dailyLimit === 'number' && updated.dailyLimit >= 0;
        const usedDoc = await db.collection('usage').findOne({ day: today(), key: 'u:' + name });
        return send(res, 200, {
          ok: true,
          username: name,
          email: updated.email || '',
          banned: !!updated.banned,
          dailyLimit: custom ? updated.dailyLimit : null,
          effectiveLimit: custom ? updated.dailyLimit : (DAILY_LIMIT + (updated.emailVerified ? VERIFY_BONUS : 0)),
          used: usedDoc?.n || 0
        });
      }

      // ----- rooms -----
      if (p === '/api/rooms') {
        const col = db.collection('rooms');
        let doc = await col.findOne({ user: a.user });
        if (!doc) {
          doc = { user: a.user, rev: 0, rooms: [], tomb: {} };
          await col.insertOne(doc);
        }

        if (m === 'GET') {
          if (url.searchParams.get('rev') === String(doc.rev)) {
            return send(res, 200, { rev: doc.rev, same: true });
          }
          return send(res, 200, { rev: doc.rev, rooms: doc.rooms || [] });
        }

        if (m === 'PUT') {
          const _b = await readBody(req, res); if (!_b) return;
          const { rooms = [], deleted = [] } = _b;
          if (!Array.isArray(rooms) || rooms.length > 300 || !Array.isArray(deleted)) {
            return fail(res, 400, '잘못된 요청입니다.');
          }
          const map = new Map((doc.rooms || []).map(r => [r.id, r]));
          const tomb = doc.tomb || {};
          for (const id of deleted) {
            map.delete(id);
            tomb[id] = Date.now();
          }
          for (const r of rooms) {
            if (!r || typeof r.id !== 'string' || !Array.isArray(r.messages) || tomb[r.id]) continue;
            const old = map.get(r.id);
            if (!old || (r.updatedAt || 0) >= (old.updatedAt || 0)) map.set(r.id, r);
          }
          const newRooms = [...map.values()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
          const newRev = (doc.rev || 0) + 1;
          await col.updateOne(
            { user: a.user },
            { $set: { rooms: newRooms, rev: newRev, tomb } }
          );
          return send(res, 200, { rev: newRev, rooms: newRooms });
        }
      }

      // ----- Virtual Sandbox API -----
      if (p === '/api/sandbox/js' && m === 'POST') {
        const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
        const code = String(_b.code || '').slice(0, 50_000);
        if (!code.trim()) return fail(res, 400, 'code 가 비어 있습니다.');
        return send(res, 200, sandbox.runJs(code, Math.min(5000, Number(_b.timeout) || 3000)));
      }

      if (p === '/api/sandbox/terminal' && m === 'POST') {
        const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
        const ws = sandbox.getWs(a.user);
        ws._userId = a.user;
        const result = await Promise.resolve(sandbox.runTerminal(ws, String(_b.command || '').slice(0, 500)));
        return send(res, 200, result);
      }

      if (p === '/api/sandbox/write' && m === 'POST') {
        const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
        try {
          const ws = sandbox.getWs(a.user);
          const fp = sandbox.writeFile(ws, _b.path, _b.content);
          return send(res, 200, { ok: true, path: fp });
        } catch (e) {
          return fail(res, 400, e.message);
        }
      }

      if (p === '/api/sandbox/read' && m === 'POST') {
        const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
        try {
          return send(res, 200, sandbox.readFile(sandbox.getWs(a.user), _b.path));
        } catch (e) {
          return fail(res, 404, e.message);
        }
      }

      if (p === '/api/sandbox/run-project' && m === 'POST') {
        const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
        const ws = sandbox.getWs(a.user);
        ws._userId = a.user;
        const result = await sandbox.runProject(ws, {
          files: _b.files || {},
          entry: _b.entry || '/project/server.js',
          tests: _b.tests || []
        });
        return send(res, 200, result);
      }

      if (p === '/api/sandbox/http' && m === 'POST') {
        const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
        const result = await sandbox.httpRequest(
          sandbox.getWs(a.user),
          _b.method || 'GET',
          _b.path || '/',
          _b.body,
          _b.headers
        );
        return send(res, 200, result);
      }

      if (p === '/api/sandbox/preview' && m === 'GET') {
        try {
          const filePath = url.searchParams.get('path') || '/project/index.html';
          const f = sandbox.readFile(sandbox.getWs(a.user), filePath);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(f.content);
        } catch (e) {
          return fail(res, 404, e.message);
        }
      }

      if (p === '/api/sandbox/reset' && m === 'POST') {
        return send(res, 200, sandbox.resetWs(a.user));
      }

      // ----- chat (Gemini stream + sandbox tools) -----
      if (p === '/api/chat' && m === 'POST') {
        const cfgDoc = await db.collection('config').findOne({ _id: 'main' }) || {};
        if (!cfgDoc.apiKey) return fail(res, 503, '관리자가 아직 API 키를 등록하지 않았습니다.');

        const u = await db.collection('users').findOne({ username: a.user });
        if (u && u.banned) return fail(res, 403, '차단된 계정입니다.');

        const used = await usedOf(a, req);
        const lim = await limitOf(a);
        const H = n => ({ 'X-Used': String(n), 'X-Limit': String(lim === Infinity ? 0 : lim) });

        if (!a.admin && used >= lim) {
          return fail(res, 429, `오늘 질문 한도(${lim}회)를 모두 사용했습니다. 내일 다시 이용해 주세요.`, H(used));
        }

        const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
        const { model, contents, temperature, noThink, useTools } = _b;
        if (!/^[\w.\-]+$/.test(model || '') || !Array.isArray(contents) || !contents.length || contents.length > 60) {
          return fail(res, 400, '잘못된 요청입니다.');
        }

        const gen = { temperature: Math.min(2, Math.max(0, Number(temperature) || 0.7)) };
        if (noThink) gen.thinkingConfig = { thinkingBudget: 0 };

        if (!a.admin) {
          await bump('u:' + a.user, 1);
          await bump('ip:' + clientIp, 1);
        }
        const refund = async () => {
          if (!a.admin) {
            await bump('u:' + a.user, -1);
            await bump('ip:' + clientIp, -1);
          }
        };

        const ac = new AbortController();
        res.on('close', () => ac.abort());

        const toolsEnabled = useTools !== false; // 기본 켜짐
        const geminiBody = {
          contents: contents.map(c => ({ role: c.role, parts: c.parts })),
          systemInstruction: SYSTEM_INSTRUCTION,
          generationConfig: gen
        };
        if (toolsEnabled) {
          geminiBody.tools = [{ functionDeclarations: sandbox.TOOL_DECLARATIONS }];
        }

        // 도구 호출 루프 + 진행 상황 SSE 스트리밍
        try {
          // 헤더를 먼저 열어 클라이언트가 "생각 중" 대신 실시간 진행을 받도록 함
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            ...H(await usedOf(a, req))
          });
          res.flushHeaders();

          const sse = (obj) => {
            if (res.writableEnded) return;
            try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {}
          };
          const progress = (msg) => {
            sse({
              gimsMeta: { phase: 'progress' },
              candidates: [{ content: { parts: [{ text: String(msg) }] } }]
            });
          };

          progress('요청 의도와 필요한 검증 단계를 정리하는 중입니다');

          let turnContents = geminiBody.contents.slice();
          let finalText = '';
          const toolTrace = [];

          const toolLabel = (name, args) => {
            const a = args || {};
            if (name === 'sandbox_terminal') {
              const cmd = String(a.command || '').trim().slice(0, 100);
              if (/^node\b/i.test(cmd)) return '가상 환경에서 Node 프로세스를 기동합니다: ' + cmd;
              if (/^curl\b|^http\b/i.test(cmd)) return '모의 서버로 HTTP 요청을 보냅니다: ' + cmd;
              if (/^ls\b|^tree\b|^pwd\b|^cat\b/i.test(cmd)) return '가상 파일시스템을 조회합니다: ' + cmd;
              if (/^cd\b/i.test(cmd)) return '작업 디렉터리를 이동합니다: ' + cmd;
              return '가상 터미널 명령을 실행합니다: ' + (cmd || '(빈 명령)');
            }
            if (name === 'sandbox_run_project') {
              let files = a.files;
              if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = {}; } }
              const keys = files && typeof files === 'object' ? Object.keys(files) : [];
              const nTest = Array.isArray(a.tests) ? a.tests.length : 0;
              if (keys.length && nTest) {
                return '프로젝트 ' + keys.length + '개 파일을 배포하고 기능 테스트 ' + nTest + '건을 준비합니다 (' + keys.slice(0, 5).join(', ') + (keys.length > 5 ? '…' : '') + ')';
              }
              if (keys.length) return '프로젝트 파일을 가상 워크스페이스에 기록합니다: ' + keys.slice(0, 6).join(', ') + (keys.length > 6 ? '…' : '');
              return '프로젝트 실행 파이프라인을 시작합니다';
            }
            if (name === 'sandbox_write_file') {
              const path = a.path || '?';
              if (/\.html?$/i.test(path)) return 'HTML 문서를 가상 디스크에 저장합니다: ' + path;
              if (/server\.js$/i.test(path)) return '서버 진입 스크립트를 기록합니다: ' + path;
              if (/\.css$/i.test(path)) return '스타일시트를 저장합니다: ' + path;
              if (/\.json$/i.test(path)) return '설정/데이터 JSON을 저장합니다: ' + path;
              return '소스 파일을 가상 파일시스템에 씁니다: ' + path;
            }
            if (name === 'sandbox_http_test') {
              const m = (a.method || 'GET').toUpperCase();
              const path = a.path || '/';
              return '모의 HTTP ' + m + ' 요청으로 엔드포인트를 검사합니다: ' + path;
            }
            if (name === 'sandbox_read_file') {
              return '가상 파일 내용을 읽어 확인합니다: ' + (a.path || '?');
            }
            return '도구를 호출합니다: ' + name;
          };

          const toolDoneLabel = (name, result) => {
            const ok = result && result.ok !== false && !result.error;
            const bits = [];
            if (result && result.message) bits.push(String(result.message).slice(0, 140));
            if (result && Array.isArray(result.routes) && result.routes.length) {
              bits.push('등록 라우트 ' + result.routes.length + '개');
            }
            if (result && Array.isArray(result.tests)) {
              const pass = result.tests.filter(x => x.pass).length;
              bits.push('테스트 ' + pass + '/' + result.tests.length + ' 통과');
            }
            if (result && result.error) bits.push('사유: ' + String(result.error).slice(0, 120));
            if (result && typeof result.output === 'string' && result.output && result.output.length < 180) {
              bits.push(result.output.replace(/\s+/g, ' ').slice(0, 140));
            }
            if (result && result.path) bits.push('경로 ' + result.path);
            if (result && result.status != null) bits.push('HTTP ' + result.status);
            const short = name.replace(/^sandbox_/, '');
            if (ok) {
              return '완료 [' + short + ']' + (bits.length ? ' — ' + bits.join(' / ') : '');
            }
            return '실패 [' + short + ']' + (bits.length ? ' — ' + bits.join(' / ') : ' — 알 수 없는 오류');
          };

          for (let round = 0; round < 6; round++) {
            if (ac.signal.aborted) break;
            progress(round === 0 ? '다음에 실행할 도구와 검증 순서를 결정하는 중입니다' : ('이전 도구 결과를 반영해 다음 단계를 재계획합니다 (' + (round + 1) + '/6)'));

            const up = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
              method: 'POST',
              signal: ac.signal,
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': cfgDoc.apiKey
              },
              body: JSON.stringify({
                ...geminiBody,
                contents: turnContents
              })
            });

            if (!up.ok) {
              if (round === 0) {
                const errBody = await up.text();
                progress('모델 API가 오류를 반환했습니다 (HTTP ' + up.status + ')');
                sse({
                  gimsMeta: { phase: 'final' },
                  candidates: [{ content: { parts: [{ text: '요청 실패: HTTP ' + up.status + '\n' + errBody.slice(0, 500) }] } }]
                });
                res.write('data: [DONE]\n\n');
                return res.end();
              }
              break;
            }

            const data = await up.json();
            const cand = data?.candidates?.[0];
            const parts = cand?.content?.parts || [];
            const fnCalls = parts.filter(p => p.functionCall);
            const textParts = parts.filter(p => p.text);

            if (fnCalls.length) {
              turnContents.push({ role: 'model', parts });
              const responseParts = [];
              for (const fc of fnCalls) {
                const name = fc.functionCall.name;
                let args = fc.functionCall.args || {};
                if (typeof args === 'string') {
                  try { args = JSON.parse(args); } catch { args = {}; }
                }
                progress(toolLabel(name, args));
                const result = await sandbox.executeTool(a.user, name, args);
                toolTrace.push({ name, args, result });
                progress(toolDoneLabel(name, result));
                responseParts.push({
                  functionResponse: {
                    name,
                    response: result
                  }
                });
              }
              turnContents.push({ role: 'user', parts: responseParts });
              continue;
            }

            finalText = textParts.map(p => p.text || '').join('');
            break;
          }

          progress('수집한 실행 로그와 테스트 결과를 바탕으로 답변을 작성합니다');

          let out = finalText || '';
          if (toolTrace.length) {
            const summary = toolTrace.map(t => {
              const ok = t.result && (t.result.ok !== false) && !t.result.error;
              return `- ${t.name}: ${ok ? 'OK' : 'FAIL'}${t.result?.error ? ' (' + t.result.error + ')' : ''}`;
            }).join('\n');
            if (!out.includes('샌드박스')) {
              out = (out ? out + '\n\n' : '') + '**샌드박스 실행 결과**\n' + summary +
                (toolTrace.some(t => t.name === 'sandbox_run_project' || t.name === 'sandbox_terminal') ?
                  '\n\n(모의 서버는 실제 포트를 열지 않습니다.)' : '');
            }
          }
          if (!out) out = '응답을 생성하지 못했습니다.';

          sse({
            gimsMeta: { phase: 'final' },
            candidates: [{ content: { parts: [{ text: out }] } }]
          });
          res.write('data: [DONE]\n\n');
          return res.end();
        } catch (e) {
          await refund();
          if (!res.headersSent) {
            return fail(res, 502, 'Gemini에 연결하지 못했습니다: ' + (e.message || e), H(await usedOf(a, req)));
          }
          try {
            res.write('data: ' + JSON.stringify({
              gimsMeta: { phase: 'final' },
              candidates: [{ content: { parts: [{ text: '오류: ' + (e.message || e) }] } }]
            }) + '\n\n');
            res.write('data: [DONE]\n\n');
          } catch (_) {}
          return res.end();
        }
      }

      fail(res, 404, 'Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) fail(res, 500, err.message || '서버 오류');
      else res.end();
    }
  }).listen(PORT, () => {
    console.log(`Gims AI → http://localhost:${PORT}`);
    console.log(`  관리자 IP: ${ADMIN_IPS.join(', ')}`);
    console.log(`  기본 일일 한도: ${DAILY_LIMIT}, 인증 보너스: +${VERIFY_BONUS}`);
    console.log(`  MongoDB: ${DB_NAME}`);
    console.log(`  Virtual Sandbox: /api/sandbox/* (js, terminal, write, run-project, http, preview)`);
    console.log(`  Chat tools: sandbox_write_file, sandbox_run_project, sandbox_terminal, ...`);
  });
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
