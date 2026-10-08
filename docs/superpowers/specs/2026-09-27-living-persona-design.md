# 拟真人格系统 — 设计稿

日期：2026-09-27
状态：待评审
上游讨论：多角色联动日程 → 扩展为「记忆流→反思→人格漂移」全栈拟真架构

## 0. 目标

让每张角色卡在"小手机"里表现得像真人：

- 角色有**自己的生活**（日程），且彼此之间有**互动**
- 经历沉淀为**长期记忆**，记忆能被组织成**链**（经历→总结→反思→性格变化）
- 模型在**空闲时间自主整理记忆**（类比睡眠巩固）
- **随机事件**和后天经历导致**性格漂移**
- 日程/互动/记忆/情绪**映射到聊天、朋友圈、群聊**内容

参考架构：Stanford Generative Agents（memory stream + recency/importance/relevance 检索 + reflection + planning）、MemGPT/Letta（分层记忆 + 自编辑工具）、SillyTavern 社区实践（lorebook 注入、摘要管线——我们已实现等价物）。

## 1. 总体分层

```
Layer 0 经历发生器   日程系统（世界日纲→角色细化→撮合）+ 随机事件
        ↓ 每件经历落成情景记忆（LLM 重要性评分，走主对话模型）
Layer 1 情景记忆流   MemoryEntry + kind + salience + links[]
        ↓ 检索: α·recency + β·salience + γ·relevance
Layer 2 空闲固化     「整理周期」：反思生成 / 去重合并 / 补链 / 修剪
        ↓ reflection 可提议性格漂移
Layer 3 人格状态     PersonaState: traits + mood + 关系阶段（全自动漂移，留证据链）
```

## 2. 数据模型

### 2.1 MemoryEntry 扩展（lib/memory-types.ts）

```ts
MemoryEntry {
  // 既有字段不变
  kind?: "episode" | "summary" | "reflection" | "trait_shift";
    // undefined 视为 "summary"（旧数据兼容）
  salience?: number;    // 1-10 LLM 评分（重要性/poignancy）
  links?: string[];     // derivedFrom：本条目由哪些条目支撑
}
```

- `episode`：单个关键事件（"下午和258在球场打球输了"），`sourceMessageIds` 指回原始记录
- `summary`：叙事压缩（现有行为）
- `reflection`：跨记忆高层推理，links→证据条目
- `trait_shift`：性格漂移记录，links→reflection/episode，metadata 记 trait 变更

### 2.2 PersonaState（新文件 lib/persona-state.ts）

```ts
type PersonaTrait = {
  key: string;                // "黏人度" | "对工作的焦虑" | 自由标签
  delta: number;              // -1..+1 相对原人设的漂移方向和强度
  confidence: number;         // 0-1
  evidenceEntryIds: string[]; // 证据记忆链
  since: string;              // ISO
};

type PersonaState = {
  characterId: string;
  traits: PersonaTrait[];                 // 活跃漂移 ≤8 条，超出按 confidence 淘汰
  moodBaseline?: string;                  // 漂移后的常态心情一句话
  currentMood?: { label: string; causeEntryId?: string; until?: string };
  driftLog: { at: string; change: string; sourceEntryId: string; reverted?: boolean }[];
  updatedAt: string;
};
```

- 漂移**全自动生效**，不弹确认；driftLog 供可视化页展示/单条回滚
- prompt 注入：`base persona` + 漂移增量（"近期她变得：更黏人（证据：连续三天主动分享日常）"）

### 2.3 日程项扩展（lib/calendar-types.ts）

```ts
CalendarScheduleItem {
  // 既有字段不变
  mood?: string;                // 心情标签（烦躁/摸鱼/专注…）
  note?: string;                // 想法备注
  photoRefs?: string[];         // media-store:// 引用（内容寻址）
  todos?: { id: string; text: string; done: boolean }[];
  participants?: string[];      // 互动参与者 characterId / "user"
  worldEventId?: string;        // 关联的 InteractionEvent
  busyLevel?: "free" | "light" | "busy";  // 回复时机用
}
```

### 2.4 DailyWorldPlan（新存储）

```ts
type InteractionEvent = {
  id: string;
  date: string;
  timeRange: [string, string];
  location?: string;
  title: string;
  participantIds: string[];     // characterId[]，可含 "user"
  summary: string;              // "和XX在咖啡馆讨论期末论文"
  outcome?: string;             // 撮合阶段补的结果/情绪
  propagated?: { momentIds?: string[]; chatNotified?: boolean };
};

type DailyWorldPlan = {
  date: string;
  weather?: string;
  sharedContext?: string;       // 当日世界氛围
  randomEvent?: { title: string; affectedIds: string[]; description: string };
  interactions: InteractionEvent[];
  generatedAt: string;
};
```

存 kv：`ai_phone_daily_world_v1` → `Record<date, DailyWorldPlan>`，登记 registerKvMigration + DATA_MODULES（导出兼容）。

### 2.5 权限（character 级，落在 chat/session 设置）

- `scheduleRead`：角色可查看用户行程（注入用户日程摘要）
- `scheduleSelfEdit`：角色可用工具改自己的日程
- `scheduleUserEdit`：角色可用工具改用户日程
- `periodCare`：生理期感知（接线到已有 periodCareContext）

## 3. 子系统设计

### 3.1 情景记忆入库与评分

改 `memory-summarizer.ts` 管线：每次总结运行时，prompt 要求模型除了叙事摘要外，输出**结构化 episode 列表**（每条：内容 + salience 1-10）。一条总结 → 1 个 `summary` 条目 + N 个 `episode` 条目（links → summary id + sourceMessageIds）。

- 评分走**主对话模型**（resolveBinding(characterId) 的 apiConfig，回落 auxiliary）
- 老条目无 salience → 检索时按 importance 字段折算（importance*10）

### 3.2 三维检索（lib/memory-service.ts）

```
score = 0.3·recencyNorm + 0.3·(salience/10) + 0.4·cosineRelevance
```

- recencyNorm = exp(-ageDays/τ)，τ≈7 天
- 无 embedding 时只用 recency+salience（归一化权重）
- 所有 kind 参与检索；reflection/trait_shift 可有轻微加成（高层记忆更该被想起）

### 3.3 空闲固化循环（lib/memory-consolidation.ts，新）

触发器：
- 重要性累积：Σ近期 salience ≥ 阈值（GA 用 ~150）→ 立即反思
- 每日空闲：MediaMaintenanceScheduler 同型——后台空闲 45s+ 启动，间隔 ≥20h
- 手动：记忆页"立即整理"

固化步骤（单角色一轮）：
1. **反思生成**：取近期高 salience 条目 → LLM 产出 ≤3 条 reflection（"X最近…因为…"），每条 links→证据 id
2. **性格漂移评估**：reflections → 可选 traitShift 提案 → 写 trait_shift 条目 + 更新 PersonaState（增量合并，confidence 低的旧 trait 淘汰）
3. **去重/修剪**：向量相似度过高的 long_term/episode 合并（保留 links 并集）
4. **补链**：新 episode 与老条目 embedding 相似 → links 互挂（可视化里形成网）

并发锁沿用 `summarizingSet` 模式。

### 3.4 日程系统（三层）

- **Phase A 世界日纲**：一次调用，用参与角色的第一个 calendar 绑定解析 API（resolveBinding(bindings, firstCharId, "calendar")），辅助绑定兜底。输入：勾选角色的 name+briefPersona+关系摘要+昨天日程概要。输出：weather/sharedContext/randomEvent/interactions[] 骨架。
- **Phase B 角色细化**：每角色一次调用（复用 resolveCalendarAssemblerInput 管线），注入世界日纲+分到的互动骨架 → 产出当日 CalendarScheduleItem[]（含 mood/note/busyLevel/participants/worldEventId）。
- **Phase C 撮合**：一次轻量调用对齐同一 InteractionEvent 在各角色日程里的时间/地点漂移，补 outcome；发现大纲外互动则补记。
- 存取：日项仍落 CalendarWeekPlan（按周聚合结构不变）；DailyWorldPlan 存 kv。老周生成入口保留。
- 失败语义：A 失败→退回各角色独立生成（Phase B 无纲运行）；B 单角色失败→该角色跳过不阻塞；C 失败→互动以大纲原样落库。

### 3.5 传播层

**第一步（上下文注入）**：
- `buildDailyWorldContext(characterId, date)`：今日本人日程 + 涉及本人的互动 + sharedContext + randomEvent
- 注入点：chat（扩展 scheduleSummary）、moments 生成、群聊、follow-up 触发文案
- 用户日程按 scheduleRead 权限决定是否注入

**第二步（到点触发）**：
- follow-up-service 检查角色当前日程项：busyLevel=busy → 延迟到项结束；light/free → 正常
- 互动事件结束时间到达 → 可选自动生成参与角色的朋友圈/后续行为（配置开关，默认关，避免刷消息）

### 3.6 角色自治工具

tool-executor 新增：
- `schedule_read`（看自己/按权限看用户日程）
- `schedule_write`（add/update/delete 自己日程项；scheduleUserEdit 时含用户日程）
- `memory_recall`（按查询主动检索记忆——MemGPT archival_memory_search 等价物）
- `reflect`（主动触发一次反思）

每次 schedule_write 成功 → 聊天里落一条系统小字"XX 更改了行程：…"（复用现有系统消息形态）。

### 3.7 时间感知修复

隔夜续聊错时间的两个根因各修一处：
- **显著"现在"标记**：不依赖预设是否放 {{timeContext}}——每轮请求在用户触发消息后追加一行 `[系统] 当前时间：2026年9月27日 15:40 星期日`（assembler 尾部，preset 无关兜底）
- **跨日分隔符**：历史渲染时按自然日插入 `── 9月26日 ──` 分隔行，让模型看到日期边界而不是连续流水

### 3.8 可视化

- `memory-timeline.tsx` 升级为链式视图：条目按 kind 分色（episode 灰/summary 蓝/reflection 紫/trait 金），点击条目展开 links 证据链（递归显示），顶部加"性格漂移日志"面板（driftLog，可单条撤销）
- 日历明细页：mood chip、想法区、图片（media-store 解析）、待办可勾选清单、互动徽标（"与XX"→跳对方日程视角）
- 月历页叠加经期/排卵期标记（数据源 menstrual-storage 已有）
- 新增「生成今日世界」入口：选日期 + 勾选角色 → 分阶段进度展示

## 4. 兼容性

- `MemoryEntry.kind/salience/links` 全可选，旧导出/旧库记录原样可读；无 salience 的老条目按 importance 折算
- `CalendarScheduleItem` 新字段全可选；旧 item 直接渲染（无 mood/note 不显示）
- `asset://`/dataURL 图片字段继续双协议读
- 日程周结构不变（CalendarWeekPlan），日生成只是按 date 填充
- 新 kv key 全部 registerKvMigration + DATA_MODULES 登记
- 性格漂移不回写 character.personality 原文——人设卡保持用户原版，漂移是覆盖层

## 5. 成本策略

- 评分/反思/撮合全部可走辅助 API 绑定回落；重要性评分按用户决策走主对话模型
- Phase B 并发上限 2-3（避免几十张卡同时打满）
- episode 抽取与摘要同一次调用内完成（不增加调用次数，只改输出格式）

## 6. 实施阶段（每阶段独立交付可用）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 记忆流升级 | kind/salience/links 字段、episode 抽取、三维检索 | 记忆页能看到 episode+链 |
| P2 空闲固化 | 反思生成、去重、trait_shift、PersonaState、漂移注入 | 跑一晚看到 reflection+漂移 |
| P3 日程联动 | 字段扩展、三层生成、DailyWorldPlan、UI 明细 | 能生成多人互动日程 |
| P4 传播+自治 | 注入扩散、权限开关、角色工具、到点触发、时间修复 | 角色按日程回消息/自主改行程 |

## 7. 不做的事

- 不引入向量数据库（IndexedDB+cosine 足够，量没到）
- 不做记忆遗忘曲线自动删除（只合并不删——用户数据安全第一）
- 不改导出格式 schema（新字段可选，老备份无损导入）
- 不搞多 Agent 对谈仿真（群聊引擎已有，日程只做注入源）
