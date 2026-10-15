聊天 Markdown 离线依赖：

- marked 17.0.5：来自 Codex 内置 Node 依赖的 `lib/marked.umd.js`。MIT，许可证见 Marked-LICENSE.md。
- DOMPurify 3.4.16：来自 `https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js`。许可证见 DOMPurify-LICENSE.txt。

脚本和许可证随 APK 打包，运行时不依赖 CDN。升级时须验证聊天 HTML 清理和手机排版回归测试。
