# 纯本地 APK 化设计

日期：2026-09-22
状态：已与用户确认方向（物理删除云代码 / Capacitor 壳 / 资源全量打包）

## 目标

把 AI Virtual Phone 改造成**零服务器依赖**的纯本地应用，打包为 Android APK：

- 安装后只需「设置 → API 设置」填 LLM key 即可使用，无任何其他配置
- 联网仅用于调用用户自配的第三方 API（LLM / 生图 / 音乐 / TTS / MCP 工具等）
- 所有用户数据存于 WebView 的 IndexedDB / localStorage（本就在浏览器本地）

## 现状依据

- 全部 `app/api/**` 路由已是 `"disabled on static deploy"` stub——作者的 CF Pages 生产部署本就走静态路线（`.github/workflows/build-cf-pages.yml` 用 `@cloudflare/next-on-pages`），服务端逻辑早已剥离
- LLM 调用浏览器直连 provider（`llm-http.ts` → `fetch(payload.url)`），`/api/llm-proxy` 路由不存在
- `NEXT_PUBLIC_SELF_HOSTED_MODE=true` 已跳过账号门禁
- 数据层全在 IndexedDB（Dexie）：`kv-db`、`chat-db`、各模块 storage
- 本机已具备 Node 24 + Java 21 + Android SDK，可本地出 APK

## 一、物理删除清单

### 服务端/门禁层（整层删）

- `app/api/`（19 个路由目录，全 stub）
- `middleware.ts`
- `app/verify/`、`app/app-market/admin/`、`app/shortcut-run/`、`app/personal-shortcut-run/`
- `app/manifest.webmanifest/route.ts` → 内容复制为 `public/manifest.webmanifest` 静态文件
- `lib/server/`（仅被 API 路由引用，删除前 grep 确认）

### 云功能客户端库 + UI 入口

- 账号/门禁：`lib/account-*`、`components/auth/`；`main-app.tsx` 去掉 `AccountGate` 直进 `DesktopShell`
- 推送/个人云/现实桥：`lib/push-*`、`lib/personal-push-cloud`、`lib/shortcut-*`、`lib/reality-bridge/`、`lib/cloud-backup/`、`components/reality-bridge-app.tsx`、`reality-bridge-scheduler.tsx`、`cloud-backup-scheduler.tsx`、`offline-push-revamp-announcement.tsx`
- 微信：`lib/weixin-*`、`lib/use-weixin-bridge`、`tools/weixin-local-assistant/`、`components/weixin-sync-toast.tsx`
- 云端市场/社区：`custom-app-market-*`（**保留**本地自定义 APP SDK 与本地安装）、`game-hall-client`、`black-market-*` 云部分、`mixology/hall-*`（保留本地特调）、`resource-hub-*`、`notewall-client`（保留 `notewall-local` 本地部分若存在独立价值，否则整 app 删）、`online-room-client`、`moderation-client`、`qa-github*`、`stt-cloud`、`community-contrib`、`timed-wake-storage`、`chat-session-merge`、`chat-offline-storage` 的云端合并路径、`chat-engine` 内快捷指令续跑钩子（`shortcut-continuation-client`、`offline-shortcut-capability`）
- UI：桌面图标移除 `realitybridge`、`resource_hub`；设置页移除云服务部署/微信接入/账号/审核等 Tab；应用市场 App 保留本地自制管理、删云端浏览
- `supabase/`、`tools/`、`docs/*.sql` 及相关 md、`scripts/` 中 weixin/push/mixology-backfill 脚本、`package.json` 对应 scripts
- `android-shell/`（被 Capacitor 取代）+ `.github/workflows/android-shell.yml`
- `.env.example` 瘦身至仅 `NEXT_PUBLIC_SELF_HOSTED_MODE`

## 二、静态导出改造

- `next.config.mjs`：`output: 'export'`、`trailingSlash: true`（Capacitor WebViewLocalServer 按目录解析 index.html）；删 `outputFileTracingIncludes`；保留 `@` webpack 别名与 `node:` 前缀剥离 fallback
- `package.json`：`build` 移除 weixin/push 预构建；新增 `build:apk`（`next build && cap sync android`）
- 无 `next/image` 使用，无需图片配置
- 悬空引用清理以 `npx tsc --noEmit` 为基准 diff（仓库有已知历史错误，见 `next.config.mjs` 注释）

## 三、Capacitor 壳

- 依赖：`@capacitor/core`、`@capacitor/android`、`@capacitor/app`（返回键）、dev `@capacitor/cli`
- `capacitor.config.ts`：`webDir: 'out'`、`appId: app.floatphone.app`、`appName: float`、`server.androidScheme: 'https'`
- `npx cap add android` 生成 `android/` 工程，提交入库
- **CORS**：不全局启用 `CapacitorHttp`（缓冲响应体会破坏 SSE 流式聊天）。现状直连与网页版行为一致；个别缺 CORS 的端点后续按需加原生桥
- `@capacitor/app` `backButton` → 派发到桌面"回主页"逻辑
- 图标复用 `public/icon-512.png`
- CI：`.github/workflows/android-shell.yml` → Capacitor APK 构建流；`build-cf-pages.yml` 产物路径改 `out/`

## 四、产物

- `npm run build:apk` → `out/` → `cap sync` → `cd android && ./gradlew assembleDebug` → APK（约 165MB，全量资源）
- 失去功能：离线推送、云备份、微信接入、iOS 现实桥、云端市场/榜单、多人联机、成年审核
- 保留功能：聊天全链路（含流式/工具/记忆）、角色、朋友圈、全部离线玩法 App、主题美化、本地导入导出、自定义 APP 本地 SDK

## 验证

1. `npx tsc --noEmit` 无新增错误（对基线 diff）
2. `npm run build` 产出 `out/` 且导出无 route handler/middleware 报错
3. `./gradlew assembleDebug` 出 APK
4. 模拟器/真机冒烟：启动进桌面 → 填 API key → 发消息收到流式回复
