export function containsChinese(text: string): boolean {
    return /[\u3400-\u9fff]/.test(text);
}

/** 文本是否"看起来是中文"：出现假名/谚文/西里尔/泰文字母即外语；剥掉空白/数字/标点/符号后汉字占比 ≥60% 才算中文 */
export function isMostlyChineseText(text: string): boolean {
    const t = (text || "").trim();
    if (!t) return false;
    if (/[぀-ヿ가-힯Ѐ-ӿ฀-๿]/.test(t)) return false;
    const letters = t.replace(/[\s\d\p{P}\p{S}]/gu, "");
    if (!letters) return false;
    const cjkCount = (letters.match(/[㐀-鿿]/g) ?? []).length;
    return cjkCount / letters.length >= 0.6;
}

/**
 * 通话 TTS 用：从可能含「原文|译文」双语的文本里提取只说出口的原文。
 * 覆盖模型掉格式的三种情况：
 *  - 正常 原文|译文 → 取原文
 *  - 有 | 但解析失败（中文|外语写反、多段|）→ 取第一段非中文内容
 *  - 译文单独换行（外语行紧跟纯中文行）→ 丢掉中文行
 * 实在分不出的行原样保留——说错也比静音强。
 */
export function extractSpeechOriginalText(text: string): string {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const kept: string[] = [];
    for (const line of lines) {
        const pair = splitBilingualText(line);
        if (pair) { kept.push(pair.original); continue; }
        if (line.includes("|")) {
            const segs = line.split("|").map(s => s.trim()).filter(Boolean);
            if (segs.length >= 2) {
                const foreign = segs.find(s => !isMostlyChineseText(s));
                kept.push(foreign ?? segs[0]);
            } else {
                kept.push(segs[0] ?? line);
            }
            continue;
        }
        // 上一行原文外语、本行纯中文 → 大概率是掉了 | 的译文行，跳过
        const prev = kept[kept.length - 1];
        if (prev && isMostlyChineseText(line) && !isMostlyChineseText(prev)) continue;
        kept.push(line);
    }
    return kept.join("\n");
}

/**
 * 显示侧纠偏：模型把顺序写反成 中文|外语 时重排回 外语|中文，
 * 让 splitBilingualText/BilingualTextBlock 照常渲染出双语折叠块。
 */
export function normalizeSwappedBilingualText(text: string): string {
    return text.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || splitBilingualText(trimmed)) return line;
        if (!trimmed.includes("|")) return line;
        const segs = trimmed.split("|").map(s => s.trim()).filter(Boolean);
        if (segs.length !== 2) return line;
        const [a, b] = segs;
        if (isMostlyChineseText(a) && !isMostlyChineseText(b)) return `${b} | ${a}`;
        return line;
    }).join("\n");
}

export function normalizeBilingualTextInput(text: string): string {
    return text.replace(/\\r\\n|\\n|\\r/g, "\n");
}

function splitSegmentedBilingualLine(line: string): { original: string; translated: string } | null {
    const parts = line.split("|").map(part => part.trim());
    if (parts.length < 2 || parts.some(part => !part)) return null;

    if (parts.length === 3) {
        const [originalLabel, mixedLabelAndOriginal, translatedValue] = parts;
        const colonIndex = mixedLabelAndOriginal.search(/[:：]/);
        if (colonIndex > 0 && containsChinese(translatedValue) && !containsChinese(originalLabel)) {
            const translatedLabel = mixedLabelAndOriginal.slice(0, colonIndex + 1).trim();
            const originalValue = mixedLabelAndOriginal.slice(colonIndex + 1).trim();
            if (translatedLabel && originalValue && containsChinese(translatedLabel)) {
                return {
                    original: `${originalLabel}: ${originalValue}`,
                    translated: `${translatedLabel} ${translatedValue}`,
                };
            }
        }
    }

    if (parts.length % 2 !== 0) return null;

    const originalParts: string[] = [];
    const translatedParts: string[] = [];
    let hasNonChineseOriginal = false;

    for (let index = 0; index < parts.length; index += 2) {
        const original = parts[index];
        const translated = parts[index + 1];
        if (!translated || !containsChinese(translated)) return null;
        if (!containsChinese(original)) hasNonChineseOriginal = true;
        originalParts.push(original);
        translatedParts.push(translated);
    }

    if (!hasNonChineseOriginal) return null;
    return {
        original: originalParts.join(" | "),
        translated: translatedParts.join(" | "),
    };
}

export function splitBilingualText(text: string): { original: string; translated: string } | null {
    const trimmed = normalizeBilingualTextInput(text).trim();
    if (!trimmed || trimmed.includes("```") || /<script\b|<style\b/i.test(trimmed)) return null;
    const firstPipe = trimmed.indexOf("|");
    if (firstPipe <= 0) return null;
    if (firstPipe === trimmed.lastIndexOf("|")) {
        const original = trimmed.slice(0, firstPipe).trim();
        const translated = trimmed.slice(firstPipe + 1).trim();
        if (!original || !translated) return null;
        if (!containsChinese(translated)) return null;
        return { original, translated };
    }
    if (trimmed.includes("\n")) {
        const originalLines: string[] = [];
        const translatedLines: string[] = [];
        let bilingualLineCount = 0;

        for (const rawLine of trimmed.split("\n")) {
            const line = rawLine.trim();
            if (!line) {
                originalLines.push("");
                translatedLines.push("");
                continue;
            }

            const linePipe = line.indexOf("|");
            if (linePipe > 0 && linePipe === line.lastIndexOf("|")) {
                const lineOriginal = line.slice(0, linePipe).trim();
                const lineTranslated = line.slice(linePipe + 1).trim();
                if (!lineOriginal || !lineTranslated || !containsChinese(lineTranslated)) return null;
                originalLines.push(lineOriginal);
                translatedLines.push(lineTranslated);
                bilingualLineCount += 1;
                continue;
            }

            if (line.includes("|")) {
                const segmented = splitSegmentedBilingualLine(line);
                if (!segmented) return null;
                originalLines.push(segmented.original);
                translatedLines.push(segmented.translated);
                bilingualLineCount += 1;
                continue;
            }

            originalLines.push(line);
            translatedLines.push(line);
        }

        if (bilingualLineCount === 0) return null;
        const original = originalLines.join("\n").trim();
        const translated = translatedLines.join("\n").trim();
        if (!original || !translated || !containsChinese(translated)) return null;
        return { original, translated };
    }
    const segmented = splitSegmentedBilingualLine(trimmed);
    if (segmented) return segmented;
    return null;
}
