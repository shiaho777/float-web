export type CalendarOwnerType = "user" | "character";

export type CalendarColorKey =
  | "blue"
  | "green"
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "slate"
  | "lilac";

export type CalendarScheduleItem = {
  id: string;
  date: string;       // YYYY-MM-DD
  weekday: string;    // 周一 ~ 周日
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  location: string;
  title: string;
  /** 事项 emoji 图标（可选，一个 emoji） */
  emoji?: string;
  colorKey: CalendarColorKey;
  source: "manual" | "generated";
  createdAt: string;
  updatedAt: string;
  /** ── 以下为世界日纲扩展字段，全部可选，旧数据原样可读 ── */
  /** 做完这件事后的心情一句话："有点累但挺开心" */
  mood?: string;
  /** 角色的内心想法/备注 */
  note?: string;
  /** 记录图（media-store ref 列表） */
  photoRefs?: string[];
  /** 关联待办 */
  todos?: { text: string; done: boolean }[];
  /** 联动参与者（characterId 列表；含 "__user__" 表示用户在场） */
  participants?: string[];
  /** 命中世界日纲里的事件 id（撮合校正回写） */
  dayEventId?: string;
  /** 忙碌度 0-3：0空闲 1轻度 2忙碌 3深度（回复时机用） */
  busyLevel?: number;
};

/** 世界日纲里的一场角色×角色互动事件 */
export type DailyWorldInteraction = {
  id: string;
  participantIds: string[];   // characterId[]，含 "__user__"
  timeHint: string;           // "下午" 或 "15:00-16:00"
  startTime?: string;         // 撮合后落定的 HH:MM
  endTime?: string;
  place: string;
  what: string;               // "一起去体育馆打羽毛球"
  outcome?: string;           // 撮合后的结果/氛围："258 赢了，约定下周再战"
  generatedContentRefs?: string[]; // 下游已生成内容引用（momentId 等），防重复传播
};

/** 某日世界日纲：一次"世界模拟"的输出，按日期键存 */
export type DailyWorldPlan = {
  id: string;
  date: string;               // YYYY-MM-DD
  weather: string;            // "晴转多云，傍晚有风"
  vibe: string;               // 当日整体氛围/背景一句话
  interactions: DailyWorldInteraction[];
  /** 参与生成的角色 id 集合 */
  characterIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type CalendarWeekPlan = {
  id: string;
  ownerType: CalendarOwnerType;
  ownerId: string;
  weekStart: string; // YYYY-MM-DD, Monday
  items: CalendarScheduleItem[];
  updatedAt: string;
};
