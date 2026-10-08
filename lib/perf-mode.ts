// 流畅模式：禁用全站 backdrop-filter 实时毛玻璃。
// 默认关闭。用户在 设置 → Runtime → 流畅模式 可手动打开。

import { kvGet, kvSet } from "./kv-db";

const KEY = "perf_smooth_mode";

export function isSmoothModeEnabled(): boolean {
    return kvGet(KEY) === "on";
}

export function setSmoothMode(on: boolean): void {
    kvSet(KEY, on ? "on" : "off");
    applyPerfMode();
}

export function applyPerfMode(): void {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("perf-smooth", isSmoothModeEnabled());
}
