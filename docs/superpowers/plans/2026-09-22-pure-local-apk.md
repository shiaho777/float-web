# 纯本地 APK 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除全部云/服务器代码，把 Next.js 应用改为静态导出，用 Capacitor 打包成可本地构建的 Android APK。

**Architecture:** 单层静态站（`output: 'export'` → `out/`）+ Capacitor WebView 壳。LLM 等第三方 API 全部浏览器直连（现状即如此）；IndexedDB 存全部数据。无服务端、无门禁、无 Supabase。

**Tech Stack:** Next.js 15 (static export), React 19, TypeScript, Dexie/IndexedDB, Capacitor 7, Gradle/Android SDK（本机已装）

**Spec:** `docs/superpowers/specs/2026-09-22-pure-local-apk-design.md`

## Global Constraints

- 不引入新的运行时服务；APK 内除 HTTPS 直连第三方 API 外无任何网络依赖
- 不全局启用 `CapacitorHttp`（缓冲响应体会破坏 SSE 流式聊天）
- 仓库非 git 仓库——所有 "commit" 步骤跳过
- `typescript.ignoreBuildErrors=true`、仓库有历史 TS 错误：验收标准是 **tsc 错误不新增**（对基线 diff），不是清零
- 删除以"谁 import 它"为准：被删文件若被保留文件 import，先改保留文件
- 保留本地功能判定：feature 去掉云客户端后能独立渲染 → 保留本地部分；否则整个 feature 删

---

### Task 0: 基线与依赖安装

**Files:** 无（只读+安装）

- [ ] **Step 1** `npm install --legacy-peer-deps`（node_modules 不存在；package-lock 存在）
- [ ] **Step 2** 记录 tsc 基线：`npx tsc --noEmit > /tmp/tsc-baseline.txt 2>&1; wc -l /tmp/tsc-baseline.txt`
- [ ] **Step 3** 记录基线构建：`npm run build` 是否通过（用于后面判断回归；weixin/push 预构建脚本此时仍存在）

---

### Task 1: 删除服务端/门禁层 + 配套资源

**Files（全部删除）:**
- `app/api/`（整个目录）
- `middleware.ts`
- `app/verify/`、`app/app-market/`、`app/shortcut-run/`、`app/personal-shortcut-run/`
- `lib/server/`（先 `grep -rln "lib/server" --include="*.ts*" components lib app | grep -v "app/api"` 确认无 API 外引用；有则先处理）
- `supabase/`、`tools/weixin-local-assistant/`、`android-shell/`
- `docs/*.sql`、`docs/verify-setup.md`、`docs/weixin-cloud-assistant.md`
- `scripts/build-weixin-assistant-dist.mjs`、`build-personal-push-dist.mjs`、`check-weixin-prompt-equivalence.mjs`、`check-personal-push-dist.mjs`、`backfill-mixology-covers.mjs`
- `.github/workflows/android-shell.yml`

**Files（修改）:**
- `app/manifest.webmanifest/route.ts` → 删除该目录，`cp public/manifest.json public/manifest.webmanifest`（layout.tsx 链接 `/manifest.webmanifest`）
- `package.json` scripts：删 `check:weixin`、`check:push`、`weixin:assistant*`、`weixin:build-dist`、`push:build-dist`；`build` 改为 `next build && node scripts/restore-backdrop-filter.mjs`（restore 脚本与静态资源相关，先读一眼确认仍需要）

- [ ] **Step 1** 逐个 `rm -rf` 上述路径
- [ ] **Step 2** 改 `package.json`、`public/manifest.webmanifest`
- [ ] **Step 3** `npx tsc --noEmit` 跑一遍收集第一批悬空引用清单（预期大量出现在 Task 2 要删的文件里——忽略那些文件内的报错）

---

### Task 2: 删除云功能客户端库（叶子层）

**Files（全部删除）:**

账号/门禁：`lib/account-client.ts`、`account-context.tsx`、`account-gate-cookie.ts`、`account-cookie-constants.ts`、`verification-availability.ts`、`self-hosting.ts`、`components/auth/`

推送/现实桥/个人云：`lib/push-client.ts`、`push-outbox-client.ts`、`push-bridge-sync.ts`、`push-bridge-shared.ts`、`push-bailout-client.ts`、`push-preview-split.ts`、`personal-push-cloud.ts`、`shortcut-command-client.ts`、`shortcut-command-media-client.ts`、`shortcut-continuation-client.ts`、`shortcut-email.ts`、`lib/reality-bridge/`、`lib/cloud-backup/`、`cloud-deploy-status.ts`、`offline-shortcut-capability.ts`、`timed-wake-storage.ts`、`chat-session-merge.ts`、`chat-offline-storage.ts`、`offline-prompt-builder.ts`、`components/reality-bridge-app.tsx`、`reality-bridge-scheduler.tsx`、`cloud-backup-scheduler.tsx`、`offline-push-revamp-announcement.tsx`

微信：`lib/weixin-bridge.ts`、`weixin-cloud-sync.ts`、`weixin-storage.ts`、`use-weixin-bridge.ts`、`components/weixin-sync-toast.tsx`、`components/settings/weixin-settings.tsx`

云端市场/社区：`lib/custom-app-market-client.ts`、`custom-app-market-update.ts`、`custom-app-market-types.ts`、`custom-app-ownership.ts`、`game-hall-client.ts`、`black-market-client.ts`、`black-market-storage.ts`（若仅服务云端列表）、`mixology/hall-client.ts`、`hall-parts.ts`、`resource-hub-client.ts`、`resource-hub-flowers.ts`、`resource-hub-identity.ts`、`resource-hub-profile.ts`、`resource-hub-review.ts`、`resource-hub-upload.ts`、`notewall-client.ts`、`notewall-local.ts`、`notewall-engine.ts`、`notewall-memory.ts`、`notewall-types.ts`、`notewall-utils.ts`、`online-room-client.ts`、`moderation-client.ts`、`qa-github.ts`、`qa-github-write.ts`、`community-contrib.ts`、`stt-cloud.ts`

组件：`components/resource-hub/`、`components/settings/cloud-services-setup.tsx`、`components/settings/moderation-center.tsx`、`components/diary/note-wall-app.tsx`

- [ ] **Step 1** 对每个文件先 `grep -rln "<basename>" components lib app` 确认引用者都在删除/待改清单内，再删
- [ ] **Step 2** 整批 `rm`（上表有交集，以 grep 结果为准，不在清单内的新发现文件追加进来）
- [ ] **Step 3** `npx tsc --noEmit 2>&1 | grep -v baseline` 提取"保留文件"中的悬空引用 → Task 3 工作清单

---

### Task 3: 改接线（保留文件的引用清理）

**Files（修改）:** 以下为已知消费点，逐一处理：

- `components/main-app.tsx`：删 `AccountGate`（直渲 DesktopShell）、`CloudBackupScheduler`、`RealityBridgeScheduler`、`OfflinePushRevampAnnouncement`；保留 `MusicProvider`、`MediaMaintenanceScheduler`、splash
- `components/desktop-shell.tsx`：删 `useWeixinBridge`、`startWeixinCloudRealtimeSync`、`WeixinSyncToast`、`RealityBridgeApp`、`REALITY_BRIDGE_*`、市场更新检查 `resolveCustomAppMarketItemForInstalled` 等；图标体系移除 `realitybridge`/`resource_hub`（`lib/desktop-config.ts` IconId、ICONS、PAGE_3_DEFAULT 同步删）
- `lib/chat-engine.ts`：删 `armShortcutContinuation`、`maybeAppendShortcutCapability`、`parseOfflineResponse` 合并路径、`isLegacyShortcutMedia` 分支
- `lib/follow-up-service.ts`：保留本地定时回复，删 push/timed-wake/bailout 云发送
- `lib/tool-executor.ts`：删 shortcut-command、notewall、timed-wake 相关工具与 oauth-callback `/api/` 依赖（MCP OAuth 回调在纯静态下不可用——对应工具入口隐藏）
- `lib/llm-http.ts`：删 `serverProxy` → `/api/llm-proxy` 分支
- `components/chat/`：`chat-room`、`chat-message-list`、`chat-settings-panel`、`user-profile-panel`、`group-call-screen`、`voice-call-screen`、`video-call-screen`、`use-hold-to-talk`、`phone-chat-app` 中的 weixin/stt-cloud/离线回复/session-merge 引用
- `components/settings/` + `phone-settings-app.tsx`：删云相关 Tab/区块（云服务部署、微信、账号、审核、管理中心）
- `components/app-market/`：`app-market-app`（只留本地自制 APP）、`custom-app-runner`（删 market-update/moderation/online-room）
- `components/game/game-hub-app.tsx`：删云端大厅，留本地游戏
- `components/shopping/black-market-app.tsx`：删云端列表/钱包 API，`black-market-builtins` 本地剧场保留
- `components/mixology/mixology-app.tsx` + `mixology-hall.tsx`：删云端大厅
- `components/phone-qa-app.tsx`、`lib/qa-content-tools.ts`、`qa-agent-tools.ts`、`qa-chat-store.ts`：删 github/resource-hub 上传链路
- `components/debug-prompt-panel.tsx`、`lib/short-term-assembler.ts`：删 notewall/离线存储引用
- `components/music/*`、`lib/image-generation-service.ts`、`lib/download-utils.ts`：`/api/*` 调用已打 stub 语义，改为直接失败/隐藏（与 CF Pages 行为一致），不需要改 provider 直连逻辑

- [ ] **Step 1** 按 Task 2 Step 3 产出的清单逐个文件改
- [ ] **Step 2** `npx tsc --noEmit` 对比基线：无新增错误即过

---

### Task 4: 静态导出配置 + 环境清理

**Files:**
- Modify: `next.config.mjs` — 加 `output: "export"`、`trailingSlash: true`；删 `outputFileTracingIncludes`；其余不动
- Modify: `.env.example` — 只留 `NEXT_PUBLIC_SELF_HOSTED_MODE=true`（或删文件改 README 说明无需 env）
- Modify: `package.json` — 加 `"build:apk": "npm run build && cap sync android"`
- Modify: `.gitignore` — 确认覆盖 `out/`、`android/app/build` 等

- [ ] **Step 1** 改配置
- [ ] **Step 2** `npm run build` → 必须产出 `out/`；若报 route/middleware 残留，回 Task 1/2 补删

---

### Task 5: Capacitor 接入

**Files:**
- Create: `capacitor.config.ts`：

```ts
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.floatphone.app",
  appName: "float",
  webDir: "out",
  server: { androidScheme: "https" },
};

export default config;
```

- Modify: `package.json` deps `+ @capacitor/core @capacitor/app`，devDeps `+ @capacitor/cli @capacitor/android`
- Create: `android/`（`npx cap add android` 生成）
- Modify: `components/desktop-shell.tsx` — Android 返回键 → 回桌面：挂 `App.addListener("backButton")`，有打开中的 App 就 `setActiveApp(null)`，否则 `App.exitApp()`（用 `@capacitor/app`，仅在 `Capacitor.isNativePlatform()` 时注册）
- Modify: `.github/workflows/` — `android-shell.yml` 换成 capacitor 版（setup-java 17 + setup-node + `npm ci && npm run build && npx cap sync android && cd android && ./gradlew assembleDebug`，artifact 传 `app-debug.apk`）；`build-cf-pages.yml` artifact 路径改 `out/`
- 图标：`public/icon-512.png` 拷入 `android/app/src/main/res/`（或用 `@capacitor/assets` 生成）

- [ ] **Step 1** `npm i -D @capacitor/cli @capacitor/android && npm i @capacitor/core @capacitor/app`（选 ≥7 天前发布的稳定大版本）
- [ ] **Step 2** 写 `capacitor.config.ts`，`npx cap add android`
- [ ] **Step 3** 接返回键 + workflow

---

### Task 6: 构建 APK + 冒烟

- [ ] **Step 1** `npm run build` → `out/` 生成
- [ ] **Step 2** `npx cap sync android`
- [ ] **Step 3** `cd android && ./gradlew assembleDebug`（本机有 SDK+JDK21；Gradle wrapper 首次会下载 distribution）
- [ ] **Step 4** 产物确认：`android/app/build/outputs/apk/debug/app-debug.apk` 存在，体积 ~160MB+
- [ ] **Step 5**（若有运行中模拟器）`adb install -r` + 启动冒烟：进桌面 → 设置填 LLM key → 聊天流式回复；没有则交付 APK 让用户装

---

### Task 7: 收尾文档

- [ ] **Step 1** `README.md` 顶部加"纯本地 APK 版"说明 + 构建命令段落（替换 Netlify/Vercel/Supabase/个人云/现实桥等失效章节——大幅瘦身）
- [ ] **Step 2** 自检 spec 覆盖：删除清单全落地、`out/` 可构建、APK 可安装

## 自审记录

- spec 覆盖：删除清单 → Task1/2/3；export → Task4；Capacitor → Task5/6；文档 → Task7 ✅
- 无占位符；Task3 的文件清单来自实际 grep 依赖图 ✅
- 风险点：`chat-offline-storage`/`follow-up-service`/`tool-executor` 嵌入深，Task3 给足单点说明；tsc diff 兜底 ✅
