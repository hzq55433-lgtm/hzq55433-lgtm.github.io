const game = require("./game2048-core.js");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length <= max;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function timestamp(value) { return text(value, 40) && !Number.isNaN(Date.parse(value)); }
function validDate(value) {
  if (!text(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function snapshot(value) {
  return object(value) && game.isBoard(value.board) && value.board.some(Boolean)
    && integer(value.score) && integer(value.moves) && typeof value.won === "boolean";
}
function cleanSnapshot(value) { return { board: value.board, score: value.score, won: value.won, moves: value.moves }; }
function normalizeDocument(kind, value) {
  if (!object(value)) throw new Error("内容格式不正确。");
  if (kind === "home") {
    if (!text(value.name, 12) || !value.name.trim() || !text(value.intro, 180) || !value.intro.trim()
      || !text(value.note, 2000) || !(value.updatedAt === "" || timestamp(value.updatedAt))) throw new Error("首页设置格式不正确。");
    return { name: value.name, intro: value.intro, note: value.note, updatedAt: value.updatedAt };
  }
  if (kind === "journal") {
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 10000) throw new Error("日志格式不正确。");
    const ids = new Set();
    const entries = value.entries.map((entry) => {
      if (!object(entry) || !text(entry.id, 100) || !/^[a-zA-Z0-9_-]+$/.test(entry.id) || ids.has(entry.id)
        || !validDate(entry.date) || !text(entry.title, 80) || !text(entry.content, 30000) || !entry.content.trim()
        || !timestamp(entry.createdAt) || !timestamp(entry.updatedAt)
        || !(entry.deletedAt === null || timestamp(entry.deletedAt))) throw new Error("日志内容或日期不正确。");
      ids.add(entry.id);
      const { id, date, title, content, createdAt, updatedAt, deletedAt } = entry;
      return { id, date, title, content, createdAt, updatedAt, deletedAt };
    });
    return { version: 1, entries };
  }
  if (kind === "game2048") {
    if (value.version !== 1 || !snapshot(value) || !integer(value.best) || value.best < value.score
      || !(value.undo === null || snapshot(value.undo))) throw new Error("游戏进度格式不正确。");
    return { version: 1, ...cleanSnapshot(value), best: value.best, undo: value.undo === null ? null : cleanSnapshot(value.undo) };
  }
  throw new Error("未知的内容类型。");
}
module.exports = { normalizeDocument };
