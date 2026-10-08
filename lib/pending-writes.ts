// lib/pending-writes.ts
// 跟踪所有 fire-and-forget 的 IndexedDB 写入，页面隐藏/被杀前 flush 一遍。
// IDB 请求一旦提交给浏览器引擎就会独立完成，真正的丢数据窗口是"缓存已更新、
// put() 还没被 JS 调到"（异步任务被挂起）——把在途 promise 全部等完即可闭合。

const _pending = new Set<Promise<unknown>>();

export function trackWrite<T>(promise: Promise<T>): Promise<T> {
    _pending.add(promise);
    const cleanup = () => { _pending.delete(promise); };
    promise.then(cleanup, cleanup);
    return promise;
}

export function hasPendingWrites(): boolean {
    return _pending.size > 0;
}

export async function flushPendingWrites(): Promise<void> {
    // flush 期间可能有新写入进来，循环直到排空（上限防死循环）。
    for (let i = 0; i < 20 && _pending.size > 0; i++) {
        await Promise.allSettled([..._pending]);
    }
}

// 在页面隐藏时尽量把在途写事务排空。
export function installWriteFlushListeners(): void {
    if (typeof window === "undefined") return;
    const flush = () => { void flushPendingWrites(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
}
