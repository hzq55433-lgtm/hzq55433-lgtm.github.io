"use strict";

(async () => {
  await window.SiteAccount.ready;
  const storage = window.SiteAccount.storage;
  const rules = window.LittleCorner2048;
  const key = "little-corner.game2048.v1";
  const $ = (id) => document.getElementById(id);
  const safeNumber = (value) => Number.isSafeInteger(value) && value >= 0;
  const validSnapshot = (value) => value && rules.isBoard(value.board) && value.board.some(Boolean)
    && safeNumber(value.score) && safeNumber(value.moves) && typeof value.won === "boolean";
  let state = { board: rules.newBoard(), score: 0, best: 0, won: false, moves: 0, undo: null };
  let storageMessage = "";
  let loadedProgress = false;
  try {
    const raw = storage.getItem(key);
    if (raw !== null) {
      const saved = JSON.parse(raw);
      if (saved?.version === 1 && validSnapshot(saved) && safeNumber(saved.best)
        && (saved.undo === null || validSnapshot(saved.undo))) {
        state = { board: [...saved.board], score: saved.score, best: Math.max(saved.best, saved.score), won: saved.won, moves: saved.moves, undo: saved.undo };
        loadedProgress = true;
      } else storageMessage = "原有游戏进度格式不完整，已开始新的一局。";
    }
  } catch { storageMessage = "当前浏览器无法读取游戏进度，本局会从头开始。"; }

  let pendingSave = null;
  let saveTask = null;
  let saveFailed = false;
  function showStorageStatus() {
    $("game-storage-status").textContent = storageMessage;
    $("game-storage-status").hidden = !storageMessage;
  }
  function persist() {
    pendingSave = JSON.stringify({ version: 1, ...state });
    if (saveTask) return saveTask;
    if (window.SiteAccount.isCloud) { storageMessage = "正在保存游戏进度…"; showStorageStatus(); }
    saveTask = (async () => {
      while (pendingSave) {
        const serialized = pendingSave;
        pendingSave = null;
        try {
          await storage.setItem(key, serialized);
          storageMessage = "";
          saveFailed = false;
        } catch (error) {
          storageMessage = error.message || "游戏进度未能保存，请稍后再试。";
          saveFailed = true;
          pendingSave = null;
          break;
        }
      }
      showStorageStatus();
    })().finally(() => { saveTask = null; });
    return saveTask;
  }
  window.SiteAccount.onBeforeLogout(async () => {
    if (saveFailed) await persist();
    if (saveTask) await saveTask;
    if (saveFailed) throw new Error("游戏进度暂未保存，请检查网络后再退出。");
  });
  window.addEventListener("beforeunload", (event) => {
    if (window.SiteAccount.isCloud && saveTask) { event.preventDefault(); event.returnValue = ""; }
  });
  function needsWinNotice() { return !state.won && state.board.some((value) => value >= 2048); }
  function isOver() { return !rules.canMove(state.board); }
  function announce(message) { $("game-announcement").textContent = message; }
  function render(newIndex = -1, mergedIndices = []) {
    $("game-score").textContent = state.score.toLocaleString("zh-CN");
    $("game-best").textContent = state.best.toLocaleString("zh-CN");
    $("game-undo").disabled = !state.undo;
    const board = $("game-board");
    board.replaceChildren();
    for (let row = 0; row < 4; row++) {
      const rowElement = document.createElement("div");
      rowElement.setAttribute("role", "row");
      rowElement.className = "game-row";
      for (let column = 0; column < 4; column++) {
        const index = row * 4 + column;
        const value = state.board[index];
        const cell = document.createElement("div");
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-label", `第 ${row + 1} 行第 ${column + 1} 列：${value || "空位"}`);
        cell.className = `game-cell ${value ? `game-tile game-value-${Math.min(value, 2048)}` : "game-cell-empty"}`;
        if (value >= 1024) cell.classList.add("game-tile-small");
        if (value >= 100000) cell.classList.add("game-tile-tiny");
        if (index === newIndex) cell.classList.add("game-tile-new");
        if (mergedIndices.includes(index)) cell.classList.add("game-tile-merged");
        cell.textContent = value || "";
        rowElement.append(cell);
      }
      board.append(rowElement);
    }
    const won = needsWinNotice();
    const over = isOver();
    $("game-overlay").hidden = !won && !over;
    $("game-continue").hidden = !won;
    $("game-overlay-label").textContent = won ? "A LITTLE VICTORY" : "ONE MORE TRY";
    $("game-overlay-title").textContent = won ? "2048！做到了。" : "这一局，就到这里。";
    $("game-overlay-text").textContent = won ? "可以停下来庆祝一下，也可以继续挑战。" : `这一局拿到了 ${state.score.toLocaleString("zh-CN")} 分。换个思路，再试一次。`;
  }
  function move(direction) {
    if (needsWinNotice() || isOver()) return;
    const result = rules.slide(state.board, direction);
    if (!result.moved) { announce("这个方向暂时不能移动，试试其他方向。"); return; }
    const snapshot = { board: [...state.board], score: state.score, won: state.won, moves: state.moves };
    const spawned = rules.addTile(result.board);
    state.board = spawned.board;
    state.score += result.score;
    state.best = Math.max(state.best, state.score);
    state.moves++;
    state.undo = snapshot;
    persist();
    render(spawned.index, result.mergedIndices);
    announce(needsWinNotice() ? "达到 2048！点击继续挑战，可以继续玩。" : isOver() ? "没有可移动的方块了。可以撤回上一步，或者再开一局。" : result.score ? `合并得到了 ${result.score} 分，当前 ${state.score} 分。` : "方块已移动，出现了一个新数字。");
  }
  function focusBoard() { $("game-board").focus({ preventScroll: true }); }
  function startGame() {
    state = { board: rules.newBoard(), score: 0, best: state.best, won: false, moves: 0, undo: null };
    persist();
    render();
    announce("新的一局开始了。合并相同的数字，试着到达 2048。");
    focusBoard();
  }
  function requestRestart() {
    if (state.moves > 0 && !isOver()) $("game-restart-dialog").showModal();
    else startGame();
  }
  $("game-restart").addEventListener("click", requestRestart);
  $("game-overlay-restart").addEventListener("click", requestRestart);
  $("game-restart-confirm").addEventListener("click", () => { $("game-restart-dialog").close(); startGame(); });
  $("game-continue").addEventListener("click", () => {
    state.won = true;
    persist();
    render();
    announce(isOver() ? "已经达成目标，但棋盘没有可移动的方块了。" : "继续挑战！试着合出比 2048 更大的数字。");
    focusBoard();
  });
  $("game-undo").addEventListener("click", () => {
    if (!state.undo) return;
    state = { ...state, ...state.undo, undo: null };
    persist();
    render();
    announce("已撤回上一步，最高分仍然保留。");
    focusBoard();
  });
  document.querySelectorAll("[data-move]").forEach((button) => {
    button.addEventListener("click", () => move(button.dataset.move));
  });
  window.addEventListener("keydown", (event) => {
    if ($("games").hidden || event.ctrlKey || event.metaKey || event.altKey || document.querySelector("dialog[open]")) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    const direction = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right" }[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (direction) { event.preventDefault(); move(direction); }
  });
  let swipe = null;
  $("game-board").addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    swipe = { x: event.clientX, y: event.clientY, id: event.pointerId };
    $("game-board").setPointerCapture(event.pointerId);
  });
  $("game-board").addEventListener("pointerup", (event) => {
    if (!swipe || swipe.id !== event.pointerId) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
    move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
  });
  $("game-board").addEventListener("pointercancel", () => { swipe = null; });
  window.addEventListener("site:viewchange", (event) => {
    if (event.detail.view === "games") focusBoard();
  });
  if (!loadedProgress) persist();
  else showStorageStatus();
  render();
  if (needsWinNotice()) announce("你的这一局已达到 2048，可以继续挑战。");
  else if (isOver()) announce("这一局没有可移动的方块了，可以撤回或重新开始。");
})();
