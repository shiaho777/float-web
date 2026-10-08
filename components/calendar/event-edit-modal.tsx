"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ImagePlus, Trash2, X } from "lucide-react";
import { Input } from "../ui/form";
import type { CalendarColorKey } from "@/lib/calendar-types";
import { CALENDAR_COLOR_KEYS } from "@/lib/calendar-utils";
import { storeMediaBlob, loadMediaObjectUrl } from "@/lib/media-cache-storage";

export type CalendarEventDraft = {
  id?: string;
  date: string;
  /** 结束日期（含当天）；留空视为单天。跨多天时保存会按天生成日程 */
  endDate?: string;
  startTime: string;
  endTime: string;
  location: string;
  title: string;
  emoji: string;
  colorKey?: CalendarColorKey;
  /** 心情一句话（世界日纲扩展字段） */
  mood?: string;
  /** 备注/想法 */
  note?: string;
  /** 记录图（media-store ref） */
  photoRefs?: string[];
  /** 待办清单 */
  todos?: { text: string; done: boolean }[];
};

const EMOJI_PRESETS = [
  "📌", "💼", "📚", "💻", "🏃", "🏋️", "🍽️", "☕", "🎬",
  "🎮", "🎵", "🛒", "🛍️", "✈️", "🏥", "📞", "💤", "❤️",
  "🎂", "🎨", "🧹", "🐾",
];

const COLOR_LABELS: Record<CalendarColorKey, string> = {
  blue: "蓝",
  green: "绿",
  amber: "橙",
  rose: "粉",
  violet: "紫",
  teal: "青",
  slate: "灰",
  lilac: "丁香",
};

export function CalendarEventEditModal({
  draft,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  draft: CalendarEventDraft;
  onChange: (next: CalendarEventDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay calendar-edit-modal-overlay" onClick={onClose}>
      <div className="calendar-edit-modal" data-ui="calendar-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" data-ui="modal-header">
          <button onClick={onClose} className="modal-header-btn modal-header-btn-muted" aria-label="返回">
            <ChevronLeft size={18} />
          </button>
          <span className="modal-header-title">{draft.id ? "编辑日程" : "新增日程"}</span>
          <button onClick={onSave} className="modal-header-btn modal-header-btn-action" aria-label="保存">
            <Check size={18} />
          </button>
        </div>

        <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-10" data-ui="modal-body">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">开始日期</label>
              <Input
                type="date"
                value={draft.date}
                onChange={e => {
                  const nextDate = e.target.value;
                  const currentEnd = draft.endDate || draft.date;
                  // 结束日期跟随开始日期，除非用户已把结束日期改到更晚
                  onChange({ ...draft, date: nextDate, endDate: currentEnd > nextDate ? currentEnd : nextDate });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">结束日期</label>
              <Input
                type="date"
                value={draft.endDate || draft.date}
                min={draft.date}
                onChange={e => onChange({ ...draft, endDate: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">开始时间</label>
              <Input
                type="time"
                value={draft.startTime}
                onChange={e => onChange({ ...draft, startTime: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">结束时间</label>
              <Input
                type="time"
                value={draft.endTime}
                onChange={e => onChange({ ...draft, endTime: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">事项</label>
            <Input
              value={draft.title}
              onChange={e => onChange({ ...draft, title: e.target.value })}
              placeholder="例如：部门周会"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">地点</label>
            <Input
              value={draft.location}
              onChange={e => onChange({ ...draft, location: e.target.value })}
              placeholder="例如：公司会议室 / 家里 / 商场"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">心情（可选）</label>
            <Input
              value={draft.mood ?? ""}
              onChange={e => onChange({ ...draft, mood: e.target.value })}
              placeholder="例如：有点累但挺开心"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">备注 / 想法（可选）</label>
            <Input
              value={draft.note ?? ""}
              onChange={e => onChange({ ...draft, note: e.target.value })}
              placeholder="想记下的一句话"
            />
          </div>

          <CalendarPhotoField draft={draft} onChange={onChange} />
          <CalendarTodoField draft={draft} onChange={onChange} />

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">图标（点选，再点一次取消）</label>
            <div className="calendar-emoji-row">
              {draft.emoji && !EMOJI_PRESETS.includes(draft.emoji) ? (
                <button
                  type="button"
                  className="calendar-emoji-preset"
                  data-active="true"
                  onClick={() => onChange({ ...draft, emoji: "" })}
                  aria-label={`取消 ${draft.emoji}`}
                >
                  {draft.emoji}
                </button>
              ) : null}
              {EMOJI_PRESETS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="calendar-emoji-preset"
                  data-active={draft.emoji === emoji ? "true" : undefined}
                  onClick={() => onChange({ ...draft, emoji: draft.emoji === emoji ? "" : emoji })}
                  aria-label={`使用 ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">颜色</label>
            <div className="calendar-color-picker">
              <button
                type="button"
                className="calendar-color-swatch calendar-color-swatch-auto"
                data-active={!draft.colorKey ? "true" : undefined}
                onClick={() => onChange({ ...draft, colorKey: undefined })}
              >
                自动
              </button>
              {CALENDAR_COLOR_KEYS.map(key => (
                <button
                  key={key}
                  type="button"
                  className="calendar-color-swatch"
                  data-color={key}
                  data-active={draft.colorKey === key ? "true" : undefined}
                  onClick={() => onChange({ ...draft, colorKey: key })}
                  aria-label={`颜色：${COLOR_LABELS[key]}`}
                  title={COLOR_LABELS[key]}
                />
              ))}
            </div>
          </div>

          {draft.id ? (
            <button type="button" className="ui-btn ui-btn-outline calendar-delete-btn" onClick={onDelete}>
              <Trash2 size={16} />
              删除该事项
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 记录图字段：上传走 media-store 内容寻址，photoRefs 存 media-store:// 引用。 */
function CalendarPhotoField({
  draft,
  onChange,
}: {
  draft: CalendarEventDraft;
  onChange: (next: CalendarEventDraft) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refs = draft.photoRefs ?? [];

  // 解析 ref → 可显示 URL（原生文件 / objectURL 双协议）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const ref of refs) {
        if (urls[ref]) { next[ref] = urls[ref]; continue; }
        try {
          const url = await loadMediaObjectUrl(ref);
          if (url) next[ref] = url;
        } catch { /* 单张失败不阻塞 */ }
      }
      if (!cancelled) setUrls(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.join(",")]);

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const ref = await storeMediaBlob(file, file.type || "image/jpeg", "image");
      onChange({ ...draft, photoRefs: [...refs, ref] });
    } catch (error) {
      console.warn("[CalendarPhoto] upload failed:", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="menu-desc ml-1">记录图（可选）</label>
      <div className="calendar-photo-row">
        {refs.map(ref => (
          <div key={ref} className="calendar-photo-thumb">
            {urls[ref] ? <img src={urls[ref]} alt="记录图" /> : <i />}
            <button
              type="button"
              aria-label="移除图片"
              onClick={() => onChange({ ...draft, photoRefs: refs.filter(r => r !== ref) })}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="calendar-photo-add"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          aria-label="上传图片"
        >
          <ImagePlus size={16} />
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={e => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleFile(file);
        }}
      />
    </div>
  );
}

/** 待办清单字段：增删 + 勾选状态编辑。 */
function CalendarTodoField({
  draft,
  onChange,
}: {
  draft: CalendarEventDraft;
  onChange: (next: CalendarEventDraft) => void;
}) {
  const todos = draft.todos ?? [];
  const [newTodo, setNewTodo] = useState("");
  const commit = () => {
    const text = newTodo.trim();
    if (!text) return;
    onChange({ ...draft, todos: [...todos, { text, done: false }] });
    setNewTodo("");
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="menu-desc ml-1">待办（可选）</label>
      {todos.map((todo, i) => (
        <div key={i} className="calendar-todo-row">
          <button
            type="button"
            className="calendar-todo-check"
            data-done={todo.done ? "true" : undefined}
            onClick={() => onChange({
              ...draft,
              todos: todos.map((t, j) => j === i ? { ...t, done: !t.done } : t),
            })}
            aria-label={todo.done ? "标记未完成" : "标记完成"}
          >
            {todo.done ? "☑" : "☐"}
          </button>
          <span className={todo.done ? "done" : ""}>{todo.text}</span>
          <button
            type="button"
            className="calendar-todo-del"
            onClick={() => onChange({ ...draft, todos: todos.filter((_, j) => j !== i) })}
            aria-label="删除待办"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="calendar-todo-add">
        <Input
          value={newTodo}
          onChange={e => setNewTodo(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          placeholder="回车添加一条待办"
        />
      </div>
    </div>
  );
}
