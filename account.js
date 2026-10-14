"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const kinds = { "little-corner.home.v1": "home", "little-corner.journal.v1": "journal", "little-corner.game2048.v1": "game2048" };
  let mode = "loading";
  let currentUser = null;
  let csrfToken = "";
  let documents = {};
  let registration = false;
  let config = {};
  const flushers = [];
  const queues = new Map();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-Requested-With": "little-corner", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}), ...options.headers } });
    } catch { throw new Error("暂时连接不上服务器，请检查网络。当前修改还没有确认保存。"); }
    let body;
    try { body = await response.json(); }
    catch { throw new Error("服务器返回的内容不完整，请稍后再试。"); }
    if (!response.ok) {
      const error = new Error(body.message || "操作没有完成，请稍后再试。");
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function equalValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalValue(a[key], b[key]));
  }
  function updateCopies() {
    const cloud = mode === "cloud";
    const disk = mode === "disk";
    $("storage-footer").textContent = disk ? "本地电脑 · 无需登录" : cloud ? "账号内容仅自己可见" : "内容保存在当前浏览器";
    $("note-storage-hint").textContent = disk ? "保存到这台电脑的小站文件夹中。" : cloud ? "保存到你的账号，仅自己可见。" : "这张便签只保存在当前设备的这个浏览器里。";
    $("profile-storage-hint").textContent = disk ? "这些设置保存在本地电脑，之后可以随时再改。" : cloud ? "这是你自己的首页设置，之后可以随时再改。" : "这些设置保存在当前浏览器，之后可以随时再改。";
    $("journal-editor-storage").textContent = disk ? "纯文字日志 · 保存在本地电脑" : cloud ? "保存到你的账号 · 仅自己可见" : "纯文字日志 · 保存后会留在当前浏览器";
    $("journal-storage-hint").textContent = disk ? "日志保存在这台电脑的小站文件夹中。也可以导出一份备份，留在自己手里。" : cloud ? "日志保存在你的账号中，仅自己可见。也可以导出一份备份，留在自己手里。" : "日志保存在当前浏览器中。定期导出一份备份，就能把这些日子好好留住。";
    $("game-footnote").textContent = disk ? "离开一下也没关系。当前进度和最高分会保存在本地电脑中。" : cloud ? "离开一下也没关系。当前进度和最高分会保存到你的账号。" : "离开一下也没关系。当前进度和最高分会保存在这个浏览器中。";
    $("account-label").textContent = currentUser ? Array.from(currentUser.nickname).slice(0, 6).join("") : "本地存储";
    $("account-button").setAttribute("aria-label", currentUser ? `账号：${currentUser.nickname}` : "查看本地存储说明");
  }
  function enter(result = null) {
    if (result) {
      mode = result.mode === "local" ? "disk" : "cloud";
      currentUser = result.user ?? null;
      csrfToken = result.csrfToken;
      documents = result.documents;
    } else mode = "local";
    $("account-loading").hidden = true;
    $("account-screen").hidden = true;
    $("site-shell").hidden = false;
    $("account-password").value = "";
    updateCopies();
    resolveReady();
  }
  function showAuth() {
    $("account-loading").hidden = true;
    $("account-screen").hidden = false;
    $("site-shell").hidden = true;
  }
  function errorMessage(message) {
    $("account-error").textContent = message;
    $("account-error").hidden = false;
  }
  function setRegistration(value) {
    registration = value;
    $("account-login-tab").setAttribute("aria-selected", String(!value));
    $("account-register-tab").setAttribute("aria-selected", String(value));
    $("account-nickname-field").hidden = !value;
    $("account-nickname").required = value;
    $("account-password-hint").hidden = !value;
    $("account-password").minLength = value ? 15 : 1;
    $("account-password").autocomplete = value ? "new-password" : "current-password";
    $("account-title").textContent = value ? "给自己一个小角落。" : "欢迎回来。";
    $("account-intro").textContent = value ? "注册之后，就有一本只属于自己的日志。" : "登录，接着记录你自己的日子。";
    $("account-submit").firstChild.textContent = value ? "创建我的账号 " : "进入我的小站 ";
    const invite = value && config.registrationMode === "invite";
    $("account-invite-field").hidden = !invite;
    $("account-invite").required = invite;
    $("account-error").hidden = true;
  }
  const storage = {
    getItem(key) {
      if (mode === "local") return localStorage.getItem(key);
      const kind = kinds[key];
      if (!kind || !["cloud", "disk"].includes(mode)) throw new Error("请先打开小站。");
      const value = documents[kind]?.value;
      return value === null || value === undefined ? null : JSON.stringify(value);
    },
    async setItem(key, serialized) {
      if (mode === "local") { localStorage.setItem(key, serialized); return; }
      const kind = kinds[key];
      if (!kind || !["cloud", "disk"].includes(mode)) throw new Error("请先打开小站。");
      const value = JSON.parse(serialized);
      const previous = queues.get(kind) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        try {
          const saved = await request(`/api/documents/${kind}`, { method: "PUT", keepalive: kind === "game2048", body: JSON.stringify({ value, revision: documents[kind]?.revision ?? 0 }) });
          documents[kind] = saved;
        } catch (error) {
          if (!error.status) {
            try {
              const latest = await request(`/api/documents/${kind}`);
              if (equalValue(latest.value, value)) { documents[kind] = latest; return; }
            } catch { /* 保留原错误，避免把未确认的保存显示成成功。 */ }
          }
          throw error;
        }
      });
      queues.set(kind, task);
      try { await task; }
      finally { if (queues.get(kind) === task) queues.delete(kind); }
    },
  };
  window.SiteAccount = { ready, storage, api: request, get isCloud() { return ["cloud", "disk"].includes(mode); }, get isDisk() { return mode === "disk"; }, onBeforeLogout(callback) { flushers.push(callback); } };
  $("account-login-tab").addEventListener("click", () => setRegistration(false));
  $("account-register-tab").addEventListener("click", () => setRegistration(true));
  $("account-password-toggle").addEventListener("click", () => {
    const visible = $("account-password").type === "password";
    $("account-password").type = visible ? "text" : "password";
    $("account-password-toggle").textContent = visible ? "隐藏" : "显示";
    $("account-password-toggle").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  });
  $("account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("account-submit");
    submit.disabled = true;
    $("account-error").hidden = true;
    try {
      const result = await request(`/api/auth/${registration ? "register" : "login"}`, { method: "POST", body: JSON.stringify({ email: $("account-email").value, password: $("account-password").value, nickname: $("account-nickname").value, inviteCode: $("account-invite").value }) });
      enter(result);
    } catch (error) { errorMessage(error.message); }
    finally { submit.disabled = false; }
  });
  $("account-button").addEventListener("click", () => {
    $("account-details-title").textContent = currentUser ? "我的账号" : "我的本地小站";
    $("account-detail-name").textContent = currentUser ? currentUser.nickname : "你现在处于本地模式。";
    $("account-detail-email").textContent = currentUser ? currentUser.email : "";
    $("account-detail-copy").textContent = mode === "disk" ? "PDF 原文件保存在 data/papers 文件夹中；日志、阅读位置和文献笔记保存在 data/site.sqlite。停止小站后，备份整个 data 文件夹即可。网站只在这台电脑上访问，不会上传内容。" : currentUser ? "日志、便签、首页设置和游戏进度都属于这个账号，其他账号无法查看。" : "双击文件夹里的「启动小站.cmd」，即可使用本地文献库。直接打开 HTML 时，旧日志和游戏仍保留在当前浏览器中；可以导出日志备份后导入本地小站。";
    $("account-logout").hidden = !currentUser;
    $("account-details-error").hidden = true;
    $("account-details").showModal();
  });
  ["account-details-close", "account-details-done"].forEach((id) => $(id).addEventListener("click", () => $("account-details").close()));
  $("account-logout").addEventListener("click", async () => {
    const button = $("account-logout");
    button.disabled = true;
    try {
      await Promise.all(flushers.map((flush) => flush()));
      await Promise.all([...queues.values()]);
      await request("/api/auth/logout", { method: "POST", body: "{}" });
      currentUser = null;
      csrfToken = "";
      documents = {};
      $("account-details").close();
      $("site-shell").hidden = true;
      location.reload();
    } catch (error) { $("account-details-error").textContent = error.message; $("account-details-error").hidden = false; }
    finally { button.disabled = false; }
  });
  $("account-retry").addEventListener("click", () => location.reload());
  (async () => {
    if (location.protocol === "file:") { enter(); return; }
    try {
      const response = await fetch("/api/config", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 404) { enter(); return; }
      if (!response.ok) throw new Error("后台暂时无法连接，请稍后重试。");
      config = await response.json();
      if (config.mode === "local") { enter(await request("/api/session")); return; }
      if (config.mode !== "email") throw new Error("后台配置不完整，请检查网站是否正确启动。");
      const result = await request("/api/session");
      if (result.user) enter(result);
      else showAuth();
    } catch (error) {
      showAuth();
      $("account-form").hidden = true;
      $("account-retry").hidden = false;
      errorMessage(error.message);
    }
  })();
})();
