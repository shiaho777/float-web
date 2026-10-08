import type { Character } from "./character-types";

/**
 * 角色的「金钱感知」：让不同国家的角色按当地货币的购买力写金额。
 * 日本角色脑子里是「午饭 1500 日元」，不是 RMB 语境下的「15 块」——
 * 之前 prompt 里红包/转账只写 [红包:金额]，模型一律按中文语境的人民币量级猜，
 * 日元角色发个 520 红包就变成了巨款。
 *
 * 解析优先级：角色卡显式 currency → 按 timeZone 推导 → 兜底 CNY（应用内钱包/界面的
 * 默认口径）。prompt 只对非 CNY 的结果注入提示，避免给中文默认场景塞冗余指令。
 */

export type CharacterCurrency = {
    code: string;       // ISO 4217
    nameCn: string;     // 中文名
    symbol: string;     // 展示符号（仅供 prompt 参考与 UI 显示）
    example?: string;   // 购买力锚点，写进提示词帮模型校准量级
};

export const CHARACTER_CURRENCIES: CharacterCurrency[] = [
    { code: "CNY", nameCn: "人民币", symbol: "¥", example: "一顿普通午饭约 15–40 元，一杯奶茶约 15–25 元，红包常见 5.2/52/88/200 元" },
    { code: "JPY", nameCn: "日元", symbol: "¥", example: "一顿普通午饭约 800–2000 日元，一瓶水约 110–160 日元，红包/零花钱常见 1000–5000 日元" },
    { code: "USD", nameCn: "美元", symbol: "$", example: "一顿普通午饭约 12–25 美元，一杯咖啡约 4–8 美元" },
    { code: "EUR", nameCn: "欧元", symbol: "€", example: "一杯咖啡约 2.5–5 欧元，一顿普通午饭约 10–20 欧元" },
    { code: "GBP", nameCn: "英镑", symbol: "£", example: "一杯咖啡约 3–5 英镑，一顿普通午饭约 8–20 英镑" },
    { code: "KRW", nameCn: "韩元", symbol: "₩", example: "一顿普通午饭约 7000–15000 韩元，一杯咖啡约 4500–6000 韩元" },
    { code: "HKD", nameCn: "港币", symbol: "HK$", example: "一顿普通午饭约 40–80 港币，一杯奶茶约 30–40 港币" },
    { code: "TWD", nameCn: "新台币", symbol: "NT$", example: "一顿普通午饭约 80–200 新台币，一杯奶茶约 50–70 新台币" },
    { code: "SGD", nameCn: "新加坡元", symbol: "S$", example: "小贩中心一顿午饭约 4–10 新元" },
    { code: "AUD", nameCn: "澳元", symbol: "A$", example: "一杯咖啡约 4–6 澳元，一顿普通午饭约 12–25 澳元" },
    { code: "CAD", nameCn: "加元", symbol: "C$", example: "一杯咖啡约 4–7 加元" },
    { code: "THB", nameCn: "泰铢", symbol: "฿", example: "一顿路边摊午饭约 50–150 泰铢" },
    { code: "MYR", nameCn: "林吉特", symbol: "RM" },
    { code: "IDR", nameCn: "印尼盾", symbol: "Rp" },
    { code: "INR", nameCn: "印度卢比", symbol: "₹" },
    { code: "AED", nameCn: "阿联酋迪拉姆", symbol: "د.إ" },
    { code: "CHF", nameCn: "瑞士法郎", symbol: "CHF" },
    { code: "RUB", nameCn: "卢布", symbol: "₽" },
    { code: "TRY", nameCn: "土耳其里拉", symbol: "₺" },
    { code: "MXN", nameCn: "墨西哥比索", symbol: "MX$" },
    { code: "BRL", nameCn: "巴西雷亚尔", symbol: "R$" },
];

const CURRENCY_BY_CODE = new Map(CHARACTER_CURRENCIES.map(c => [c.code, c]));

/** 常见时区 → 货币的精确映射；兜不住的前缀规则见下方。 */
const TIMEZONE_TO_CURRENCY: Record<string, string> = {
    "Asia/Shanghai": "CNY", "Asia/Urumqi": "CNY", "Asia/Chongqing": "CNY", "Asia/Harbin": "CNY",
    "Asia/Tokyo": "JPY",
    "Asia/Seoul": "KRW",
    "Asia/Taipei": "TWD",
    "Asia/Hong_Kong": "HKD", "Asia/Macau": "HKD",
    "Asia/Singapore": "SGD",
    "Asia/Bangkok": "THB",
    "Asia/Kuala_Lumpur": "MYR",
    "Asia/Jakarta": "IDR",
    "Asia/Kolkata": "INR", "Asia/Calcutta": "INR",
    "Asia/Dubai": "AED",
    "Europe/London": "GBP", "Europe/Jersey": "GBP", "Europe/Guernsey": "GBP", "Europe/Isle_of_Man": "GBP",
    "Europe/Zurich": "CHF",
    "Europe/Moscow": "RUB",
    "Europe/Istanbul": "TRY",
    "America/Toronto": "CAD", "America/Vancouver": "CAD", "America/Winnipeg": "CAD",
    "America/Mexico_City": "MXN",
    "America/Sao_Paulo": "BRL",
    "Pacific/Auckland": "NZD",
};

const TIMEZONE_PREFIX_TO_CURRENCY: [string, string][] = [
    ["Europe/", "EUR"],
    ["Australia/", "AUD"],
    ["Pacific/", "USD"], // 关岛等太平洋美属地多用美元；Auckland 已被精确映射
    ["America/", "USD"],
];

export const DEFAULT_CURRENCY_CODE = "CNY";

export function resolveCharacterCurrency(char: Pick<Character, "currency" | "timeZone">): CharacterCurrency {
    const explicit = char.currency?.trim().toUpperCase();
    if (explicit && CURRENCY_BY_CODE.has(explicit)) return CURRENCY_BY_CODE.get(explicit)!;

    const tz = char.timeZone?.trim();
    if (tz) {
        const exact = TIMEZONE_TO_CURRENCY[tz];
        if (exact) return CURRENCY_BY_CODE.get(exact)!;
        for (const [prefix, code] of TIMEZONE_PREFIX_TO_CURRENCY) {
            if (tz.startsWith(prefix)) return CURRENCY_BY_CODE.get(code)!;
        }
    }
    return CURRENCY_BY_CODE.get(DEFAULT_CURRENCY_CODE)!;
}

/** 编辑器下拉里所有可选项（含「自动」哨兵之外的目录本身）。 */
export function currencyDisplayLabel(cur: CharacterCurrency): string {
    return `${cur.nameCn} ${cur.code} ${cur.symbol}`;
}

function moneyRuleSuffix(): string {
    return "发红包、转账、代付、报价及一切涉及金额的表述，都按该货币的购买力书写（金额数字即该货币面额），不要按人民币量级换算；消息正文保持原本的语言和格式。";
}

/** 1:1 聊天的货币感知提示；人民币（默认口径）不注入。 */
export function buildCharacterMoneyHint(char: Character): string | null {
    const cur = resolveCharacterCurrency(char);
    if (cur.code === DEFAULT_CURRENCY_CODE) return null;
    return `【货币感知】${char.name}所在地区通用货币为${cur.nameCn}（${cur.code}，符号 ${cur.symbol}）。${cur.example ? `参考尺度：${cur.example}。` : ""}${moneyRuleSuffix()}`;
}

/**
 * 群聊的货币感知提示：按成员币种分组列出；全员同币种时一句话带过。
 * 全员都是默认人民币（或推导不出）时不注入。
 */
export function buildGroupMoneyHint(members: Character[]): string | null {
    const byCode = new Map<string, { cur: CharacterCurrency; names: string[] }>();
    for (const m of members) {
        const cur = resolveCharacterCurrency(m);
        byCode.set(cur.code, { cur, names: [...(byCode.get(cur.code)?.names ?? []), m.name] });
    }
    byCode.delete(DEFAULT_CURRENCY_CODE);
    if (byCode.size === 0) return null;

    let mapping: string;
    if (byCode.size === 1 && byCode.get([...byCode.keys()][0])!.names.length === members.length) {
        const cur = [...byCode.values()][0].cur;
        mapping = `本群成员均使用${cur.nameCn}（${cur.code}，符号 ${cur.symbol}）。${cur.example ? `参考尺度：${cur.example}。` : ""}`;
    } else {
        const parts = [...byCode.values()].map(({ cur, names }) => `${names.join("、")}使用${cur.nameCn}（${cur.code}，符号 ${cur.symbol}）`);
        mapping = `群成员的货币感知不同：${parts.join("；")}。`;
    }
    return `【货币感知】${mapping}${moneyRuleSuffix()}`;
}
