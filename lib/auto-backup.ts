// Web edition does not write a silent backup to the OS Documents folder.
// The browser cannot save a file without a user gesture. Export still works
// from 设置 → 数据管理, which triggers a normal download.

import { kvGet } from "./kv-db";

const PERMISSION_BLOCKED_KEY = "ai_phone_autobackup_perm_blocked";
const LAST_RUN_KEY = "ai_phone_autobackup_last_at";
export const AUTOBACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function getLastAutoBackupAt(): string | null {
    return kvGet(LAST_RUN_KEY);
}

export function isAutoBackupPermissionBlocked(): boolean {
    return kvGet(PERMISSION_BLOCKED_KEY) === "1";
}

export async function maybeRunAutoBackup(): Promise<void> {}

export function startAutoBackupLoop(): void {}
