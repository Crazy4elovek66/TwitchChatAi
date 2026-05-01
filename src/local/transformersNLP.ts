import { logger } from '../logger';

type KnowledgeItem = any;

export class TransformersNLP {
    private generator: any;
    private initPromise: Promise<void> | null = null;
    private currentModelName: string | null = null;

    /**
     * Initializes the local NLP pipeline (HuggingFace transformers via @xenova/transformers).
     * Safe to call multiple times; it will only initialize once.
     */
    init(modelName = process.env.LOCAL_NLP_MODEL || 'Xenova/LaMini-Flan-T5-783M'): Promise<void> {
        if (process.env.LOCAL_NLP === '0') {
            // Explicitly disabled
            this.generator = null;
            this.initPromise = Promise.resolve();
            this.currentModelName = null;
            logger.info('Local NLP disabled via LOCAL_NLP=0');
            return this.initPromise;
        }

        if (this.generator && this.currentModelName === modelName) return Promise.resolve();
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            // @xenova/transformers is an ESM module, so we import dynamically.
            const { pipeline } = await import('@xenova/transformers');

            // NOTE: first run will download model weights (cached afterwards).
            this.generator = await pipeline('text2text-generation', modelName);
            this.currentModelName = modelName;

            logger.info(`NLP model loaded: ${modelName}`);
        })()
            .catch((err) => {
                // If init fails, reset so we can retry later.
                this.generator = null;
                this.currentModelName = null;
                this.initPromise = null;
                logger.error(`Failed to init local NLP model: ${String(err?.message ?? err)}`);
                throw err;
            });

        return this.initPromise;
    }

    /**
     * Extracts "global knowledge" items from text.
     * Fix: auto-initializes model on first call to avoid "NLP model not initialized".
     */
    async extractKnowledge(text: string): Promise<KnowledgeItem[]> {
        if (process.env.LOCAL_NLP === '0') return [];

        const cleaned = (text ?? '').trim();
        if (!cleaned) return [];

        if (!this.generator) {
            // Lazy init to avoid crashing learning mode on first extraction.
            await this.init();
        }
        if (!this.generator) return [];

        const prompt =
            'Извлеки общие знания из текста. Категории: game_terms, twitch_terms, humor, behavior, culture. ' +
            'Ответ строго в JSON без лишнего текста: {"knowledge":[...]}\\n' +
            `Текст: "${cleaned.replace(/\\s+/g, ' ').slice(0, 1200)}"`;

        const result = await this.generator(prompt, {
            max_new_tokens: 250,
            temperature: 0.2,
            // do_sample: false, // если поддерживается твоей версией
        });

        const output = (result?.[0]?.generated_text ?? result?.[0]?.text ?? '').toString();
        return this.parseKnowledgeJSON(output);
    }

    private parseKnowledgeJSON(text: string): KnowledgeItem[] {
        const stripCodeFences = (s: string): string => {
            const t = (s || '').trim();
            if (!t) return t;
            return t.replace(/^```(?:json)?\\s*/i, '').replace(/```\\s*$/i, '').trim();
        };

        const extractJsonObject = (raw: string): any | null => {
            const t = stripCodeFences(raw);

            // 1) direct parse
            try {
                return JSON.parse(t);
            } catch {
                /* noop */
            }

            // 2) try to slice from first { to last }
            const start = t.indexOf('{');
            const end = t.lastIndexOf('}');
            if (start >= 0 && end > start) {
                const slice = t.slice(start, end + 1);
                try {
                    return JSON.parse(slice);
                } catch {
                    /* noop */
                }
            }
            return null;
        };

        const json = extractJsonObject(text);
        if (json && Array.isArray(json.knowledge)) return json.knowledge;

        return [];
    }
}

// Singleton — удобно, если используется из разных мест
export const transformersNLP = new TransformersNLP();
