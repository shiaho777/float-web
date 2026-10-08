// lib/memory-graph.ts
// 记忆链解析：MemoryEntry.links 是 derivedFrom 边（本条目由谁支撑）。
// 这里提供两个方向的遍历——证据链（向上）与衍生链（向下），供可视化与固化用。

import type { MemoryEntry } from "./memory-types";

export type MemoryIndex = Map<string, MemoryEntry>;

export function buildMemoryIndex(entries: MemoryEntry[]): MemoryIndex {
    return new Map(entries.map(e => [e.id, e]));
}

/** 向上追溯：返回本条目的全部祖先证据（BFS，防环），按距离近→远排列。 */
export function resolveEvidenceChain(entry: MemoryEntry, index: MemoryIndex): MemoryEntry[] {
    const visited = new Set<string>([entry.id]);
    const out: MemoryEntry[] = [];
    const queue = [...(entry.links ?? [])];
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const target = index.get(id);
        if (!target) continue;
        out.push(target);
        queue.push(...(target.links ?? []));
    }
    return out;
}

/** 向下追踪：返回以本条目为证据的衍生条目（谁 links→我），含间接后代。 */
export function resolveDerivedChain(entry: MemoryEntry, entries: MemoryEntry[]): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    const visited = new Set<string>([entry.id]);
    let frontier = [entry.id];
    while (frontier.length) {
        const next: string[] = [];
        for (const candidate of entries) {
            if (visited.has(candidate.id)) continue;
            if ((candidate.links ?? []).some(l => frontier.includes(l))) {
                visited.add(candidate.id);
                out.push(candidate);
                next.push(candidate.id);
            }
        }
        frontier = next;
    }
    return out;
}

/** 链路视图节点：一个条目 + 以它为证据的直接衍生条目（最多 2 层） */
export type MemoryChainNode = {
    entry: MemoryEntry;
    children: MemoryChainNode[];
};

export type MemoryChainView = {
    /** 链头：reflection / trait_shift / 有衍生条目的 summary，按层级高→低、新→旧 */
    heads: MemoryChainNode[];
    /** 未挂链的散点（孤儿 episode / 旧式 summary） */
    orphans: MemoryEntry[];
};

/** 把扁平条目组织成证据链树，供可视化页渲染。
 *  方向：entry.links = derivedFrom（我由谁支撑）→ 链头向下展开出证据子树。 */
export function buildChainTree(entries: MemoryEntry[], maxDepth = 3): MemoryChainView {
    const index = buildMemoryIndex(entries);
    const childMap = new Map<string, MemoryEntry[]>();
    for (const e of entries) {
        for (const l of e.links ?? []) {
            if (!index.has(l)) continue;
            const list = childMap.get(l) ?? [];
            list.push(e);
            childMap.set(l, list);
        }
    }

    const build = (entry: MemoryEntry, depth: number, visited: Set<string>): MemoryChainNode => {
        if (depth >= maxDepth || visited.has(entry.id)) return { entry, children: [] };
        const nextVisited = new Set(visited).add(entry.id);
        const kids = (childMap.get(entry.id) ?? [])
            .filter(k => !nextVisited.has(k.id))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map(k => build(k, depth + 1, nextVisited));
        return { entry, children: kids };
    };

    const rank = (e: MemoryEntry) =>
        e.kind === "trait_shift" ? 3
        : e.kind === "reflection" ? 2
        : e.kind === "summary" && (childMap.get(e.id)?.length ?? 0) > 0 ? 1
        : 0;

    const heads = entries
        .filter(e => rank(e) > 0)
        .sort((a, b) => rank(b) - rank(a) || b.createdAt.localeCompare(a.createdAt))
        .map(e => build(e, 0, new Set()));

    const inTree = new Set<string>();
    const mark = (n: MemoryChainNode) => { inTree.add(n.entry.id); n.children.forEach(mark); };
    heads.forEach(mark);
    // 散点：不在任何树里、也不是链头
    const orphans = entries
        .filter(e => !inTree.has(e.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return { heads, orphans };
}

// ── 记忆健康诊断 ──────────────────────────────
// 只体检不删数据：把"可能出问题"的形态列出来交给用户/调用方决定。
// repairDanglingLinks 是唯一修复动作——摘掉指向不存在条目的死链（写操作、不删条目）。

export type MemoryHealthReport = {
    total: number;
    /** links 指向不存在条目的死链总数（可修复） */
    danglingLinks: { entry: MemoryEntry; missingIds: string[] }[];
    /** 同角色 + 规范化内容完全相同的重复条目（可能由重复总结产生） */
    duplicateGroups: MemoryEntry[][];
    /** episode 类型但完全没挂链的散点——不算坏，只提示链覆盖率 */
    unlinkedEpisodes: MemoryEntry[];
    /** 角色 id 不在已知角色集合里的条目（角色已删但记忆还在） */
    foreignCharacterEntries: MemoryEntry[];
    /** 空内容条目 */
    emptyContent: MemoryEntry[];
};

const normalizeForDup = (s: string) => s.replace(/\s+/g, "").trim();

export function diagnoseMemoryHealth(
    entries: MemoryEntry[],
    validCharacterIds?: Set<string>,
): MemoryHealthReport {
    const index = buildMemoryIndex(entries);
    const danglingLinks: MemoryHealthReport["danglingLinks"] = [];
    const dupMap = new Map<string, MemoryEntry[]>();
    const unlinkedEpisodes: MemoryEntry[] = [];
    const foreignCharacterEntries: MemoryEntry[] = [];
    const emptyContent: MemoryEntry[] = [];

    const linkedAsEvidence = new Set<string>();
    for (const e of entries) for (const l of e.links ?? []) linkedAsEvidence.add(l);

    for (const e of entries) {
        if (!e.content?.trim()) emptyContent.push(e);
        const missing = (e.links ?? []).filter(l => !index.has(l));
        if (missing.length) danglingLinks.push({ entry: e, missingIds: missing });
        if (e.kind === "episode" && !(e.links?.length) && !linkedAsEvidence.has(e.id)) unlinkedEpisodes.push(e);
        if (validCharacterIds && e.characterId && !validCharacterIds.has(e.characterId)) foreignCharacterEntries.push(e);
        const key = `${e.characterId ?? ""}|${normalizeForDup(e.content ?? "")}`;
        if (e.content?.trim()) {
            const list = dupMap.get(key) ?? [];
            list.push(e);
            dupMap.set(key, list);
        }
    }
    const duplicateGroups = [...dupMap.values()].filter(g => g.length > 1);
    return { total: entries.length, danglingLinks, duplicateGroups, unlinkedEpisodes, foreignCharacterEntries, emptyContent };
}

/** 摘掉死链：返回被修改过的条目（供调用方持久化），不产生删除。 */
export function repairDanglingLinks(entries: MemoryEntry[]): MemoryEntry[] {
    const index = buildMemoryIndex(entries);
    const changed: MemoryEntry[] = [];
    for (const e of entries) {
        const live = (e.links ?? []).filter(l => index.has(l));
        if (live.length !== (e.links?.length ?? 0)) {
            e.links = live.length ? live : undefined;
            changed.push(e);
        }
    }
    return changed;
}
