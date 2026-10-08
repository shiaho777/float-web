"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, createContext, type CSSProperties, type ReactNode } from "react";
import { Activity, ChevronRight, Clock, Database, FileText, Fingerprint, Globe, HardDrive, Image, Info, Laptop, Layers, Link2, Mic, SlidersHorizontal, UserCircle, Wrench, X,  } from "lucide-react";
import { ApiSettings } from "./settings/api-settings";
import { VoiceSettings } from "./settings/voice-settings";
import { ImageGenerationSettings } from "./settings/image-generation-settings";
import { PresetManager } from "./settings/preset-manager";
import { WorldBookManager } from "./settings/worldbook-manager";
import { RegexManager } from "./settings/regex-manager";
import { DataManagement } from "./settings/data-management";
import { UserIdentitySettings } from "./settings/user-identity";
import { AboutDeclaration } from "./settings/about-declaration";
import { BindingManager } from "./settings/binding-manager";
import { ToolboxSettings } from "./settings/toolbox-settings";
import { AgentComputerSettings } from "./settings/agent-computer-settings";
import { PageShell } from "./ui/page-shell";
import { CardGrid, FeaturedCard, type CardItem, type FeaturedCardItem } from "./ui/card-grid";
import { GlassIcon } from "./ui/glass-icon";
import { Toggle } from "./ui/form";
import { loadChatAppSettings, saveChatAppSettings } from "@/lib/chat-storage";
import { isSmoothModeEnabled, setSmoothMode } from "@/lib/perf-mode";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";

export const SettingsContext = createContext<{
    setSubpageTitle: (title: string | null) => void;
    setOverrideBack: (action: (() => void) | null) => void;
    setSubpageRightAction: (page: string, action: ReactNode | null) => void;
}>({ setSubpageTitle: () => { }, setOverrideBack: () => { }, setSubpageRightAction: () => { } });

type SettingsPageProps = {
    onClose: () => void;
    onNotice: (msg: string) => void;
};

type SubPage =
    | "main"
    | "api"
    | "voice"
    | "imageGeneration"
    | "presets"
    | "worldbook"
    | "regex"
    | "data"
    | "binding"
    | "identity"
    | "toolbox"
    | "agentComputer"
    | "about";

const SETTINGS_MENU = [
    { id: "api", icon: HardDrive, label: "API 设置", desc: "大模型接口", iconColor: BINDING_ACCENTS.api , glass: "api" },
    { id: "voice", icon: Mic, label: "语音 API", desc: "语音合成", iconColor: BINDING_ACCENTS.voice , glass: "voice" },
    { id: "imageGeneration", icon: Image, label: "图像生成 API", desc: "模型、参考图与提示词", iconColor: CONTENT_APP_ACCENTS.moments , glass: "image-generation" },
    { id: "presets", icon: Fingerprint, label: "预设", desc: "角色预设", iconColor: BINDING_ACCENTS.preset , glass: "presets" },
    { id: "worldbook", icon: Globe, label: "世界书", desc: "世界观设定", iconColor: BINDING_ACCENTS.worldBook , glass: "worldbook" },
    { id: "regex", icon: Database, label: "正则规则", desc: "文本替换", iconColor: BINDING_ACCENTS.regex , glass: "regex" },
    { id: "data", icon: Layers, label: "数据管理", desc: "导入导出", iconColor: BINDING_ACCENTS.api , glass: "data" },
    { id: "binding", icon: Link2, label: "配置绑定", desc: "管理全局默认、角色与应用的配置绑定关系", iconColor: BINDING_ACCENTS.identity , glass: "binding" },
    { id: "toolbox", icon: Wrench, label: "聊天工具箱", desc: "外部工具调用", iconColor: BINDING_ACCENTS.voice , glass: "toolbox" },
    { id: "agentComputer", icon: Laptop, label: "角色电脑", desc: "云端小电脑（自部署）", iconColor: BINDING_ACCENTS.memory , glass: "agent-computer" },
    { id: "identity", icon: UserCircle, label: "用户身份", desc: "个人信息", iconColor: BINDING_ACCENTS.identity , glass: "identity" },
    { id: "about", icon: Info, label: "关于与声明", desc: "版本与协议", iconColor: BINDING_ACCENTS.memory , glass: "about" },
] as const;

const realtimeIconStyle = {
    "--icon-color": CONTENT_APP_ACCENTS.calendar,
} as CSSProperties;

const promptViewerIconStyle = {
    "--icon-color": BINDING_ACCENTS.preset,
} as CSSProperties;

const quickActionIconStyle = {
    "--icon-color": BINDING_ACCENTS.worldBook,
} as CSSProperties;

export function PhoneSettingsApp({ onClose, onNotice }: SettingsPageProps) {
    const [currentPage, setCurrentPage] = useState<SubPage>("main");
    const [subpageTitle, setSubpageTitle] = useState<string | null>(null);
    const [subpageRightActions, setSubpageRightActions] = useState<Record<string, ReactNode>>({});
    const [overrideBack, setOverrideBack] = useState<(() => void) | null>(null);
    const [timeAware, setTimeAware] = useState(true);
    const [smoothMode, setSmoothModeState] = useState(true);
    const [promptViewerEnabled, setPromptViewerEnabled] = useState(false);
    const [quickActionEnabled, setQuickActionEnabled] = useState(false);
    // 角色电脑：施工中弹窗（返回 / 仍要看看）
    const pageBodyRef = useRef<HTMLDivElement | null>(null);

    const defaultTitle = currentPage === "main"
        ? "设置"
        : currentPage === "api" || currentPage === "voice" || currentPage === "imageGeneration" || currentPage === "presets" || currentPage === "worldbook" || currentPage === "regex" || currentPage === "identity"
            ? ""
            : SETTINGS_MENU.find(m => m.id === currentPage)?.label || "设置";
    const title = subpageTitle || defaultTitle;

    const setSubpageRightAction = useCallback((page: string, action: ReactNode | null) => {
        setSubpageRightActions(prev => {
            if (action === null) {
                const next = { ...prev };
                delete next[page];
                return next;
            }
            return { ...prev, [page]: action };
        });
    }, []);

    const handleBack = () => {
        if (overrideBack) {
            overrideBack();
        } else if (currentPage !== "main") {
            setCurrentPage("main");
            setSubpageTitle(null);
            setOverrideBack(null);
        } else {
            onClose();
        }
    };

    const makeCardItem = (item: typeof SETTINGS_MENU[number]): CardItem => ({
        id: item.id,
        icon: item.icon,
        label: item.label,
        desc: item.desc,
        iconColor: item.iconColor,
        glassIcon: item.glass,
        onClick: () => {
            // 施工中：角色电脑先弹提示，可选择仍要看看
            setCurrentPage(item.id as SubPage);
        },
    });

    const handleTimeAwareChange = useCallback((next: boolean) => {
        setTimeAware(next);
        saveChatAppSettings({ ...loadChatAppSettings(), timeAware: next });
        onNotice(next ? "已开启全局真实时间感知" : "已关闭全局真实时间感知");
    }, [onNotice]);

    const handleSmoothModeChange = useCallback((next: boolean) => {
        setSmoothModeState(next);
        setSmoothMode(next);
        onNotice(next ? "已开启流畅模式（关闭实时毛玻璃）" : "已关闭流畅模式");
    }, [onNotice]);

    const handlePromptViewerChange = useCallback((next: boolean) => {
        setPromptViewerEnabled(next);
        saveChatAppSettings({ ...loadChatAppSettings(), promptViewerEnabled: next });
        onNotice(next ? "已开启提示词查看器" : "已关闭提示词查看器");
    }, [onNotice]);

    const handleQuickActionChange = useCallback((next: boolean) => {
        setQuickActionEnabled(next);
        saveChatAppSettings({ ...loadChatAppSettings(), quickActionEnabled: next });
        onNotice(next ? "已开启快捷操作" : "已关闭快捷操作");
    }, [onNotice]);

    const imageGenerationItem = SETTINGS_MENU.find(i => i.id === "imageGeneration")!;
    const imageGenerationFeaturedItem: FeaturedCardItem = {
        id: imageGenerationItem.id,
        icon: imageGenerationItem.icon,
        label: imageGenerationItem.label,
        desc: imageGenerationItem.desc,
        iconColor: imageGenerationItem.iconColor,
        glassIcon: imageGenerationItem.glass,
        onClick: () => setCurrentPage("imageGeneration"),
    };

    const agentComputerItem = SETTINGS_MENU.find(i => i.id === "agentComputer")!;
    const agentComputerFeaturedItem: FeaturedCardItem = {
        id: agentComputerItem.id,
        icon: agentComputerItem.icon,
        label: agentComputerItem.label,
        desc: agentComputerItem.desc,
        iconColor: agentComputerItem.iconColor,
        glassIcon: agentComputerItem.glass,
        onClick: () => setCurrentPage("agentComputer"),
    };

    const bindingItem = SETTINGS_MENU.find(i => i.id === "binding")!;
    const bindingFeaturedItem: FeaturedCardItem = {
        id: bindingItem.id,
        icon: bindingItem.icon,
        label: bindingItem.label,
        desc: bindingItem.desc,
        iconColor: bindingItem.iconColor,
        glassIcon: bindingItem.glass,
        onClick: () => setCurrentPage("binding"),
    };

    const renderSubPage = () => {
        switch (currentPage) {
            case "api":
                return <ApiSettings />;
            case "voice":
                return <VoiceSettings />;
            case "imageGeneration":
                return <ImageGenerationSettings />;
            case "presets":
                return <PresetManager isActive />;
            case "worldbook":
                return <WorldBookManager isActive />;
            case "regex":
                return <RegexManager isActive />;
            case "data":
                return <DataManagement onNotice={onNotice} />;
            case "binding":
                return <BindingManager />;
            case "toolbox":
                return <ToolboxSettings />;
            case "agentComputer":
                return <AgentComputerSettings onNotice={onNotice} />;
            case "identity":
                return <UserIdentitySettings />;
            case "about":
                return <AboutDeclaration />;
            default:
                return null;
        }
    };

    useLayoutEffect(() => {
        pageBodyRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }, [currentPage]);

    // Check for pending mascot navigation mode on mount (stored by desktop-shell)
    useEffect(() => {
        const pending = sessionStorage.getItem("mascot-settings-mode");
        if (pending) {
            sessionStorage.removeItem("mascot-settings-mode");
            if (SETTINGS_MENU.some(m => m.id === pending)) {
                setCurrentPage(pending as SubPage);
            }
        }
    }, []);

    useEffect(() => {
        const settings = loadChatAppSettings();
        setTimeAware(settings.timeAware !== false);
        setSmoothModeState(isSmoothModeEnabled());
        setPromptViewerEnabled(settings.promptViewerEnabled === true);
        setQuickActionEnabled(settings.quickActionEnabled === true);
    }, []);

    // Listen for mascot navigation mode (e.g. jump to worldbook/regex tab)
    useEffect(() => {
        const onMode = (e: Event) => {
            const { mode } = (e as CustomEvent).detail ?? {};
            if (mode && SETTINGS_MENU.some(m => m.id === mode)) {
                setCurrentPage(mode as SubPage);
            }
        };
        window.addEventListener("mascot-navigate-mode", onMode);
        return () => window.removeEventListener("mascot-navigate-mode", onMode);
    }, []);

    // Listen for internal settings tab navigation (e.g. mascot "修改绑定" button)
    useEffect(() => {
        const onNav = (e: Event) => {
            const { page } = (e as CustomEvent).detail ?? {};
            if (page) setCurrentPage(page as SubPage);
        };
        window.addEventListener("settings-navigate", onNav);
        return () => window.removeEventListener("settings-navigate", onNav);
    }, []);

    return (
        <SettingsContext.Provider value={{ setSubpageTitle, setOverrideBack, setSubpageRightAction }}>
            <PageShell title={title} onBack={handleBack} rightAction={currentPage !== "main" ? subpageRightActions[currentPage] : undefined} bodyRef={pageBodyRef}>
                {currentPage === "main" && (
                    <div className="page-menu settings-main-menu">
                        <CardGrid
                            label="API Config"
                            labelClassName="settings-menu-section-title"
                            items={SETTINGS_MENU.filter(item => ["api", "voice"].includes(item.id)).map(makeCardItem)}
                        />
                        <div className="settings-data-rules-section">
                            <h3 className="settings-menu-section-title">Data & Rules</h3>
                            <div className="mt-[10px] flex flex-col gap-3">
                                <CardGrid
                                    items={SETTINGS_MENU.filter(item => ["presets", "worldbook", "regex", "data"].includes(item.id)).map(makeCardItem)}
                                />
                                <FeaturedCard item={bindingFeaturedItem} />
                            </div>
                        </div>
                        <div className="settings-image-generation-section">
                            <h3 className="settings-menu-section-title">Image Generation</h3>
                            <div className="mt-[10px]">
                                <FeaturedCard item={imageGenerationFeaturedItem} />
                            </div>
                        </div>
                        <div>
                            <h3 className="settings-menu-section-title">Connections</h3>
                            <div className="mt-[10px]">
                                <CardGrid
                                    items={SETTINGS_MENU.filter(item => ["toolbox"].includes(item.id)).map(makeCardItem)}
                                />
                            </div>
                            <div className="mt-[10px]">
                                <FeaturedCard item={agentComputerFeaturedItem} />
                            </div>
                        </div>
                        <div className="settings-realtime-section">
                            <h3 className="settings-menu-section-title">Runtime</h3>
                            <div className="app-card card-featured settings-toggle-card">
                                <span className="card-icon card-icon-glass">
                                    <GlassIcon name="time-aware" />
                                </span>
                                <div className="card-featured-body">
                                    <div className="card-featured-label">真实时间感知</div>
                                    <div className="card-featured-desc">控制全局历史事件流中是否注入时间戳</div>
                                </div>
                                <Toggle checked={timeAware} onChange={handleTimeAwareChange} className="settings-toggle-control" />
                            </div>
                            <div className="app-card card-featured settings-toggle-card mt-[10px]">
                                <span className="card-icon card-icon-glass" style={realtimeIconStyle}>
                                    <GlassIcon name="quick-action" />
                                </span>
                                <div className="card-featured-body">
                                    <div className="card-featured-label">流畅模式</div>
                                    <div className="card-featured-desc">关闭实时毛玻璃特效，Android 端默认开启以缓解掉帧</div>
                                </div>
                                <Toggle checked={smoothMode} onChange={handleSmoothModeChange} className="settings-toggle-control" />
                            </div>
                        </div>
                        <div className="settings-tools-section">
                            <h3 className="settings-menu-section-title">Tools</h3>
                            <div className="menu-group settings-tools-menu">
                                <div className="menu-item settings-tools-menu-item">
                                    <span className="card-icon card-icon-glass">
                                        <GlassIcon name="prompt-viewer" />
                                    </span>
                                    <span className="settings-tools-menu-copy">
                                        <span className="menu-label appearance-menu-item-label">提示词查看器</span>
                                        <span className="menu-desc settings-tools-menu-desc">开启后显示悬浮按钮，可查看当前提示词</span>
                                    </span>
                                    <span className="menu-right settings-tools-menu-toggle">
                                        <Toggle checked={promptViewerEnabled} onChange={handlePromptViewerChange} className="settings-toggle-control" />
                                    </span>
                                </div>
                                <div className="menu-item settings-tools-menu-item">
                                    <span className="card-icon card-icon-glass">
                                        <GlassIcon name="quick-action" />
                                    </span>
                                    <span className="settings-tools-menu-copy">
                                        <span className="menu-label appearance-menu-item-label">快捷操作</span>
                                        <span className="menu-desc settings-tools-menu-desc">快速切换 API 与世界书</span>
                                    </span>
                                    <span className="menu-right settings-tools-menu-toggle">
                                        <Toggle checked={quickActionEnabled} onChange={handleQuickActionChange} className="settings-toggle-control" />
                                    </span>
                                </div>
                            </div>
                        </div>
                        <CardGrid
                            label="User"
                            labelClassName="settings-menu-section-title"
                            items={SETTINGS_MENU.filter(item => ["identity", "about"].includes(item.id)).map(makeCardItem)}
                        />
                    </div>
                )}

                {currentPage !== "main" && (
                    // shrink-0：page-body 是 flex 容器，包裹层默认可压缩——内容超一屏时会被压到
                    // 恰好一屏高、卡片从中溢出，底部 padding 落不到内容末尾，最后一张卡贴死滚动边界
                    //（iOS 底部工具栏/安全区一盖就"没放下又滚不动"）。尾部留白 = 原 pb-8 + 安全区。
                    <div className="block min-h-full shrink-0 p-4 box-border" style={{ paddingBottom: "calc(32px + env(safe-area-inset-bottom, 0px))" }}>
                        {renderSubPage()}
                    </div>
                )}
            </PageShell>
        </SettingsContext.Provider>
    );
}
