// src/emotionStats.ts
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from './logger';

export interface EmotionalMoment {
    id: string;
    timestamp: number;
    streamerSpeech: string;
    chatReactions: any[];
    emotionType: string;
    intensity: number;
    tags: string[];
    analysis: any;
}

export class EmotionLogger {
    private logDir: string;
    private currentLogFile: string | null = null;

    constructor() {
        this.logDir = join(process.cwd(), 'data', 'emotions');
        this.ensureDir().then(() => {
            this.createNewLogFile();
            logger.info(`EmotionLogger initialized. Log directory: ${this.logDir}`);
        });
    }

    private async ensureDir(): Promise<void> {
        try {
            await fs.mkdir(this.logDir, { recursive: true });
        } catch (error) {
            logger.error('Error creating emotion log directory:', error);
        }
    }

    private createNewLogFile(): void {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        this.currentLogFile = join(this.logDir, `emotions_${dateStr}.json`);
    }

    public async logMoment(moment: EmotionalMoment): Promise<void> {
        try {
            if (!this.currentLogFile) {
                this.createNewLogFile();
            }

            // Загружаем существующие моменты
            let moments: EmotionalMoment[] = [];
            try {
                const data = await fs.readFile(this.currentLogFile!, 'utf-8');
                moments = JSON.parse(data);
            } catch {
                // Файл не существует или пустой
                moments = [];
            }

            // Добавляем новый момент
            moments.push(moment);

            // Сохраняем обратно
            await fs.writeFile(
                this.currentLogFile!,
                JSON.stringify(moments, null, 2),
                'utf-8'
            );

            logger.debug(`[Emotion] Записан момент ${moment.id} в файл`);
        } catch (error) {
            logger.error('Error logging emotion moment:', error);
        }
    }

    public async getTodayMoments(): Promise<EmotionalMoment[]> {
        try {
            const data = await fs.readFile(this.currentLogFile!, 'utf-8');
            return JSON.parse(data);
        } catch {
            return [];
        }
    }

    public async getMomentsByDate(date: string): Promise<EmotionalMoment[]> {
        try {
            const filePath = join(this.logDir, `emotions_${date}.json`);
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch {
            return [];
        }
    }

    public async getEmotionStats(date?: string): Promise<{
        total: number;
        byEmotion: Record<string, number>;
        topIntense: EmotionalMoment[];
    }> {
        const moments = date
            ? await this.getMomentsByDate(date)
            : await this.getTodayMoments();

        const byEmotion: Record<string, number> = {};
        moments.forEach(m => {
            byEmotion[m.emotionType] = (byEmotion[m.emotionType] || 0) + 1;
        });

        const topIntense = [...moments]
            .sort((a, b) => b.intensity - a.intensity)
            .slice(0, 10);

        return {
            total: moments.length,
            byEmotion,
            topIntense
        };
    }
}

async function showStats() {
    const logger = new EmotionLogger();
    const stats = await logger.getEmotionStats();

    console.log('\n=== СТАТИСТИКА ЭМОЦИОНАЛЬНЫХ МОМЕНТОВ ===');
    console.log(`Всего моментов: ${stats.total}\n`);

    if (stats.total > 0) {
        console.log('Распределение по эмоциям:');
        Object.entries(stats.byEmotion).forEach(([emotion, count]) => {
            console.log(`  ${emotion}: ${count}`);
        });

        console.log('\nСамые интенсивные моменты:');
        stats.topIntense.forEach((moment, i) => {
            console.log(`${i + 1}. [${moment.emotionType}] ${moment.streamerSpeech.substring(0, 50)}...`);
            console.log(`   Интенсивность: ${moment.intensity}/5, Реакций: ${moment.chatReactions.length}`);
            console.log();
        });
    } else {
        console.log('Нет данных об эмоциональных моментах');
    }
}

async function exportToday() {
    const logger = new EmotionLogger();
    const moments = await logger.getTodayMoments();
    const exportData = {
        exportDate: new Date().toISOString(),
        total: moments.length,
        moments
    };

    const fs = require('fs');
    const fileName = `emotions_export_${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(fileName, JSON.stringify(exportData, null, 2), 'utf-8');
    console.log(`Экспортировано в ${fileName}`);
}

// Запуск
const args = process.argv.slice(2);

if (args[0] === 'export') {
    exportToday();
} else if (args[0] === 'today') {
    const logger = new EmotionLogger();
    logger.getTodayMoments().then(moments => {
        console.log(JSON.stringify(moments, null, 2));
    });
} else {
    showStats();
}