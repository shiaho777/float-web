"use client";

// 空闲记忆固化调度器：App 前台运行时每 30 分钟 tick 一次，
// 逐角色走 maybeRunConsolidation 水位线门控（距上次 ≥6h 且新记忆够重要才真跑）。
// "空闲时自己整理记忆" 的落点——不跟总结管线强耦合，长时间不聊天也会沉淀旧记忆。

import { useEffect } from "react";
import { runConsolidationSweep } from "@/lib/memory-consolidation";
import { loadCharacters } from "@/lib/character-storage";

const TICK_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000;

export function MemoryConsolidationScheduler() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let intervalHandle: number | null = null;

    const tick = () => {
      if (cancelled) return;
      const characters = loadCharacters().map(c => ({ id: c.id, name: c.name }));
      if (!characters.length) return;
      void runConsolidationSweep(characters).catch((error) => {
        console.warn("[MemoryConsolidationScheduler] sweep failed:", error);
      });
    };

    const startHandle = window.setTimeout(() => {
      if (cancelled) return;
      tick();
      intervalHandle = window.setInterval(tick, TICK_MS);
    }, STARTUP_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(startHandle);
      if (intervalHandle !== null) window.clearInterval(intervalHandle);
    };
  }, []);

  return null;
}
