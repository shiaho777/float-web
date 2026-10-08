// lib/file-picker.ts
// 统一的文件选择入口。
//
// 为什么不能 document.createElement("input").click() 直接用：
// Android WebView 的 onShowFileChooser 需要 input 挂在 DOM 里（游离节点拿不到
// frame，选择器静默不弹，还可能报 "File chooser dialog can only be shown with
// a user activation"）。custom-app-runner 里已有的正确写法是先挂到 body 再 click，
// 这里把同一模式抽成公共函数。

export type PickFileOptions = {
    accept?: string;
    multiple?: boolean;
};

/** 弹出系统文件选择器，resolve 选中的文件；用户取消时 resolve []。 */
export function pickFiles(options: PickFileOptions = {}): Promise<File[]> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        if (options.accept) input.accept = options.accept;
        if (options.multiple) input.multiple = true;
        input.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0";
        document.body.appendChild(input);

        let settled = false;
        const finish = (files: File[]) => {
            if (settled) return;
            settled = true;
            window.removeEventListener("focus", onWindowFocus, true);
            input.remove();
            resolve(files);
        };
        const onWindowFocus = () => {
            // 选择器收起回到本页但 onchange 没触发 → 用户取消
            window.setTimeout(() => finish([]), 400);
        };

        input.onchange = () => finish(Array.from(input.files ?? []));
        // 兜底：极端情况下事件丢失也不让 Promise 悬挂
        window.addEventListener("focus", onWindowFocus, true);
        input.click();
    });
}

export async function pickFile(accept?: string): Promise<File | null> {
    const files = await pickFiles({ accept });
    return files[0] ?? null;
}
