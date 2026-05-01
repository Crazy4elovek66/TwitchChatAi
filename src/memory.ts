import { promises as fs } from 'fs';
import { join } from 'path';

export type MemoryEventType = 'speech' | 'chat' | 'screen';

export interface MemoryEvent {
    ts: number;
    type: MemoryEventType;
    text: string;
    meta?: Record<string, any>;
}

export interface MemoryFact {
    id: string;
    text: string;
    ts: number;
    importance: number;
    tags?: string[];
    isGlobal?: boolean;
}

export interface ChannelMemoryFile {
    channel: string;
    updatedAt: number;
    facts: MemoryFact[];
}

export interface GlobalKnowledge {
    id: string;
    category: 'game_terms' | 'twitch_terms' | 'humor' | 'behavior' | 'culture';
    text: string;
    examples: string[];
    usageContext: string[];
    learnedFrom: string[];
    confidence: number; // 0-1
    lastUsed: number;
    usageCount: number;
}

function safeChannelId(channel: string) {
    return channel.toLowerCase().replace(/[^a-z0-9_-]/gi, '_');
}

export class MemoryStore {
    private baseDir: string;
    private globalFile: string;

    constructor(baseDir = join(process.cwd(), 'data', 'memory')) {
        this.baseDir = baseDir;
        this.globalFile = join(this.baseDir, 'global_knowledge.json');
    }

    private async ensureDir() {
        await fs.mkdir(this.baseDir, { recursive: true });
    }

    private filePath(channel: string) {
        return join(this.baseDir, `${safeChannelId(channel)}.json`);
    }

    // ===== Локальная память (конкретный канал) =====
    async load(channel: string): Promise<ChannelMemoryFile> {
        await this.ensureDir();
        const fp = this.filePath(channel);

        try {
            const raw = await fs.readFile(fp, 'utf-8');
            const parsed = JSON.parse(raw) as ChannelMemoryFile;
            if (!parsed.facts) parsed.facts = [];
            return parsed;
        } catch {
            return { channel, updatedAt: Date.now(), facts: [] };
        }
    }

    async save(mem: ChannelMemoryFile): Promise<void> {
        await this.ensureDir();
        mem.updatedAt = Date.now();
        const fp = this.filePath(mem.channel);
        await fs.writeFile(fp, JSON.stringify(mem, null, 2), 'utf-8');
    }

    // ===== Глобальная память (общие знания) =====
    async loadGlobal(): Promise<GlobalKnowledge[]> {
        await this.ensureDir();
        try {
            const raw = await fs.readFile(this.globalFile, 'utf-8');
            const parsed = JSON.parse(raw) as GlobalKnowledge[];
            return parsed || [];
        } catch {
            return [];
        }
    }

    async saveGlobal(knowledge: GlobalKnowledge[]): Promise<void> {
        await this.ensureDir();
        await fs.writeFile(this.globalFile, JSON.stringify(knowledge, null, 2), 'utf-8');
    }

    async addGlobalKnowledge(knowledge: Omit<GlobalKnowledge, 'id' | 'lastUsed' | 'usageCount'>): Promise<string> {
        const existing = await this.loadGlobal();
        const now = Date.now();

        // Проверяем, нет ли дубликатов
        const similarExists = existing.some(item =>
            item.text === knowledge.text ||
            item.examples.some(ex => knowledge.examples.includes(ex))
        );

        if (similarExists) {
            return '';
        }

        const newItem: GlobalKnowledge = {
            ...knowledge,
            id: `${now}_${Math.random().toString(36).substring(2, 9)}`,
            lastUsed: now,
            usageCount: 0
        };

        existing.push(newItem);
        await this.saveGlobal(existing);
        return newItem.id;
    }

    async updateGlobalKnowledgeUsage(id: string): Promise<void> {
        const knowledge = await this.loadGlobal();
        const item = knowledge.find(k => k.id === id);
        if (item) {
            item.lastUsed = Date.now();
            item.usageCount++;
            await this.saveGlobal(knowledge);
        }
    }

    async findRelevantGlobalKnowledge(query: string, categories?: GlobalKnowledge['category'][]): Promise<GlobalKnowledge[]> {
        const allKnowledge = await this.loadGlobal();
        const queryLower = query.toLowerCase();
        const queryWords = queryLower.split(/[^a-zа-я0-9]+/).filter(w => w.length >= 3);

        const scored = allKnowledge.map(k => {
            if (categories && categories.length > 0 && !categories.includes(k.category)) {
                return { k, score: 0 };
            }

            // 1. Проверка по тексту
            const textScore = k.text.toLowerCase().includes(queryLower) ? 10 : 0;

            // 2. Проверка по примерам использования
            const exampleScore = k.examples.reduce((score, example) => {
                const words = example.toLowerCase().split(/[^a-zа-я0-9]+/);
                const matches = words.filter(w => queryWords.includes(w)).length;
                return score + matches;
            }, 0);

            // 3. Проверка по контексту использования
            const contextScore = k.usageContext.reduce((score, context) => {
                const words = context.toLowerCase().split(/[^a-zа-я0-9]+/);
                const matches = words.filter(w => queryWords.includes(w)).length;
                return score + matches;
            }, 0);

            // 4. Учет уверенности и частоты использования
            const confidenceScore = k.confidence * 5;
            const recencyScore = (Date.now() - k.lastUsed) / (1000 * 60 * 60 * 24 * 30); // 30 дней

            const totalScore = textScore + exampleScore * 3 + contextScore * 2 + confidenceScore - recencyScore;

            return { k, score: totalScore };
        });

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map(s => s.k);
    }

    async getKnowledgeByCategory(category: GlobalKnowledge['category']): Promise<GlobalKnowledge[]> {
        const knowledge = await this.loadGlobal();
        return knowledge.filter(k => k.category === category);
    }

    async getKnowledgeStats(): Promise<{
        total: number;
        byCategory: Record<string, number>;
        mostUsed: GlobalKnowledge[];
    }> {
        const knowledge = await this.loadGlobal();
        const byCategory: Record<string, number> = {};

        knowledge.forEach(k => {
            byCategory[k.category] = (byCategory[k.category] || 0) + 1;
        });

        const mostUsed = [...knowledge]
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, 10);

        return {
            total: knowledge.length,
            byCategory,
            mostUsed
        };
    }

    // ===== Гибридный поиск (локальные + глобальные знания) =====
    async pickRelevantFacts(allFacts: MemoryFact[], queryText: string, globalKnowledge: GlobalKnowledge[], limit = 8): Promise<MemoryFact[]> {
        const q = (queryText || '').toLowerCase();
        const qWords = new Set(q.split(/[^a-zа-я0-9_]+/i).filter(w => w.length >= 3));

        // Локальные факты
        const localScored = allFacts.map(f => {
            const t = f.text.toLowerCase();
            const words = t.split(/[^a-zа-я0-9_]+/i).filter(w => w.length >= 3);
            let hit = 0;
            for (const w of words) if (qWords.has(w)) hit++;
            const recency = Math.max(0, 1_000_000_000 - (Date.now() - f.ts));
            const score = hit * 10 + (f.importance || 1) * 3 + recency / 1_000_000_000;
            return { f, score, isGlobal: false };
        });

        // Глобальные знания
        const globalScored = globalKnowledge.map(k => {
            const fact: MemoryFact = {
                id: k.id,
                text: k.text,
                ts: k.lastUsed,
                importance: Math.round(k.confidence * 5),
                tags: [k.category],
                isGlobal: true
            };

            const t = k.text.toLowerCase();
            const words = t.split(/[^a-zа-я0-9_]+/i).filter(w => w.length >= 3);
            let hit = 0;
            for (const w of words) if (qWords.has(w)) hit++;

            const exampleWords = k.examples.join(' ').toLowerCase();
            const exampleHit = k.examples.some(example =>
                example.toLowerCase().includes(q) || q.includes(example.toLowerCase())
            ) ? 3 : 0;

            const usageScore = k.usageContext.some(context =>
                context.toLowerCase().includes(q)
            ) ? 2 : 0;

            const confidenceScore = k.confidence * 4;
            const usageCountScore = Math.min(k.usageCount / 100, 5); // нормализуем
            const recency = Math.max(0, 1_000_000_000 - (Date.now() - k.lastUsed));

            const score = hit * 5 + exampleHit + usageScore + confidenceScore + usageCountScore + recency / 2_000_000_000;

            return { f: fact, score, isGlobal: true };
        });

        const allScored = [...localScored, ...globalScored];

        return allScored
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(x => x.f);
    }
}