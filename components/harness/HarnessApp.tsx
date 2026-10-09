import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";

import {
  Button,
  IconCloseOutlineRegular,
  IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  Modal,
  SegmentedControl,
  Tag,
  Toast,
  Tooltip,
} from "@/vendor/dsh/primitives/index.ts";
import {
  IconArchiveOutlineRegular,
  IconBranchOutlineRegular,
  IconClockOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconDatabaseOutlineRegular,
  IconDeliverDocRegular,
  IconEditOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconGlobeOutlineRegular,
  IconGoalOutlineRegular,
  IconInspectOutlineRegular,
  IconLightOutlineRegular,
  IconListPenOutlineRegular,
  IconMicrophoneOutlineRegular,
  IconPlayOutlineRegular,
  IconPluginPinwheelOutlineRegular,
  IconSettingsOutlineRegular,
  IconSkillOutlineRegular,
  IconSparkleRegular,
  IconUserOutlineRegular,
  IconUsersOutlineRegular,
  IconWorkspaceTreeOutlineRegular,
} from "@/vendor/dsh/primitives/icons/index.tsx";
import "@/vendor/dsh/theme/base.css";
import "@/vendor/dsh/theme/brand-font.css";
import "@/vendor/dsh/theme/corner-shape.css";
import "@/vendor/dsh/theme/design-platform.css";
import "@/vendor/dsh/theme/focus.css";
import "@/vendor/dsh/theme/scrollbar.css";

import { bgTimerCleanup } from "@/lib/bg-timer";
import { loadCharacters } from "@/lib/character-storage";
import { evaluateTierAdjustments } from "@/lib/character-tier";
import { CHAT_MESSAGE_PUSHED_EVENT, createOrGetSession, hydrateChatStorage, loadChatSessions, type ChatSession } from "@/lib/chat-storage";
import { CHAT_OPEN_SESSION_EVENT } from "@/lib/chat-notification-events";
import { installChatSoundListener } from "@/lib/chat-sound";
import { deleteDatabase } from "@/lib/data-management/idb";
import { startDiaryEntryTimerService, stopDiaryEntryTimerService } from "@/lib/diary-entry-timer-service";
import { hydrateDwellingStorage } from "@/lib/dwelling-storage";
import { hydrateCheckPhoneStorage } from "@/lib/checkphone-storage";
import { startFollowUpService, stopFollowUpService } from "@/lib/follow-up-service";
import { hydrateKvDb, kvGet, kvKeysWithPrefix, kvRemove, kvSet } from "@/lib/kv-db";
import { startMomentsService, stopMomentsService } from "@/lib/moments-engine";
import { resolveCharacterPresence } from "@/lib/presence-engine";
import { loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { ensureGlobalBindingDefaults } from "@/lib/settings-storage";
import { hydrateSettingsDb } from "@/lib/settings-db";
import { hydrateMomentsStorage } from "@/lib/moments-storage";
import { hydrateStoryStorage } from "@/lib/story-storage";
import { hydrateVnStorage } from "@/lib/vn-storage";

import "./harness.css";

const PhoneCharacterApp = lazy(() => import("@/components/phone-character-app").then(m => ({ default: m.PhoneCharacterApp })));
const PhoneSettingsApp = lazy(() => import("@/components/phone-settings-app").then(m => ({ default: m.PhoneSettingsApp })));
const ChatRoom = lazy(() => import("@/components/chat/chat-room").then(m => ({ default: m.ChatRoom })));
const MusicApp = lazy(() => import("@/components/music/music-app"));
const PhoneCalendarApp = lazy(() => import("@/components/calendar-app").then(m => ({ default: m.PhoneCalendarApp })));
const PhoneQaApp = lazy(() => import("@/components/phone-qa-app").then(m => ({ default: m.PhoneQaApp })));
const DiaryApp = lazy(() => import("@/components/diary/diary-app").then(m => ({ default: m.DiaryApp })));
const XiaohongshuApp = lazy(() => import("@/components/xiaohongshu/xiaohongshu-app").then(m => ({ default: m.XiaohongshuApp })));
const StoryApp = lazy(() => import("@/components/story/story-app").then(m => ({ default: m.StoryApp })));
const VnApp = lazy(() => import("@/components/vn/vn-app").then(m => ({ default: m.VnApp })));
const ReadingApp = lazy(() => import("@/components/reading/reading-app"));
const MapApp = lazy(() => import("@/components/map/map-app"));
const FindMyApp = lazy(() => import("@/components/findmy/findmy-app"));
const DwellingApp = lazy(() => import("@/components/dwelling/dwelling-app").then(m => ({ default: m.DwellingApp })));
const PhoneResourcesApp = lazy(() => import("@/components/phone-resources-app").then(m => ({ default: m.PhoneResourcesApp })));
const CheckPhoneApp = lazy(() => import("@/components/checkphone/checkphone-app").then(m => ({ default: m.CheckPhoneApp })));
const ShoppingApp = lazy(() => import("@/components/shopping/shopping-app").then(m => ({ default: m.ShoppingApp })));
const GameHubApp = lazy(() => import("@/components/game/game-hub-app").then(m => ({ default: m.GameHubApp })));
const MixologyApp = lazy(() => import("@/components/mixology/mixology-app").then(m => ({ default: m.MixologyApp })));
const InterviewMagazineApp = lazy(() => import("@/components/interview/interview-magazine-app"));
const CoCreateApp = lazy(() => import("@/components/cocreate/cocreate-app").then(m => ({ default: m.CoCreateApp })));
const AppMarketApp = lazy(() => import("@/components/app-market/app-market-app").then(m => ({ default: m.AppMarketApp })));
const ResourceHubApp = lazy(() => import("@/components/resource-hub/resource-hub-app").then(m => ({ default: m.ResourceHubApp })));
const CustomAppRunner = lazy(() => import("@/components/app-market/custom-app-runner").then(m => ({ default: m.CustomAppRunner })));
const WorldBuilder = lazy(() => import("@/components/world-builder/WorldBuilder"));

type FunctionId =
  | "chat" | "characters" | "calendar" | "diary" | "moments" | "findmy"
  | "reading" | "music" | "story" | "vn" | "game" | "shopping" | "mixology"
  | "dwelling" | "world" | "map" | "checkphone" | "qa" | "cocreate"
  | "market" | "resources" | "hub" | "magazine" | "appearance" | "settings";

type IconCmp = ComponentType<{ size?: number; className?: string }>;
type FunctionItem = { id: FunctionId; label: string; icon: IconCmp };
type FunctionGroup = { label: string; items: FunctionItem[] };

const GROUPS: FunctionGroup[] = [
  { label: "关系", items: [
    { id: "characters", label: "角色", icon: IconUserOutlineRegular },
    { id: "calendar", label: "日程", icon: IconClockOutlineRegular },
    { id: "diary", label: "手记", icon: IconListPenOutlineRegular },
    { id: "moments", label: "动态", icon: IconSparkleRegular },
    { id: "findmy", label: "位置", icon: IconGlobeOutlineRegular },
  ]},
  { label: "内容", items: [
    { id: "reading", label: "阅读", icon: IconDeliverDocRegular },
    { id: "music", label: "音乐", icon: IconPlayOutlineRegular },
    { id: "story", label: "剧情", icon: IconBranchOutlineRegular },
    { id: "vn", label: "冒险", icon: IconGoalOutlineRegular },
    { id: "game", label: "游戏", icon: IconPluginPinwheelOutlineRegular },
    { id: "shopping", label: "购物", icon: IconArchiveOutlineRegular },
    { id: "mixology", label: "特调", icon: IconSparkleRegular },
    { id: "magazine", label: "访谈", icon: IconMicrophoneOutlineRegular },
  ]},
  { label: "世界", items: [
    { id: "dwelling", label: "栖所", icon: IconFolderOpenOutlineRegular },
    { id: "world", label: "筑境", icon: IconWorkspaceTreeOutlineRegular },
    { id: "map", label: "地图", icon: IconGlobeOutlineRegular },
    { id: "checkphone", label: "查手机", icon: IconInspectOutlineRegular },
  ]},
  { label: "系统", items: [
    { id: "qa", label: "工坊", icon: IconSkillOutlineRegular },
    { id: "cocreate", label: "共创", icon: IconEditOutlineRegular },
    { id: "market", label: "插件", icon: IconCordisPluginOutlineRegular },
    { id: "resources", label: "素材", icon: IconFolderOpenOutlineRegular },
    { id: "hub", label: "资源", icon: IconDatabaseOutlineRegular },
    { id: "appearance", label: "外观", icon: IconLightOutlineRegular },
  ]},
];

const FUNCTION_LABEL = new Map<FunctionId, string>([
  ...GROUPS.flatMap(group => group.items.map(item => [item.id, item.label] as const)),
  ["chat", "会话"],
  ["settings", "设置"],
]);

function applySystemTheme(mode: "system" | "light" | "dark") {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = mode === "dark" || (mode === "system" && systemDark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.documentElement.setAttribute("data-ds-theme-source", mode);
  if (dark) document.body.setAttribute("data-ds-dark-theme", "");
  else document.body.removeAttribute("data-ds-dark-theme");
}

function sessionTitle(session: ChatSession, names: Map<string, string>): string {
  if (session.isGroup) return session.groupName?.trim() || "群聊";
  return session.alias?.trim() || names.get(session.contactId) || "未命名会话";
}

export function HarnessApp() {
  const [ready, setReady] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<FunctionId>("chat");
  const [opened, setOpened] = useState<FunctionId[]>(["chat"]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [visited, setVisited] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [characters, setCharacters] = useState<{ id: string; name: string }[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKey, setNoticeKey] = useState(0);
  const [themeMode, setThemeMode] = useState<"system" | "light" | "dark">("system");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [customAppId, setCustomAppId] = useState<string | null>(null);

  const showNotice = (text: string) => {
    setNotice(text);
    setNoticeKey(key => key + 1);
  };

  const openFunction = useCallback((id: FunctionId) => {
    setCustomAppId(null);
    setActive(id);
    setOpened(prev => prev.includes(id) ? prev : [...prev, id]);
    if (id === "chat") setInspectorOpen(true);
  }, []);

  const openSession = useCallback((id: string) => {
    const session = loadChatSessions().find(item => item.id === id);
    if (!session) return;
    setSessions(loadChatSessions());
    setVisited(prev => prev.some(item => item.id === id) ? prev : [...prev, session]);
    setSessionId(id);
    setCustomAppId(null);
    setActive("chat");
    setOpened(prev => prev.includes("chat") ? prev : [...prev, "chat"]);
    setInspectorOpen(true);
  }, []);

  const refreshCharacters = useCallback(() => {
    const list = loadCharacters();
    setCharacters(list.map(character => ({ id: character.id, name: character.name })));
    setNames(new Map(list.map(character => [character.id, character.name])));
  }, []);

  useEffect(() => {
    applySystemTheme(themeMode);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (themeMode === "system") applySystemTheme("system"); };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeMode]);

  useEffect(() => installChatSoundListener(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !typing) {
        event.preventDefault();
        setCollapsed(value => !value);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n" && !typing) {
        event.preventDefault();
        refreshCharacters();
        setPickerOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshCharacters]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await Promise.all([
          hydrateKvDb(),
          hydrateChatStorage(),
          hydrateSettingsDb(),
          hydrateStoryStorage(),
          hydrateMomentsStorage(),
          hydrateVnStorage(),
          hydrateDwellingStorage(),
          hydrateCheckPhoneStorage(),
        ]);
      } catch (error) {
        console.warn("[harness] storage hydration error:", error);
      }
      if (cancelled) return;
      kvKeysWithPrefix("chat-generating:").forEach(key => kvRemove(key));
      ensureGlobalBindingDefaults();
      evaluateTierAdjustments();
      if (!kvGet("ai_phone_orphan_db_cleaned_v1")) {
        void deleteDatabase("AiPhoneBackupHandleDB");
        kvSet("ai_phone_orphan_db_cleaned_v1", "1");
      }
      refreshCharacters();
      const nextSessions = loadChatSessions();
      setSessions(nextSessions);
      const first = nextSessions[0];
      if (first) {
        setSessionId(first.id);
        setVisited([first]);
      }
      startFollowUpService();
      startMomentsService();
      startDiaryEntryTimerService();
      setReady(true);
    })();
    return () => {
      cancelled = true;
      stopFollowUpService();
      stopMomentsService();
      stopDiaryEntryTimerService();
      bgTimerCleanup();
    };
  }, [refreshCharacters]);

  useEffect(() => {
    const refresh = () => setSessions(loadChatSessions());
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, refresh);
    window.addEventListener("chat-messages-updated", refresh);
    return () => {
      window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, refresh);
      window.removeEventListener("chat-messages-updated", refresh);
    };
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (id) openSession(id);
    };
    window.addEventListener(CHAT_OPEN_SESSION_EVENT, onOpen);
    return () => window.removeEventListener(CHAT_OPEN_SESSION_EVENT, onOpen);
  }, [openSession]);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...sessions].sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt));
    if (!needle) return sorted;
    return sorted.filter(session => sessionTitle(session, names).toLowerCase().includes(needle)
      || (session.lastMessagePreview ?? "").toLowerCase().includes(needle));
  }, [names, query, sessions]);

  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return GROUPS;
    return GROUPS
      .map(group => ({ ...group, items: group.items.filter(item => item.label.toLowerCase().includes(needle) || group.label.toLowerCase().includes(needle)) }))
      .filter(group => group.items.length > 0);
  }, [query]);

  const activeSession = sessions.find(session => session.id === sessionId) ?? visited.find(session => session.id === sessionId) ?? null;
  const presence = activeSession && !activeSession.isGroup ? resolveCharacterPresence(activeSession.contactId) : null;
  const showRight = inspectorOpen && active === "chat" && activeSession != null && customAppId == null;

  const close = () => openFunction("chat");

  const forgetSession = (id: string) => {
    setVisited(prev => prev.filter(item => item.id !== id));
    const next = loadChatSessions();
    setSessions(next);
    setSessionId(prev => prev === id ? (next[0]?.id ?? null) : prev);
    if (next[0] && sessionId === id) {
      setVisited(prev => prev.some(item => item.id === next[0].id) ? prev.filter(item => item.id !== id) : [...prev.filter(item => item.id !== id), next[0]]);
    }
  };

  const startWithCharacter = (contactId: string) => {
    const session = createOrGetSession(contactId);
    setPickerOpen(false);
    openSession(session.id);
  };

  return (
    <div
      className="harness-frame"
      data-collapsed={collapsed ? "1" : "0"}
      style={{ ["--harness-right" as string]: showRight ? "360px" : "0px" }}
    >
      <aside className="harness-sidebar">
        <div className="harness-side-head">
          <Tooltip label={collapsed ? "展开侧栏" : "折叠侧栏"} side="right" delayMs={400} portal>
            <Button variant="toolbar" size="sm" aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} aria-keyshortcuts="Meta+B Control+B" onClick={() => setCollapsed(value => !value)} icon={<IconPanelLeftOutlineRegular size={16} />} />
          </Tooltip>
          <span className="harness-brand wide-only">float</span>
        </div>
        <div className="harness-new-row">
          <Button className="harness-new" variant="primary" size="sm" aria-label="新会话" onClick={() => { refreshCharacters(); setPickerOpen(true); }} icon={<IconNewChatOutlineRegular size={16} />}>
            <span className="harness-new-label wide-only">新会话</span>
          </Button>
        </div>
        <div className="harness-side-search wide-only">
          <Input value={query} placeholder="搜索会话或功能" aria-label="搜索会话或功能" onChange={event => setQuery(event.target.value)} icon={<IconSearchOutlineRegular size={16} />} />
        </div>
        <div className="harness-sessions wide-only" data-empty={filteredSessions.length === 0 ? "1" : "0"}>
          {filteredSessions.map(session => {
            const title = sessionTitle(session, names);
            const selected = active === "chat" && session.id === sessionId;
            return (
              <button
                key={session.id}
                type="button"
                className="harness-session"
                data-active={selected ? "1" : "0"}
                aria-current={selected ? "page" : undefined}
                onClick={() => openSession(session.id)}
              >
                <span className="harness-session-title">
                  {session.isGroup ? <IconUsersOutlineRegular size={14} /> : null}
                  <span>{title}</span>
                  {session.unreadCount > 0 ? <Tag tone="info">{session.unreadCount}</Tag> : null}
                </span>
                <span className="harness-session-preview">{session.lastMessagePreview || "还没有消息"}</span>
              </button>
            );
          })}
          {ready && filteredSessions.length === 0 ? <p className="harness-meta">没有匹配的会话。</p> : null}
        </div>
        <div className="harness-side-groups">
          {filteredGroups.map(group => (
            <div key={group.label}>
              <div className="harness-group-label wide-only">{group.label}</div>
              {group.items.map(item => (
                <NavButton
                  key={item.id}
                  label={item.label}
                  icon={item.icon}
                  active={active === item.id && customAppId == null}
                  collapsed={collapsed}
                  onClick={() => openFunction(item.id)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="harness-foot">
          {activeSession ? (
            <NavButton
              label={inspectorOpen ? "收起详情" : "会话详情"}
              icon={IconInspectOutlineRegular}
              active={showRight}
              collapsed={collapsed}
              onClick={() => { openFunction("chat"); setInspectorOpen(value => !value); }}
            />
          ) : null}
          <NavButton
            label="设置"
            icon={IconSettingsOutlineRegular}
            active={active === "settings"}
            collapsed={collapsed}
            onClick={() => openFunction("settings")}
          />
        </div>
      </aside>

      <section className="harness-center">
        <div className="harness-stage">
          {!ready ? <div className="harness-empty">正在打开本地数据</div> : null}
          {visited.map(session => (
            <div
              key={session.id}
              className="harness-pane"
              hidden={active !== "chat" || session.id !== sessionId || customAppId != null}
              data-surface="conversation"
            >
              <Suspense fallback={<div className="harness-empty">正在打开这场对话</div>}>
                <ChatRoom
                  session={session}
                  embedded
                  onBack={() => openFunction("chat")}
                  onDeleted={() => forgetSession(session.id)}
                />
              </Suspense>
            </div>
          ))}
          {ready && active === "chat" && visited.length === 0 ? (
            <div className="harness-page">
              <h1>会话</h1>
              <p>从左侧打开一场对话，或先去角色里认识一个人。</p>
              <div className="harness-page-actions">
                <Button variant="primary" onClick={() => { refreshCharacters(); setPickerOpen(true); }} icon={<IconNewChatOutlineRegular size={16} />}>新会话</Button>
                <Button variant="outline" onClick={() => openFunction("characters")}>去角色</Button>
              </div>
            </div>
          ) : null}
          <ToolPane id="characters" active={active} opened={opened} blocked={customAppId != null}><PhoneCharacterApp onClose={close} onNotice={showNotice} /></ToolPane>
          <ToolPane id="calendar" active={active} opened={opened} blocked={customAppId != null}><PhoneCalendarApp onClose={close} onNotice={showNotice} /></ToolPane>
          <ToolPane id="diary" active={active} opened={opened} blocked={customAppId != null}><DiaryApp onClose={close} onNotice={showNotice} /></ToolPane>
          <ToolPane id="moments" active={active} opened={opened} blocked={customAppId != null}><XiaohongshuApp onClose={close} onNotice={showNotice} visible={active === "moments"} /></ToolPane>
          <ToolPane id="findmy" active={active} opened={opened} blocked={customAppId != null}><FindMyApp onClose={close} /></ToolPane>
          <ToolPane id="reading" active={active} opened={opened} blocked={customAppId != null}><ReadingApp onClose={close} /></ToolPane>
          <ToolPane id="music" active={active} opened={opened} blocked={customAppId != null}><MusicApp onClose={close} /></ToolPane>
          <ToolPane id="story" active={active} opened={opened} blocked={customAppId != null}><StoryApp onClose={close} /></ToolPane>
          <ToolPane id="vn" active={active} opened={opened} blocked={customAppId != null}><VnApp onClose={close} /></ToolPane>
          <ToolPane id="game" active={active} opened={opened} blocked={customAppId != null}><GameHubApp onClose={close} /></ToolPane>
          <ToolPane id="shopping" active={active} opened={opened} blocked={customAppId != null}><ShoppingApp onClose={close} visible={active === "shopping"} /></ToolPane>
          <ToolPane id="mixology" active={active} opened={opened} blocked={customAppId != null}><MixologyApp onClose={close} /></ToolPane>
          <ToolPane id="dwelling" active={active} opened={opened} blocked={customAppId != null}><DwellingApp onClose={close} visible={active === "dwelling"} /></ToolPane>
          <ToolPane id="world" active={active} opened={opened} blocked={customAppId != null}><WorldBuilder /></ToolPane>
          <ToolPane id="map" active={active} opened={opened} blocked={customAppId != null}><MapApp onClose={close} /></ToolPane>
          <ToolPane id="checkphone" active={active} opened={opened} blocked={customAppId != null}><CheckPhoneApp onClose={close} /></ToolPane>
          <ToolPane id="qa" active={active} opened={opened} blocked={customAppId != null}><PhoneQaApp onClose={close} onNotice={showNotice} /></ToolPane>
          <ToolPane id="cocreate" active={active} opened={opened} blocked={customAppId != null}><CoCreateApp onClose={close} onNotice={showNotice} /></ToolPane>
          <ToolPane id="market" active={active} opened={opened} blocked={customAppId != null}>
            <AppMarketApp
              onClose={close}
              onNotice={showNotice}
              onOpenCustomApp={setCustomAppId}
              onInstallToDesktop={app => showNotice(`已装上 ${app.name}`)}
            />
          </ToolPane>
          <ToolPane id="resources" active={active} opened={opened} blocked={customAppId != null}><PhoneResourcesApp onClose={close} onNotice={showNotice} /></ToolPane>
          <ToolPane id="hub" active={active} opened={opened} blocked={customAppId != null}><ResourceHubApp onClose={close} onNotice={showNotice} /></ToolPane>
          <ToolPane id="magazine" active={active} opened={opened} blocked={customAppId != null}><InterviewMagazineApp onClose={close} /></ToolPane>
          <ToolPane id="settings" active={active} opened={opened} blocked={customAppId != null}><PhoneSettingsApp onClose={close} onNotice={showNotice} /></ToolPane>
          {opened.includes("appearance") ? (
            <div className="harness-pane" hidden={active !== "appearance" || customAppId != null}>
              <div className="harness-page">
                <h1>外观</h1>
                <p>工作区使用 DeepSeek Harness 的色板和控件。角色、对话里的自定义样式仍按各自的设置走。</p>
                <SegmentedControl
                  id="harness-appearance"
                  value={themeMode}
                  label="外观"
                  onChange={setThemeMode}
                  options={[
                    { value: "system", label: "系统" },
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                  ]}
                />
                <p className="harness-meta">Command B 或 Ctrl B 折叠侧栏。</p>
              </div>
            </div>
          ) : null}
          {customAppId ? (
            <div className="harness-pane">
              <Suspense fallback={<div className="harness-empty">正在打开</div>}>
                <CustomAppHost appId={customAppId} onClose={() => setCustomAppId(null)} onNotice={showNotice} />
              </Suspense>
            </div>
          ) : null}
        </div>
      </section>

      {showRight && activeSession ? (
        <aside className="harness-right">
          <div className="harness-right-head">
            <h2>{sessionTitle(activeSession, names)}</h2>
            <Button variant="toolbar" size="sm" aria-label="收起详情" onClick={() => setInspectorOpen(false)} icon={<IconCloseOutlineRegular size={14} />} />
          </div>
          <div className="harness-right-tags">
            {activeSession.isGroup ? <Tag tone="neutral">群聊</Tag> : <Tag tone="quiet">单聊</Tag>}
            {activeSession.isPinned ? <Tag tone="info">置顶</Tag> : null}
            {activeSession.unreadCount > 0 ? <Tag tone="warning">{activeSession.unreadCount} 条未读</Tag> : <Tag tone="success">已读</Tag>}
          </div>
          <p>{activeSession.lastMessagePreview || "这场对话还没有留下句子。"}</p>
          <p className="harness-meta">
            {activeSession.isGroup
              ? `${activeSession.participantIds?.length ?? 0} 人在这场群聊里`
              : presence ? `此刻在${presence.place.name}` : "位置还没从日程里推出来"}
          </p>
          <div className="harness-right-actions">
            <Button variant="outline" size="sm" onClick={() => openFunction("characters")}>打开角色</Button>
            <Button variant="ghost" size="sm" onClick={() => openFunction("calendar")}>看日程</Button>
            <Button variant="ghost" size="sm" onClick={() => openFunction("moments")}>看动态</Button>
          </div>
        </aside>
      ) : null}

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="新会话"
        closeLabel="关闭"
        description="选一个角色。已有的对话会直接打开，不会再开一场重复的。"
      >
        <div className="harness-picker">
          {characters.length === 0 ? <p className="harness-meta">还没有角色。</p> : characters.map(character => (
            <button key={character.id} type="button" className="harness-session" onClick={() => startWithCharacter(character.id)}>
              <span className="harness-session-title"><span>{character.name}</span></span>
            </button>
          ))}
        </div>
        <div className="harness-page-actions">
          <Button variant="outline" size="sm" onClick={() => { setPickerOpen(false); openFunction("characters"); }}>去角色里新建</Button>
        </div>
      </Modal>

      {notice ? <Toast key={noticeKey} text={notice} onDone={() => setNotice(null)} /> : null}
    </div>
  );
}

function NavButton(props: { label: string; icon: IconCmp; active: boolean; collapsed: boolean; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <Tooltip label={props.label} side="right" delayMs={400} disabled={!props.collapsed} portal>
      <button
        type="button"
        className="harness-nav-item"
        data-active={props.active ? "1" : "0"}
        aria-label={props.label}
        aria-current={props.active ? "page" : undefined}
        onClick={props.onClick}
      >
        <span className="harness-nav-icon" aria-hidden="true"><Icon size={16} /></span>
        <span className="harness-nav-label wide-only">{props.label}</span>
      </button>
    </Tooltip>
  );
}

function CustomAppHost(props: { appId: string; onClose: () => void; onNotice: (text: string) => void }) {
  const app = loadInstalledCustomApps().find(item => item.id === props.appId);
  if (!app) return <div className="harness-empty">这个插件不在本地。</div>;
  return <CustomAppRunner app={app} onClose={props.onClose} onNotice={props.onNotice} />;
}

function ToolPane(props: { id: FunctionId; active: FunctionId; opened: FunctionId[]; blocked?: boolean; children: ReactNode }) {
  if (!props.opened.includes(props.id)) return null;
  return (
    <div className="harness-pane" hidden={props.active !== props.id || props.blocked === true}>
      <Suspense fallback={<div className="harness-empty">正在打开</div>}>{props.children}</Suspense>
    </div>
  );
}
