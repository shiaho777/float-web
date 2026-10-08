# P1 记忆流升级 实现计划

> Goal：把记忆系统从「攒N条事件→一段摘要」升级为 Generative Agents 式记忆流——episode 级条目、LLM 重要性评分、记忆链接、三维检索。
> 验证基建：本项目无测试框架/无 git，每个任务以 `npx tsc --noEmit` + 相关路径人工核查为验收。

## Global Constraints

- MemoryEntry 新字段全部可选，旧数据/旧导出零迁移兼容
- 评分/抽取走主对话模型：resolveBinding(bindings, characterId) → 回落 resolveAuxiliaryApiConfig("memorySummaryApiConfigId")
- 不删任何旧条目；kind 缺省视为 "summary"
- 检索公式：score = 0.3·recency + 0.3·salienceNorm + 0.4·relevance；无 embedding 时退化为 recency+salience 归一化

---

### Task 1: MemoryEntry 扩展类型 + 辅助函数

**Files:** Modify `lib/memory-types.ts`

- [ ] 加 `MemoryKind = "episode" | "summary" | "reflection" | "trait_shift"`
- [ ] MemoryEntry 增 `kind?: MemoryKind; salience?: number; links?: string[]`
- [ ] 导出 `memoryKindOf(e): MemoryKind`（e.kind ?? "summary"）、`effectiveSalience(e): number`（e.salience ?? round(e.importance*10) clamp 1..10）
- [ ] `npx tsc --noEmit` 通过

### Task 2: 结构化总结输出（episode 抽取 + salience + links）

**Files:** Modify `lib/memory-types.ts`（新默认 prompt）、`lib/memory-summarizer.ts`

- [ ] 新 `DEFAULT_SUMMARIZATION_PROMPT_V2`：要求输出 `SUMMARY:` 段 + 多行 `EPISODE|<1-10>|<一句话事件>`，保留 {{char}}/{{earliest}}/{{latest}}/{{events}} 占位
- [ ] `parseSummarizationOutput(raw)`：提取 summary 文本 + episodes[{salience,content}]；无 EPISODE 行 → 旧格式兜底（整段当 summary）
- [ ] runSummarizationPipeline：API 解析改为 resolveBinding(loadBindingConfig(), characterId) 主绑定优先 → resolveAuxiliaryApiConfig 兜底；保存 summary 条目（kind:"summary"）+ 每 episode 一条（kind:"episode", salience, links:[summaryId], sourceMessageIds 沿用）; episode 逐条 embedding（vectorRecallEnabled 时）
- [ ] `npx tsc --noEmit` 通过

### Task 3: 三维检索（memory-service.ts）

- [ ] `retrieveMemoriesForPrompt`：复合分 `0.3·exp(-ageDays/7) + 0.3·salience/10 + 0.4·cosine`；无 embedding 走 `0.5·recency + 0.5·salienceNorm`；token 预算填充逻辑不动
- [ ] reflection/trait_shift 类型检索权重 +10%（高层记忆优先）
- [ ] `npx tsc --noEmit` 通过

### Task 4: 记忆链解析助手

**Files:** Create `lib/memory-graph.ts`

- [ ] `buildMemoryIndex(entries)` → Map<id, entry>
- [ ] `resolveEvidenceChain(entry, index)` → 递归 links 收集祖先条目（防环 visited set）
- [ ] `resolveDerivedChain(entryId, entries)` → 反向：谁的 links 含此 id（descendants）
- [ ] `npx tsc --noEmit` 通过

### Task 5: 时间轴页链式可视化

**Files:** Modify `components/memory/memory-timeline.tsx`

- [ ] 条目渲染按 kind 着色/加标（episode=事件、summary=摘要、reflection=反思、trait_shift=漂移）
- [ ] 有 links 的条目可展开证据链（resolveEvidenceChain）
- [ ] trait_shift/reflection 显示证据计数徽标
- [ ] `npx tsc --noEmit` + `npm run build` 通过
