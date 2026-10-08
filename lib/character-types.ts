export type Character = {
  id: string;
  name: string;
  avatar: string | null; // data URL 或外部 URL
  persona: string;       // 人设
  briefPersona?: string; // 简量版人设：注入到同世界有关系角色的「角色关系」marker，供对方了解 TA（防 OOC）
  briefPersonaUpdatedAt?: string; // 简介生成时间；早于 updatedAt 时编辑器提示「设定已更新，建议重新生成」
  wechatID?: string;     // 手机号格式的微信号
  personality?: string;    // 角色性格
  skills?: CharacterSkill[];    // 技能模块：索引常驻、正文按触发词激活（人格版世界书）
  automations?: CharacterAutomation[]; // 自动化规则：当条件满足时注入一句提示词（用户级 hooks）
  timeZone?: string;       // IANA 时区，例如 America/New_York；空值表示跟随系统时间
  currency?: string;       // ISO 4217 货币代码，例如 JPY；空值 = 按时区自动推导，推导不出按人民币处理
  tags?: string[];
  /** 戏份层级：main=主角（全量生成日程/日记/互动）；npc=配角（世界背景板，批量简版日程）。
   *  缺省按 tags 里的「配角」推断，推断不出按主角。见 lib/character-tier.ts */
  tier?: "main" | "npc";
  /** 用户在角色卡里手动钉住层级；true 时戏份评估不再自动升降 */
  tierPinned?: boolean;
  createdAt: string;
  updatedAt: string;

  // 画布坐标与渲染属性
  canvasX?: number;
  canvasY?: number;
  canvasRot?: number;
  canvasZIndex?: number;
  polaroidStyle?: number; // 用户选择的拍立得样式索引
};

/** 角色技能模块：Skill 式渐进披露——索引行常驻，正文命中触发词才注入 */
export type CharacterSkill = {
  id: string;
  name: string;            // 索引名，如「吉他曲库」
  description?: string;    // 一句话索引描述（随索引行常驻）
  trigger?: string;        // 逗号分隔触发词；命中最近聊天上下文时注入 content。留空 = 仅索引
  content: string;         // 技能正文（按需注入的细节）
  enabled?: boolean;       // 缺省 true
};

/** 自动化规则（用户级 hooks）：条件命中 → 注入提示词文本 */
export type CharacterAutomation = {
  id: string;
  name?: string;             // 规则备注名
  enabled?: boolean;         // 缺省 true
  trigger: "always" | "keyword" | "turns" | "state";
  keywords?: string;         // trigger=keyword：逗号分隔触发词
  everyTurns?: number;       // trigger=turns：每 N 条历史消息注入一次
  states?: string;           // trigger=state：逗号分隔会话状态 tag（blocked/offline/voice/video/followup 等）
  text: string;              // 条件命中时注入的提示词
};

export type CanvasBgItem = {
  id: string;
  type: 'a4' | 'yellow-note' | 'blue-note' | 'torn' | 'grid' | 'scrap';
  x: number;
  y: number;
  rot: number;
  zIndex: number;
  worldId?: string; // 所属世界画布；缺省 = 默认世界（存量数据零迁移）
};
