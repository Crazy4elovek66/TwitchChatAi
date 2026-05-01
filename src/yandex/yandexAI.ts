// src/yandex/yandexAI.ts
import axios from 'axios';
import { logger } from '../logger';
import {
    clamp,
    normalizeMessage,
    extractJsonObject,
    addHumanLikeErrors
} from '../utils';
import { MemoryEvent, MemoryFact, GlobalKnowledge } from '../memory';
import { Personality } from '../personality';
import { VisionAnalyzer } from '../vision';
import { MemoryStore } from '../memory';

// =====================================================
// 1. РАСПОЗНАВАНИЕ РЕЧИ (STT)
// =====================================================
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
    const apiKey = process.env.YANDEX_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;
    const lang = process.env.YANDEX_STT_LANG || (process.env.ORIGINAL_STREAM_LANGUAGE === 'ru' ? 'ru-RU' : 'en-US');

    if (!apiKey) throw new Error('YANDEX_API_KEY is missing');
    if (!folderId) throw new Error('YANDEX_FOLDER_ID is missing');

    const lpcm = wavToLpcm(audioBuffer); // локальная функция, определена ниже

    const url = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
    try {
        const response = await axios.post(url, lpcm, {
            params: {
                folderId,
                lang,
                format: 'lpcm',
                sampleRateHertz: 16000
            },
            headers: {
                Authorization: `Api-Key ${apiKey}`,
                'Content-Type': 'application/octet-stream'
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 30000
        });
        return (response.data?.result || '').toString().trim();
    } catch (error) {
        logger.error('Yandex STT error:', error);
        throw error;
    }
}

// Вспомогательная функция для конвертации WAV в LPCM (взята из ai.ts)
function wavToLpcm(wav: Buffer): Buffer {
    if (wav.length < 12) return wav;

    const riff = wav.toString('ascii', 0, 4);
    const wave = wav.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') return wav;

    let offset = 12;
    while (offset + 8 <= wav.length) {
        const chunkId = wav.toString('ascii', offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        const dataStart = offset + 8;

        if (chunkId === 'data') {
            const dataEnd = Math.min(dataStart + chunkSize, wav.length);
            return wav.slice(dataStart, dataEnd);
        }

        offset = dataStart + chunkSize + (chunkSize % 2);
    }
    return wav;
}

// =====================================================
// 2. ИЗВЛЕЧЕНИЕ ЗНАНИЙ (YandexGPT)
// =====================================================
export async function extractKnowledge(
    text: string,
    type: 'chat' | 'screen' | 'speech' | 'vision' = 'chat'
): Promise<Array<{
    category: string;
    text: string;
    examples: string[];
    usageContext: string[];
    confidence: number;
}>> {
    const apiKey = process.env.YANDEX_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
        throw new Error('Yandex credentials missing');
    }

    const modelName = process.env.YANDEX_GPT_MODEL || 'yandexgpt-lite';
    const modelUri = `gpt://${folderId}/${modelName}`;
    const url = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

    let systemPrompt = '';

    switch (type) {
        case 'chat':
            systemPrompt = `
Ты - аналитик интернет-чатов. Извлекай ОБЩИЕ знания из сообщений чата.
Фокус на: игровые термины, твич-культуру, интернет-мемы, паттерны общения.
Не извлекай личную информацию или контекстные факты.

Категории:
- game_terms: термины игр, геймплей, механики
- twitch_terms: стриминг, донаты, подписки, чат
- humor: шутки, мемы, ирония
- behavior: поведение в чате, реакции
- culture: интернет-культура, тренды

Формат: {"knowledge": [{"category": "тип", "text": "знание", "examples": ["пример"], "usageContext": ["контекст"], "confidence": 0.8}]}
`.trim();
            break;
        case 'screen':
            systemPrompt = `
Ты - аналитик интерфейсов игр и приложений. Извлекай ОБЩИЕ знания из текста на экране.
Фокус на: игровые интерфейсы, меню, HUD, системные сообщения.
Не извлекай личную информацию или уникальные ситуации.

Категории:
- game_terms: игровые интерфейсы, HUD, меню
- twitch_terms: интерфейсы стриминга, алерты
- behavior: паттерны взаимодействия с интерфейсом

Формат: {"knowledge": [{"category": "тип", "text": "знание", "examples": ["пример"], "usageContext": ["контекст"], "confidence": 0.8}]}
`.trim();
            break;
        case 'speech':
            systemPrompt = `
Ты - аналитик интернет-культуры, специализирующийся на Twitch и играх. 
Твоя задача - извлекать ОБЩИЕ знания, которые будут полезны на ЛЮБОМ стриме.

ИЗВЛЕКАЙ ТОЛЬКО:
1. ИГРОВЫЕ ТЕРМИНЫ и МЕХАНИКИ (геймплей, стратегии, жаргон)
2. ТВИЧ-КУЛЬТУРУ (стриминг, донаты, подписки, эмодзи, мемы)
3. ИНТЕРНЕТ-ШУТКИ и МЕМЫ (форматы, тренды, ироничные выражения)
4. ПОВЕДЕНЧЕСКИЕ ПАТТЕРНЫ (как реагируют зрители, что смешно, что нет)
5. ОБЩИЕ ТЕМЫ ДЛЯ ОБСУЖДЕНИЯ (игры, киберспорт, IT, поп-культура)

НЕ ИЗВЛЕКАЙ:
- Имена конкретных стримеров или зрителей
- Личную информацию
- События одного конкретного стрима
- Временные/контекстные факты (типа "сегодня стример устал")

КАТЕГОРИИ:
- game_terms: термины игр, геймплейные механики, названия игр/жанров
- twitch_terms: стриминг, чат, донаты, подписки, платформенные фичи
- humor: шутки, мемы, ироничные выражения, форматы юмора
- behavior: поведение в чате, реакции, социальные паттерны
- culture: интернет-культура, тренды, сообщества

ФОРМАТ ОТВЕТА: { "knowledge": [...] }
`.trim();
            break;
        case 'vision':
            systemPrompt = `
Из визуального анализа стрима извлекай ОБЩИЕ знания об играх и интерфейсах.
Фокус на:
1. Игровые интерфейсы (HUD, меню, карты)
2. Визуальные стили игр (графика, анимация)
3. Объекты и элементы геймплея
4. Текстовые элементы интерфейса

Не упоминай конкретных стримеров или уникальные ситуации.

Категории:
- game_terms: игровые интерфейсы, HUD, элементы геймплея
- behavior: взаимодействие с интерфейсом

Формат: {"knowledge": [...]}
`.trim();
            break;
        default:
            systemPrompt = 'Извлеки общие знания из текста.';
    }

    const body = {
        modelUri,
        completionOptions: { stream: false, temperature: 0.3, maxTokens: 500 },
        messages: [
            { role: 'system', text: systemPrompt },
            { role: 'user', text: `Текст: "${text}"\n\nИзвлеки общие знания:` }
        ]
    };

    try {
        const response = await axios.post(url, body, {
            headers: {
                Authorization: `Api-Key ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        const raw = response.data?.result?.alternatives?.[0]?.message?.text || '';
        const json = extractJsonObject(raw);

        if (json && Array.isArray(json.knowledge)) {
            return json.knowledge;
        }
        return [];
    } catch (error) {
        logger.error('YandexGPT extractKnowledge error:', error);
        return [];
    }
}

// =====================================================
// 3. ОБНОВЛЕНИЕ ФАКТОВ (YandexGPT)
// =====================================================
export async function updateFacts(
    events: MemoryEvent[],
    existingFacts: MemoryFact[]
): Promise<Omit<MemoryFact, 'id' | 'ts'>[]> {
    const apiKey = process.env.YANDEX_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
        throw new Error('Yandex credentials missing');
    }

    const modelName = process.env.YANDEX_GPT_MODEL || 'yandexgpt-lite';
    const modelUri = `gpt://${folderId}/${modelName}`;
    const url = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

    const eventsText = events
        .slice(-30)
        .map(e => {
            const tag = e.type === 'speech' ? 'SPEECH' : e.type === 'chat' ? 'CHAT' : 'SCREEN';
            return `[${tag}] ${e.text}`;
        })
        .join('\n');

    const existingText = (existingFacts || [])
        .slice(-40)
        .map(f => `- (${f.importance}) ${f.text}`)
        .join('\n');

    const system = `
Извлеки факты о стримере и чате из событий.
Факты должны быть короткими (3-7 слов).
Верни JSON: {"facts":[{"text":"факт", "importance":1-5, "tags":["тэг"]}]}
`.trim();

    const body = {
        modelUri,
        completionOptions: { stream: false, temperature: 0.2, maxTokens: 300 },
        messages: [
            { role: 'system', text: system },
            { role: 'user', text: `События:\n${eventsText}\n\nСуществующие факты:\n${existingText || '(нет)'}` }
        ]
    };

    try {
        const response = await axios.post(url, body, {
            headers: {
                Authorization: `Api-Key ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        const raw = response.data?.result?.alternatives?.[0]?.message?.text || '';
        const json = extractJsonObject(raw);
        if (!json) return [];

        const facts = Array.isArray(json?.facts) ? json.facts : [];

        const normalized: Omit<MemoryFact, 'id' | 'ts'>[] = facts
            .map((f: any) => ({
                text: String(f?.text || '').trim(),
                importance: clamp(Number(f?.importance || 3), 1, 5),
                tags: Array.isArray(f?.tags) ? f.tags.map((x: any) => String(x)) : []
            }))
            .filter((f: { text: string }) => f.text.length >= 3);

        return normalized;
    } catch (error) {
        logger.error('YandexGPT updateFacts error:', error);
        return [];
    }
}

// =====================================================
// 4. ГЕНЕРАЦИЯ СООБЩЕНИЙ ДЛЯ БОТА (YandexGPT)
// =====================================================
export async function generateBotMessage(
    personality: Personality,
    context: {
        contextText: string;
        triggerReason: string;
        interactionWith?: string;
        currentChannelInfo?: any;
        recentChat?: any[];
        recentSpeech?: string[];
        lastVisionAnalysis?: any;
        visionAnalyzer?: VisionAnalyzer;
        globalKnowledge?: GlobalKnowledge[];
        facts?: MemoryFact[];
        memoryStore?: MemoryStore;
    }
): Promise<string> {
    const apiKey = process.env.YANDEX_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
        throw new Error('Yandex credentials missing');
    }

    // В режиме обучения не генерируем сообщения (проверка на уровне вызова)
    if (personality.id === 'learning') {
        return '';
    }

    const modelName = process.env.YANDEX_GPT_MODEL || 'yandexgpt-lite';
    const modelUri = `gpt://${folderId}/${modelName}`;
    const url = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

    // Формируем systemPrompt из personality (можно вызвать метод класса, но тут мы продублируем логику)
    const traits = personality.traits.join(', ');
    const interests = personality.interests.join(', ');
    const avoid = personality.avoidPhrases?.join(', ') || '';

    const systemPrompt = `
Ты — ${personality.name}, обычный человек в чате Twitch. Тебе ${personality.age} лет.
Ты смотришь стрим для себя, как обычный зритель.

Как ты общаешься:
- Характер: ${traits}
- О чем говоришь: ${interests}
- Стиль: ${personality.speechStyle}

ОСНОВНЫЕ ПРАВИЛА:
1. НИКОГДА не пиши: "${avoid}" — это звучит как бот
2. Пиши КАК В ЖИЗНИ: с опечатками, без идеальной пунктуации
3. Короткие фразы (5-10 слов максимум)
4. Реагируй только если есть реальный повод
5. Не задавай вопросов без причины
6. Избегай шаблонных фраз и клише
7. Не пересказывай слова стримера
8. Если нечего сказать — молчи (пустая строка)
9. Ты НЕ знаешь что ты бот — ты обычный человек

# ГЛОБАЛЬНЫЕ ЗНАНИЯ (используй для более реалистичных ответов):
- Ты знаешь игровые термины, твич-культуру, интернет-мемы
- Используй их естественно, как настоящий зритель
- Не перегружай ответы терминами, используй их уместно

Примеры использования знаний:
- Если видишь игру → можешь вспомнить похожие игры/механики
- Если шутка → можешь ответить в том же стиле
- Если обсуждают стриминг → знаешь про донаты, подписки и т.д.
- Но помни: ты обычный зритель, не эксперт!

Что писать можно:
- Короткие реакции "ахах", "ого", "ну такое"
- Поддержку "держись", "молодец"
- Короткие комментарии по делу
- Ответы если к тебе обратились

Что НЕ писать:
- Длинные сообщения
- Вопросы "что дальше", "расскажи подробнее"
- Шаблоны "лол", "интересно", "вау"
- Литературные красивые фразы

Примеры ТВОЕГО стиля:
- Вместо "Это весьма занимательно" → "прикольно"
- Вместо "Что будет дальше?" → "жду продолжения"
- Вместо "Мне кажется это интересно" → "норм тема"
- Вместо "Я согласен с тобой" → "я так же думаю"

Пиши как настоящий человек в интернете!
`.trim();

    // Формируем контекст пользователя
    const channelInfo = context.currentChannelInfo || {};
    const recentChat = context.recentChat?.slice(-8).map(msg => `${msg.username}: ${msg.message}`).join('\n') || '(пока нет сообщений)';
    const recentSpeech = context.recentSpeech?.slice(-4).map(t => `Стример: ${t}`).join('\n') || '(стример молчит)';

    let visualContext = '';
    if (context.lastVisionAnalysis && context.visionAnalyzer) {
        visualContext = context.visionAnalyzer.formatAnalysisForPrompt(context.lastVisionAnalysis);
        const gameplay = context.visionAnalyzer.analyzeGameplay(context.lastVisionAnalysis);
        if (gameplay) {
            visualContext += `\nГеймплей: ${gameplay}`;
        }
    }

    const factsBlock = '';
    // Факты мы могли бы получить из memoryStore, но для простоты оставим пока пустым

    const userPrompt = `
Контекст стрима:
- Название: ${channelInfo.title || 'стрим'}
- Категория: ${channelInfo.gameName || 'неизвестно'}
- Зрителей: ~${channelInfo.viewerCount || 0}

${visualContext ? `Визуальный контекст (что видно на экране):\n${visualContext}\n` : ''}

Последние сообщения в чате:
${recentChat}

Последние фразы стримера:
${recentSpeech}

Текущий контекст: ${context.contextText || 'новое событие на стриме'}

${context.interactionWith ? `Тебе написал ${context.interactionWith}, ответь ему:` : 'Напиши сообщение в чат:'}
`.trim();

    const messages = [
        { role: 'system', text: systemPrompt },
        { role: 'user', text: userPrompt }
    ];

    // Если есть факты, добавим их как system сообщение (упрощённо)
    if (context.globalKnowledge?.length) {
        const relevant = await context.memoryStore?.pickRelevantFacts(
            context.facts || [],
            context.contextText || '',
            context.globalKnowledge,
            8
        ) || [];
        if (relevant.length) {
            const factsText = `Память:\n${relevant.map(f => `- ${f.text} ${f.isGlobal ? '[глобальное знание]' : ''}`).join('\n')}`;
            messages.unshift({ role: 'system', text: factsText });
        }
    }

    const body = {
        modelUri,
        completionOptions: { stream: false, temperature: 0.8, maxTokens: 100 },
        messages
    };

    try {
        const response = await axios.post(url, body, {
            headers: {
                Authorization: `Api-Key ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        let message = response.data?.result?.alternatives?.[0]?.message?.text?.trim?.() || '';
        message = normalizeMessage(message);
        message = message.replace(/^["']|["']$/g, '');

        if (message.length > 100) {
            const sentences = message.split(/[.!?]/);
            message = sentences[0].trim();
            if (message.length > 0 && !/[.!?]$/.test(message)) {
                message += '.';
            }
        }

        if (Math.random() > 0.5) {
            message = addHumanLikeErrors(message);
        }

        if (!personality.useEmojis) {
            message = message.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
        }

        return message;
    } catch (error) {
        logger.error('YandexGPT generateBotMessage error:', error);
        return '';
    }
}