# 博客部署

生产地址：<https://blog.iyoroy.cn/>。

Astro 的 `site` 使用上述域名，`base` 保持 `/`。自定义域名不使用仓库名 `/blog/` 作为路径前缀。

## 自动构建

推送到 `main` 会触发 `.github/workflows/build.yml`：

1. 使用 Node.js 22 和 `package.json` 中指定的 pnpm 版本安装锁定依赖。
2. 运行 `node --test scripts/deploy-cn.test.mjs` 检查部署脚本。
3. 运行 `pnpm check`。
4. 运行 `pnpm build`，生成静态页面和 Pagefind 搜索索引。
5. 将 `dist/` 打包为 `github-pages` 构建产物。
6. 并行发布 GitHub Pages，并通过 SSH 将同一份产物部署到境内服务器。

Pull Request 只检查和构建，不发布。也可以在 Actions 页面手动运行工作流。

## GitHub Pages 配置

仓库：<https://github.com/KaguraiYoRoy/blog>。

1. 在仓库的 **Settings > Pages** 中，将 **Source** 设置为 **GitHub Actions**。
2. 将 **Custom domain** 设置为 `blog.iyoroy.cn`。`public/CNAME` 同步记录该域名。
3. 在 DNS 服务商处，将境外线路的 `blog` CNAME 指向 `kaguraiyoroy.github.io`，不包含协议或 `/blog/` 路径；境内线路指向境内服务器。同一线路不要同时保留冲突的旧记录。不使用线路解析时，所有流量也可以直接指向境内服务器。
4. 等待 GitHub 的域名验证与证书签发完成，然后开启 **Enforce HTTPS**。

更换域名时，同时更新 GitHub Pages 设置、DNS、`public/CNAME`、`astro.config.mjs`、RSS 的备用地址和友链资料中的绝对地址。

### Typecho 旧地址

构建时通过 Astro 原生跳转生成 80 个兼容页面，部署到 GitHub Pages 后即可自动跳转：

| 旧地址 | 新地址 |
| --- | --- |
| `/archives/<cid>/` | `/posts/<cid>/` |
| `/en/archives/<cid>/` | `/posts/en-<cid>/` |
| `/about.html`、`/friends.html`、`/privacy.html`、`/dn42.html` | `/about/`、`/friends/`、`/privacy/`、`/dn42/` |
| `/en/about.html`、`/en/friends.html`、`/en/privacy.html`、`/en/dn42.html` | `/en/about/`、`/en/friends/`、`/en/privacy/`、`/en/dn42/` |

旧文章 ID 和独立页面映射集中在 `src/constants/typecho-redirects.ts`。文章通过 `astro.config.mjs` 的 `redirects` 生成目录入口，独立页面通过 `src/pages/[...legacy].html.ts` 生成真正的 `.html` 文件。新写的 Astro 文章无需增加旧地址。

GitHub Pages 提供的是包含即时 `meta refresh`、`noindex` 和新地址 `canonical` 的 HTML，实际 HTTP 状态码为 200，不是服务器级 301。境内可以继续使用 Nginx 的 301 规则；两端使用同一份构建产物。域名跳转仍需在接收旧域名（例如 `www.iyoroy.cn`）的服务器或代理上配置。

## 境内自动部署

在仓库的 **Settings > Environments > github-pages > Environment secrets** 中配置。境内部署任务已声明使用 `github-pages` 环境；也可以使用同名 Repository secrets：

| Secret | 内容 |
| --- | --- |
| `DEPLOY_CN_HOST` | 境内服务器的 IP 或域名，不带协议、用户名、端口或路径。建议使用独立的部署地址，不使用有线路解析的博客域名。 |
| `DEPLOY_CN_PORT` | SSH 端口。未设置时使用 `22`。 |
| `DEPLOY_CN_USER` | SSH 部署用户。 |
| `DEPLOY_CN_SSH_KEY` | 部署专用 SSH 私钥的完整内容，包括首尾标记；私钥不能设置口令。 |
| `DEPLOY_CN_KNOWN_HOSTS` | 服务器的 SSH 主机公钥记录，使用 `known_hosts` 格式；这是服务器身份公钥，不是部署用户公钥。 |
| `DEPLOY_CN_PATH` | 部署根目录的绝对路径，例如 `/var/www/blog`，不能填写文件系统根目录 `/`。 |
| `DEPLOY_CN_LINK_NAME` | 可选，Web 服务入口的目录名，默认 `current`。例如 `www` 对应 `/var/www/blog/www`。不能包含 `/`，也不能使用脚本保留的 `incoming`、`releases` 名称。 |

所有连接信息均通过 Secrets 注入，不写入仓库。工作流启用严格的 SSH 主机校验。可在可信机器上用 `ssh-keyscan -p <端口> <主机>` 获取主机公钥，并通过服务器控制台核对指纹，再将记录放入 `DEPLOY_CN_KNOWN_HOSTS`。非标准端口的记录通常以 `[主机]:端口` 开头。

### 服务器准备

服务器需要 Linux、Bash、GNU tar、coreutils 和 `flock`，以及可从 GitHub Actions 连接的 SSH 服务。不需要 Node.js、pnpm 或访问 GitHub。Ubuntu/Debian 常规安装通常已包含上述命令。

1. 创建部署专用 SSH 密钥，将公钥加入部署用户的 `~/.ssh/authorized_keys`，将私钥保存到 `DEPLOY_CN_SSH_KEY`。当前脚本通过 SSH 传输压缩包并执行 Bash 命令，不使用 SCP 或 SFTP，因此部署用户需要 `/bin/bash` 等有效 Shell，不能设置为 `nologin` 或强制 `internal-sftp`。建议使用独立、无 sudo 权限的部署用户，仅允许密钥认证。在这条部署公钥前加 `restrict` 可以禁用 PTY、端口转发、代理转发等能力，同时允许执行部署命令：

   ```text
   restrict ssh-ed25519 <部署公钥内容> github-actions-deploy
   ```

   `restrict` 不限制可执行的命令或文件访问范围；文件权限仍需由部署用户的权限控制。
2. 创建部署根目录并允许部署用户写入。以下示例中的 `deploy` 需要替换为实际用户：

   ```sh
   sudo install -d -m 0755 -o deploy -g deploy /var/www/blog
   ```

3. Nginx/OpenResty/Caddy 的站点根目录指向 `DEPLOY_CN_PATH/DEPLOY_CN_LINK_NAME`，默认示例为 `/var/www/blog/current`，设置 `DEPLOY_CN_LINK_NAME=www` 则为 `/var/www/blog/www`。配置 `index.html` 为默认首页。父目录必须允许 Web 服务用户进入，服务器配置也需要允许读取该软链接。该入口由部署脚本管理，必须是不存在的路径或软链接，不能直接使用已有的实体站点目录。
4. 为境内站点配置 `blog.iyoroy.cn` 的 HTTPS 证书。使用线路解析时，两端都需要有效证书。
5. 配置好 Secrets 后，推送到 `main`，或在 Actions 中选择 `main` 手动运行 **Build and Deploy Blog**。

### 更新和回滚

境内部署任务下载本次构建的 `artifact.tar`，经 SSH 上传到 `incoming/`。服务器验证 SHA-256、解压并检查首页、Astro 资源和 Pagefind 索引，再原子切换 Web 服务入口软链接（默认 `current`）。版本名包含提交号、工作流运行 ID 和重试次数，因此重复运行不会覆盖旧版本。

```text
/var/www/blog/
├── incoming/
├── releases/
│   ├── <提交号>-<运行ID>-<重试次数>/
│   └── ...
└── current -> releases/<当前版本>/
```

上传或校验失败时不会切换 `current`，旧站点继续服务。GitHub Pages 与境内部署分别报告结果；境内部署失败不会阻止 Pages 发布。缺少必填 Secret 时，境内部署任务会明确失败。

旧版本保留用于回滚，不自动清理。回滚时，在部署根目录执行以下命令，将 `<旧版本>` 替换为 `releases/` 中实际存在的目录名；如果设置了自定义入口名，也将 `current` 替换为该名称，并避开正在进行的自动部署：

```sh
ln -s releases/<旧版本> .rollback-current
mv -Tf .rollback-current current
```

可以定期清理不再需要的旧版本和上传中断后留在 `incoming/` 的文件；不要删除 Web 服务入口软链接指向的版本。更换入口名后，旧入口软链接会保留，确认 Web 服务配置已切换后再手动移除。
