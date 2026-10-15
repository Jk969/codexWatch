# CodexWatch 安卓原生壳 — 构建说明

零 Gradle、零 Android Studio 的手工构建。所有工具链来自仓库 `.tools/`,脚本一键完成。

## 一键构建

在 **Git Bash** 中(任意目录):

```bash
bash app/build-apk.sh
```

产物:**`D:\dev\gpt\codexWatch\dist\codexwatch.apk`**

`adb install -r dist/codexwatch.apk` 即可安装。

## 工具链(已就位,脚本自动取用)

| 路径 | 内容 |
|---|---|
| `.tools/jdk` | Microsoft OpenJDK 17(msjdk17.zip 解压) |
| `.tools/bt34` | Android build-tools 34(aapt2 / zipalign / lib/d8.jar / lib/apksigner.jar) |
| `.tools/android-34/android.jar` | platform-34(android-14 子目录整理而来) |
| `.tools/Java-WebSocket-1.5.7.jar` | WebSocket 客户端库(dex 时一并打入) |
| `.tools/slf4j-api-2.0.6.jar` / `.tools/slf4j-nop-2.0.6.jar` | WebSocket 必需的日志 API 和静默实现；class 与 ServiceLoader 注册资源均打入 APK |
| `.tools/cw.keystore` | 自签名密钥库(首次构建自动生成) |

外部依赖: **node**(生成图标、检查 DEX 类定义)与 **unzip**(检查 APK 条目)。SLF4J 2.0.6 与 WebSocket 内嵌 POM 的依赖版本一致，可从 Maven Central 的 `org/slf4j/slf4j-api/2.0.6/` 和 `org/slf4j/slf4j-nop/2.0.6/` 下载到 `.tools/`。

1.0.1 修复原生通道无法连接：旧构建缺少 SLF4J，创建客户端时抛出 `NoClassDefFoundError: org/slf4j/LoggerFactory`，异常被吞掉导致只显示未连接。构建现在验证客户端创建及 DEX 实际类定义，并保留 SLF4J provider 注册资源。执行 `node app/test/ws-smoke.js` 可验证同一套 Java 依赖的本地握手及消息往返；手机后台保活仍需真机验证。

## 签名信息

- keystore:`.tools/cw.keystore`
- alias:`cw`
- storepass / keypass:`codexwatch2024`
- 有效期 10950 天,RSA 2048,自签名
- 指纹查看:`.tools/jdk/bin/keytool.exe -list -v -keystore .tools/cw.keystore -alias cw -storepass codexwatch2024`

> 换正式签名:替换 `.tools/cw.keystore` 或修改 `build-apk.sh` 顶部 `KEYSTORE/KS_ALIAS/KS_PASS` 变量。

## 构建流水线(脚本内部步骤)

1. `node make-icons.js` — 纯 Node(zlib + 手写 PNG 编码器)生成 5 密度 mipmap 图标(48/72/96/144/192),4x 超采样抗锯齿;
2. `aapt2 compile --dir res` → `res.zip`;
3. `aapt2 link --manifest AndroidManifest.xml -I android.jar --java gen` → `base.apk`(manifest 二进制、resources.arsc、mipmap 图标)+ `gen/**/R.java`;
4. `javac -source 8 -target 8`(JDK17,classpath = android.jar + Java-WebSocket jar);
5. `java -cp .tools/bt34/lib/d8.jar com.android.tools.r8.D8 --release --lib android.jar --min-api 24`(业务 class + Java-WebSocket jar 一起 dex 成单 classes.dex);
6. `jar uf` 塞入 `classes.dex` 与 `src/assets/`(assets 单独走 jar,规避 Windows aapt2 `-A` 的反斜杠条目 bug)→ `zipalign -f -p 4` → `java -cp .../apksigner.jar ...ApkSignerTool sign`(v2+v3 签名);
7. `aapt2 dump badging` + `apksigner verify --print-certs` 终检。

中间产物在 `app/build/`(可随时删除)。

## 应用基本信息

- 包名 `top.jingxixi.codexwatch`,versionName `1.3.5`(versionCode 22),minSdk 24 / targetSdk 33
- 入口 `MainActivity`:全屏 WebView 加载 `file:///android_asset/www/index.html`
- 前台服务 `GatewayService`(dataSync):wss 长连接 + 指数退避重连(前台 2s→60s，后台 30s→300s)+ 消息/状态回调 + 任务完成本地通知；不持有 CPU 唤醒锁
- `BootReceiver`:开机自启服务

## JS 桥(window.CWApp)

| 方法 | 说明 |
|---|---|
| `getVersion()` | 返回 `"1.3.5"` |
| `getConfig()` / `setConfig(json)` | SharedPreferences(`cw_config/cfg`)读写;缺省 `{"endpoint":"wss://pcphone.jingxixi.top/ws","token":""}`;setConfig 解析失败忽略,字段合并保存 |
| `send(json)` | 未连接先入队(上限 100)并确保服务已启动,连接后依序发出 |
| `isConnected()` | 当前 socket 状态 |
| `requestConnect()` / `disconnect()` | 立即连接 / 用户登出断开 |
| `notifyLocal(title, body, chatId)` | 发 `task_done` 渠道本地通知,nid 缺省按 hash(chatId) |
| `exitApp()` | finish |

页面回调挂点:

```js
window.__cwonmessage = (msg) => {}      // 服务端消息(原样 JSON)
window.__cwstatus   = (s) => {}         // {"connected":true,"ts":169...}
window.__cwdeeplink = (chatId) => {}   // 通知点击跳转
```

WebView 未 attach 时消息进入服务内环形缓冲(200 条),`onResume` 自动排空重放。

1.3.5 耗电修复：移除常驻唤醒锁及 WAKE_LOCK 权限，后台暂停 WebView 的 JS 计时器和渲染。APK 不再发送网页层的 30 秒心跳，原生心跳为 180 秒；连接参数 `power=balanced` 让中继按 120 秒发送心跳，旧客户端与电脑仍为 25 秒。恢复前台立即重试断线连接并补拉设备/任务快照。通知仍在原生服务处理，Android 深度休眠或后台网络限制可能延迟送达；不以常驻唤醒锁强行阻止休眠。实际耗电与锁屏通知需真机验证。

## 替换正式 Web UI

把你的前端产物放到 `app/src/assets/www/`(入口保持 `index.html`),重新跑 `build-apk.sh` 即可——`aapt2 link -A` 会把整个目录打进 APK 的 `assets/`。

## 已知坑(踩过并已规避)

1. `bt34/d8.bat` / `apksigner.bat` 会捡系统 PATH 里的旧 Java(1.8)报 `UnsupportedClassVersionError` —— 脚本一律用 `.tools/jdk/bin/java -cp lib/d8.jar com.android.tools.r8.D8` 直调;
2. d8 的 `--output` 目录必须**预先存在**,否则报 `Invalid output`;
3. Git Bash 无 `zip` 命令 —— 用 JDK 的 `jar uf` 塞 `classes.dex`(已验证保留 resources.arsc 的 Stored 未压缩状态,满足 targetSdk 30+ 安装要求);
4. javac 的 classpath 在 Windows JVM 下必须用 `;` 分隔,且用相对路径(绝对 POSIX 路径 `/d/...` 不会被 Windows 原生工具识别,MSYS 只自动转换单路径参数);
5. javac `-source/-target 8` 的 deprecation 警告属预期,可忽略;
6. **Windows 版 aapt2 `link -A` 会把 assets 条目名写成反斜杠**(`assets\www\index.html`),AssetManager/WebView 按 `/` 寻址必然 404 —— 因此 assets 改用 `jar uf` 从 `build/pkg/assets` 补入(entry 名统一为 `/`),并在脚本里 grep 校验条目分隔符;
7. `startForeground(id, notif, type)` 的类型常量在 `android.content.pm.ServiceInfo` 上(`FOREGROUND_SERVICE_TYPE_DATA_SYNC`),不在 `Service` 上,javac 会直接报错。
