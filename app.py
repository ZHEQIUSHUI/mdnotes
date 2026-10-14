"""mdnotes: a tiny markdown article site.

AUTH_MODE: none = no login at all; edit = reading is public, editing needs login (default when a
password is set); all = everything needs login. AUTH_USER is optional; when set, login asks for it too.
"""
import hashlib
import hmac
import mimetypes
import os
import re
import secrets
import shutil
import time
from datetime import datetime
from pathlib import Path

from fastapi import Body, Cookie, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

DATA = Path(os.environ.get("DATA_DIR", "/data")).resolve()
PASSWORD = os.environ.get("AUTH_PASSWORD") or os.environ.get("EDIT_PASSWORD", "")
USER = os.environ.get("AUTH_USER", "")
MODE = os.environ.get("AUTH_MODE", "edit" if PASSWORD else "none").strip().lower()
if MODE not in ("none", "edit", "all"):
    raise SystemExit(f"AUTH_MODE must be none / edit / all, got {MODE!r}")
if MODE != "none" and not PASSWORD:
    raise SystemExit(f"AUTH_MODE={MODE} needs AUTH_PASSWORD")
SECRET = os.environ.get("SESSION_SECRET") or hashlib.sha256(("mdnotes" + PASSWORD).encode()).hexdigest()
STATIC = Path(__file__).parent / "static"
HIDDEN = {".trash", ".history"}
FM_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)
TS = "%Y-%m-%d %H:%M:%S"

app = FastAPI(docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ---------- helpers ----------

def safe(rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/")
    p = (DATA / rel).resolve()
    if p != DATA and DATA not in p.parents:
        raise HTTPException(400, "bad path")
    if any(part in HIDDEN or part.startswith(".") for part in p.relative_to(DATA).parts):
        raise HTTPException(400, "bad path")
    return p


def now() -> str:
    return datetime.now().strftime(TS)


def parse(text: str):
    meta, body = {}, text
    m = FM_RE.match(text)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"')
        body = text[m.end():]
    return meta, body


def dump(meta: dict, body: str) -> str:
    head = "\n".join(f"{k}: {v}" for k, v in meta.items())
    return f"---\n{head}\n---\n\n{body.lstrip(chr(10))}"


def title_of(meta, body, path: Path) -> str:
    if meta.get("title"):
        return meta["title"]
    m = re.search(r"^#\s+(.+)$", body, re.M)
    if m:
        return m.group(1).strip()
    return path.parent.name if path.name == "index.md" else path.stem


def ensure_meta(path: Path):
    """Add created/updated front matter to files dropped in without it."""
    text = path.read_text(encoding="utf-8", errors="replace")
    meta, body = parse(text)
    if "created" in meta and "updated" in meta:
        return meta, body
    st = path.stat()
    ctime = getattr(st, "st_birthtime", None) or min(st.st_mtime, st.st_ctime)
    meta.setdefault("created", datetime.fromtimestamp(ctime).strftime(TS))
    meta.setdefault("updated", datetime.fromtimestamp(st.st_mtime).strftime(TS))
    path.write_text(dump(meta, body), encoding="utf-8")
    return meta, body


def category_of(rel: Path) -> str:
    """Folder an article belongs to. An article that owns a dir (dir/index.md) sits in the dir's parent."""
    parent = rel.parent.parent if rel.name == "index.md" and rel.parent != Path(".") else rel.parent
    s = parent.as_posix()
    return "" if s == "." else s


def is_article_dir(d: Path) -> bool:
    return (d / "index.md").is_file()


def folders():
    out = []
    for d in DATA.rglob("*"):
        if not d.is_dir():
            continue
        rel = d.relative_to(DATA)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if is_article_dir(d) or any(is_article_dir(a) for a in d.parents if a != DATA and DATA in a.parents):
            continue  # article dirs and their asset subdirs are not categories
        out.append(rel.as_posix())
    return sorted(out)


def articles():
    out = []
    for p in DATA.rglob("*.md"):
        rel = p.relative_to(DATA)
        if any(part.startswith(".") for part in rel.parts):
            continue
        try:
            meta, body = ensure_meta(p)
        except OSError:
            continue
        out.append({
            "path": rel.as_posix(),
            "folder": category_of(rel),
            "title": title_of(meta, body, p),
            "created": meta.get("created", ""),
            "updated": meta.get("updated", ""),
            "size": len(body),
        })
    out.sort(key=lambda a: a["updated"], reverse=True)
    return out


def sign(v: str) -> str:
    return hmac.new(SECRET.encode(), v.encode(), hashlib.sha256).hexdigest()


def require_auth(token):
    if MODE == "none":
        return
    if not token or "." not in token:
        raise HTTPException(401, "need password")
    exp, sig = token.split(".", 1)
    if not hmac.compare_digest(sig, sign(exp)) or int(exp) < time.time():
        raise HTTPException(401, "need password")


def backup(path: Path):
    if path.exists():
        rel = path.relative_to(DATA)
        dst = DATA / ".history" / rel.parent / f"{rel.name}.{datetime.now():%Y%m%d-%H%M%S}"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dst)


def slugify(title: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|#%\s]+", "-", title.strip()).strip("-.")
    return s[:80] or f"article-{int(time.time())}"


# ---------- auth ----------

@app.middleware("http")
async def guard_all(request: Request, call_next):
    """AUTH_MODE=all: data and files need login too; the page shell stays public so it can show the login box."""
    path = request.url.path
    if MODE == "all" and (path.startswith("/files/") or path.startswith("/api/")) and path not in ("/api/login", "/api/me"):
        try:
            require_auth(request.cookies.get("mdn"))
        except HTTPException:
            return JSONResponse({"detail": "need login"}, status_code=401)
    resp = await call_next(request)
    # Always revalidate (cheap 304 via ETag) so a redeploy never mixes old cached css/js with new html;
    # pinned third-party libs under /vendor/ can be cached for a week.
    resp.headers.setdefault("Cache-Control", "public, max-age=604800" if path.startswith("/vendor/") else "no-cache")
    return resp


@app.post("/api/login")
def login(password: str = Body(...), user: str = Body("")):
    ok_user = not USER or hmac.compare_digest(user.strip(), USER)
    if MODE == "none" or not (hmac.compare_digest(password, PASSWORD) & ok_user):
        raise HTTPException(400, "账号或口令不对" if USER else "口令不对")
    exp = str(int(time.time()) + 30 * 86400)
    r = JSONResponse({"ok": True})
    r.set_cookie("mdn", f"{exp}.{sign(exp)}", max_age=30 * 86400, httponly=True, samesite="lax")
    return r


@app.get("/api/me")
def me(mdn: str | None = Cookie(None)):
    try:
        require_auth(mdn)
        editor = True
    except HTTPException:
        editor = False
    return {"editor": editor, "mode": MODE, "need_user": bool(USER)}


# ---------- articles ----------

@app.get("/api/articles")
def list_articles(q: str = ""):
    items = articles()
    q = q.strip().lower()
    if q:
        hits = []
        for a in items:
            if q in a["title"].lower() or q in a["path"].lower():
                hits.append(a)
                continue
            body = (DATA / a["path"]).read_text(encoding="utf-8", errors="replace").lower()
            i = body.find(q)
            if i >= 0:
                hits.append({**a, "snippet": body[max(0, i - 40): i + 80].replace("\n", " ")})
        items = hits
    return items


@app.get("/api/folders")
def list_folders():
    return folders()


@app.post("/api/folder")
def create_folder(path: str = Body(..., embed=True), mdn: str | None = Cookie(None)):
    require_auth(mdn)
    parts = [slugify(x) for x in path.replace("\\", "/").split("/") if x.strip()]
    if not parts:
        raise HTTPException(400, "empty name")
    d = safe("/".join(parts))
    d.mkdir(parents=True, exist_ok=True)
    return {"path": d.relative_to(DATA).as_posix()}


@app.post("/api/move")
def move_article(path: str = Body(...), folder: str = Body(""), mdn: str | None = Cookie(None)):
    """Move an article (with its own dir and assets, if it has one) into another folder."""
    require_auth(mdn)
    p = safe(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    dest = safe(folder) if folder.strip() else DATA
    if not dest.is_dir():
        raise HTTPException(400, "folder not found")
    src = p.parent if p.name == "index.md" and p.parent != DATA else p
    if src.parent == dest:
        return {"path": path}
    if src.is_dir() and (dest == src or src in dest.parents):
        raise HTTPException(400, "cannot move into itself")
    target = dest / src.name
    if target.exists():
        raise HTTPException(409, "目标文件夹里已有同名文章")
    shutil.move(str(src), str(target))
    newp = target / "index.md" if src.is_dir() else target
    return {"path": newp.relative_to(DATA).as_posix()}


@app.delete("/api/folder")
def delete_folder(path: str, mdn: str | None = Cookie(None)):
    require_auth(mdn)
    d = safe(path)
    if d == DATA or not d.is_dir():
        raise HTTPException(404, "not found")
    if any(d.iterdir()):
        raise HTTPException(409, "文件夹不为空")
    d.rmdir()
    return {"ok": True}


@app.get("/api/article")
def get_article(path: str):
    p = safe(path)
    if not p.is_file() or p.suffix != ".md":
        raise HTTPException(404, "not found")
    meta, body = ensure_meta(p)
    return {"path": path, "title": title_of(meta, body, p), "meta": meta, "content": body}


@app.put("/api/article")
def save_article(path: str = Body(...), content: str = Body(...), base_updated: str = Body(""),
                 mdn: str | None = Cookie(None)):
    require_auth(mdn)
    p = safe(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    meta, _ = parse(p.read_text(encoding="utf-8", errors="replace"))
    if base_updated and meta.get("updated") and meta["updated"] != base_updated:
        raise HTTPException(409, f"文章在 {meta['updated']} 被别人改过，请先复制你的内容再刷新")
    backup(p)
    meta.setdefault("created", now())
    meta["updated"] = now()
    p.write_text(dump(meta, content), encoding="utf-8")
    return {"ok": True, "meta": meta}


@app.post("/api/article")
def create_article(title: str = Body(...), folder: str = Body(""), mdn: str | None = Cookie(None)):
    require_auth(mdn)
    base = safe(folder) if folder.strip() else DATA
    d = base / slugify(title)
    if d.exists():
        d = base / f"{slugify(title)}-{int(time.time())}"
    d.mkdir(parents=True)
    p = d / "index.md"
    t = now()
    p.write_text(dump({"created": t, "updated": t}, f"# {title.strip()}\n\n"), encoding="utf-8")
    return {"path": p.relative_to(DATA).as_posix()}


@app.post("/api/rename")
def rename_article(path: str = Body(...), title: str = Body(...), mdn: str | None = Cookie(None)):
    """Change the article title (front matter + first H1); file location stays stable."""
    require_auth(mdn)
    p = safe(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    backup(p)
    meta, body = parse(p.read_text(encoding="utf-8", errors="replace"))
    meta["title"] = title.strip()
    meta["updated"] = now()
    body = re.sub(r"^#\s+.+$", f"# {title.strip()}", body, count=1, flags=re.M)
    p.write_text(dump(meta, body), encoding="utf-8")
    return {"ok": True}


@app.delete("/api/article")
def delete_article(path: str, mdn: str | None = Cookie(None)):
    """Move to .trash. An article that owns its folder (index.md) takes the folder along."""
    require_auth(mdn)
    p = safe(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    target = p.parent if p.name == "index.md" and p.parent != DATA else p
    rel = target.relative_to(DATA)
    dst = DATA / ".trash" / f"{datetime.now():%Y%m%d-%H%M%S}" / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(dst))
    return {"ok": True, "trash": dst.relative_to(DATA).as_posix()}


@app.post("/api/upload")
async def upload(path: str = Form(...), file: UploadFile = File(...), mdn: str | None = Cookie(None)):
    """Save into the article's folder; returns the name to reference relatively."""
    require_auth(mdn)
    art = safe(path)
    folder = art.parent
    name = re.sub(r"[\\/:*?\"<>|#%\s]+", "_", Path(file.filename or "file").name) or "file"
    if name in ("", ".") or name.startswith("."):
        name = "file" + name
    dst = folder / name
    if dst.exists():
        dst = folder / f"{dst.stem}-{secrets.token_hex(3)}{dst.suffix}"
    with dst.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    return {"name": dst.name}


# ---------- files (with Range for video seeking) ----------

@app.get("/files/{rel:path}")
def files(rel: str, request: Request):
    p = safe(rel)
    if not p.is_file():
        raise HTTPException(404, "not found")
    size = p.stat().st_size
    ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(p, media_type=ctype, headers={"Accept-Ranges": "bytes"})
    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    if not m:
        raise HTTPException(416)
    start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2) or 0))
    end = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
    end = min(end, size - 1)
    if start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    def stream():
        with p.open("rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk

    return StreamingResponse(stream(), status_code=206, media_type=ctype, headers={
        "Accept-Ranges": "bytes", "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(end - start + 1)})


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
