import { MemoryStore } from './memory';
import { logger } from './logger';
import { join } from 'path';
import { promises as fs } from 'fs';

export class KnowledgeViewer {
    private memoryStore: MemoryStore;

    constructor() {
        this.memoryStore = new MemoryStore();
    }

    async showAllCategories(): Promise<void> {
        try {
            const stats = await this.memoryStore.getKnowledgeStats();

            console.log('\n=== ВСЕ КАТЕГОРИИ ЗНАНИЙ ===');
            console.log(`Всего знаний: ${stats.total}\n`);

            if (stats.byCategory) {
                Object.entries(stats.byCategory).forEach(([category, count]) => {
                    console.log(`${category}: ${count} знаний`);
                });
            }

            console.log('\nСамые используемые знания:');
            if (stats.mostUsed && stats.mostUsed.length > 0) {
                stats.mostUsed.slice(0, 5).forEach((k, i) => {
                    console.log(`${i + 1}. ${k.text.substring(0, 60)}... (использовано: ${k.usageCount})`);
                });
            }
        } catch (error) {
            console.error('Ошибка при получении статистики:', error);
        }
    }

    async showKnowledgeByCategory(category: string): Promise<void> {
        const validCategories = ['game_terms', 'twitch_terms', 'humor', 'behavior', 'culture'];

        if (!validCategories.includes(category)) {
            console.log(`Неверная категория. Доступные: ${validCategories.join(', ')}`);
            return;
        }

        try {
            const knowledge = await this.memoryStore.getKnowledgeByCategory(category as any);

            console.log(`\n=== ЗНАНИЯ: ${category.toUpperCase()} ===`);
            console.log(`Найдено: ${knowledge.length}\n`);

            knowledge.slice(0, 20).forEach((k, i) => {
                console.log(`${i + 1}. ${k.text}`);
                console.log(`   Примеры: ${k.examples.slice(0, 2).join(', ')}`);
                console.log(`   Уверенность: ${(k.confidence * 100).toFixed(0)}%`);
                console.log(`   Использовано: ${k.usageCount} раз`);
                console.log(`   Источники: ${k.learnedFrom.slice(0, 2).join(', ')}`);
                console.log();
            });

            if (knowledge.length > 20) {
                console.log(`... и еще ${knowledge.length - 20} знаний`);
            }
        } catch (error) {
            console.error('Ошибка при получении знаний:', error);
        }
    }

    async searchKnowledge(query: string): Promise<void> {
        try {
            const results = await this.memoryStore.findRelevantGlobalKnowledge(query);

            console.log(`\n=== ПОИСК: "${query}" ===`);
            console.log(`Найдено: ${results.length}\n`);

            results.slice(0, 10).forEach((k, i) => {
                console.log(`${i + 1}. [${k.category}] ${k.text}`);
                console.log(`   Контекст: ${k.usageContext.join(', ')}`);
                console.log(`   Пример: ${k.examples[0]}`);
                console.log(`   Уверенность: ${(k.confidence * 100).toFixed(0)}%`);
                console.log();
            });
        } catch (error) {
            console.error('Ошибка при поиске знаний:', error);
        }
    }

    async exportKnowledge(format: 'json' | 'csv' | 'txt' = 'json'): Promise<void> {
        try {
            const knowledge = await this.memoryStore.loadGlobal();

            if (format === 'json') {
                const json = JSON.stringify(knowledge, null, 2);
                await fs.writeFile('knowledge_export.json', json, 'utf-8');
                console.log('Экспортировано в knowledge_export.json');
            } else if (format === 'csv') {
                let csv = 'category,text,examples,usageContext,confidence,usageCount,lastUsed\n';
                knowledge.forEach(k => {
                    const examples = `"${k.examples.join('|')}"`;
                    const contexts = `"${k.usageContext.join('|')}"`;
                    csv += `${k.category},"${k.text}",${examples},${contexts},${k.confidence},${k.usageCount},${new Date(k.lastUsed).toISOString()}\n`;
                });
                await fs.writeFile('knowledge_export.csv', csv, 'utf-8');
                console.log('Экспортировано в knowledge_export.csv');
            } else if (format === 'txt') {
                let txt = `=== ЭКСПОРТ БАЗЫ ЗНАНИЙ ===\n`;
                txt += `Всего знаний: ${knowledge.length}\n`;
                txt += `Дата экспорта: ${new Date().toLocaleString()}\n\n`;

                knowledge.forEach((k, i) => {
                    txt += `${i + 1}. [${k.category}] ${k.text}\n`;
                    txt += `   Примеры: ${k.examples.join(', ')}\n`;
                    txt += `   Контекст: ${k.usageContext.join(', ')}\n`;
                    txt += `   Уверенность: ${(k.confidence * 100).toFixed(0)}%\n`;
                    txt += `   Использовано: ${k.usageCount} раз\n`;
                    txt += `   Последнее использование: ${new Date(k.lastUsed).toLocaleString()}\n`;
                    txt += `   Источники: ${k.learnedFrom.join(', ')}\n\n`;
                });

                await fs.writeFile('knowledge_export.txt', txt, 'utf-8');
                console.log('Экспортировано в knowledge_export.txt');
            }
        } catch (error) {
            console.error('Ошибка при экспорте знаний:', error);
        }
    }

    async showMostUsedKnowledge(limit: number = 10): Promise<void> {
        try {
            const stats = await this.memoryStore.getKnowledgeStats();

            console.log(`\n=== САМЫЕ ИСПОЛЬЗУЕМЫЕ ЗНАНИЯ (топ ${limit}) ===\n`);

            if (stats.mostUsed && stats.mostUsed.length > 0) {
                stats.mostUsed.slice(0, limit).forEach((k, i) => {
                    console.log(`${i + 1}. [${k.category}] ${k.text}`);
                    console.log(`   Использовано: ${k.usageCount} раз`);
                    console.log(`   Последнее использование: ${new Date(k.lastUsed).toLocaleString()}`);
                    console.log(`   Уверенность: ${(k.confidence * 100).toFixed(0)}%`);
                    console.log();
                });
            }
        } catch (error) {
            console.error('Ошибка при получении самых используемых знаний:', error);
        }
    }
}

// Пример использования в командной строке
if (require.main === module) {
    const viewer = new KnowledgeViewer();
    const args = process.argv.slice(2);

    if (args[0] === 'categories') {
        viewer.showAllCategories();
    } else if (args[0] === 'category' && args[1]) {
        viewer.showKnowledgeByCategory(args[1]);
    } else if (args[0] === 'search' && args[1]) {
        viewer.searchKnowledge(args[1]);
    } else if (args[0] === 'export' && args[1]) {
        viewer.exportKnowledge(args[1] as any);
    } else if (args[0] === 'most-used') {
        const limit = args[1] ? parseInt(args[1]) : 10;
        viewer.showMostUsedKnowledge(limit);
    } else {
        console.log(`
Использование:
  npm run knowledge:view categories              - Показать все категории
  npm run knowledge:view category <type>         - Показать знания по категории
  npm run knowledge:view search <query>          - Поиск знаний
  npm run knowledge:export <format>              - Экспорт (json/csv/txt)
  npm run knowledge:view most-used [limit]       - Самые используемые знания

Примеры:
  npm run knowledge:stats                        - Быстрая статистика
  npm run knowledge:view category game_terms     - Показать игровые термины
  npm run knowledge:view search "CS:GO"          - Поиск знаний по CS:GO
  npm run knowledge:export json                  - Экспорт в JSON
        `);
    }
}