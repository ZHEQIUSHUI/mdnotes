"use strict";
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const state = { editor: false, mode: "edit", needUser: false, articles: [], folders: [], dirty: false };
const VIDEO = /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const short = (t) => (t || "").slice(0, 16);

// ---------- api ----------
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401) {
    state.editor = false; renderWho();
    if (state.mode === "all" && $("#modal").classList.contains("hidden")) login();
    throw new Error("need-login");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || r.statusText);
  return data;
}

const ICON = {
  all: '<svg viewBox="0 0 16 16"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5zM5 5.5h6M5 8h6M5 10.5h4"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/></svg>',
  empty: '<svg viewBox="0 0 16 16" class="big"><path d="M3 2h7l3 3v9H3zM10 2v3h3"/></svg>',
};
function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------- modal ----------
function modal(title, html, onOk, cancelable = true) {
  return new Promise((resolve) => {
    $("#mTitle").textContent = title; $("#mBody").innerHTML = html + '<div class="err"></div>';
    $("#modal").classList.remove("hidden"); $("#mCancel").classList.toggle("hidden", !cancelable);
    const first = $("#mBody input, #mBody select"); if (first) setTimeout(() => first.focus(), 0);
    const close = (v) => { $("#modal").classList.add("hidden"); $("#mOk").onclick = $("#mCancel").onclick = null; document.removeEventListener("keydown", key); resolve(v); };
    const ok = async () => {
      try { const v = await onOk($("#mBody")); close(v === undefined ? true : v); }
      catch (e) { $("#mBody .err").textContent = e.message === "need-login" ? "需要先登录" : e.message; }
    };
    const key = (e) => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") ok(); if (e.key === "Escape" && cancelable) close(null); };
    document.addEventListener("keydown", key);
    $("#mOk").onclick = ok; $("#mCancel").onclick = () => close(null);
  });
}

async function login() {
  const all = state.mode === "all";
  const html = `<label>${all ? "本站需要登录后才能查看" : "只有修改文章需要登录，阅读不需要"}</label>`
    + (state.needUser ? '<input id="user" placeholder="账号" autocomplete="username">' : "")
    + `<input id="pw" type="password" placeholder="${state.needUser ? "密码" : "口令"}" autocomplete="current-password">`;
  const ok = await modal(all ? "登录" : "登录后编辑", html, async (b) => {
    await api("POST", "/api/login", { user: $("#user", b)?.value || "", password: $("#pw", b).value });
    state.editor = true; renderWho();
  }, !all);
  if (ok && all) route();
  return ok;
}

async function needEditor() {
  if (state.editor) return true;
  return !!(await login());
}

function renderWho() {
  const w = $("#who");
  w.classList.toggle("hidden", state.mode === "none");
  w.innerHTML = state.editor ? "<i></i><span class=\"wt\">可编辑</span>" : "<i></i><span class=\"wt\">只读 · 点此登录</span>";
  w.classList.toggle("on", state.editor);
}
$("#who").onclick = () => { if (!state.editor) login(); };

// ---------- markdown ----------
function dirOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function resolvePath(base, rel) {
  const out = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out.join("/");
}
const isRel = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);

marked.use({
  gfm: true,
  renderer: {
    code(code, info) {
      const lang = (info || "").trim().split(/\s+/)[0];
      if (lang === "mermaid") return `<pre class="mermaid">${esc(code)}</pre>`;
      let html;
      try { html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value; }
      catch { html = esc(code); }
      return `<pre><code class="hljs">${html}</code></pre>`;
    },
    image(href, title, text) {
      if (VIDEO.test(href || "")) return `<video controls preload="metadata" src="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}></video>`;
      return false;
    },
  },
});

function stripFront(md) { return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); }

let mermaidSeq = 0, mermaidReady = null;
function loadMermaid() {  // 3 MB; only fetched when a page actually has a diagram
  return mermaidReady ||= new Promise((ok, fail) => {
    const s = document.createElement("script"); s.src = "vendor/mermaid.min.js";
    s.onload = () => { mermaid.initialize({ startOnLoad: false, securityLevel: "strict",
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" }); ok(); };
    s.onerror = () => { mermaidReady = null; fail(new Error("流程图组件加载失败")); };
    document.head.appendChild(s);
  });
}

async function renderMd(el, md, articlePath) {
  const html = DOMPurify.sanitize(marked.parse(stripFront(md)), {
    ADD_TAGS: ["video", "source"], ADD_ATTR: ["controls", "preload", "target"] });
  el.innerHTML = html;
  const base = dirOf(articlePath);
  el.querySelectorAll("img[src], video[src], source[src]").forEach((n) => {
    const s = n.getAttribute("src");
    if (isRel(s)) n.setAttribute("src", "/files/" + enc(resolvePath(base, decodeURI(s))));
  });
  el.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href");
    if (!isRel(h)) { if (/^https?:/i.test(h)) a.target = "_blank"; return; }
    const [p, hash] = h.split("#");
    const target = resolvePath(base, decodeURI(p));
    if (/\.md$/i.test(target)) a.setAttribute("href", "#/a/" + enc(target));
    else if (p) a.setAttribute("href", "/files/" + enc(target) + (hash ? "#" + hash : ""));
  });
  el.querySelectorAll("img").forEach((img) => img.addEventListener("click", () => {
    $("#lightbox img").src = img.src; $("#lightbox").classList.remove("hidden");
  }));
  const used = {};
  el.querySelectorAll("h1,h2,h3,h4").forEach((h) => {
    let id = h.textContent.trim().toLowerCase().replace(/[^\w一-鿿]+/g, "-").replace(/^-|-$/g, "") || "h";
    if (used[id]) id += "-" + used[id]++; else used[id] = 1;
    h.id = id;
  });
  const nodes = [...el.querySelectorAll("pre.mermaid")];
  if (nodes.length) {
    try { await loadMermaid(); }
    catch (e) { nodes.forEach((n) => n.insertAdjacentHTML("afterbegin", `<code style="color:var(--danger)">${esc(e.message)}</code>\n`)); return; }
  }
  for (const n of nodes) {
    const src = n.textContent;
    try { const { svg } = await mermaid.render("mmd" + ++mermaidSeq, src); n.innerHTML = svg; }
    catch (e) { n.innerHTML = `<code style="color:var(--danger)">流程图语法错误：${esc(e.message || e)}</code>`; }
  }
}
$("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");

// ---------- routing ----------
window.addEventListener("hashchange", () => route());
window.addEventListener("beforeunload", (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

async function route() {
  const h = decodeURIComponent(location.hash.slice(1) || "/");
  if (state.leaveGuard && !state.leaveGuard()) return;
  state.leaveGuard = null; state.dirty = false;
  if (h.startsWith("/a/")) return viewArticle(h.slice(3));
  if (h.startsWith("/e/")) return editArticle(h.slice(3));
  if (h.startsWith("/f/")) return listPage(h.slice(3));
  return listPage(null);
}

// ---------- list ----------
async function loadAll(q = "") {
  [state.articles, state.folders] = await Promise.all([
    api("GET", "/api/articles?q=" + encodeURIComponent(q)), api("GET", "/api/folders")]);
}

async function listPage(folder, q = $("#search").value.trim()) {
  await loadAll(q);
  const all = q ? state.articles : state.articles;
  const counts = {};
  for (const a of all) {
    const parts = a.folder ? a.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) { const k = parts.slice(0, i).join("/"); counts[k] = (counts[k] || 0) + 1; }
  }
  const fset = new Set(state.folders);
  for (const k of Object.keys(counts)) fset.add(k);
  const flist = [...fset].sort();
  const items = folder === null ? all : all.filter((a) => a.folder === folder || a.folder.startsWith(folder + "/"));

  const side = [`<a class="f ${folder === null ? "cur" : ""}" href="#/"><span class="fl">${ICON.all}<span>全部文章</span></span><span class="n">${all.length}</span></a>`]
    .concat(flist.map((f) => {
      const depth = f.split("/").length - 1, name = f.split("/").pop();
      return `<a class="f ${folder === f ? "cur" : ""}" href="#/f/${enc(f)}" style="padding-left:${10 + depth * 16}px">
        <span class="fl">${ICON.folder}<span>${esc(name)}</span></span><span class="fr"><span class="n">${counts[f] || 0}</span>
        <span class="del ${counts[f] ? "" : "can"}" data-del="${esc(f)}" title="删除空文件夹">✕</span></span></a>`;
    })).join("");

  const rows = items.map((a) => `<a class="card" href="#/a/${enc(a.path)}">
      <div class="ct">${esc(a.title)}</div>
      ${a.snippet ? `<div class="snip">…${esc(a.snippet)}…</div>` : ""}
      <div class="cm">${a.folder ? `<span class="chip">${ICON.folder}${esc(a.folder)}</span>` : ""}
        <span title="创建时间">创建 ${esc(short(a.created))}</span><span class="dot">·</span><span title="最后修改时间">修改 ${esc(short(a.updated))}</span></div>
    </a>`).join("");

  const heading = q ? `搜索 “${esc(q)}”` : folder ? esc(folder.split("/").pop()) : "全部文章";
  app.innerHTML = `<div class="layout"><nav class="side"><div class="side-h">文件夹</div>${side}</nav><section class="content">
    <div class="list-h"><h2>${heading}</h2><span class="cnt">${items.length} 篇 · 按最后修改排序</span></div>
    ${folder && !q ? `<div class="crumb"><a href="#/">全部</a> / ${esc(folder)}</div>` : ""}
    ${items.length ? `<div class="cards">${rows}</div>`
      : `<div class="empty">${ICON.empty}<div>${q ? "没有匹配的文章" : "这里还没有文章"}</div></div>`}
  </section></div>`;
  state.curFolder = folder;
  app.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!(await needEditor())) return;
    try { await api("DELETE", "/api/folder?path=" + encodeURIComponent(x.dataset.del)); toast("已删除文件夹"); location.hash = "#/"; route(); }
    catch (err) { toast(err.message); }
  }));
}

let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!location.hash.startsWith("#/f/") && location.hash !== "#/" && location.hash !== "") location.hash = "#/";
    else listPage(state.curFolder ?? null);
  }, 250);
});

// ---------- view ----------
async function viewArticle(path) {
  const a = await api("GET", "/api/article?path=" + encodeURIComponent(path)).catch((e) => { app.innerHTML = `<div class="empty">打不开：${esc(e.message)}</div>`; });
  if (!a) return;
  const folder = folderOf(path);
  app.innerHTML = `<div class="article-wrap"><article class="article">
    <div class="ahead">
      <div class="crumb"><a href="#/">全部</a>${folder ? ` / <a href="#/f/${enc(folder)}">${esc(folder)}</a>` : ""}</div>
      <h1>${esc(a.title)}</h1>
      <div class="meta"><span>创建 ${esc(a.meta.created || "-")}</span><span class="dot">·</span><span>最后修改 ${esc(a.meta.updated || "-")}</span><span class="sp"></span>
        <button class="btn small primary" id="aEdit">${ICON.edit}编辑</button><button class="btn small" id="aRen">重命名</button>
        <button class="btn small" id="aMove">移动</button><button class="btn small danger" id="aDel">删除</button></div>
    </div><div class="md" id="body"></div></article><aside class="toc" id="toc"></aside></div>`;
  document.title = a.title + " - 文档";
  const body = $("#body");
  await renderMd(body, a.content.replace(/^\s*#\s+.+\n?/, ""), path);
  const hs = [...body.querySelectorAll("h2,h3,h4")];
  $("#toc").innerHTML = hs.length > 2 ? "<div class=\"toc-h\">目录</div>" + hs.map((h) => `<a class="l${h.tagName[1]}" href="javascript:void(0)" data-id="${h.id}">${esc(h.textContent)}</a>`).join("") : "";
  $("#toc").querySelectorAll("a").forEach((x) => x.onclick = () => document.getElementById(x.dataset.id).scrollIntoView({ behavior: "smooth" }));
  $("#aEdit").onclick = async () => { if (await needEditor()) location.hash = "#/e/" + enc(path); };
  $("#aRen").onclick = () => renameDlg(path, a.title);
  $("#aMove").onclick = () => moveDlg(path);
  $("#aDel").onclick = () => deleteDlg(path, a.title);
}

function folderOf(path) {
  const parts = path.split("/");
  if (parts[parts.length - 1] === "index.md") parts.pop();
  parts.pop();
  return parts.join("/");
}

async function folderOptions(selected) {
  const fs = await api("GET", "/api/folders");
  return ['<option value="">（根目录）</option>'].concat(fs.map((f) => `<option value="${esc(f)}" ${f === selected ? "selected" : ""}>${esc(f)}</option>`)).join("");
}

async function renameDlg(path, title) {
  if (!(await needEditor())) return;
  const ok = await modal("重命名", `<label>新标题</label><input id="nt" value="${esc(title)}">`, async (b) => {
    const t = $("#nt", b).value.trim(); if (!t) throw new Error("标题不能为空");
    await api("POST", "/api/rename", { path, title: t });
  });
  if (ok) { toast("已重命名"); route(); }
}

async function moveDlg(path) {
  if (!(await needEditor())) return;
  const opts = await folderOptions(folderOf(path));
  const res = await modal("移动到文件夹", `<label>目标文件夹</label><select id="mf">${opts}</select>`, async (b) =>
    api("POST", "/api/move", { path, folder: $("#mf", b).value }));
  if (res && res.path) { toast("已移动"); location.hash = "#/a/" + enc(res.path); }
}

async function deleteDlg(path, title) {
  if (!(await needEditor())) return;
  const ok = await modal("删除文章", `<p>确定删除「${esc(title)}」？<br><small>会移到回收站（.trash），可以找回。</small></p>`, async () =>
    api("DELETE", "/api/article?path=" + encodeURIComponent(path)));
  if (ok) { toast("已移到回收站"); location.hash = "#/"; }
}

$("#btnNew").onclick = async () => {
  if (!(await needEditor())) return;
  const opts = await folderOptions(state.curFolder || "");
  const res = await modal("新建文章", `<label>标题</label><input id="nt"><label>文件夹</label><select id="nf">${opts}</select>`, async (b) => {
    const t = $("#nt", b).value.trim(); if (!t) throw new Error("标题不能为空");
    return api("POST", "/api/article", { title: t, folder: $("#nf", b).value });
  });
  if (res && res.path) location.hash = "#/e/" + enc(res.path);
};

$("#btnFolder").onclick = async () => {
  if (!(await needEditor())) return;
  const opts = await folderOptions(state.curFolder || "");
  const res = await modal("新建文件夹", `<label>放在</label><select id="pf">${opts}</select><label>文件夹名</label><input id="fn">`, async (b) => {
    const n = $("#fn", b).value.trim(); if (!n) throw new Error("名字不能为空");
    const parent = $("#pf", b).value;
    return api("POST", "/api/folder", { path: parent ? parent + "/" + n : n });
  });
  if (res && res.path) { toast("已创建"); location.hash = "#/f/" + enc(res.path); route(); }
};

// ---------- edit: preview left, source right ----------
async function editArticle(path) {
  if (!(await needEditor())) { location.hash = "#/a/" + enc(path); return; }
  const a = await api("GET", "/api/article?path=" + encodeURIComponent(path));
  let base = a.meta.updated || "";
  app.innerHTML = `<div class="editor">
    <div class="etool"><span class="name">${esc(a.title)}</span>
      <button class="btn primary" id="eSave">保存 (Ctrl+S)</button>
      <button class="btn" id="eUp">插入图片/视频</button><input id="eFile" type="file" multiple accept="image/*,video/*" class="hidden">
      <button class="btn" id="eMmd">插入流程图</button>
      <button class="btn" id="eBack">退出编辑</button><span class="st" id="eSt">左边预览，右边源码；图片/视频可直接拖进或粘贴到右侧</span></div>
    <div class="plabels"><span>预览</span><span>源码 · Markdown</span></div>
    <div class="panes"><div class="pane preview md" id="ePrev"></div>
      <div class="pane src" id="eSrc"><textarea id="eTxt" spellcheck="false"></textarea></div></div></div>`;
  const ta = $("#eTxt"), prev = $("#ePrev"), st = $("#eSt");
  ta.value = a.content;
  let t;
  const refresh = () => { clearTimeout(t); t = setTimeout(() => renderMd(prev, ta.value, path), 250); };
  refresh();
  ta.addEventListener("input", () => { state.dirty = true; st.textContent = "未保存"; refresh(); });
  ta.addEventListener("scroll", () => {
    const r = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
    prev.scrollTop = r * (prev.scrollHeight - prev.clientHeight);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); insert("  "); }
  });
  const insert = (text) => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, "end"); ta.focus(); ta.dispatchEvent(new Event("input"));
  };
  const save = async () => {
    try {
      st.textContent = "保存中…";
      const r = await api("PUT", "/api/article", { path, content: ta.value, base_updated: base });
      base = r.meta.updated; state.dirty = false; st.textContent = "已保存 " + base.slice(11);
    } catch (e) { st.textContent = "保存失败"; toast(e.message === "need-login" ? "登录已过期，请重新登录" : e.message, 5000); if (e.message === "need-login") login(); }
  };
  const upload = async (files) => {
    for (const f of files) {
      const ph = `![上传中 ${f.name}…]()`; insert(ph);
      try {
        const fd = new FormData(); fd.append("path", path); fd.append("file", f);
        st.textContent = `上传 ${f.name}…`;
        const r = await api("POST", "/api/upload", fd);
        ta.value = ta.value.replace(ph, `![${f.name.replace(/\.[^.]+$/, "")}](${encodeURI(r.name)})`);
        ta.dispatchEvent(new Event("input")); st.textContent = "已上传 " + r.name;
      } catch (e) { ta.value = ta.value.replace(ph, ""); toast("上传失败：" + e.message, 5000); }
    }
  };
  $("#eSave").onclick = save;
  $("#eBack").onclick = () => { location.hash = "#/a/" + enc(path); };
  $("#eUp").onclick = () => $("#eFile").click();
  $("#eFile").onchange = (e) => { upload([...e.target.files]); e.target.value = ""; };
  $("#eMmd").onclick = () => insert("\n```mermaid\nflowchart LR\n    A[开始] --> B{判断}\n    B -->|是| C[处理]\n    B -->|否| D[结束]\n```\n");
  const src = $("#eSrc");
  src.addEventListener("dragover", (e) => { e.preventDefault(); src.classList.add("drag"); });
  src.addEventListener("dragleave", () => src.classList.remove("drag"));
  src.addEventListener("drop", (e) => { e.preventDefault(); src.classList.remove("drag"); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); });
  ta.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); upload(fs); }
  });
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } };
  document.addEventListener("keydown", onKey);
  state.leaveGuard = () => {
    if (state.dirty && !confirm("还有未保存的修改，确定离开？")) { history.replaceState(null, "", "#/e/" + enc(path)); return false; }
    document.removeEventListener("keydown", onKey); return true;
  };
}

// ---------- boot ----------
(async () => {
  try { const me = await api("GET", "/api/me"); state.editor = me.editor; state.mode = me.mode; state.needUser = me.need_user; } catch {}
  renderWho();
  if (state.mode === "all" && !state.editor) login(); else route();
})();
