// src/utils.ts
import crypto from 'crypto';

// =====================================================
// НОРМАЛИЗАЦИЯ ТЕКСТА
// =====================================================
export function normalizeMessage(text: string): string {
    return (text || '')
        .replace(/\s+/g, ' ')
        .replace(/[“”]/g, '"')
        .replace(/[’]/g, "'")
        .trim();
}

// =====================================================
// CLAMP (ограничение числа)
// =====================================================
export function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

// =====================================================
// РАБОТА С JSON И КОДОВЫМИ БЛОКАМИ
// =====================================================
export function stripCodeFences(s: string): string {
    const t = (s || '').trim();
    if (!t) return t;
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
}

export function extractJsonObject(text: string): any | null {
    const t = stripCodeFences(text);
    try {
        return JSON.parse(t);
    } catch {
        // невалидный JSON
    }

    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const slice = t.slice(start, end + 1);
        try {
            return JSON.parse(slice);
        } catch {
            // невалидный JSON
        }
    }

    return null;
}

// =====================================================
// ИМИТАЦИЯ ЧЕЛОВЕЧЕСКИХ ОПЕЧАТОК (для сообщений ботов)
// =====================================================
export function addHumanLikeErrors(text: string): string {
    if (!text || Math.random() > 0.2) return text;

    const errors = [
        () => text.replace(/\.$/, '') + '..',
        () => text.replace(/\!$/, '') + '!!',
        () => text.toLowerCase(),
        () => text.replace(/\s+/g, ' ').replace(' ,', ',').replace(' .', '.'),
        () => text + ' вроде',
        () => text + ' типа',
        () => text.replace(/[.,;!?]$/, '') + ' ' + ['кста', 'вообще', 'как бы', 'ну'][Math.floor(Math.random() * 4)]
    ];

    const errorFunc = errors[Math.floor(Math.random() * errors.length)];
    return errorFunc();
}

// =====================================================
// СЛИЯНИЕ ФАКТОВ ПАМЯТИ (из ai.ts)
// =====================================================
export interface MemoryFact {
    id: string;
    text: string;
    ts: number;
    importance: number;
    tags?: string[];
    isGlobal?: boolean;
}

export function mergeFactsSimple(
    existing: MemoryFact[],
    incoming: Omit<MemoryFact, 'id' | 'ts'>[]
): MemoryFact[] {
    const now = Date.now();
    const out = [...existing];

    const normKey = (s: string) => normalizeMessage(s).toLowerCase();

    const existingKeys = new Map<string, MemoryFact>();
    for (const f of out) existingKeys.set(normKey(f.text), f);

    for (const inc of incoming) {
        const key = normKey(inc.text);
        if (!key) continue;

        const prev = existingKeys.get(key);
        if (prev) {
            prev.ts = now;
            prev.importance = clamp(Math.max(prev.importance || 1, inc.importance || 1), 1, 5);
            prev.tags = Array.from(new Set([...(prev.tags || []), ...(inc.tags || [])]));
        } else {
            const created: MemoryFact = {
                id: `${now}-${crypto.randomBytes(6).toString('hex')}`,
                ts: now,
                text: inc.text,
                importance: clamp(inc.importance, 1, 5),
                tags: inc.tags || []
            };
            out.push(created);
            existingKeys.set(key, created);
        }
    }

    out.sort((a, b) => (b.importance - a.importance) || (b.ts - a.ts));
    return out.slice(0, 120);
}