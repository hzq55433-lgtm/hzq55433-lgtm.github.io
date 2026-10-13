/* 2048 的纯游戏规则：浏览器直接加载，也可以用 Node 检查规则。 */
((root, factory) => {
  const rules = factory();
  if (typeof module === "object" && module.exports) module.exports = rules;
  else root.LittleCorner2048 = rules;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";
  const SIZE = 4;
  function isBoard(board) {
    return Array.isArray(board) && board.length === SIZE * SIZE
      && board.every((value) => value === 0 || (Number.isSafeInteger(value) && value >= 2 && 2 ** Math.round(Math.log2(value)) === value));
  }
  function slide(board, direction) {
    if (!isBoard(board)) throw new TypeError("无效的棋盘");
    if (!["left", "right", "up", "down"].includes(direction)) throw new RangeError("无效的方向");
    const next = [...board];
    const mergedIndices = [];
    let score = 0;
    for (let line = 0; line < SIZE; line++) {
      const indices = Array.from({ length: SIZE }, (_, position) => {
        if (direction === "left") return line * SIZE + position;
        if (direction === "right") return line * SIZE + SIZE - 1 - position;
        if (direction === "up") return position * SIZE + line;
        return (SIZE - 1 - position) * SIZE + line;
      });
      const values = indices.map((index) => board[index]).filter(Boolean);
      const combined = [];
      for (let i = 0; i < values.length; i++) {
        if (values[i] === values[i + 1] && Number.isSafeInteger(values[i] * 2)) {
          const merged = values[i] * 2;
          mergedIndices.push(indices[combined.length]);
          combined.push(merged);
          score += merged;
          i++;
        } else combined.push(values[i]);
      }
      indices.forEach((index, position) => { next[index] = combined[position] ?? 0; });
    }
    return { board: next, score, moved: next.some((value, index) => value !== board[index]), mergedIndices };
  }
  function addTile(board, random = Math.random) {
    if (!isBoard(board)) throw new TypeError("无效的棋盘");
    const next = [...board];
    const empty = next.map((value, index) => value === 0 ? index : -1).filter((index) => index !== -1);
    if (!empty.length) return { board: next, index: -1 };
    const index = empty[Math.min(empty.length - 1, Math.floor(random() * empty.length))];
    next[index] = random() < 0.9 ? 2 : 4;
    return { board: next, index };
  }
  function newBoard(random = Math.random) {
    return addTile(addTile(Array(SIZE * SIZE).fill(0), random).board, random).board;
  }
  function canMove(board) {
    if (!isBoard(board)) return false;
    if (board.includes(0)) return true;
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const index = row * SIZE + column;
        if (column < SIZE - 1 && board[index] === board[index + 1] && Number.isSafeInteger(board[index] * 2)) return true;
        if (row < SIZE - 1 && board[index] === board[index + SIZE] && Number.isSafeInteger(board[index] * 2)) return true;
      }
    }
    return false;
  }
  return { isBoard, slide, addTile, newBoard, canMove };
});
