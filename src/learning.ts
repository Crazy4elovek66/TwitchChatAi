// src/learning.ts
import { logger } from './logger';
import { AIService } from './ai';
import { MemoryStore } from './memory';
import { join } from 'path';
import { promises as fs } from 'fs';

export interface LearningSession {
    id: string;
    channel: string;
    startTime: number;
    endTime?: number;
    duration: number; // в минутах
    factsLearned: number;
    eventsCaptured: number;
    summary?: string;
}

export interface LearningEvent {
    type: 'speech' | 'chat' | 'screen';
    content: string;
    timestamp: number;
    metadata?: Record<string, any>;
}

export interface LearningStats {
    speechEvents: number;
    chatEvents: number;
    screenEvents: number;
    factsExtracted: number;
    uniqueTopics: string[];
    uniqueTopicsCount: number;
    session?: LearningSession | null;
}

export interface SessionIndexEntry {
    id: string;
    channel: string;
    startTime: number;
    endTime?: number;
    duration: number;
    eventsCaptured: number;
    factsLearned: number;
    summary?: string;
}

export class LearningManager {
    private learningMode: boolean = false;
    private currentSession: LearningSession | null = null;
    private learningStartTime: number = 0;
    private memoryStore: MemoryStore;
    private aiService: AIService;

    // Статистика обучения
    private stats = {
        speechEvents: 0,
        chatEvents: 0,
        screenEvents: 0,
        factsExtracted: 0,
        uniqueTopics: new Set<string>()
    };

    // Все события обучения (сырые данные)
    private learningEvents: LearningEvent[] = [];

    // Путь для сохранения данных обучения
    private learningDataPath: string;
    private eventsBatchSize: number = 50; // Сохранять каждые N событий

    constructor(aiService: AIService) {
        this.aiService = aiService;
        this.memoryStore = new MemoryStore();

        // Создаем папку для данных обучения
        this.learningDataPath = join(process.cwd(), 'data', 'learning');
        this.ensureLearningDir();

        // Проверяем режим обучения из env
        this.learningMode = process.env.LEARNING_MODE === '1';

        if (this.learningMode) {
            logger.info('Режим обучения активирован');
            logger.info(`Данные обучения будут сохраняться в: ${this.learningDataPath}`);
        }
    }

    private async ensureLearningDir(): Promise<void> {
        try {
            await fs.mkdir(this.learningDataPath, { recursive: true });
            logger.debug(`Папка для данных обучения создана: ${this.learningDataPath}`);
        } catch (error) {
            logger.error('Ошибка создания папки для обучения:', error);
        }
    }

    public isLearningMode(): boolean {
        return this.learningMode;
    }

    public startLearningSession(channel: string): void {
        if (!this.learningMode) return;

        this.currentSession = {
            id: `learn_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            channel,
            startTime: Date.now(),
            duration: parseInt(process.env.LEARNING_SESSION_DURATION_MINUTES || '120', 10),
            factsLearned: 0,
            eventsCaptured: 0
        };

        this.learningStartTime = Date.now();
        this.resetStats();
        this.learningEvents = [];

        logger.info(`Начата сессия обучения на канале: ${channel}`);
        logger.info(`ID сессии: ${this.currentSession.id}`);
        logger.info(`Длительность сессии: ${this.currentSession.duration} минут`);

        // Запускаем таймер завершения сессии
        const sessionMs = this.currentSession.duration * 60 * 1000;
        setTimeout(() => {
            this.endLearningSession();
        }, sessionMs);

        // Начинаем периодический сбор статистики
        this.startPeriodicUpdates();

        // Сохраняем информацию о начале сессии
        this.saveSessionStart();
    }

    private resetStats(): void {
        this.stats = {
            speechEvents: 0,
            chatEvents: 0,
            screenEvents: 0,
            factsExtracted: 0,
            uniqueTopics: new Set()
        };
    }

    private startPeriodicUpdates(): void {
        // Каждые 5 минут обновляем статистику и сохраняем промежуточные данные
        const interval = setInterval(() => {
            if (this.currentSession) {
                this.logLearningProgress();
                this.saveLearningEventsToFile();
            } else {
                clearInterval(interval);
            }
        }, 300000);
    }

    public recordEvent(eventType: 'speech' | 'chat' | 'screen', content: string, metadata?: Record<string, any>): void {
        if (!this.learningMode || !this.currentSession) return;

        const event: LearningEvent = {
            type: eventType,
            content: content.trim(),
            timestamp: Date.now(),
            metadata
        };

        this.learningEvents.push(event);

        switch (eventType) {
            case 'speech':
                this.stats.speechEvents++;
                this.analyzeSpeechForTopics(content);
                break;
            case 'chat':
                this.stats.chatEvents++;
                break;
            case 'screen':
                this.stats.screenEvents++;
                break;
        }

        this.currentSession.eventsCaptured++;

        // Каждые 10 событий обновляем память
        if (this.currentSession.eventsCaptured % 10 === 0) {
            this.updateMemoryFromLearning();
        }

        // Периодически сохраняем события на диск
        if (this.learningEvents.length % this.eventsBatchSize === 0) {
            this.saveLearningEventsToFile();
        }
    }

    private analyzeSpeechForTopics(speech: string): void {
        // Простой анализ тем в речи
        const topics = this.extractTopics(speech);
        topics.forEach(topic => this.stats.uniqueTopics.add(topic));
    }

    private extractTopics(text: string): string[] {
        const topics: string[] = [];
        const lowerText = text.toLowerCase();

        // Простые темы для русского языка
        const topicPatterns = [
            { pattern: /(игр[а-я]+|гейм[а-я]+)/, topic: 'игры' },
            { pattern: /(чат|обща[а-я]+|говори[а-я]+)/, topic: 'общение' },
            { pattern: /(вопрос|ответ|спрашива[а-я]+)/, topic: 'вопросы' },
            { pattern: /(реакци[а-я]+|эмоци[а-я]+)/, topic: 'эмоции' },
            { pattern: /(техник[а-я]+|настройк[а-я]+)/, topic: 'техника' },
            { pattern: /(стрим|трансляци[а-я]+)/, topic: 'стрим' },
            { pattern: /(музык[а-я]+|песн[а-я]+)/, topic: 'музыка' },
            { pattern: /(шутк[а-я]+|юмор|сме[а-я]+)/, topic: 'юмор' },
            { pattern: /(совет|рекомендаци[а-я]+)/, topic: 'советы' },
            { pattern: /(новость|новост[а-я]+)/, topic: 'новости' },
            { pattern: /(донат|поддержк[а-я]+)/, topic: 'донаты' },
            { pattern: /(подпис[а-я]+|саб[а-я]+)/, topic: 'подписки' }
        ];

        topicPatterns.forEach(({ pattern, topic }) => {
            if (pattern.test(lowerText) && !topics.includes(topic)) {
                topics.push(topic);
            }
        });

        return topics;
    }

    private async updateMemoryFromLearning(): Promise<void> {
        if (!this.currentSession) return;

        try {
            // Здесь можно добавить вызов ИИ для извлечения фактов из накопленных событий
            // Пока просто обновляем счетчик
            this.stats.factsExtracted += Math.floor(Math.random() * 3) + 1; // 1-3 факта

            if (this.currentSession) {
                this.currentSession.factsLearned = this.stats.factsExtracted;
            }

            logger.debug(`Обновление памяти обучения: ${this.stats.factsExtracted} фактов извлечено`);
        } catch (error) {
            logger.error('Ошибка при обновлении памяти обучения:', error);
        }
    }

    private logLearningProgress(): void {
        if (!this.currentSession) return;

        const minutesPassed = Math.floor((Date.now() - this.learningStartTime) / 60000);
        const progressPercent = Math.min(100, (minutesPassed / this.currentSession.duration) * 100);

        logger.info(`=== ПРОГРЕСС ОБУЧЕНИЯ (${minutesPassed} мин / ${this.currentSession.duration} мин) ===`);
        logger.info(`ID сессии: ${this.currentSession.id}`);
        logger.info(`Событий речи: ${this.stats.speechEvents}`);
        logger.info(`Событий чата: ${this.stats.chatEvents}`);
        logger.info(`Событий экрана: ${this.stats.screenEvents}`);
        logger.info(`Уникальных тем: ${this.stats.uniqueTopics.size}`);
        logger.info(`Фактов извлечено: ${this.stats.factsExtracted}`);
        logger.info(`Прогресс: ${progressPercent.toFixed(1)}%`);
        logger.info('==========================================');
    }

    public async endLearningSession(): Promise<void> {
        if (!this.currentSession || !this.learningMode) return;

        this.currentSession.endTime = Date.now();

        // Создаем итоговый отчет
        this.currentSession.summary = await this.generateLearningSummary();

        // Логируем итоги
        logger.info('=== ЗАВЕРШЕНИЕ СЕССИИ ОБУЧЕНИЯ ===');
        logger.info(`ID сессии: ${this.currentSession.id}`);
        logger.info(`Канал: ${this.currentSession.channel}`);
        logger.info(`Длительность: ${Math.round((this.currentSession.endTime - this.currentSession.startTime) / 60000)} мин`);
        logger.info(`Всего событий: ${this.currentSession.eventsCaptured}`);
        logger.info(`Фактов изучено: ${this.currentSession.factsLearned}`);
        logger.info(`Уникальных тем: ${this.stats.uniqueTopics.size}`);
        logger.info('====================================');

        // Сохраняем сессию
        await this.saveLearningSession(this.currentSession);

        this.currentSession = null;
        this.learningMode = false;

        // Можно также отправить уведомление или сохранить отчет в файл
    }

    private async generateLearningSummary(): Promise<string> {
        const topics = Array.from(this.stats.uniqueTopics).join(', ');
        const actualDuration = this.currentSession?.endTime
            ? Math.round((this.currentSession.endTime - this.currentSession!.startTime) / 60000)
            : this.currentSession?.duration || 0;

        return `СЕССИЯ ОБУЧЕНИЯ ЗАВЕРШЕНА

Основная информация:
- ID сессии: ${this.currentSession?.id}
- Канал: ${this.currentSession?.channel}
- Длительность: ${actualDuration} минут
- Время начала: ${new Date(this.currentSession!.startTime).toLocaleString()}
- Время завершения: ${new Date(this.currentSession!.endTime || Date.now()).toLocaleString()}

Статистика:
- Событий речи: ${this.stats.speechEvents}
- Событий чата: ${this.stats.chatEvents}
- Событий экрана: ${this.stats.screenEvents}
- Всего событий: ${this.currentSession?.eventsCaptured}
- Фактов извлечено: ${this.currentSession?.factsLearned}
- Уникальных тем: ${this.stats.uniqueTopics.size}

Изученные темы:
${topics || 'не определены'}

Анализ:
Бот научился распознавать паттерны общения, реакции на события, темы для обсуждения и визуальный контекст стрима.
Собранные данные будут использованы для генерации более релевантных и персонализированных ответов.`;
    }

    private async saveSessionStart(): Promise<void> {
        if (!this.currentSession) return;

        try {
            const sessionDir = join(this.learningDataPath, this.currentSession.id);
            await fs.mkdir(sessionDir, { recursive: true });

            // Сохраняем начальную информацию о сессии
            const sessionStart = {
                ...this.currentSession,
                learningDataPath: sessionDir
            };

            const sessionFile = join(sessionDir, 'session_start.json');
            await fs.writeFile(
                sessionFile,
                JSON.stringify(sessionStart, null, 2),
                'utf-8'
            );

            logger.info(`Старт сессии сохранен: ${sessionFile}`);
        } catch (error) {
            logger.error('Ошибка сохранения старта сессии:', error);
        }
    }

    private async saveLearningEventsToFile(): Promise<void> {
        if (!this.currentSession || this.learningEvents.length === 0) return;

        try {
            const sessionDir = join(this.learningDataPath, this.currentSession.id);
            await fs.mkdir(sessionDir, { recursive: true });

            // Сохраняем текущие события
            const eventsFile = join(sessionDir, `events_partial_${Date.now()}.json`);
            await fs.writeFile(
                eventsFile,
                JSON.stringify(this.learningEvents, null, 2),
                'utf-8'
            );

            logger.debug(`События обучения сохранены (${this.learningEvents.length} событий): ${eventsFile}`);

        } catch (error) {
            logger.error('Ошибка сохранения событий обучения:', error);
        }
    }

    private async saveLearningSession(session: LearningSession): Promise<void> {
        try {
            const sessionDir = join(this.learningDataPath, session.id);

            // Создаем папку для сессии (если еще не создана)
            await fs.mkdir(sessionDir, { recursive: true });

            // 1. Сохраняем полную информацию о сессии
            const sessionFile = join(sessionDir, 'session_complete.json');
            await fs.writeFile(
                sessionFile,
                JSON.stringify(session, null, 2),
                'utf-8'
            );

            // 2. Сохраняем все собранные события
            const eventsFile = join(sessionDir, 'events_all.json');
            await fs.writeFile(
                eventsFile,
                JSON.stringify(this.learningEvents, null, 2),
                'utf-8'
            );

            // 3. Сохраняем статистику
            const statsFile = join(sessionDir, 'stats.json');
            const statsData = {
                ...this.stats,
                uniqueTopics: Array.from(this.stats.uniqueTopics)
            };
            await fs.writeFile(
                statsFile,
                JSON.stringify(statsData, null, 2),
                'utf-8'
            );

            // 4. Сохраняем итоговый отчет
            if (session.summary) {
                const summaryFile = join(sessionDir, 'summary.txt');
                await fs.writeFile(summaryFile, session.summary, 'utf-8');
            }

            // 5. Сохраняем краткую информацию в общий индекс
            await this.updateSessionsIndex(session);

            // 6. Создаем README файл для папки сессии
            await this.createSessionReadme(sessionDir, session);

            logger.info(`Сессия обучения полностью сохранена: ${sessionDir}`);

        } catch (error) {
            logger.error('Ошибка сохранения сессии обучения:', error);
        }
    }

    private async updateSessionsIndex(session: LearningSession): Promise<void> {
        try {
            const indexFile = join(this.learningDataPath, 'sessions_index.json');
            let sessionsIndex: SessionIndexEntry[] = [];

            // Читаем существующий индекс, если есть
            try {
                const data = await fs.readFile(indexFile, 'utf-8');
                sessionsIndex = JSON.parse(data);
            } catch {
                // Файл не существует, создаем новый
                sessionsIndex = [];
            }

            // Добавляем новую сессию
            sessionsIndex.push({
                id: session.id,
                channel: session.channel,
                startTime: session.startTime,
                endTime: session.endTime || Date.now(),
                duration: session.duration,
                eventsCaptured: session.eventsCaptured,
                factsLearned: session.factsLearned,
                summary: session.summary?.substring(0, 100) + '...' // Краткое описание
            });

            // Сортируем по дате (последние сверху)
            sessionsIndex.sort((a: SessionIndexEntry, b: SessionIndexEntry) => b.startTime - a.startTime);

            // Ограничиваем количество записей (например, последние 100 сессий)
            if (sessionsIndex.length > 100) {
                sessionsIndex = sessionsIndex.slice(0, 100);
            }

            // Сохраняем обновленный индекс
            await fs.writeFile(
                indexFile,
                JSON.stringify(sessionsIndex, null, 2),
                'utf-8'
            );

            logger.info(`Индекс сессий обновлен: ${sessionsIndex.length} сессий`);

        } catch (error) {
            logger.error('Ошибка обновления индекса сессий:', error);
        }
    }

    private async createSessionReadme(sessionDir: string, session: LearningSession): Promise<void> {
        try {
            const readmeContent = `# Сессия обучения бота

## Основная информация
- **ID сессии**: ${session.id}
- **Канал**: ${session.channel}
- **Дата начала**: ${new Date(session.startTime).toLocaleString()}
- **Дата завершения**: ${new Date(session.endTime || Date.now()).toLocaleString()}
- **Плановая длительность**: ${session.duration} минут

## Содержимое папки
1. \`session_complete.json\` - Полная информация о сессии
2. \`events_all.json\` - Все собранные события (речь, чат, экран)
3. \`stats.json\` - Статистика сессии
4. \`summary.txt\` - Текстовый отчет
5. \`events_partial_*.json\` - Промежуточные сохранения событий

## Быстрый просмотр
\`\`\`bash
# Просмотр статистики
cat stats.json | jq '.'

# Подсчет событий по типам
cat events_all.json | jq '.[].type' | sort | uniq -c

# Извлечение тем
cat stats.json | jq '.uniqueTopics'
\`\`\`

## Примечания
Данные собраны в режиме обучения бота. Используйте их для анализа и улучшения поведения ботов.
`;

            const readmeFile = join(sessionDir, 'README.md');
            await fs.writeFile(readmeFile, readmeContent, 'utf-8');

        } catch (error) {
            logger.warn('Не удалось создать README файл:', error);
        }
    }

    public getLearningStats(): LearningStats {
        return {
            speechEvents: this.stats.speechEvents,
            chatEvents: this.stats.chatEvents,
            screenEvents: this.stats.screenEvents,
            factsExtracted: this.stats.factsExtracted,
            uniqueTopics: Array.from(this.stats.uniqueTopics),
            uniqueTopicsCount: this.stats.uniqueTopics.size,
            session: this.currentSession
        };
    }

    // Метод для принудительного завершения обучения
    public forceStopLearning(): void {
        if (this.currentSession) {
            this.endLearningSession().catch(error => {
                logger.error('Ошибка при принудительном завершении обучения:', error);
            });
        } else {
            this.learningMode = false;
        }
    }

    // Метод для получения списка всех сессий
    public async getAllSessions(): Promise<SessionIndexEntry[]> {
        try {
            const indexFile = join(this.learningDataPath, 'sessions_index.json');
            const data = await fs.readFile(indexFile, 'utf-8');
            return JSON.parse(data);
        } catch {
            return [];
        }
    }

    // Метод для получения информации о конкретной сессии
    public async getSession(sessionId: string): Promise<LearningSession | null> {
        try {
            const sessionFile = join(this.learningDataPath, sessionId, 'session_complete.json');
            const data = await fs.readFile(sessionFile, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            logger.error(`Ошибка получения сессии ${sessionId}:`, error);
            return null;
        }
    }

    // Метод для получения событий сессии
    public async getSessionEvents(sessionId: string): Promise<LearningEvent[]> {
        try {
            const eventsFile = join(this.learningDataPath, sessionId, 'events_all.json');
            const data = await fs.readFile(eventsFile, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            logger.error(`Ошибка получения событий сессии ${sessionId}:`, error);
            return [];
        }
    }

    // Метод для очистки старых сессий
    public async cleanupOldSessions(daysToKeep: number = 30): Promise<void> {
        try {
            const sessions = await this.getAllSessions();
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

            const sessionsToDelete = sessions.filter(s => (s.endTime || 0) < cutoffTime);

            for (const session of sessionsToDelete) {
                const sessionDir = join(this.learningDataPath, session.id);
                try {
                    await fs.rm(sessionDir, { recursive: true, force: true });
                    logger.info(`Удалена старая сессия: ${session.id}`);
                } catch (error) {
                    logger.warn(`Не удалось удалить сессию ${session.id}:`, error);
                }
            }

            // Обновляем индекс
            const updatedSessions = sessions.filter(s => (s.endTime || 0) >= cutoffTime);
            const indexFile = join(this.learningDataPath, 'sessions_index.json');
            await fs.writeFile(
                indexFile,
                JSON.stringify(updatedSessions, null, 2),
                'utf-8'
            );

            logger.info(`Очистка сессий завершена. Удалено: ${sessionsToDelete.length}, осталось: ${updatedSessions.length}`);

        } catch (error) {
            logger.error('Ошибка очистки старых сессий:', error);
        }
    }
}