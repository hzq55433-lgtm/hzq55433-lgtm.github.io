import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, createReadStream, statSync, existsSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import validation from "./server-validation.cjs";

class LocalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const validID = /^[a-f0-9-]{36}$/;
export function createLocalLibrary({ db, directory, getOrigin, json, bodyJSON, maxPDFBytes = 80 * 1024 * 1024 }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const csrf = randomBytes(32).toString("hex");
  db.exec(`CREATE TABLE IF NOT EXISTS local_documents (kind TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL, pages INTEGER NOT NULL DEFAULT 0, current_page INTEGER NOT NULL DEFAULT 1,
      authors TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '', starred INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    ) STRICT;`);
  function checkWrite(req) {
    if (req.headers.origin !== getOrigin() || req.headers["x-requested-with"] !== "little-corner") throw new LocalError(403, "请从本地小站页面操作。");
    const supplied = String(req.headers["x-csrf-token"] ?? "");
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))) throw new LocalError(403, "本地连接已更新，请刷新页面后重试。");
  }
  function document(kind) {
    const row = db.prepare("SELECT payload, revision FROM local_documents WHERE kind = ?").get(kind);
    return row ? { value: JSON.parse(row.payload), revision: row.revision } : { value: null, revision: 0 };
  }
  function paper(row) {
    if (!row) return null;
    return { id: row.id, title: row.title, filename: row.filename, size: row.size, pages: row.pages, currentPage: row.current_page,
      authors: row.authors, year: row.year, tags: JSON.parse(row.tags), notes: row.notes, starred: Boolean(row.starred),
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }
  const getPaper = (id) => db.prepare("SELECT * FROM papers WHERE id = ?").get(id);
  async function upload(req, res) {
    checkWrite(req);
    if ((req.headers["content-type"] ?? "").split(";")[0] !== "application/pdf") throw new LocalError(415, "请选择 PDF 文件。");
    if (Number(req.headers["content-length"]) > maxPDFBytes) { req.resume(); throw new LocalError(413, "PDF 超过 80 MB 上限。"); }
    let filename;
    try { filename = decodeURIComponent(String(req.headers["x-file-name"] ?? "")); } catch { throw new LocalError(400, "文件名格式不正确。"); }
    filename = filename.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 240);
    if (!filename || !/\.pdf$/i.test(filename)) throw new LocalError(400, "请选择扩展名为 .pdf 的文件。");
    const id = randomUUID();
    const temp = join(directory, `${id}.upload`);
    const destination = join(directory, `${id}.pdf`);
    const handle = await open(temp, "wx", 0o600);
    let size = 0;
    let header = Buffer.alloc(0);
    let moved = false;
    const hash = createHash("sha256");
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxPDFBytes) throw new LocalError(413, "PDF 超过 80 MB 上限。");
        if (header.length < 8) header = Buffer.concat([header, chunk.subarray(0, 8 - header.length)]);
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      await handle.sync();
      await handle.close();
      if (!/^%PDF-\d\.\d/.test(header.toString("ascii"))) throw new LocalError(400, "文件内容不是有效的 PDF，请检查原文件。");
      const digest = hash.digest("hex");
      const existing = db.prepare("SELECT * FROM papers WHERE sha256 = ?").get(digest);
      if (existing) {
        if (!existsSync(join(directory, `${existing.id}.pdf`))) await rename(temp, join(directory, `${existing.id}.pdf`));
        if (existing.deleted_at) db.prepare("UPDATE papers SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
        return json(res, 200, { paper: paper(getPaper(existing.id)), duplicate: true });
      }
      await rename(temp, destination);
      moved = true;
      const now = new Date().toISOString();
      try {
        db.prepare("INSERT INTO papers (id, title, filename, sha256, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, filename.replace(/\.pdf$/i, ""), filename, digest, size, now, now);
      } catch (error) {
        const duplicate = db.prepare("SELECT * FROM papers WHERE sha256 = ?").get(digest);
        if (!duplicate) throw error;
        await unlink(destination);
        moved = false;
        return json(res, 200, { paper: paper(duplicate), duplicate: true });
      }
      return json(res, 201, { paper: paper(getPaper(id)), duplicate: false });
    } finally {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      if (moved && !getPaper(id)) await unlink(destination).catch(() => {});
    }
  }
  function sendPDF(req, res, id) {
    const row = getPaper(id);
    if (!row || row.deleted_at) throw new LocalError(404, "这份文献不在文献库中，可以检查回收站。");
    const path = join(directory, `${id}.pdf`);
    let info;
    try { info = statSync(path); } catch { throw new LocalError(404, "找不到原 PDF 文件，请从备份恢复，或重新导入。"); }
    const headers = { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g, "%27")}`, "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { "Content-Range": `bytes */${info.size}` }); res.end(); return; }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { "Content-Range": `bytes */${info.size}` }); res.end(); return; }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = createReadStream(path, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }
  function editPaper(row, data) {
    if (data.revision !== row.revision) throw new LocalError(409, "这份文献在另一处修改了。请先保留笔记，刷新后再编辑。");
    const title = typeof data.title === "string" ? data.title.trim() : row.title;
    const authors = typeof data.authors === "string" ? data.authors.trim() : row.authors;
    const year = typeof data.year === "string" ? data.year.trim() : row.year;
    const notes = typeof data.notes === "string" ? data.notes : row.notes;
    const tags = Array.isArray(data.tags) ? [...new Set(data.tags.map((tag) => typeof tag === "string" ? tag.trim() : "").filter(Boolean))] : JSON.parse(row.tags);
    if (!title || title.length > 300 || authors.length > 500 || notes.length > 100000 || (year && !/^\d{4}$/.test(year)) || tags.length > 20 || tags.some((tag) => tag.length > 30)) throw new LocalError(400, "请检查标题、年份、标签或笔记的长度。");
    const starred = typeof data.starred === "boolean" ? Number(data.starred) : row.starred;
    const deletedAt = typeof data.trashed === "boolean" ? (data.trashed ? new Date().toISOString() : null) : row.deleted_at;
    const changed = db.prepare("UPDATE papers SET title = ?, authors = ?, year = ?, tags = ?, notes = ?, starred = ?, deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
      .run(title, authors, year, JSON.stringify(tags), notes, starred, deletedAt, new Date().toISOString(), row.id, row.revision);
    if (changed.changes !== 1) throw new LocalError(409, "文献已经更新，请先保留笔记再刷新。");
    return paper(getPaper(row.id));
  }
  return async (req, res, pathname) => {
    if (pathname === "/api/session" && req.method === "GET") {
      json(res, 200, { mode: "local", csrfToken: csrf, documents: Object.fromEntries(["home", "journal", "game2048"].map((kind) => [kind, document(kind)])) }); return true;
    }
    const doc = /^\/api\/documents\/(home|journal|game2048)$/.exec(pathname);
    if (doc) {
      if (req.method === "GET") json(res, 200, document(doc[1]));
      else if (req.method === "PUT") {
        checkWrite(req);
        const data = await bodyJSON(req);
        const latest = document(doc[1]);
        if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new LocalError(400, "内容版本不正确。");
        if (data.revision !== latest.revision) throw new LocalError(409, "内容在另一处更新了。请先保留本次修改，刷新后再编辑。");
        let value;
        try { value = validation.normalizeDocument(doc[1], data.value); } catch (error) { throw new LocalError(400, error.message); }
        const changed = db.prepare("INSERT INTO local_documents (kind, payload, revision) VALUES (?, ?, 1) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, revision = local_documents.revision + 1 WHERE local_documents.revision = ?").run(doc[1], JSON.stringify(value), latest.revision);
        if (changed.changes !== 1) throw new LocalError(409, "内容在保存时更新了，请先保留修改再刷新。");
        json(res, 200, { value, revision: latest.revision + 1 });
      } else throw new LocalError(405, "不支持这个操作。");
      return true;
    }
    if (pathname === "/api/library") {
      if (req.method === "GET") json(res, 200, { papers: db.prepare("SELECT * FROM papers ORDER BY created_at DESC, id").all().map(paper), maxPDFBytes });
      else if (req.method === "POST") await upload(req, res);
      else throw new LocalError(405, "不支持这个操作。");
      return true;
    }
    const match = /^\/api\/library\/([a-f0-9-]+)(?:\/(file|progress))?$/.exec(pathname);
    if (!match) return false;
    const [, id, action] = match;
    if (!validID.test(id)) throw new LocalError(404, "找不到这份文献。");
    const row = getPaper(id);
    if (!row) throw new LocalError(404, "找不到这份文献。");
    if (action === "file" && ["GET", "HEAD"].includes(req.method)) sendPDF(req, res, id);
    else if (action === "progress" && req.method === "PUT") {
      checkWrite(req);
      const data = await bodyJSON(req);
      if (!Number.isSafeInteger(data.pages) || data.pages < 1 || data.pages > 100000 || !Number.isSafeInteger(data.page) || data.page < 1 || data.page > data.pages || row.deleted_at) throw new LocalError(400, "阅读页码不正确。");
      db.prepare("UPDATE papers SET pages = ?, current_page = ? WHERE id = ?").run(data.pages, data.page, id);
      json(res, 200, { paper: paper(getPaper(id)) });
    } else if (!action && req.method === "PATCH") { checkWrite(req); json(res, 200, { paper: editPaper(row, await bodyJSON(req)) }); }
    else throw new LocalError(405, "不支持这个操作。");
    return true;
  };
}
