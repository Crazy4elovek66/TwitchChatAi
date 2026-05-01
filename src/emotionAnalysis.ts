// src/emotionAnalysis.ts
import { EventEmitter } from 'events';
import { logger } from './logger';

export interface EmotionalMoment {
    id: string;
    timestamp: number;
    streamerSpeech: string;
    chatReactions: ChatReaction[];
    emotionType: EmotionType;
    intensity: number; // 1-5
    tags: string[];
    analysis: {
        humorScore: number;
        surpriseScore: number;
        interestScore: number;
        emotionalScore: number;
    };
}

export interface ChatReaction {
    username: string;
    message: string;
    timestamp: number;
    emotion?: string;
}

export type EmotionType = 'humor' | 'surprise' | 'interest' | 'emotional' | 'drama' | 'anger' | 'sadness' | 'neutral';

export class EmotionAnalyzer extends EventEmitter {
    private emotionalMoments: EmotionalMoment[] = [];
    private currentMoment: EmotionalMoment | null = null;
    private momentWindowMs = 30000; // 30 секунд для сбора реакций
    private minReactions = 2; // Минимальное количество реакций для создания момента

    constructor() {
        super();
        logger.info('EmotionAnalyzer initialized');
    }

    // Регистрируем речь стримера как начало потенциального эмоционального момента
    public registerStreamerSpeech(speech: string, timestamp: number): void {
        const trimmedSpeech = speech.trim();
        if (trimmedSpeech.length < 10) return;

        // Если есть активный момент, закрываем его
        if (this.currentMoment) {
            this.finalizeCurrentMoment();
        }

        // Создаем новый момент
        this.currentMoment = {
            id: `moment_${timestamp}_${Math.random().toString(36).substring(2, 9)}`,
            timestamp,
            streamerSpeech: trimmedSpeech,
            chatReactions: [],
            emotionType: 'neutral',
            intensity: 1,
            tags: [],
            analysis: {
                humorScore: 0,
                surpriseScore: 0,
                interestScore: 0,
                emotionalScore: 0
            }
        };

        logger.debug(`[Emotion] Начало нового момента: ${trimmedSpeech.substring(0, 50)}...`);

        // Устанавливаем таймер для завершения момента
        setTimeout(() => {
            if (this.currentMoment && this.currentMoment.id.startsWith(`moment_${timestamp}`)) {
                this.finalizeCurrentMoment();
            }
        }, this.momentWindowMs);
    }

    // Добавляем реакцию чата к текущему моменту
    public addChatReaction(username: string, message: string, timestamp: number): void {
        if (!this.currentMoment) return;

        const reaction: ChatReaction = {
            username,
            message: message.trim(),
            timestamp,
            emotion: this.analyzeMessageEmotion(message)
        };

        this.currentMoment.chatReactions.push(reaction);

        // Обновляем анализ момента на основе новой реакции
        this.updateMomentAnalysis();
    }

    // Анализируем эмоцию в сообщении
    private analyzeMessageEmotion(message: string): string {
        const lower = message.toLowerCase();

        // Юмор
        if (/(ха[х]+|аха[х]+|ло[л]+|сме[яю]+|рж[уе]+|ржот)/i.test(lower)) {
            return 'humor';
        }
        // Удивление
        if (/(ого|вау|ниче[гз]о себе|обалдеть|ебать|пиздец|ёбаный)/i.test(lower)) {
            return 'surprise';
        }
        // Интерес
        if (/(интересно|любопытно|круто|класс|прикольно|занятно)/i.test(lower)) {
            return 'interest';
        }
        // Эмоциональная поддержка
        if (/(молодец|красава|умничка|так держать|супер|шикарно)/i.test(lower)) {
            return 'emotional';
        }
        // Грусть
        if (/(жалко|печаль|грустно|обидно|не повезло)/i.test(lower)) {
            return 'sadness';
        }
        // Злость
        if (/(злюсь|бесит|раздражает|достало|заебало)/i.test(lower)) {
            return 'anger';
        }

        return 'neutral';
    }

    // Обновляем анализ момента
    private updateMomentAnalysis(): void {
        if (!this.currentMoment) return;

        const reactions = this.currentMoment.chatReactions;
        const emotionCounts: Record<string, number> = {
            humor: 0,
            surprise: 0,
            interest: 0,
            emotional: 0,
            sadness: 0,
            anger: 0,
            neutral: 0
        };

        // Считаем эмоции
        reactions.forEach(r => {
            if (r.emotion) emotionCounts[r.emotion]++;
        });

        // Вычисляем интенсивность (чем больше реакций, тем выше)
        const totalReactions = reactions.length;
        const uniqueUsers = new Set(reactions.map(r => r.username)).size;
        const intensity = Math.min(5, Math.floor(totalReactions / 2) + Math.floor(uniqueUsers / 3));

        // Определяем доминирующую эмоцию
        let dominantEmotion: EmotionType = 'neutral';
        let maxCount = 0;

        for (const [emotion, count] of Object.entries(emotionCounts)) {
            if (count > maxCount) {
                maxCount = count;
                dominantEmotion = emotion as EmotionType;
            }
        }

        // Вычисляем баллы
        const total = Math.max(1, totalReactions);
        const scores = {
            humorScore: (emotionCounts.humor / total) * 100,
            surpriseScore: (emotionCounts.surprise / total) * 100,
            interestScore: (emotionCounts.interest / total) * 100,
            emotionalScore: (emotionCounts.emotional / total) * 100
        };

        // Определяем тип момента на основе доминирующей эмоции
        let emotionType: EmotionType = 'neutral';
        if (scores.humorScore > 30) emotionType = 'humor';
        else if (scores.surpriseScore > 30) emotionType = 'surprise';
        else if (scores.interestScore > 30) emotionType = 'interest';
        else if (scores.emotionalScore > 30) emotionType = 'emotional';
        else if (emotionCounts.sadness > totalReactions * 0.3) emotionType = 'sadness';
        else if (emotionCounts.anger > totalReactions * 0.3) emotionType = 'anger';

        this.currentMoment.emotionType = emotionType;
        this.currentMoment.intensity = intensity;
        this.currentMoment.analysis = scores;
    }

    // Завершаем текущий момент и сохраняем его
    private finalizeCurrentMoment(): void {
        if (!this.currentMoment) return;

        // Проверяем, есть ли достаточно реакций
        if (this.currentMoment.chatReactions.length >= this.minReactions) {
            // Добавляем теги на основе анализа
            const tags = this.generateTags(this.currentMoment);
            this.currentMoment.tags = tags;

            // Сохраняем момент
            this.emotionalMoments.push(this.currentMoment);

            logger.info(`[Emotion] Сохранен момент: ${this.currentMoment.emotionType} (интенсивность: ${this.currentMoment.intensity}, реакций: ${this.currentMoment.chatReactions.length})`);

            // Если момент значительный, создаем глобальное знание
            if (this.currentMoment.intensity >= 3) {
                this.createKnowledgeFromMoment(this.currentMoment);
            }
        }

        this.currentMoment = null;
    }

    // Генерируем теги для момента
    private generateTags(moment: EmotionalMoment): string[] {
        const tags: string[] = [];

        // Базовые теги
        tags.push(`emotion:${moment.emotionType}`);
        tags.push(`intensity:${moment.intensity}`);

        // Тематические теги на основе речи
        const speech = moment.streamerSpeech.toLowerCase();

        if (speech.includes('игр')) tags.push('тема:игры');
        if (speech.includes('чат')) tags.push('тема:общение');
        if (speech.includes('вопрос')) tags.push('тема:вопросы');
        if (speech.includes('шут')) tags.push('тема:юмор');
        if (speech.includes('донат') || speech.includes('подписк')) tags.push('тема:донаты');
        if (speech.includes('стрим')) tags.push('тема:стриминг');
        if (speech.includes('команд')) tags.push('тема:команда');
        if (speech.includes('соревнов')) tags.push('тема:соревнования');

        // Теги на основе реакций
        const uniqueUsers = new Set(moment.chatReactions.map(r => r.username)).size;
        if (uniqueUsers > 5) tags.push('масштаб:массовая_реакция');
        if (moment.chatReactions.length > 10) tags.push('реакция:активная');

        return tags;
    }

    // Создаем глобальное знание из эмоционального момента
    private createKnowledgeFromMoment(moment: EmotionalMoment): void {
        // Примеры реакций (первые 3)
        const exampleReactions = moment.chatReactions
            .slice(0, 3)
            .map(r => `${r.username}: ${r.message}`);

        // Формируем текст знания
        let knowledgeText = '';

        switch (moment.emotionType) {
            case 'humor':
                knowledgeText = `Когда стример шутит "${moment.streamerSpeech.substring(0, 50)}...", зрители реагируют смехом`;
                break;
            case 'surprise':
                knowledgeText = `Неожиданные моменты "${moment.streamerSpeech.substring(0, 50)}..." вызывают удивление у зрителей`;
                break;
            case 'interest':
                knowledgeText = `Тема "${moment.streamerSpeech.substring(0, 50)}..." вызывает интерес у зрителей`;
                break;
            case 'emotional':
                knowledgeText = `Эмоциональные моменты "${moment.streamerSpeech.substring(0, 50)}..." вызывают поддержку в чате`;
                break;
            default:
                knowledgeText = `На фразу "${moment.streamerSpeech.substring(0, 50)}..." зрители реагируют активно`;
        }

        // Создаем знание для сохранения в глобальную память
        const knowledge = {
            category: 'behavior' as const,
            text: knowledgeText,
            examples: exampleReactions,
            usageContext: [`эмоциональные реакции на стриме`, `тип: ${moment.emotionType}`],
            confidence: Math.min(0.9, 0.5 + (moment.intensity * 0.1)),
            tags: [...moment.tags, 'source:emotional_analysis']
        };

        // Отправляем событие для сохранения знания
        this.emit('emotionalKnowledge', knowledge);

        logger.info(`[Emotion] Создано знание: ${knowledgeText}`);
    }

    // Получаем статистику эмоциональных моментов
    public getEmotionStats(): {
        totalMoments: number;
        byEmotion: Record<string, number>;
        recentMoments: EmotionalMoment[];
    } {
        const byEmotion: Record<string, number> = {};

        this.emotionalMoments.forEach(moment => {
            byEmotion[moment.emotionType] = (byEmotion[moment.emotionType] || 0) + 1;
        });

        return {
            totalMoments: this.emotionalMoments.length,
            byEmotion,
            recentMoments: this.emotionalMoments.slice(-10).reverse()
        };
    }

    // Получаем последние моменты
    public getRecentMoments(limit: number = 5): EmotionalMoment[] {
        return this.emotionalMoments.slice(-limit).reverse();
    }

    // Поиск моментов по тегу
    public findMomentsByTag(tag: string): EmotionalMoment[] {
        return this.emotionalMoments.filter(moment =>
            moment.tags.some(t => t.includes(tag))
        );
    }

    // Очистка старых моментов
    public cleanupOldMoments(maxAgeHours: number = 24): void {
        const cutoff = Date.now() - (maxAgeHours * 60 * 60 * 1000);
        const initialCount = this.emotionalMoments.length;

        this.emotionalMoments = this.emotionalMoments.filter(m => m.timestamp >= cutoff);

        const removed = initialCount - this.emotionalMoments.length;
        if (removed > 0) {
            logger.info(`[Emotion] Удалено ${removed} старых моментов`);
        }
    }

    // Экспорт моментов
    public exportMoments(): any {
        return {
            timestamp: Date.now(),
            total: this.emotionalMoments.length,
            moments: this.emotionalMoments
        };
    }
}

export const emotionAnalyzer = new EmotionAnalyzer();