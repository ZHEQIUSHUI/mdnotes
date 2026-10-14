# mdnotes

极简 Markdown 文章站：打开就是文章列表。支持文件夹、mermaid 流程图、图片、视频（可拖动进度）、编辑时左预览右源码、拖拽/粘贴上传、创建/最后修改日期、历史版本（`.history/`）与回收站（`.trash/`）。是否需要登录可在启动容器时选择。

文章就是数据目录下的 `.md` 文件；推荐一篇一个文件夹（`index.md` + 图片视频）。日期写在文件头 front matter（`created` / `updated`），没有的文件首次被扫描时自动补上。

## 运行

```bash
docker run -d --name mdnotes --restart unless-stopped -p 25002:8000 \
  -v /path/to/notes:/data --user $(id -u):$(id -g) \
  -v /etc/localtime:/etc/localtime:ro -e TZ=Asia/Shanghai \
  -e AUTH_MODE=edit -e AUTH_PASSWORD=xxxx \
  ghcr.io/<owner>/mdnotes:latest
```

## 登录配置（环境变量）

| 变量 | 说明 |
|---|---|
| `AUTH_MODE` | `none`：完全不用登录，任何人可看可改<br>`edit`：阅读免登录，修改要登录（设了密码时的默认值）<br>`all`：看和改都要先登录 |
| `AUTH_PASSWORD` | 密码 / 口令。`AUTH_MODE` 为 `edit`、`all` 时必填。旧名 `EDIT_PASSWORD` 仍可用 |
| `AUTH_USER` | 可选。设置后登录时需同时输入账号 |
| `SESSION_SECRET` | 可选。登录 cookie 的签名密钥，重建容器时保持不变，已登录的浏览器就不用重新登录（有效期 30 天） |

不设任何变量等同于 `AUTH_MODE=none`。

## 构建

```bash
docker build -t mdnotes .
# 国内网络
docker build --build-arg PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple -t mdnotes .
```

推送到 `main` 或打 `v*` tag 时，GitHub Actions（`.github/workflows/docker.yml`）会先跑冒烟测试，再构建 amd64 + arm64 镜像并推送到 `ghcr.io/<owner>/<repo>`：`main` 打 `latest`，`v1.2.3` 打 `1.2.3` 和 `1.2`，每次还会打一个短 sha 标签。PR 只构建，不推送。
