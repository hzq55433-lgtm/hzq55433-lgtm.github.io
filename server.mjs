import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isIP } from "node:net";
import validation from "./server-validation.cjs";
import { createLocalLibrary } from "./local-library.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const SCRYPT = { N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 };
const KINDS = ["home", "journal", "game2048"];
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY = 10 * 1024 * 1024;
const STATIC_FILES = ["index.html", "styles.css", "journal.css", "games.css", "account.css", "library.css", "app.js", "journal.js", "games.js", "account.js", "library.js", "game2048-core.js"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function secureEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length > 512 || b.length > 512) return false;
  const one = Buffer.from(a);
  const two = Buffer.from(b);
  return one.length === two.length && timingSafeEqual(one, two);
}
class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt, 64, SCRYPT);
  return `scrypt$65536$8$2$${salt}$${hash.toString("hex")}`;
}
async function passwordMatches(password, encoded) {
  const [, cost, block, parallel, salt, expected] = encoded.split("$");
  if (cost !== "65536" || block !== "8" || parallel !== "2" || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const actual = await derive(password, salt, 64, SCRYPT);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
async function bodyJSON(req) {
  if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") throw new HttpError(415, "请使用 JSON 格式提交内容。");
  if (Number(req.headers["content-length"]) > MAX_BODY) { req.resume(); throw new HttpError(413, "提交内容超过了 10 MB 上限。"); }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "提交内容超过了 10 MB 上限。");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, "提交内容不是有效的 JSON 对象。"); }
}

export function createSiteServer(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const mode = options.mode ?? "email";
  if (!["local", "email"].includes(mode)) throw new Error("SITE_MODE 只能是 local 或 email。");
  if (mode === "local" && production) throw new Error("本地模式只允许在个人电脑上运行，不能作为生产服务发布。");
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? (process.env.RENDER === "true" ? process.env.RENDER_EXTERNAL_URL ?? "" : "");
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error("PUBLIC_ORIGIN 应只包含协议、域名和可选端口，不要带路径或末尾斜杠。");
  if (production && !publicOrigin.startsWith("https://")) throw new Error("生产环境必须设置 HTTPS 的 PUBLIC_ORIGIN。");
  const registrationMode = options.registrationMode ?? process.env.REGISTRATION_MODE ?? "open";
  if (!["open", "invite"].includes(registrationMode)) throw new Error("REGISTRATION_MODE 只能是 open 或 invite。");
  const inviteCode = options.inviteCode ?? process.env.INVITE_CODE ?? "";
  if (registrationMode === "invite" && inviteCode.length < 16) throw new Error("邀请模式需要设置至少 16 个字符的 INVITE_CODE。");
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === "true";
  const dbPath = options.dbPath ?? process.env.DATA_FILE ?? join(ROOT, "data", "site.sqlite");
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_secret TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS documents (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('home','journal','game2048')), payload TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, kind)) STRICT;
    PRAGMA user_version = 1;`);
  const files = new Map(STATIC_FILES.map((filename) => [`/${filename}`, readFileSync(join(ROOT, filename))]));
  const cookieName = production ? "__Host-littlecorner_session" : "littlecorner_session";
  const dummyHash = `scrypt$65536$8$2$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;
  const attempts = new Map();
  let hashing = 0;
  function origin() {
    const address = server.address();
    return publicOrigin || `http://127.0.0.1:${typeof address === "object" && address ? address.port : 4317}`;
  }
  function clientIP(req) {
    if (trustProxy) {
      const candidate = String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1).trim();
      if (isIP(candidate)) return candidate;
    }
    return req.socket.remoteAddress ?? "unknown";
  }
  function takeAttempt(key, limit) {
    const now = Date.now();
    if (attempts.size > 10000) for (const [stored, value] of attempts) if (value.until < now) attempts.delete(stored);
    const item = attempts.get(key);
    const current = item && item.until > now ? item : { count: 0, until: now + 15 * 60 * 1000 };
    current.count++;
    attempts.set(key, current);
    if (current.count > limit) throw new HttpError(429, "尝试次数较多，请 15 分钟后再试。");
  }
  function setCookie(res, token = "", age = SESSION_SECONDS) {
    res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${production ? "; Secure" : ""}`);
  }
  function session(req) {
    const token = String(req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return db.prepare("SELECT s.*, u.email, u.nickname FROM sessions s JOIN users u ON s.user_id = u.id WHERE token_hash = ? AND expires_at > ?").get(sha256(token), Date.now());
  }
  function requireSession(req) {
    const current = session(req);
    if (!current) throw new HttpError(401, "登录已过期，请重新登录。");
    return current;
  }
  function checkOrigin(req) {
    if (req.headers.origin !== origin() || req.headers["x-requested-with"] !== "little-corner") throw new HttpError(403, "请求来源不正确，请从本站页面操作。");
  }
  function checkCSRF(req, current) {
    checkOrigin(req);
    if (!secureEqual(req.headers["x-csrf-token"], current.csrf_secret)) throw new HttpError(403, "登录校验已失效，请刷新后重试。");
  }
  function getDocument(userId, kind) {
    const row = db.prepare("SELECT payload, revision FROM documents WHERE user_id = ? AND kind = ?").get(userId, kind);
    return row ? { value: JSON.parse(row.payload), revision: row.revision } : { value: null, revision: 0 };
  }
  function userResult(current) {
    return { user: { id: current.user_id, email: current.email, nickname: current.nickname }, csrfToken: current.csrf_secret, documents: Object.fromEntries(KINDS.map((kind) => [kind, getDocument(current.user_id, kind)])) };
  }
  function issueSession(user, res) {
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), user.id, csrf, Date.now() + SESSION_SECONDS * 1000);
    setCookie(res, token);
    return userResult({ user_id: user.id, email: user.email, nickname: user.nickname, csrf_secret: csrf });
  }
  function json(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  }
  const local = mode === "local" ? createLocalLibrary({ db, directory: options.libraryDir ?? join(dirname(resolve(dbPath)), "papers"), getOrigin: origin, json, bodyJSON, maxPDFBytes: options.maxPDFBytes }) : null;
  async function auth(req, res, action) {
    checkOrigin(req);
    takeAttempt(`${action}:ip:${clientIP(req)}`, action === "register" ? 10 : 30);
    const data = await bodyJSON(req);
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    const password = data.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== "string" || password.length > 128 || !password.length) throw new HttpError(400, "请填写有效的邮箱和密码。");
    const accountKey = `login:email:${sha256(email)}`;
    if (action === "login") takeAttempt(accountKey, 10);
    if (hashing >= 2) throw new HttpError(503, "现在登录的人较多，请稍后再试。");
    hashing++;
    try {
      if (action === "register") {
        if (password.length < 15) throw new HttpError(400, "注册密码至少需要 15 个字符，可以使用一句短句。");
        if (registrationMode === "invite" && !secureEqual(data.inviteCode, inviteCode)) throw new HttpError(403, "邀请码不正确。");
        const nickname = typeof data.nickname === "string" ? data.nickname.trim() : "";
        if (!nickname || nickname.length > 24) throw new HttpError(400, "请填写 1 至 24 个字符的昵称。");
        if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) throw new HttpError(409, "无法用这个邮箱创建账号，可以尝试登录。");
        const hash = await passwordHash(password);
        const user = { id: randomUUID(), email, nickname };
        try {
          db.prepare("INSERT INTO users (id, email, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(user.id, email, nickname, hash, new Date().toISOString());
        } catch { throw new HttpError(409, "无法用这个邮箱创建账号，可以尝试登录。"); }
        json(res, 201, issueSession(user, res));
      } else {
        const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
        const matches = await passwordMatches(password, user?.password_hash ?? dummyHash);
        if (!user || !matches) throw new HttpError(401, "邮箱或密码不正确。");
        attempts.delete(accountKey);
        json(res, 200, issueSession(user, res));
      }
    } finally { hashing--; }
  }

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; font-src 'self' data: blob:; img-src 'self' data: blob:; connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (production) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const pathname = new URL(req.url, origin()).pathname;
      if (mode === "local") {
        const port = server.address()?.port;
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || ["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])) throw new HttpError(403, "本地小站只允许从这台电脑打开。");
        if (req.headers.origin && req.headers.origin !== origin()) throw new HttpError(403, "请求来源不正确。");
      }
      if (req.method === "GET" && pathname === "/api/config") return json(res, 200, { mode, registrationMode, passwordMinLength: 15 });
      if (req.method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true });
      if (local && await local(req, res, pathname)) return;
      if (mode === "local" && pathname.startsWith("/api/auth/")) throw new HttpError(404, "本地模式无需账号。");
      if (req.method === "GET" && pathname === "/api/session") {
        const current = session(req);
        return json(res, 200, current ? userResult(current) : { user: null });
      }
      if (req.method === "POST" && ["/api/auth/register", "/api/auth/login"].includes(pathname)) return await auth(req, res, pathname.endsWith("register") ? "register" : "login");
      if (req.method === "POST" && pathname === "/api/auth/logout") {
        const current = requireSession(req);
        checkCSRF(req, current);
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(current.token_hash);
        setCookie(res, "", 0);
        return json(res, 200, { ok: true });
      }
      const match = /^\/api\/documents\/(home|journal|game2048)$/.exec(pathname);
      if (match) {
        const current = requireSession(req);
        const kind = match[1];
        if (req.method === "GET") return json(res, 200, getDocument(current.user_id, kind));
        if (req.method === "PUT") {
          checkCSRF(req, current);
          const body = await bodyJSON(req);
          if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new HttpError(400, "内容版本不正确，请刷新后重试。");
          let value;
          try { value = validation.normalizeDocument(kind, body.value); }
          catch (error) { throw new HttpError(400, error.message); }
          const latest = getDocument(current.user_id, kind);
          if (body.revision !== latest.revision) throw new HttpError(409, "这个账号的内容在另一处更新了。请先保留本次修改，刷新后再编辑。");
          const payload = JSON.stringify(value);
          if (latest.revision === 0) db.prepare("INSERT INTO documents (user_id, kind, payload, revision, updated_at) VALUES (?, ?, ?, 1, ?)").run(current.user_id, kind, payload, new Date().toISOString());
          else {
            const changed = db.prepare("UPDATE documents SET payload = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND kind = ? AND revision = ?").run(payload, new Date().toISOString(), current.user_id, kind, latest.revision);
            if (changed.changes !== 1) throw new HttpError(409, "内容在保存时更新了，请先保留本次修改再刷新。");
          }
          return json(res, 200, { value, revision: latest.revision + 1 });
        }
        throw new HttpError(405, "不支持这个操作。");
      }
      if (pathname.startsWith("/api/")) throw new HttpError(404, "没有这个接口。");
      if (!["GET", "HEAD"].includes(req.method)) throw new HttpError(405, "不支持这个操作。");
      const file = pathname === "/" ? "/index.html" : pathname;
      if (/^\/vendor\/pdfjs\/(?:pdf(?:\.worker)?\.mjs|pdf_viewer\.css|LICENSE|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/.test(file)) {
        const path = join(ROOT, file.slice(1));
        if (!existsSync(path)) throw new HttpError(404, "找不到阅读器资源。");
        const mime = /\.(mjs|js)$/.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        return res.end(req.method === "HEAD" ? undefined : readFileSync(path));
      }
      const contents = files.get(file);
      if (!contents) throw new HttpError(404, "没有找到这个页面。");
      const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : contents);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (!error.status) console.error("请求处理失败：", error.name);
      json(res, error.status ?? 500, { message: error.status ? error.message : "服务器暂时无法处理请求，请稍后再试。", ...(error.extra ?? {}) });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return { server, db, close: () => { server.closeAllConnections(); return new Promise((done) => server.close(() => { db.close(); done(); })); } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("请使用 Node.js 24 或更高版本。");
  const mode = process.argv.includes("--accounts") ? "email" : process.env.SITE_MODE ?? (process.env.NODE_ENV === "production" ? "email" : "local");
  const app = createSiteServer({ mode, ...(mode === "local" ? { publicOrigin: "" } : {}) });
  const port = Number(process.env.PORT ?? 4317);
  const host = mode === "local" ? "127.0.0.1" : process.env.HOST ?? "127.0.0.1";
  app.server.listen(port, host, () => console.log(`小站已启动：${mode === "local" ? `http://127.0.0.1:${port}` : process.env.PUBLIC_ORIGIN || (process.env.RENDER === "true" && process.env.RENDER_EXTERNAL_URL) || `http://127.0.0.1:${port}`}\n关闭此窗口或按 Ctrl+C 停止。`));
  const stop = () => app.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
