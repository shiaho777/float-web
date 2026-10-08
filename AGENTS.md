# AGENTS.md

Instructions for coding agents working in this repository.

## Code style

- Do what you believe is right. Make the change complete and correct, not the smallest possible diff. If a fix calls for refactoring, renaming, or touching multiple files, do it.
- Fix root causes, not symptoms. Do not paper over a defect with catch-and-swallow, degraded fallbacks, or UI workarounds that leave the underlying behavior broken. Trace the failure to where it originates and repair it there — even when that is harder.
- Match the patterns and conventions already in the surrounding code.
- Do not add copyright or license headers unless asked.

## Project layout

| Path | Role |
|------|------|
| `entries/` | Vite multi-page entry points: `main.tsx` (phone), `world-builder.tsx` (3D world builder), `characters.tsx` (standalone character page). Each maps to an HTML file at repo root. |
| `components/` | React UI tree — chat, desktop, settings, check-phone simulated apps, findmy, moments, games, etc. (~6.8 MB, dense codebase; read neighbors before adding). |
| `lib/` | Business logic layer (~268 modules): Dexie/IndexedDB stores, LLM adapter, prompt assembler, engines (chat/group-chat/memory/presence/dwelling/checkphone), importer, backup. |
| `styles/components.css` | Single design-token CSS file shared by all components (`dl-*`, `ap-*`, `fi-*`, `cp-*` families). Reuse existing classes before inventing new ones. |
| `custom-apps/` | Built-in user apps installed through the Custom App SDK. |
| `app-store-apps/` | Extra apps for the in-app market. |
| `world-builder/` | 3D world builder page (React Three Fiber). |
| `characters/` | Standalone character management page. |
| `docs/` | Specs and plans (docs/specs/, docs/plans/) plus README screenshots in `docs/screenshots/`. |

User-facing product doc: `README.md` (Chinese-first). The upstream project this repo is built from is `xiaolongbao0709/ai-virtual-phone` — see the README acknowledgement section.

## How the main pieces connect

```text
Vite multi-page build (vite.config.ts)
  index.html / world-builder/index.html / characters/index.html
  → entries/*.tsx → components/* + lib/*
  → dev server http://localhost:3001, or production build in out/

Browser page
  → Dexie/IndexedDB (all app data, per-entity tables)
  → fetch to user-configured third-party APIs (LLM / image / voice / music / map tiles)
```

Mental model:

- **This repository is the web edition.** It runs in a desktop or mobile browser. There is no Capacitor shell, no Android project, and no iOS project. The installable APK lives in [shiaho777/float-android](https://github.com/shiaho777/float-android).
- **Everything is client-side.** There is no project backend. Data lives in IndexedDB (via Dexie stores in `lib/`) and localStorage. Supabase-dependent modules from upstream were removed; direct third-party connectivity (LLM, image gen, music, map tiles) remains.
- **Generation lives only while the tab is open.** `lib/keep-alive.ts` is a no-op. `lib/native-http.ts` is `fetch`. Do not add a native bridge to keep streams alive in the background.
- **Media stays in IndexedDB.** `lib/native-media.ts` reports that the native disk store is unavailable, and `media-cache-storage` keeps blobs in IndexedDB. Do not send large base64 strings through a bridge; this build has no bridge.

## Platform constraints

- **CORS:** the page is a normal browser origin. `httpFetch` is `fetch`. Endpoints the user configures must send CORS headers the browser accepts, or the call fails. Do not add a native HTTP proxy to paper over that.
- **Memory:** do not accumulate large base64 strings for import/export. Downloads use a blob URL and an anchor click (`lib/download-utils.ts`). Media blobs go to IndexedDB.
- **Permissions:** microphone, camera, and geolocation prompts come from the browser. `lib/media-permissions.ts` does not request anything itself.
- **No self-update installer.** `isAndroidPlatform()` is always false. The About page can link out to the Android releases; it does not download or install an APK.
- **Version:** `package.json` `version` is the web app version.
- Avoid new third-party dependencies unless strongly justified; prefer existing modules in `lib/` and browser APIs.

## Web runtime

Run it with `npm run dev` and open `http://localhost:3001`. `npm run build` writes `out/`. `npm run start` previews that build on the same port.

The old native wrappers still exist so callers do not branch:

| Module | Web behavior |
|---|---|
| `native-http` | `fetch` |
| `native-media` | unavailable; IndexedDB holds blobs |
| `keep-alive` | no-op |
| `storage-access` | always granted; exports are browser downloads |
| `media-permissions` | always granted; the browser prompts on `getUserMedia` |
| `app-updater` | no installer; download opens a browser tab |
| `auto-backup` | no silent disk write |

**Backward compatibility (every update must honor):**

- Dexie schema changes go through `version(n).stores(...)` upgrades — never leave data written by an older release unreadable.
- New `localStorage`/settings keys ship with defaults; importing a backup from an older version must not break.
- Export format changes must keep older exports importable (or provide migration on import).
- Keep the wrapper module names (`native-http`, `native-media`, `keep-alive`, and the rest). Callers already import them. Change behavior inside the wrapper, not at every call site.

**Verification:** `npx tsc --noEmit` and `npm run build`. For UI changes, open `http://localhost:3001` and use the screen that changed.

## Workflow

- Do not commit secrets, `.env`, or IDE/cache junk.
- Do not create commits, push, open PRs, or file Issues unless the user asks to deliver / ship / push / open a PR (or equivalent).
- Verify before handing off: `npx tsc --noEmit` (strict; repo should stay at 0 errors) and `npm run build`.

### Delivery (Issue + PR + CI)

Default target: [shiaho777/float-web](https://github.com/shiaho777/float-web). Prefer a pull request over direct pushes to `main` when delivering code. The Android APK line stays in [shiaho777/float-android](https://github.com/shiaho777/float-android).

**Language (required):** GitHub **Issues and PRs must be written in English** — titles, bodies, labels text you author, and delivery comments on the Issue/PR. Local chat with the user may be Chinese or any language; do not copy that language into Issue/PR text.

When the user asks to deliver a change, run the Issue → branch → PR → CI → merge loop end-to-end. Do not close the Issue until the PR is merged and CI is green.

**Branch naming:** use plain `type/slug` names — `fix/…`, `feat/…`, `refactor/…`, `docs/…`, `perf/…`, `chore/…`. Do not use tool/agent namespaces (`codex/…`, `devin/…`, etc.); the branch belongs to the repo, not the agent.

PR bodies follow `.github/pull_request_template.md` and must include `Fixes #N` (or `Closes #N`) so the Issue closes on merge — never on PR open, never while checks are red.

### Releases

This repo ships as a website, not an APK. Bump `version` in `package.json`. Build with `npm run build` and publish `out/`, or tell people to clone and run `npm run dev`.

Android releases stay on `shiaho777/float-android`. Do not tag an APK from this repository.
