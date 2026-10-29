<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" width="96" alt="TestYourSpeed">
  </picture>
</p>

<h1 align="center">TestYourSpeed</h1>

<p align="center">
  基于 WASM 的 LLM 测速工具。无状态，密钥默认不离开这台电脑。
</p>

<p align="center">
  <a href="https://github.com/Hill-1024/TestYourSpeed">GitHub</a>
</p>

在浏览器里量一次对话补全：响应时间、首 token（TTFT）、输出速度。支持 OpenAI Chat Completions、OpenAI Responses，以及 Anthropic Messages。

React 负责填写和展示。Rust 编成 WebAssembly，只做两件纯计算：拆 SSE 帧，以及把时间戳算成指标。请求默认由页面直接发给你填的接口，没有自己的后端；接口不支持 CORS 时，可以选用仓库自带的 Worker 中继。

## 指标

| 数字 | 含义 |
| --- | --- |
| 首 token | 发出请求到第一段正文 |
| 响应时间 | 发出请求到流结束 |
| 输出速度 | 首 token 之后的 completion token / 秒 |
| token 间隔 | 相邻输出 token 的平均间隔 |
| 整段速度 | 全部输出 token / 整段响应时间 |

有 `usage` 时用接口给的 completion token。没有时按文本估算，并在结果里标明。输出被 `length` 截断时也会标明。多次测量时，时间取中位数，速度取平均，token 数取平均。

## 导出

结果可以复制成 JSON、下载 CSV，或生成 1200×630 的 PNG 卡片：点「导出图片」先弹出预览，再选择保存或关闭。卡片由 WASM 内核排版成 SVG，再交给这台机器的浏览器画布栅格化，全程不上传任何数据。

如果接口拒绝了 `max_tokens` 或 `temperature`（新版 OpenAI 推理模型常见），页面会自动换用 `max_completion_tokens` 或省去 `temperature` 重试一次，并在结果下面注明改了什么。

## 本地测速（含没有 CORS 的接口）

需要测 `127.0.0.1`、`localhost` 等本地网关，或接口不允许浏览器跨域时，请 clone 本项目并在同一台电脑上运行：

```bash
git clone https://github.com/Hill-1024/TestYourSpeed.git
cd TestYourSpeed
```

安装 [Rust](https://rustup.rs/) 和 Node.js 20+，然后：

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run dev
```

打开终端里显示的本地地址（默认 `http://127.0.0.1:5173`）。开发服务器会把每个请求经你的电脑转发出去，所以本地网关不必配置 CORS，没有实现 CORS 预检的公网接口也能测。

线上页面默认直连：接口必须允许页面所在源的跨域 `POST`，包括正确响应 `OPTIONS` 预检并放行 `authorization`、`content-type` 等请求头。缺少任何一项时浏览器会直接报 `Failed to fetch`，WASM 绕不过去；页面的「检查接口连通性」可以区分是网络不可达还是 CORS 被拒。

`npm run build` 的产物在 `web/dist/`。

## 中继（接口不支持 CORS 时）

线上页面可以勾选「通过非持久化 worker 中转请求以绕过 CORS 限制」。请求会发到本站的 `/api/relay`，由 `worker/relay.js` 转发一次，响应原样流式返回：

- 无状态：不写日志、不落盘、不排队，响应结束即结束；
- 密钥会随请求经过 Cloudflare，这一点和直连不同，所以默认关闭；
- 只接受同源页面发来的 `POST`，拒绝 `localhost`、局域网、链路本地和云元数据地址，避免被当成内网探测器；
- 只转发 `GET` / `POST` / `HEAD`，请求体上限 64 KB。

本地 `npm run dev` 走的是 Vite 转发，不需要勾选。

## 测试

```bash
npm test
```

会先编译 WASM，再跑内核的 C ABI 冒烟测试、中继的地址过滤测试和前端的单元测试。也可以分开跑：`cargo test --manifest-path kernel/Cargo.toml`、`node scripts/smoke.mjs`、`node scripts/relay-smoke.mjs`、`npm test --prefix web`。

## 部署

`wrangler.jsonc` 把 `worker/relay.js` 当作 Worker，`web/dist` 当作静态资源，`npm run deploy` 会两者一起发布。仓库连到 Cloudflare 后每次推送都会重新构建，默认构建镜像没有 Rust，先装一个最小工具链：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown
. "$HOME/.cargo/env"
npm run build
```

发布命令 `npx wrangler deploy`。如果只部署成纯静态 Pages（没有 Worker），页面照常可用，但 `/api/relay` 不存在，中继开关会报错。

地址栏不会因切换协议而改写。发请求时，路径若已以 `/chat/completions`、`/responses` 或 `/messages` 结尾，就原样请求；否则按当前协议追加对应路径。

接口必须允许这个页面所在源的跨域 `POST`。密钥只放在当次请求头里，不写入存储。
