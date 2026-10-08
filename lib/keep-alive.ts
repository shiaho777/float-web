// Web edition: the tab stays alive only while it is open.
// The Android foreground service is not part of this build.
// Callers still acquire and release so chat, image, and check-phone jobs
// share one code path.

export function acquireGenerationKeepAlive(_label?: string): () => void {
    return () => {};
}

export async function withGenerationKeepAlive<T>(_label: string, task: () => Promise<T>): Promise<T> {
    return task();
}
