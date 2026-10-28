<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" width="96" alt="TestYourSpeed">
  </picture>
</p>

<h1 align="center">TestYourSpeed</h1>

<p align="center">
  基于 WASM 的 LLM 测速工具。无状态，密钥不离开这台电脑。
</p>

<p align="center">
  <a href="https://github.com/Hill-1024/TestYourSpeed">GitHub</a>
</p>

在浏览器里量一次对话补全：响应时间、首 token（TTFT）、输出速度。支持 OpenAI Chat Completions、OpenAI Responses，以及 Anthropic Messages。

React 负责填写和展示。Rust 编成 WebAssembly，只做两件纯计算：拆 SSE 帧，以及把时间戳算成指标。请求由页面直接发给你填的接口，没有自己的后端，构建结果可以挂到 Cloudflare Pages。

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

## 本地网关测速

需要测 `127.0.0.1`、`localhost` 等本地网关时，请 clone 本项目并在同一台电脑上运行：

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

打开终端里显示的本地地址（默认 `http://127.0.0.1:5173`）。开发服务器会把请求转发到你填写的本地网关，因此网关不需要额外配置 CORS。

线上页面直连本地网关会受到浏览器的 CORS、混合内容和 Private Network Access 限制；WASM 无法绕过这些限制。不要把线上失败理解为 WASM 没有访问到本机。

`npm run build` 的产物在 `web/dist/`。

## 测试

```bash
npm test
```

会先编译 WASM，再跑内核的 C ABI 冒烟测试和前端的单元测试。也可以分开跑：`cargo test --manifest-path kernel/Cargo.toml`、`node scripts/smoke.mjs`、`npm test --prefix web`。

## Cloudflare Pages

构建命令（默认构建镜像没有 Rust，先装一个最小工具链）：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown
. "$HOME/.cargo/env"
npm run build
```

输出目录填 `web/dist`。

地址栏不会因切换协议而改写。发请求时，路径若已以 `/chat/completions`、`/responses` 或 `/messages` 结尾，就原样请求；否则按当前协议追加对应路径。

接口必须允许这个页面所在源的跨域 `POST`。密钥只放在当次请求头里，不写入存储。
