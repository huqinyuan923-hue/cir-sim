# 部署说明

## 生产环境：Cloudflare Pages

- 项目名：`cir-sim`
- 域名：https://cir.adcakeyuan.top
- 形态：纯静态（`dist/index.html` + `dist/app.js`）

```bash
npm run build
npx wrangler pages deploy dist --project-name cir-sim --branch main
```

要求：本机已 `npx wrangler login`（或设置 `CLOUDFLARE_API_TOKEN`）。

## GitHub Pages（已停用）

仓库里保留了 `gh-pages` 分支作为静态快照，但它**不是**生产来源：
自定义域已解除，站点早先的 HTTPS 证书始终未签发，已整体迁到 Cloudflare Pages。
不要往 `gh-pages` 发布新版本。

## 测试与验收

```bash
npm test          # 正确性测试
npm run typecheck
```

可选：程序级差分（俄罗斯方块与 nand-computer 官方行为核逐字节对拍，约 40 秒）

```bash
npm run test:long
```

行为核默认读 `C:/works/nand-computer/software/demo/engine.js`，换机器用 `HACKCORE_PATH` 覆盖。