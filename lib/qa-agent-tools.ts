import { buildProviderRequest, parseProviderResponse } from "./llm-provider-adapter";
import { fetchLlmPayload } from "./llm-http";
import { loadApiConfigs } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import type { ToolCall } from "./tool-executor";
import { getQaErrorEntries } from "./qa-error-log";
import { getDebugPromptSnapshot } from "./debug-store";

import {
    saveQaFeedbackTicket,
    captureQaEnvironment,
    type QaFeedbackTicket,
} from "./qa-feedback";
import { QA_COMPUTER_TOOLS, QA_COMPUTER_ALIAS_TOOLS } from "./qa-computer-tools";
import { isWorkshopComputerEnabled } from "./agent-computer";
import {
    QA_CONTENT_TOOLS,
    workbenchWriteLocal,
    workbenchEditLocal,
    workbenchPublishLocal,
    getAppStagingNote,
    readStagedAppFile,
    type QaCreatedContent,
} from "./qa-content-tools";
import { searchQaFaq, readQaFaqPage } from "./qa-faq";


export type { QaCreatedContent } from "./qa-content-tools";

// ── 工坊诊断工具集（P1）──────────────────────────────
// 文本协议与全项目一致：[执行动作:工具名({"参数":"值"})]，解析复用 tool-executor.parseToolCalls。

export type QaToolContext = {
    signal?: AbortSignal;
    /** 内容工具安装/更新本机内容后回调（store 记到会话上，供工坊内预览）。 */
    onContentCreated?: (item: QaCreatedContent) => void;
};

export type QaToolRunResult = {
    name: string;
    success: boolean;
    resultForModel: string;
};

type QaTool = {
    name: string;
    /** 原生工具协议的稳定英文名（function 名仅允许 ASCII） */
    nativeName: string;
    description: string;
    schemaLines: string[];
    /** 原生工具协议的 JSON Schema 参数定义 */
    parameters: Record<string, unknown>;
    run: (args: Record<string, unknown>, context?: QaToolContext) => Promise<string>;
};

/** 空参数工具的兜底 schema：带一个无意义可选字段，避免部分 provider（如 Gemini）拒绝空 properties */
const NOOP_PARAMS: Record<string, unknown> = {
    type: "object",
    properties: { noop: { type: "string", description: "无需参数，忽略" } },
};

const RESULT_CHAR_LIMIT = 2000;

function clip(text: string): string {
    return text.length > RESULT_CHAR_LIMIT ? `${text.slice(0, RESULT_CHAR_LIMIT)}\n…（已截断）` : text;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

// ── 工具 1：检测 API 连通性 ──

async function pingApiConfig(config: ApiConfig, signal?: AbortSignal): Promise<string> {
    const started = Date.now();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20_000);
    const onOuterAbort = () => abort.abort();
    signal?.addEventListener("abort", onOuterAbort);
    try {
        const request = buildProviderRequest(config, null, [{ role: "user", content: "连通性测试，只回复：ok" }]);
        const response = await fetchLlmPayload(request, { signal: abort.signal });
        const ms = Date.now() - started;
        if (!response.ok) {
            const bodyText = (await response.text()).slice(0, 300);
            return `✗ 「${config.name || config.provider}」HTTP ${response.status}（${ms}ms）：${bodyText}`;
        }
        const parsed = parseProviderResponse(request.providerKind, await response.json());
        if (!parsed.content) return `⚠ 「${config.name || config.provider}」请求成功但返回空内容（${ms}ms），检查模型名 ${config.defaultModel} 是否正确`;
        return `✓ 「${config.name || config.provider}」正常，模型 ${config.defaultModel}，耗时 ${ms}ms`;
    } catch (error) {
        const ms = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        if (abort.signal.aborted && !signal?.aborted) return `✗ 「${config.name || config.provider}」超时（>${ms}ms）`;
        return `✗ 「${config.name || config.provider}」连接失败（${ms}ms）：${message.slice(0, 200)}（常见原因：Base URL 写错、网络不通、CORS 被服务商拦截）`;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onOuterAbort);
    }
}

const apiCheckTool: QaTool = {
    name: "检测API",
    nativeName: "check_api",
    parameters: {
        type: "object",
        properties: { name: { type: "string", description: "只测指定名称的 API 配置；不填测全部" } },
    },
    description: "逐个测试用户已配置的 LLM API 是否可用（真实发送一条极短请求），返回连通状态、耗时与错误详情。",
    schemaLines: [
        "  参数：",
        "    · name (可选) — 只测指定名称的 API 配置；不填测全部",
        '  调用：[执行动作:检测API({})] 或 [执行动作:检测API({"name":"DeepSeek"})]',
    ],
    async run(args, options) {
        const all = loadApiConfigs();
        if (all.length === 0) return "用户还没有配置任何 API。请引导用户到「设置 → API 设置」添加。";
        const filter = typeof args.name === "string" ? args.name.trim() : "";
        const targets = filter ? all.filter((c) => (c.name || "").includes(filter)) : all;
        if (targets.length === 0) return `找不到名称包含「${filter}」的 API 配置。现有配置：${all.map((c) => c.name || c.provider).join("、")}`;
        const results: string[] = [];
        for (const config of targets) {
            results.push(await pingApiConfig(config, options?.signal));
        }
        return clip(results.join("\n"));
    },
};

// ── 工具 2：存储体检 ──

const storageReportTool: QaTool = {
    name: "存储体检",
    nativeName: "storage_report",
    parameters: NOOP_PARAMS,
    description: "查看浏览器存储占用（配额、已用空间、各数据库清单），用于排查存储不足或数据异常。",
    schemaLines: ["  参数：无", "  调用：[执行动作:存储体检({})]"],
    async run() {
        const lines: string[] = [];
        try {
            const estimate = await navigator.storage?.estimate?.();
            if (estimate) {
                const usage = estimate.usage ?? 0;
                const quota = estimate.quota ?? 0;
                lines.push(`存储占用：${formatBytes(usage)} / 配额 ${formatBytes(quota)}（${quota ? ((usage / quota) * 100).toFixed(1) : "?"}%）`);
            }
            const persisted = await navigator.storage?.persisted?.();
            lines.push(`持久化存储：${persisted ? "已开启（浏览器不会自动清理）" : "未开启（存储紧张时浏览器可能清数据，建议提醒用户定期备份）"}`);
        } catch {
            lines.push("无法读取存储估算（浏览器不支持）。");
        }
        try {
            const dbs = await indexedDB.databases?.();
            if (dbs?.length) lines.push(`IndexedDB 数据库（${dbs.length} 个）：${dbs.map((d) => d.name).filter(Boolean).join("、")}`);
        } catch {
            // Safari 不支持 databases()
        }
        try {
            lines.push(`localStorage 键数量：${localStorage.length}`);
        } catch {
            // ignore
        }
        return clip(lines.join("\n"));
    },
};

// ── 工具 3：最近报错 ──

const errorLogTool: QaTool = {
    name: "最近报错",
    nativeName: "recent_errors",
    parameters: NOOP_PARAMS,
    description: "读取本次会话内页面捕获到的 JS 报错和未处理异常（最多 50 条），以及最近一次 LLM 请求的调试快照信息。",
    schemaLines: ["  参数：无", "  调用：[执行动作:最近报错({})]"],
    async run() {
        const lines: string[] = [];
        const errors = getQaErrorEntries();
        if (errors.length === 0) {
            lines.push("本次会话没有捕获到运行时报错。（收集范围：宿主页面与本机测试游戏/剧场 iframe；自定义 APP 内部报错不在此列，「没有报错」不代表你写的代码没问题——排查代码问题请用「读取」看源码。）");
        } else {
            lines.push(`捕获到 ${errors.length} 条报错（最近 10 条）：`);
            for (const entry of errors.slice(-10)) {
                const time = new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false });
                lines.push(`[${time}] ${entry.kind === "error" ? "JS错误" : "未处理异常"} ${entry.source ? `(${entry.source}) ` : ""}${entry.message}`);
            }
        }
        const snapshot = getDebugPromptSnapshot();
        if (snapshot) {
            lines.push("", "最近一次 LLM 请求快照存在（用户可在调试面板查看完整提示词）。");
        }
        return clip(lines.join("\n"));
    },
};

// ── 工具 4：设备环境 ──

const deviceInfoTool: QaTool = {
    name: "设备环境",
    nativeName: "device_info",
    parameters: NOOP_PARAMS,
    description: "读取设备与运行环境信息（浏览器、视口、PWA 状态、网络状态、通知权限），用于排查显示异常和兼容问题。",
    schemaLines: ["  参数：无", "  调用：[执行动作:设备环境({})]"],
    async run() {
        const lines: string[] = [];
        lines.push(`UA：${navigator.userAgent.slice(0, 160)}`);
        lines.push(`视口：${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`);
        lines.push(`语言：${navigator.language}；在线：${navigator.onLine ? "是" : "否"}`);
        try {
            const standalone = window.matchMedia("(display-mode: standalone)").matches;
            lines.push(`PWA 独立窗口：${standalone ? "是（已安装到桌面）" : "否（浏览器内打开）"}`);
        } catch {
            // ignore
        }
        try {
            lines.push(`Service Worker：${navigator.serviceWorker?.controller ? "已激活" : "未激活"}`);
        } catch {
            // ignore
        }
        try {
            lines.push(`通知权限：${typeof Notification !== "undefined" ? Notification.permission : "不支持"}`);
        } catch {
            // ignore
        }
        return clip(lines.join("\n"));
    },
};

// ── 答疑文档（可检索、可翻页的持续补充 FAQ）──────────

const faqTool: QaTool = {
    name: "答疑文档",
    nativeName: "read_faq_doc",
    parameters: {
        type: "object",
        properties: {
            find: { type: "string", description: "关键词（可空格分隔多个，任一命中即返回该问答条目）" },
            page: { type: "number", description: "不带 find 时按页顺序阅读全文，默认第 1 页" },
        },
    },
    description:
        "检索产品答疑文档（FAQ）——只用于回答用户的产品使用问题：功能怎么用、设置在哪、故障怎么排查。回答没把握的产品问题前先查这里；查不到再读源码求证。注意：开发 APP/小游戏/剧场所需的运行时协议、宿主 API、manifest/权限/工具声明等资料全部在「创作指南」里，创作任务不要来这里查资料。",
    schemaLines: [
        "  参数：",
        "    · find (可选) — 关键词，任一命中即返回对应问答条目",
        "    · page (可选) — 不带 find 时分页通读，默认第 1 页",
        '  调用：[执行动作:答疑文档({"find":"备份 迁移"})]',
    ],
    async run(args) {
        const find = typeof args.find === "string" ? args.find.trim() : "";
        if (find) {
            const hits = searchQaFaq(find);
            if (hits.length === 0) {
                return `答疑文档里没有找到与「${find}」相关的条目。可换关键词再查；仍无结论就如实告诉用户并用「记录反馈」登记。`;
            }
            return `【答疑文档命中 ${hits.length} 条】\n\n${hits.join("\n\n")}`;
        }
        return readQaFaqPage(args.page);
    },
};

let feedbackSeq = 0;

const feedbackTool: QaTool = {
    name: "记录反馈",
    nativeName: "record_feedback",
    parameters: {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["feature", "bug", "other"], description: "反馈类型" },
            title: { type: "string", description: "一句话标题" },
            detail: { type: "string", description: "详细描述；bug 请含复现步骤与期望行为" },
        },
        required: ["kind", "title", "detail"],
    },
    description:
        "当用户提出你无法直接处理的核心功能需求或产品级 bug（需要改动应用本体代码、而非用户自己的本地设置）时，把它整理成结构化反馈单留存在本机。",
    schemaLines: [
        "  参数：",
        "    · kind (必填) — feature（功能建议）/ bug（问题反馈）/ other",
        "    · title (必填) — 一句话标题",
        "    · detail (必填) — 详细描述；bug 请含复现步骤与期望行为",
        '  调用：[执行动作:记录反馈({"kind":"feature","title":"希望群聊支持消息撤回","detail":"…"})]',
    ],
    async run(args, context) {
        const kind = args.kind === "bug" || args.kind === "other" ? args.kind : "feature";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const detail = typeof args.detail === "string" ? args.detail.trim() : "";
        if (!title || !detail) return "缺少 title 或 detail。";
        feedbackSeq += 1;
        const ticket: QaFeedbackTicket = {
            id: `fb-${Date.now().toString(36)}-${feedbackSeq}`,
            ts: Date.now(),
            kind: kind as QaFeedbackTicket["kind"],
            title,
            detail,
            environment: captureQaEnvironment(),
        };
        saveQaFeedbackTicket(ticket);
        return `✓ 已在本地记录反馈「${title}」，反馈暂存在本机（用户可在需要时复制反馈内容发给开发者）。请告知用户已记录。`;
    },
};

// ── 统一 CRUD 工具集 ─────────────────────────────────
// 主流 agent 形态：内容与仓库统一寻址（type + name/path + field），每个动作只有
// 一个入口——清单 / 读取 / 写入(append 分段) / 编辑(find/replace) / 发布，再加
// 归类后的辅助工具。旧工具全部保留为隐藏别名（仍可执行，兼容旧会话回放与弱模型
// 记忆里的旧指令），但不再出现在系统提示里。

function contentToolByNative(native: string): QaTool {
    const tool = QA_CONTENT_TOOLS.find((t) => t.nativeName === native);
    if (!tool) throw new Error(`内容工具缺失：${native}`);
    return tool;
}

const listTool: QaTool = {
    name: "清单",
    nativeName: "list_items",
    parameters: {
        type: "object",
        properties: {
            scope: { type: "string", enum: ["local"], description: "local=本机内容（默认）" },
        },
    },
    description:
        "看看有什么。scope=local（默认）：本机自定义 APP、游戏/剧场草稿箱、本机测试内容、应用暂存区的状态。",
    schemaLines: [
        "  参数：",
        "    · scope (可选) — local（默认，本机内容与暂存区）",
        '  调用：[执行动作:清单({})]',
    ],
    async run(_args, context) {
        const local = await contentToolByNative("list_local_content").run({}, context);
        return `${local}\n${getAppStagingNote()}`;
    },
};

const readTool: QaTool = {
    name: "读取",
    nativeName: "read_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater"], description: "内容类型" },
            name: { type: "string", description: "app/game/theater：APP 名 / 游戏标题 / 剧场档案名" },
            path: { type: "string", description: "app：读应用暂存区的包文件（分段写入时核实进度用）" },
            page: { type: "number", description: "本机内容/暂存文件较长时分页，默认第 1 页（最后一页可看结尾）" },
            start: { type: "number", description: "起始行" },
            end: { type: "number", description: "结束行" },
        },
        required: ["type"],
    },
    description:
        "读取一条内容的完整源码与字段：本机 APP/游戏/剧场用 type+name（可分页）；应用暂存区的包文件用 type=app + path。修改前/续写前先读，基于真实内容再动手。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater",
        "    · name — 本机内容的名称（type=app/game/theater 已装内容用）",
        "    · path — 应用暂存区包文件路径（type=app，分段写入时核实进度）",
        "    · page (可选) — 本机内容/暂存文件分页；start/end (可选) — 暂存文件行号范围",
        '  调用：[执行动作:读取({"type":"game","name":"五子棋"})] 或 [执行动作:读取({"type":"app","path":"index.html","page":2})]',
    ],
    async run(args, context) {
        if (args.type === "app" && typeof args.path === "string" && args.path.trim()) {
            return readStagedAppFile(args.path, args.page, args.start, args.end);
        }
        const result = await contentToolByNative("read_local_content").run({ type: args.type, name: args.name, page: args.page }, context);
        if (args.type === "app" && result.startsWith("没有找到名为") && !getAppStagingNote().includes("（暂存区为空）")) {
            return `${result}\n${getAppStagingNote()}——暂存区文件还没安装，读它们要用 path 参数（如 {"type":"app","path":"index.html"}）。`;
        }
        return result;
    },
};

const writeTool: QaTool = {
    name: "写入",
    nativeName: "write_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater"], description: "写入目标" },
            name: { type: "string", description: "game/theater：草稿标题（没有会新建）" },
            path: { type: "string", description: "app：包内路径（如 index.html / manifest.json）" },
            field: { type: "string", description: "game/theater：字段名。game 默认 gameHtml（还有 pickerHtml/roleSlots/subtitle/synopsis/playNote/tags）；theater 默认 openingHtml（还有 aiInstruction/outputContract/renderRules/renderCss/memorySummaryPrompt/subtitle/synopsis/storyText/tags）" },
            content: { type: "string", description: "内容（roleSlots/renderRules 传 JSON 数组文本）" },
            append: { type: "boolean", description: "true=追加到已有内容末尾——大文件分多轮写，每段自然收尾，绝不会被输出上限截断" },
            base64: { type: "boolean", description: "仅 app：content 是 base64 二进制（如图标）" },
        },
        required: ["type", "content"],
    },
    description:
        "写内容（新建或整体覆盖，append=true 则分段追加）：app 按包内 path 写应用暂存区（单文件应用只需 index.html；完整包加 manifest.json）；game/theater 按 name+field 写草稿（可逐字段分多轮写）。大文件必须分段 append，写完用「发布」。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app（暂存区，配 path）/ game / theater（草稿，配 name+field）",
        "    · name / path — 见 type 说明；field (可选) — game 默认 gameHtml，theater 默认 openingHtml",
        "    · content (必填) — 内容；append (可选) — true=追加（大文件分轮写）",
        '  调用：[执行动作:写入({"type":"game","name":"五子棋","content":"<!doctype html>…","append":true})]',
    ],
    async run(args, context) {
        if (args.type === "app") return contentToolByNative("stage_app_file").run({ path: args.path, content: args.content, append: args.append, base64: args.base64 }, context);
        return workbenchWriteLocal(args as Record<string, unknown>);
    },
};

const editTool: QaTool = {
    name: "编辑",
    nativeName: "edit_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater"], description: "编辑目标" },
            name: { type: "string", description: "app：已装应用名；game/theater：标题（只在本机测试时会自动转成草稿再改）" },
            path: { type: "string", description: "app：暂存文件路径" },
            field: { type: "string", description: "game/theater：字段名，game 默认 gameHtml，theater 默认 openingHtml" },
            find: { type: "string", description: "要被替换的原文片段（须唯一，含足够上下文；空格换行须与原文完全一致）" },
            replace: { type: "string", description: "替换后的新片段" },
            all: { type: "boolean", description: "true=替换全部匹配处（默认要求唯一匹配）" },
        },
        required: ["type", "find", "replace"],
    },
    description:
        "改已有内容的首选方式（find/replace 片段替换）：只输出改动片段，省 token 且不会被输出上限截断，绝不要整体重写大文件。可改：已装 APP（name）、应用暂存文件（path）、游戏/剧场草稿字段（name+field）。改前先「读取」核对原文。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater",
        "    · name / path / field — 定位目标，见参数说明",
        "    · find (必填) / replace (必填) / all (可选) — 原文片段须唯一，all=true 替换全部",
        '  调用：[执行动作:编辑({"type":"game","name":"五子棋","find":"const SIZE = 15","replace":"const SIZE = 19"})]',
    ],
    async run(args, context) {
        return workbenchEditLocal(args as Record<string, unknown>, context);
    },
};

const publishTool: QaTool = {
    name: "发布",
    nativeName: "publish_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater"], description: "发布目标" },
            name: { type: "string", description: "app 单文件时的应用名；game/theater：草稿标题" },
            description: { type: "string", description: "app：一句话简介" },
            permissions: { type: "array", items: { type: "string" }, description: "app：覆盖默认权限集" },
            clear: { type: "boolean", description: "true=不发布，只清空应用暂存区" },
        },
        required: ["type"],
    },
    description:
        "把写好的内容落地：app=用应用暂存区组包安装到桌面（有 manifest.json 走完整包，只有 index.html 时配 name 走单文件）；game/theater=把草稿装进本机测试（游戏大厅/黑市剧场）。app/game 发布前会做结构体检（文档收尾位置、script 配平、内联脚本语法试编译），不过会返回具体问题——按提示「编辑」修复后重新发布即可。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater",
        "    · name — app 单文件应用名 / game、theater 草稿标题",
        "    · clear (可选) — true=只清空应用暂存区",
        '  调用：[执行动作:发布({"type":"game","name":"五子棋"})]',
    ],
    async run(args, context) {
        return workbenchPublishLocal(args as Record<string, unknown>, context);
    },
};

const diagnoseTool: QaTool = {
    name: "环境体检",
    nativeName: "env_check",
    parameters: {
        type: "object",
        properties: {
            scope: { type: "string", enum: ["api", "storage", "errors", "device"], description: "检查什么：api=LLM API 连通性；storage=浏览器存储占用；errors=运行时报错收集（见工具说明的覆盖范围）；device=设备与运行环境" },
            name: { type: "string", description: "scope=api 时只测指定名称的配置" },
        },
        required: ["scope"],
    },
    description:
        "检查运行环境本身是否健康：api=逐个真实测试已配置的 LLM API 连通性；storage=存储配额与占用；device=浏览器/视口/PWA/通知权限；errors=本次会话收集到的运行时报错（宿主页面 + 本机测试游戏/剧场 iframe）与 LLM 请求快照。它只看环境，不分析任何内容代码——某个 APP/游戏自身功能不对，用「读取」看它的源码。",
    schemaLines: [
        "  参数：",
        "    · scope (必填) — api / storage / errors / device",
        "    · name (可选) — scope=api 时只测该名称的配置",
        '  调用：[执行动作:环境体检({"scope":"api"})]',
    ],
    async run(args, context) {
        if (args.scope === "api") return apiCheckTool.run({ name: args.name }, context);
        if (args.scope === "storage") return storageReportTool.run({}, context);
        if (args.scope === "errors") return errorLogTool.run({}, context);
        if (args.scope === "device") return deviceInfoTool.run({}, context);
        return "scope 需为 api / storage / errors / device 之一。";
    },
};

// 「诊断」旧名别名：改名「环境体检」前的会话回放/弱模型旧指令仍可执行（隐藏，不进提示词）
const diagnoseLegacyAliasTool: QaTool = {
    name: "诊断",
    nativeName: "run_diagnostics",
    parameters: diagnoseTool.parameters,
    description: diagnoseTool.description,
    schemaLines: diagnoseTool.schemaLines,
    run: (args, context) => diagnoseTool.run(args, context),
};

// ── 注册表 ───────────────────────────────────────────

// 旧工具分组（隐藏别名：仍可执行，不进系统提示）
const BASE_TOOLS: QaTool[] = [apiCheckTool, storageReportTool, errorLogTool, deviceInfoTool, feedbackTool, faqTool, ...QA_CONTENT_TOOLS];

// 暴露给模型的统一工具集
const UNIFIED_BASE_TOOLS: QaTool[] = [
    listTool,
    readTool,
    writeTool,
    editTool,
    publishTool,
    contentToolByNative("read_creation_guide"),
    faqTool,
    contentToolByNative("export_local_content"),
    diagnoseTool,
    feedbackTool,
];
/** 当前可用工具集：统一 CRUD + 辅助 + （已连接角色电脑）工作机。 */
export function getQaTools(): QaTool[] {
    const tools = [...UNIFIED_BASE_TOOLS];
    if (isWorkshopComputerEnabled()) tools.push(...QA_COMPUTER_TOOLS);
    return tools;
}

// 全量注册表（store 里用于工具名映射与执行查找）：统一工具 + 全部旧工具隐藏别名，
// Set 去重（部分工具两边都在）
export const QA_TOOLS: QaTool[] = [...new Set([
    ...UNIFIED_BASE_TOOLS,
    ...QA_COMPUTER_TOOLS,
    ...QA_COMPUTER_ALIAS_TOOLS,
    diagnoseLegacyAliasTool,
    ...BASE_TOOLS,
])];

// ── 原生工具协议（function calling）────────────────────

export type QaNativeToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };

/** 当前可用工具的原生定义（供请求体 tools 字段用）。 */
export function getQaNativeToolDefinitions(): QaNativeToolDefinition[] {
    return getQaTools().map((tool) => ({
        name: tool.nativeName,
        description: tool.description,
        parameters: tool.parameters,
    }));
}

/** 原生英文名 → 中文工具名（执行与 UI 展示都用中文名）。 */
export function buildQaNativeNameMap(): Map<string, string> {
    return new Map(QA_TOOLS.map((tool) => [tool.nativeName, tool.name]));
}

export function buildQaToolsPrompt(): string {
    const tools = getQaTools();
    const lines: string[] = [];
    lines.push("===== 你的工具 =====");
    lines.push("排查用户问题先分诊，再选工具，不要凭空猜测、也不要把工具挨个跑一遍：");
    lines.push("· 某个 APP/游戏/剧场自身行为不对（界面不显示、按钮没反应、数据不对）→ 这是它的代码问题，「读取」它的源码定位逻辑，与环境无关；");
    lines.push("· 环境问题（API 连不上、存储满、整个页面崩溃报错、设备兼容）→「环境体检」对应 scope；");
    lines.push("· 产品用法问题（功能怎么用、设置在哪）→「答疑文档」。");
    lines.push("可用工具：");
    lines.push("");
    for (const tool of tools) {
        lines.push(`【${tool.name}】${tool.description}`);
        lines.push(...tool.schemaLines);
        lines.push("");
    }
    lines.push("===== 调用规则 =====");
    lines.push('· 执行动作：使用 [执行动作:工具名({"参数":"值"})] 格式，无参数时用 [执行动作:工具名({})]');
    lines.push("· 一条回复里可以调用多个工具；调用后等待系统返回工具结果再继续分析");
    lines.push("· 产品问题没把握时先用「答疑文档」按关键词检索；文档查不到且已连接仓库时再查源码；仍无结论就如实说明");
    lines.push("· 回答代码问题时，先用「清单」scope=repo 或「搜索仓库代码」定位，再用「读取」type=repo 看具体实现，基于真实代码作答");
    lines.push("· 用户想要新 APP/小游戏/剧场时：先用「创作指南」读对应类型的制作说明（可分页），用「写入」写内容（可能超出输出预算的大文件才分段 append），写完「发布」装进本机，最后告诉用户去哪里打开；同名会更新。创作所需的协议/API/声明资料一律以「创作指南」为准，不要查「答疑文档」——那是给用户答疑用的");
    lines.push("· 改已有内容（本机或仓库）一律先「读取」核对原文，再用「编辑」find/replace 只改动片段，绝不整体重写大文件；改完本机内容重新「发布」生效");
    lines.push("· 收到工具结果后，用人话向用户解释结论和建议，不要原样罗列");
    lines.push("· 不需要工具时直接回复文字");
    return lines.join("\n");
}

/**
 * 工具行副标题：从参数里提炼一句人能看懂的摘要（统一工具名太泛，"读取/写入"
 * 不带参数没有信息量）。规则通用，旧工具的 title/query/path 也能覆盖。
 * 例：读取 → repo:lib/chat-engine.ts 1-80行；写入 → app:index.html 3.2k字·追加。
 */
export function formatQaToolSubtitle(name: string, args?: Record<string, unknown>): string {
    void name;
    if (!args || typeof args !== "object") return "";
    const str = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const clipText = (v: string, max: number): string => (v.length > max ? `${v.slice(0, max)}…` : v);

    const kind = str(args.type) || str(args.scope) || str(args.kind) || str(args.action);
    const target = str(args.path) || str(args.name) || str(args.title);
    const field = str(args.field);
    const parts: string[] = [];
    if (kind && target) parts.push(`${kind}:${clipText(target, 36)}${field ? `·${field}` : ""}`);
    else if (kind) parts.push(kind + (field ? `·${field}` : ""));
    else if (target) parts.push(clipText(target, 36) + (field ? `·${field}` : ""));

    const query = str(args.query) || (!target ? str(args.find) : "");
    if (query) parts.push(clipText(query, 24));
    const sha = str(args.sha);
    if (sha) parts.push(sha.slice(0, 8));
    const number = num(args.number);
    if (number != null) parts.push(`#${number}`);
    const page = num(args.page);
    if (page != null && page > 1) parts.push(`第${page}页`);
    const start = num(args.start);
    const end = num(args.end);
    if (start != null || end != null) parts.push(`${start ?? 1}-${end ?? ""}行`);

    const contentLen = typeof args.content === "string" ? args.content.length : 0;
    if (contentLen > 0) {
        const size = contentLen >= 1000 ? `${(contentLen / 1000).toFixed(1)}k` : String(contentLen);
        parts.push(`${size}字${args.append === true ? "·追加" : ""}`);
    } else if (args.append === true) {
        parts.push("追加");
    }
    if (args.fromDraft === true) parts.push("从草稿");
    if (args.fromStaged === true) parts.push("从暂存");
    if (args.clear === true) parts.push("清空");
    const message = str(args.message);
    if (message) parts.push(clipText(message, 20));
    return parts.join(" ");
}

export async function runQaToolCall(call: ToolCall, context?: QaToolContext): Promise<QaToolRunResult> {
    const tool = QA_TOOLS.find((t) => t.name === call.name);
    if (!tool) {
        return { name: call.name, success: false, resultForModel: `未知工具「${call.name}」。可用工具：${getQaTools().map((t) => t.name).join("、")}` };
    }
    try {
        const result = await tool.run(call.args ?? {}, context);
        return { name: call.name, success: true, resultForModel: result };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { name: call.name, success: false, resultForModel: `工具执行失败：${message.slice(0, 300)}` };
    }
}
