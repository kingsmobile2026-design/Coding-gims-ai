/**
 * Gims AI Virtual Sandbox
 * - 사용자별 가상 파일시스템 (쓰기 가능)
 * - JS 실행 (vm)
 * - 모의 HTTP 서버 (실제 포트 없이 server.js 테스트)
 * - 가상 터미널
 */
'use strict';

const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const MAX_FILE_SIZE = 2_000_000; // 대형 HTML 게임(Three.js RPG 등) 허용
const MAX_FILES = 60;
const DEFAULT_TIMEOUT = 8000;

function emptyWorkspace() {
  const fs = Object.create(null);
  const put = (p, node) => { fs[path.posix.normalize(p)] = node; };
  put('/', { type: 'dir', children: ['home', 'tmp', 'project'] });
  put('/home', { type: 'dir', children: ['user'] });
  put('/home/user', { type: 'dir', children: ['readme.txt'] });
  put('/home/user/readme.txt', {
    type: 'file',
    content: 'Gims AI Virtual Workspace\n실제 OS에 접근하지 않습니다.\n프로젝트는 /project 에 작성하세요.\n'
  });
  put('/tmp', { type: 'dir', children: [] });
  put('/project', { type: 'dir', children: [] });
  return { fs, cwd: '/project', mockServer: null, logs: [] };
}

/** 사용자별 워크스페이스 (메모리) */
const workspaces = new Map();

function getWs(userId) {
  const key = userId || '_anon';
  if (!workspaces.has(key)) workspaces.set(key, emptyWorkspace());
  return workspaces.get(key);
}

function resetWs(userId) {
  workspaces.set(userId || '_anon', emptyWorkspace());
  return { ok: true, output: '워크스페이스가 초기화되었습니다.' };
}

function ensureParent(ws, filePath) {
  const parts = filePath.split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur += '/' + parts[i];
    const n = ws.fs[cur];
    if (!n) {
      const parent = cur === '/' + parts[0] ? '/' : path.posix.dirname(cur);
      const pname = path.posix.basename(cur);
      if (ws.fs[parent] && ws.fs[parent].type === 'dir') {
        if (!ws.fs[parent].children.includes(pname)) ws.fs[parent].children.push(pname);
      }
      ws.fs[cur] = { type: 'dir', children: [] };
    } else if (n.type !== 'dir') {
      throw new Error(`${cur} is not a directory`);
    }
  }
}

function writeFile(ws, filePath, content) {
  const p = path.posix.normalize(filePath.startsWith('/') ? filePath : path.posix.join(ws.cwd, filePath));
  if (p === '/' || p === '/home' || p === '/tmp') throw new Error('cannot write there');
  const text = String(content ?? '');
  if (text.length > MAX_FILE_SIZE) throw new Error(`file too large (max ${MAX_FILE_SIZE} bytes)`);
  const fileCount = Object.values(ws.fs).filter(n => n.type === 'file').length;
  const exists = ws.fs[p] && ws.fs[p].type === 'file';
  if (!exists && fileCount >= MAX_FILES) throw new Error(`too many files (max ${MAX_FILES})`);
  ensureParent(ws, p);
  const parent = path.posix.dirname(p);
  const base = path.posix.basename(p);
  if (ws.fs[parent] && ws.fs[parent].type === 'dir' && !ws.fs[parent].children.includes(base)) {
    ws.fs[parent].children.push(base);
  }
  ws.fs[p] = { type: 'file', content: text };
  return p;
}

function readFile(ws, filePath) {
  const p = path.posix.normalize(filePath.startsWith('/') ? filePath : path.posix.join(ws.cwd, filePath));
  const n = ws.fs[p];
  if (!n) throw new Error(`No such file: ${p}`);
  if (n.type !== 'file') throw new Error(`Is a directory: ${p}`);
  return { path: p, content: n.content || '' };
}

function listDir(ws, dirPath) {
  const p = path.posix.normalize(dirPath || ws.cwd);
  const n = ws.fs[p];
  if (!n) throw new Error(`No such directory: ${p}`);
  if (n.type !== 'dir') throw new Error(`Not a directory: ${p}`);
  return (n.children || []).map(name => {
    const child = ws.fs[path.posix.join(p, name)];
    return { name, type: child ? child.type : 'unknown' };
  });
}

/** 순수 JS 실행 */
function runJs(code, timeoutMs = DEFAULT_TIMEOUT) {
  const logs = [];
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.map(x => formatVal(x)).join(' ')),
      error: (...a) => logs.push('[error] ' + a.map(x => formatVal(x)).join(' ')),
      warn: (...a) => logs.push('[warn] ' + a.map(x => formatVal(x)).join(' '))
    }
  };
  try {
    const script = new vm.Script(String(code), { filename: 'sandbox.js' });
    const ctx = vm.createContext(sandbox);
    const result = script.runInContext(ctx, { timeout: timeoutMs, displayErrors: true });
    return {
      ok: true,
      result: result === undefined ? null : formatVal(result),
      logs,
      error: null
    };
  } catch (e) {
    return { ok: false, result: null, logs, error: e.message || String(e) };
  }
}

function formatVal(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * server.js 모의 실행
 * - 순수 http.createServer
 * - Express 스타일 앱 (app.get/post, app.use, app.listen)
 * - ws / mongodb / helmet / rate-limit 은 스텁 (로드·문법 검증 + 일부 라우트 테스트)
 */
function startMockServer(ws, entryPath, timeoutMs = DEFAULT_TIMEOUT) {
  const p = path.posix.normalize(entryPath.startsWith('/') ? entryPath : path.posix.join(ws.cwd, entryPath));
  const file = ws.fs[p];
  if (!file || file.type !== 'file') {
    return { ok: false, error: `파일을 찾을 수 없습니다: ${p}`, logs: [] };
  }

  const logs = [];
  let handler = null;
  let listening = false;
  const expressRoutes = []; // { method, path, handlers[] }

  const mockResFactory = () => {
    const state = { statusCode: 200, headers: {}, body: '', ended: false };
    const res = {
      statusCode: 200,
      setHeader(k, v) { state.headers[String(k).toLowerCase()] = String(v); return res; },
      getHeader(k) { return state.headers[String(k).toLowerCase()]; },
      writeHead(code, h) {
        state.statusCode = code;
        if (h && typeof h === 'object') {
          for (const [k, v] of Object.entries(h)) state.headers[String(k).toLowerCase()] = String(v);
        }
        return res;
      },
      write(chunk) {
        state.body += chunk == null ? '' : (Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
        return true;
      },
      end(chunk) {
        if (chunk != null) state.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        state.ended = true;
        state.statusCode = res.statusCode || state.statusCode;
        return res;
      },
      json(obj) {
        state.headers['content-type'] = 'application/json; charset=utf-8';
        state.body = JSON.stringify(obj);
        state.ended = true;
        return res;
      },
      send(data) {
        if (typeof data === 'object' && data !== null && !Buffer.isBuffer(data)) {
          return res.json(data);
        }
        state.body += data == null ? '' : String(data);
        state.ended = true;
        return res;
      },
      status(code) { state.statusCode = code; res.statusCode = code; return res; },
      _state: state
    };
    Object.defineProperty(res, 'statusCode', {
      get() { return state.statusCode; },
      set(v) { state.statusCode = v; }
    });
    return res;
  };

  const mockReq = (method, urlPath, body, headers) => {
    const u = new URL(urlPath || '/', 'http://sandbox.local');
    const req = {
      method: (method || 'GET').toUpperCase(),
      url: (urlPath || '/'),
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: Object.assign({ host: 'sandbox.local' }, headers || {}),
      body: body ? (typeof body === 'string' ? tryParse(body) : body) : undefined,
      params: {},
      ip: '127.0.0.1',
      on(ev, cb) {
        if (ev === 'data' && body) cb(Buffer.from(String(typeof body === 'string' ? body : JSON.stringify(body))));
        if (ev === 'end') setImmediate(cb);
        return req;
      }
    };
    return req;
  };

  function tryParse(s) {
    try { return JSON.parse(s); } catch { return s; }
  }

  function pathMatch(pattern, pathname) {
    if (pattern === pathname) return {};
    if (pattern === '*') return {};
    const pp = pattern.split('/').filter(Boolean);
    const up = pathname.split('/').filter(Boolean);
    if (pp.length !== up.length) return null;
    const params = {};
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = up[i];
      else if (pp[i] !== up[i]) return null;
    }
    return params;
  }

  const mockHttp = {
    createServer(fn) {
      if (typeof fn === 'function') handler = fn;
      return {
        listen(port, host, cb) {
          listening = true;
          const fnCb = typeof host === 'function' ? host : cb;
          logs.push(`[mock] http.Server.listen(${port || 0}) – 실제 포트 없음`);
          if (typeof fnCb === 'function') fnCb();
          return this;
        },
        on() { return this; },
        close(cb) { listening = false; if (cb) cb(); }
      };
    },
    Server: function () {}
  };

  // Express 최소 스텁
  function createExpressApp() {
    const app = function (req, res) {
      // top-level handler
      dispatchExpress(req, res);
    };
    app._routes = expressRoutes;
    const add = (method, pathStr, ...handlers) => {
      expressRoutes.push({ method: method.toUpperCase(), path: pathStr, handlers });
      return app;
    };
    app.get = (pathStr, ...h) => add('GET', pathStr, ...h);
    app.post = (pathStr, ...h) => add('POST', pathStr, ...h);
    app.put = (pathStr, ...h) => add('PUT', pathStr, ...h);
    app.delete = (pathStr, ...h) => add('DELETE', pathStr, ...h);
    app.patch = (pathStr, ...h) => add('PATCH', pathStr, ...h);
    app.use = function (...args) {
      if (typeof args[0] === 'string') {
        expressRoutes.push({ method: 'USE', path: args[0], handlers: args.slice(1) });
      } else {
        expressRoutes.push({ method: 'USE', path: '/', handlers: args });
      }
      return app;
    };
    app.set = () => app;
    app.disable = () => app;
    app.enable = () => app;
    app.listen = (port, host, cb) => {
      listening = true;
      handler = (req, res) => dispatchExpress(req, res);
      logs.push(`[mock] express.listen(${port || 0}) – 실제 포트 없음`);
      const fnCb = typeof host === 'function' ? host : cb;
      if (typeof fnCb === 'function') fnCb();
      return mockHttp.createServer();
    };
    return app;
  }

  function dispatchExpress(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = (req.path || req.url || '/').split('?')[0];
    // exact route first
    for (const r of expressRoutes) {
      if (r.method === 'USE') continue;
      if (r.method !== method) continue;
      const params = pathMatch(r.path, pathname);
      if (params == null) continue;
      req.params = params;
      runHandlers(r.handlers, req, res);
      return;
    }
    // fallback USE /
    for (const r of expressRoutes) {
      if (r.method !== 'USE') continue;
      if (r.path !== '/' && !pathname.startsWith(r.path)) continue;
      runHandlers(r.handlers, req, res);
      if (res._state && res._state.ended) return;
    }
    if (!res._state.ended) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found (sandbox)' }));
    }
  }

  function runHandlers(handlers, req, res) {
    let i = 0;
    const next = (err) => {
      if (err) {
        res.statusCode = 500;
        res.end(String(err.message || err));
        return;
      }
      const h = handlers[i++];
      if (!h) return;
      if (typeof h !== 'function') return next();
      try {
        if (h.length >= 3) h(req, res, next);
        else {
          const r = h(req, res, next);
          if (r && typeof r.then === 'function') r.catch(next);
        }
      } catch (e) {
        next(e);
      }
    };
    next();
  }

  // ws 스텁
  const mockWs = {
    WebSocketServer: function (opts) {
      logs.push('[mock] WebSocketServer created (실제 WS 연결 없음)');
      this.clients = new Set();
      this.on = () => this;
      this.close = () => {};
    },
    WebSocket: function () {
      this.send = () => {};
      this.close = () => {};
      this.on = () => this;
    }
  };

  // mongodb 스텁
  const mockMongo = {
    MongoClient: function (uri, opts) {
      this.connect = async () => { logs.push('[mock] MongoClient.connect() OK (스텁)'); return this; };
      this.close = async () => {};
      this.db = () => ({
        collection: () => ({
          findOne: async () => null,
          updateOne: async () => ({ acknowledged: true }),
          insertOne: async () => ({ insertedId: 'mock' }),
          deleteOne: async () => ({ deletedCount: 0 }),
          find: () => ({ toArray: async () => [], sort() { return this; }, limit() { return this; }, skip() { return this; } }),
          createIndex: async () => 'mock_idx',
          countDocuments: async () => 0
        })
      });
    }
  };

  const mockHelmet = () => (req, res, next) => next && next();
  mockHelmet.contentSecurityPolicy = () => (req, res, next) => next && next();

  const mockRateLimit = () => (req, res, next) => next && next();

  const sandboxCtx = {
    console: {
      log: (...a) => logs.push(a.map(formatVal).join(' ')),
      error: (...a) => logs.push('[error] ' + a.map(formatVal).join(' ')),
      warn: (...a) => logs.push('[warn] ' + a.map(formatVal).join(' ')),
      dir: (...a) => logs.push(a.map(formatVal).join(' '))
    },
    require(name) {
      if (name === 'http' || name === 'node:http') return mockHttp;
      if (name === 'https' || name === 'node:https') return mockHttp;
      if (name === 'url' || name === 'node:url') return require('url');
      if (name === 'path' || name === 'node:path') return require('path');
      if (name === 'querystring') return require('querystring');
      if (name === 'fs' || name === 'node:fs') {
        return {
          readFileSync: () => '',
          writeFileSync: () => {},
          existsSync: () => false,
          mkdirSync: () => {},
          readdirSync: () => [],
          promises: { readFile: async () => '', writeFile: async () => {}, mkdir: async () => {} }
        };
      }
      if (name === 'crypto' || name === 'node:crypto') {
        return {
          randomBytes: (n) => crypto.randomBytes(Math.min(n || 16, 64)),
          createHash: (alg) => crypto.createHash(alg),
          createHmac: (alg, key) => crypto.createHmac(alg, key),
          scryptSync: (...a) => crypto.scryptSync(...a),
          timingSafeEqual: (a, b) => {
            try { return crypto.timingSafeEqual(a, b); } catch { return false; }
          },
          randomUUID: () => crypto.randomUUID ? crypto.randomUUID() : 'mock-uuid'
        };
      }
      if (name === 'express') return createExpressApp;
      if (name === 'ws') return mockWs;
      if (name === 'mongodb') return mockMongo;
      if (name === 'helmet') return mockHelmet;
      if (name === 'express-rate-limit') return mockRateLimit;
      // 기타 모듈: 빈 스텁 (로드만 통과)
      logs.push(`[mock] require('${name}') → empty stub`);
      return new Proxy(function () { return {}; }, {
        get: () => new Proxy(function () { return {}; }, { get: () => () => ({}), apply: () => ({}) }),
        apply: () => ({})
      });
    },
    module: { exports: {} },
    exports: {},
    process: {
      env: {
        PORT: '3000',
        NODE_ENV: 'sandbox',
        MONGO_URI: 'mongodb://sandbox',
        MONGO_DB: 'sandbox',
        SESSION_SECRET: 'sandbox-secret-key-32chars-minimum!!'
      },
      argv: ['node', p],
      cwd: () => '/project',
      exit: (code) => { logs.push(`[mock] process.exit(${code}) ignored`); },
      on: () => {},
      version: process.version
    },
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 50)),
    clearInterval,
    setImmediate,
    __filename: p,
    __dirname: path.posix.dirname(p),
    URL,
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    Map,
    Set,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    Number,
    String,
    Boolean,
    RegExp
  };
  sandboxCtx.global = sandboxCtx;
  sandboxCtx.globalThis = sandboxCtx;

  // 정적 분석 힌트 (실행 전)
  const src = file.content || '';
  const analysis = analyzeServerSource(src);
  if (analysis.notes.length) logs.push('[분석] ' + analysis.notes.join(' | '));

  try {
    const script = new vm.Script(src, { filename: p });
    const ctx = vm.createContext(sandboxCtx);
    script.runInContext(ctx, { timeout: timeoutMs, displayErrors: true });
  } catch (e) {
    return {
      ok: false,
      error: e.message || String(e),
      logs,
      analysis,
      hint: '문법/런타임 오류입니다. Express·WS 풀 기능은 스텁이므로 일부 코드는 여기서 실패할 수 있습니다.'
    };
  }

  if (!handler && expressRoutes.length) {
    handler = (req, res) => dispatchExpress(req, res);
    listening = true;
  }

  if (!handler) {
    return {
      ok: analysis.loadable !== false,
      error: handler ? null : 'HTTP 핸들러를 등록하지 못했습니다. (listen 전 async 초기화일 수 있음)',
      logs,
      analysis,
      message: '파일은 로드를 시도했습니다. Mongo/WS 연결은 스텁입니다. 라우트·문법은 analysis 를 확인하세요.',
      routes: expressRoutes.map(r => r.method + ' ' + r.path)
    };
  }

  ws.mockServer = {
    handler,
    listening,
    entry: p,
    routes: expressRoutes.map(r => r.method + ' ' + r.path),
    analysis,
    request(method, urlPath, body, headers) {
      return new Promise((resolve) => {
        const req = mockReq(method, urlPath, body, headers);
        const res = mockResFactory();
        try {
          const maybe = handler(req, res);
          if (maybe && typeof maybe.then === 'function') {
            maybe.then(() => finish()).catch(err => {
              resolve({ status: 500, headers: {}, body: String(err.message || err), error: true });
            });
          } else {
            setTimeout(finish, 40);
          }
        } catch (e) {
          resolve({ status: 500, headers: {}, body: e.message || String(e), error: true });
        }
        function finish() {
          const s = res._state;
          resolve({ status: s.statusCode, headers: s.headers, body: s.body });
        }
      });
    }
  };

  return {
    ok: true,
    error: null,
    logs,
    analysis,
    routes: expressRoutes.map(r => r.method + ' ' + r.path),
    message: `모의 서버 시작 (entry: ${p}). 등록 라우트 ${expressRoutes.length}개. curl/http 로 테스트하세요.`
  };
}

/** 서버 소스 정적 분석 – 대형 RPG 서버도 로드 전 점검 */
function analyzeServerSource(src) {
  const notes = [];
  const routes = [];
  let loadable = true;
  if (/require\s*\(\s*['"]express['"]\s*\)/.test(src)) notes.push('Express 앱 감지');
  if (/require\s*\(\s*['"]ws['"]\s*\)|WebSocketServer/.test(src)) notes.push('WebSocket 감지 (모의 환경에선 연결 테스트 불가, 로드만 가능)');
  if (/mongodb|MongoClient/.test(src)) notes.push('MongoDB 감지 (스텁 연결)');
  if (/three\.js|THREE\./.test(src)) notes.push('Three.js – 브라우저 프리뷰로 확인');
  const re = /\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) routes.push(m[1].toUpperCase() + ' ' + m[2]);
  if (routes.length) notes.push('HTTP 라우트 후보 ' + routes.length + '개');
  if (src.length > 100000) notes.push('대형 파일 (' + Math.round(src.length / 1024) + 'KB) – 타임아웃에 주의');
  return { notes, routes: routes.slice(0, 40), loadable };
}

async function httpRequest(ws, method, urlPath, body, headers) {
  if (!ws.mockServer) {
    return { ok: false, error: '실행 중인 모의 서버가 없습니다. 먼저 `node server.js` 또는 start_server 를 실행하세요.' };
  }
  const result = await ws.mockServer.request(method || 'GET', urlPath || '/', body, headers);
  return { ok: true, ...result };
}

/** 프로젝트 일괄 배포 + 선택적 HTTP 테스트 */
async function runProject(ws, { files = {}, entry = '/project/server.js', tests = [] } = {}) {
  const written = [];
  const steps = [];

  try {
    for (const [fp, content] of Object.entries(files)) {
      const abs = fp.startsWith('/') ? fp : path.posix.join('/project', fp);
      writeFile(ws, abs, content);
      written.push(abs);
    }
    steps.push({ step: 'write', ok: true, files: written });

    const htmlFiles = written.filter(f => /\.html?$/i.test(f));
    const hasServer = written.some(f => /server\.js$/i.test(f) || f === entry);

    let serverResult = null;
    if (hasServer) {
      const entryPath = written.find(f => f.endsWith('server.js')) || entry;
      serverResult = startMockServer(ws, entryPath);
      steps.push({ step: 'start_server', ...serverResult });
      if (!serverResult.ok) {
        return { ok: false, written, steps, tests: [] };
      }
    }

    const testResults = [];
    for (const t of tests) {
      if (t.type === 'http' || t.method || t.path) {
        const r = await httpRequest(ws, t.method || 'GET', t.path || '/', t.body, t.headers);
        const expectStatus = t.expectStatus;
        const expectIncludes = t.expectIncludes;
        let pass = r.ok;
        const notes = [];
        if (expectStatus != null && r.status !== expectStatus) {
          pass = false;
          notes.push(`status ${r.status} !== expected ${expectStatus}`);
        }
        if (expectIncludes && r.body != null && !String(r.body).includes(expectIncludes)) {
          pass = false;
          notes.push(`body does not include: ${expectIncludes}`);
        }
        testResults.push({
          name: t.name || `${t.method || 'GET'} ${t.path || '/'}`,
          pass,
          response: r,
          notes
        });
      } else if (t.type === 'js') {
        const r = runJs(t.code || '');
        testResults.push({ name: t.name || 'js', pass: r.ok && !r.error, response: r });
      }
    }

    // HTML만 있는 경우 프리뷰 안내
    if (htmlFiles.length && !hasServer) {
      steps.push({
        step: 'html_preview',
        ok: true,
        message: `HTML 파일 준비됨. /api/sandbox/preview?path=${encodeURIComponent(htmlFiles[0])} 로 미리보기`,
        paths: htmlFiles
      });
    }

    const allPass = testResults.length === 0 || testResults.every(x => x.pass);
    return {
      ok: allPass && (serverResult ? serverResult.ok : true),
      written,
      steps,
      tests: testResults,
      htmlPreview: htmlFiles[0] || null,
      serverRunning: !!(ws.mockServer && ws.mockServer.listening)
    };
  } catch (e) {
    return { ok: false, written, steps, error: e.message || String(e), tests: [] };
  }
}

function runTerminal(ws, cmdLine) {
  const raw = String(cmdLine || '').trim();
  if (!raw) return { ok: true, output: '' };

  // echo with redirect: echo ... > file
  const redir = raw.match(/^echo\s+([\s\S]+?)\s*>\s*(\S+)$/);
  if (redir) {
    try {
      const content = redir[1].replace(/^["']|["']$/g, '');
      const p = writeFile(ws, redir[2], content + '\n');
      return { ok: true, output: `wrote ${p}` };
    } catch (e) {
      return { ok: false, output: e.message };
    }
  }

  const parts = raw.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  const resolve = (p) => {
    if (!p || p === '.') return ws.cwd;
    if (p.startsWith('/')) return path.posix.normalize(p);
    return path.posix.normalize(path.posix.join(ws.cwd, p));
  };

  try {
    switch (cmd) {
      case 'help':
        return {
          ok: true,
          output: [
            '가상 터미널 (실제 OS 접근 없음)',
            '  help, pwd, ls, cd, cat, echo, whoami, date, clear, reset',
            '  write <path>     – 이어서 본문은 API로 전달 (또는 run-project 사용)',
            '  node <file.js>   – JS 실행 또는 server.js 모의 서버 시작',
            '  curl <url>       – 모의 서버에 HTTP 요청 (예: curl /api/hello)',
            '  http <METHOD> <path>  – 예: http GET /',
            '  tree             – /project 트리',
            '  search <query>   – 가상 검색'
          ].join('\n')
        };
      case 'pwd':
        return { ok: true, output: ws.cwd };
      case 'whoami':
        return { ok: true, output: 'gims-user' };
      case 'date':
        return { ok: true, output: new Date().toISOString() };
      case 'clear':
        return { ok: true, output: '', clear: true };
      case 'reset':
        return resetWs(ws._userId);
      case 'ls': {
        const target = resolve(args[0] || '.');
        const items = listDir(ws, target);
        return {
          ok: true,
          output: items.map(i => (i.type === 'dir' ? i.name + '/' : i.name)).join('  ') || '(empty)'
        };
      }
      case 'tree': {
        const root = resolve(args[0] || '/project');
        const lines = [];
        const walk = (dir, prefix) => {
          const items = listDir(ws, dir);
          items.forEach((it, idx) => {
            const last = idx === items.length - 1;
            lines.push(prefix + (last ? '└── ' : '├── ') + it.name + (it.type === 'dir' ? '/' : ''));
            if (it.type === 'dir') walk(path.posix.join(dir, it.name), prefix + (last ? '    ' : '│   '));
          });
        };
        lines.push(root);
        try { walk(root, ''); } catch (e) { return { ok: false, output: e.message }; }
        return { ok: true, output: lines.join('\n') };
      }
      case 'cd': {
        if (!args[0]) return { ok: true, output: ws.cwd };
        const target = resolve(args[0]);
        const n = ws.fs[target];
        if (!n || n.type !== 'dir') return { ok: false, output: `cd: ${args[0]}: No such directory` };
        ws.cwd = target;
        return { ok: true, output: '' };
      }
      case 'cat': {
        if (!args[0]) return { ok: false, output: 'cat: missing operand' };
        const f = readFile(ws, args[0]);
        return { ok: true, output: f.content };
      }
      case 'echo':
        return { ok: true, output: args.join(' ') };
      case 'node': {
        if (!args[0]) return { ok: false, output: 'node: missing script' };
        const target = resolve(args[0]);
        const n = ws.fs[target];
        if (!n || n.type !== 'file') return { ok: false, output: `node: cannot find ${args[0]}` };
        // server.js 패턴이면 모의 서버
        if (/server\.js$/i.test(target) || /createServer\s*\(/.test(n.content || '')) {
          const r = startMockServer(ws, target);
          return {
            ok: r.ok,
            output: (r.logs || []).join('\n') + (r.message ? '\n' + r.message : '') + (r.error ? '\nError: ' + r.error : '')
          };
        }
        const r = runJs(n.content || '');
        return {
          ok: r.ok,
          output: (r.logs.length ? r.logs.join('\n') + '\n' : '') +
            (r.result != null ? String(r.result) : '') +
            (r.error ? '\nError: ' + r.error : '')
        };
      }
      case 'curl': {
        // curl /path  or curl http://localhost:3000/path
        let u = args[0] || '/';
        u = u.replace(/^https?:\/\/[^/]+/, '') || '/';
        if (!u.startsWith('/')) u = '/' + u;
        return httpRequest(ws, 'GET', u).then(r => {
          if (!r.ok) return { ok: false, output: r.error };
          return {
            ok: true,
            output: `HTTP ${r.status}\n` + Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
              '\n\n' + (r.body || '')
          };
        });
      }
      case 'http': {
        const method = (args[0] || 'GET').toUpperCase();
        const u = args[1] || '/';
        return httpRequest(ws, method, u).then(r => {
          if (!r.ok) return { ok: false, output: r.error };
          return {
            ok: true,
            output: `HTTP ${r.status}\n` + (r.body || '')
          };
        });
      }
      case 'search': {
        const q = args.join(' ');
        if (!q) return { ok: false, output: 'search: query required' };
        return {
          ok: true,
          output: `[가상 검색] "${q}"\n실제 웹 검색은 지원하지 않습니다. 채팅에서 질문하세요.`
        };
      }
      default:
        return { ok: false, output: `${cmd}: command not found (help 입력)` };
    }
  } catch (e) {
    return { ok: false, output: e.message || String(e) };
  }
}

/** Gemini function-calling 도구 정의 */
const TOOL_DECLARATIONS = [
  {
    name: 'sandbox_write_file',
    description: '가상 샌드박스 파일시스템에 파일을 저장합니다. HTML, server.js, JS 등 프로젝트 파일을 작성할 때 사용합니다. 경로는 /project/ 아래로 권장합니다.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '파일 경로 예: /project/index.html 또는 /project/server.js' },
        content: { type: 'string', description: '파일 전체 내용' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'sandbox_run_project',
    description: '여러 파일을 한 번에 쓰고, server.js가 있으면 모의 HTTP 서버를 띄운 뒤 테스트를 실행합니다. 기능이 동작하는지 검증할 때 사용하세요.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'object',
          description: '경로(문자열) → 내용(문자열) 맵. 예: {"index.html":"<!doctype html>...", "server.js":"const http=..."}'
        },
        entry: { type: 'string', description: '서버 진입 파일 기본 /project/server.js' },
        tests: {
          type: 'array',
          description: 'HTTP 테스트 목록',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              method: { type: 'string' },
              path: { type: 'string' },
              body: { type: 'string' },
              expectStatus: { type: 'number' },
              expectIncludes: { type: 'string' }
            }
          }
        }
      },
      required: ['files']
    }
  },
  {
    name: 'sandbox_terminal',
    description: '가상 터미널 명령 실행 (ls, cat, node server.js, curl /, http GET / 등)',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '실행할 명령어' }
      },
      required: ['command']
    }
  },
  {
    name: 'sandbox_http_test',
    description: '모의 서버에 HTTP 요청을 보내 응답을 확인합니다. 먼저 server.js를 실행해야 합니다.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        path: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['path']
    }
  },
  {
    name: 'sandbox_read_file',
    description: '가상 파일 내용 읽기',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    }
  }
];

async function executeTool(userId, name, args) {
  const ws = getWs(userId);
  ws._userId = userId;
  try {
    switch (name) {
      case 'sandbox_write_file': {
        const p = writeFile(ws, args.path, args.content);
        return { ok: true, path: p, bytes: String(args.content || '').length };
      }
      case 'sandbox_run_project': {
        // files가 문자열로 올 수 있음
        let files = args.files;
        if (typeof files === 'string') {
          try { files = JSON.parse(files); } catch { files = {}; }
        }
        return await runProject(ws, {
          files: files || {},
          entry: args.entry || '/project/server.js',
          tests: args.tests || []
        });
      }
      case 'sandbox_terminal': {
        const r = runTerminal(ws, args.command);
        return await Promise.resolve(r);
      }
      case 'sandbox_http_test': {
        return await httpRequest(ws, args.method || 'GET', args.path || '/', args.body, args.headers);
      }
      case 'sandbox_read_file': {
        return readFile(ws, args.path);
      }
      default:
        return { ok: false, error: 'unknown tool: ' + name };
    }
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  getWs,
  resetWs,
  writeFile,
  readFile,
  listDir,
  runJs,
  startMockServer,
  httpRequest,
  runProject,
  runTerminal,
  TOOL_DECLARATIONS,
  executeTool
};
