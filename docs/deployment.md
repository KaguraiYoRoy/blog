# GitHub Pages 部署

生产地址：<https://blog.iyoroy.cn/>。

Astro 的 `site` 使用上述域名，`base` 保持 `/`。自定义域名不使用仓库名 `/blog/` 作为路径前缀。

## 自动构建

推送到 `main` 会触发 `.github/workflows/build.yml`：

1. 使用 Node.js 22 和 `package.json` 中指定的 pnpm 版本安装锁定依赖。
2. 运行 `pnpm check`。
3. 运行 `pnpm build`，生成静态页面和 Pagefind 搜索索引。
4. 上传 `dist/` 并通过 GitHub Pages 发布。

Pull Request 只检查和构建，不发布。也可以在 Actions 页面手动运行工作流。

## 首次配置

仓库：<https://github.com/KaguraiYoRoy/blog>。

1. 在仓库的 **Settings > Pages** 中，将 **Source** 设置为 **GitHub Actions**。
2. 将 **Custom domain** 设置为 `blog.iyoroy.cn`。`public/CNAME` 同步记录该域名。
3. 在 DNS 服务商处，将 `blog` 的 CNAME 指向 `kaguraiyoroy.github.io`，不包含协议或 `/blog/` 路径。删除同名的旧 A、AAAA 或 CNAME 记录，避免冲突。
4. 等待 GitHub 的域名验证与证书签发完成，然后开启 **Enforce HTTPS**。

更换域名时，同时更新 GitHub Pages 设置、DNS、`public/CNAME`、`astro.config.mjs`、RSS 的备用地址和友链资料中的绝对地址。
