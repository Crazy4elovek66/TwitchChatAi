import { Bot } from './bot';
import { AIService } from './ai';
import { logger } from './logger';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Определяем режим из переменной окружения (её устанавливает cross-env)
const mode = process.env.MODE || 'yandex';

// Загружаем соответствующий .env файл
if (mode === 'local' && fs.existsSync(path.join(process.cwd(), '.env.local'))) {
  dotenv.config({ path: '.env.local' });
  logger.info(`✅ Загружен .env.local (режим LOCAL)`);
} else {
  dotenv.config();
  logger.info(`✅ Загружен .env (режим ${mode})`);
}

// Валидация обязательных переменных (только для режима Yandex)
if (mode !== 'local') {
  const requiredEnvVars = [
    'TWITCH_CHANNEL',
    'TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET',
    'YANDEX_API_KEY',
    'YANDEX_FOLDER_ID'
  ];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      logger.error(`Missing required environment variable: ${envVar}`);
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }
}

// Проверка наличия хотя бы одного бота (всегда нужна)
if (!process.env['BOT1_USERNAME'] || !process.env['BOT1_OAUTH']) {
  throw new Error('BOT1 credentials are required in environment variables');
}

// Инициализация AI сервиса
const aiService = new AIService();

// Создание и подключение ботов
const bots: Bot[] = [];

async function shutdown() {
  logger.info('Shutting down...');
  // ... (весь остальной код без изменений)
  for (const bot of bots) {
    try {
      bot.disconnect();
    } catch (error) {
      logger.error(`Error disconnecting bot ${bot.getUsername()}:`, error);
    }
  }

  // Завершаем сессию обучения, если активна
  if (aiService.isLearningMode()) {
    const learningManager = aiService.getLearningManager();
    learningManager.forceStopLearning();

    // Показываем финальную статистику знаний
    try {
      const stats = await aiService.getKnowledgeStats();
      if (stats) {
        logger.info('=== ФИНАЛЬНАЯ СТАТИСТИКА ЗНАНИЙ ===');
        logger.info(`Всего собрано знаний: ${stats.total}`);
        logger.info('Распределение по категориям:');
        Object.entries(stats.byCategory).forEach(([category, count]) => {
          logger.info(`  ${category}: ${count}`);
        });
        logger.info('====================================');
      }
    } catch (error) {
      logger.debug('Ошибка получения финальной статистики:', error);
    }
  }

  // Показываем статистику эмоциональных моментов
  try {
    const emotionStats = aiService.getEmotionStats();
    if (emotionStats && emotionStats.totalMoments > 0) {
      logger.info('=== ЭМОЦИОНАЛЬНЫЕ МОМЕНТЫ ===');
      logger.info(`Всего моментов: ${emotionStats.totalMoments}`);
      logger.info('Распределение по типам:');
      Object.entries(emotionStats.byEmotion).forEach(([emotion, count]) => {
        logger.info(`  ${emotion}: ${count}`);
      });
      logger.info('================================');
    }
  } catch (error) {
    logger.debug('Ошибка получения статистики эмоций:', error);
  }

  // Даем время на очистку
  await new Promise(resolve => setTimeout(resolve, 2000));

  process.exit(0);
}

async function main() {
  try {
    if (aiService.isLearningMode()) {
      logger.info('=== ЗАПУСК В РЕЖИМЕ ОБУЧЕНИЯ ===');
      logger.info('Цель: сбор глобальных знаний об играх и твич-культуре');
      logger.info('Используется только один аккаунт для анализа');
      logger.info('Сообщения отправляться не будут');

      const learningChannel = process.env.LEARNING_CHANNEL || process.env.TWITCH_CHANNEL!;
      logger.info(`Канал для обучения: ${learningChannel}`);

      const sessionDuration = parseInt(process.env.LEARNING_SESSION_DURATION_MINUTES || '120', 10);
      logger.info(`Длительность сессии: ${sessionDuration} минут`);

      logger.info('Собираемые категории знаний:');
      logger.info('  - game_terms: термины игр, геймплей, механики');
      logger.info('  - twitch_terms: стриминг, донаты, подписки, чат');
      logger.info('  - humor: шутки, мемы, ирония');
      logger.info('  - behavior: поведение в чате, реакции');
      logger.info('  - culture: интернет-культура, тренды');
      logger.info('========================================');
    } else {
      logger.info('=== ЗАПУСК MULTI-BOT TWITCH AI СИСТЕМЫ ===');
      logger.info('Боты будут общаться в чате, используя глобальные знания');
      logger.info('Анализ эмоциональных моментов активирован');
    }

    // Извлекаем имя канала из URL
    const channelUrl = process.env.TWITCH_CHANNEL!;
    const channelName = channelUrl.includes('twitch.tv/')
      ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
      : channelUrl;

    if (aiService.isLearningMode()) {
      logger.info(`Целевой канал для обучения: ${channelName}`);
    } else {
      logger.info(`Целевой канал: ${channelName}`);
    }

    if (aiService.isLearningMode()) {
      logger.info('Настройка единственного бота для обучения...');
    } else {
      logger.info('Настройка ботов с личностями...');
    }

    // Доступные личности
    const availablePersonalities = ['bot1', 'bot2', 'bot3', 'bot4'];
    let personalityIndex = 0;

    // Определяем сколько ботов создавать
    const maxBots = aiService.isLearningMode() ? 1 : 10;

    // Создаем ботов из переменных окружения
    for (let i = 1; i <= maxBots; i++) {
      const username = process.env[`BOT${i}_USERNAME`];
      const oauth = process.env[`BOT${i}_OAUTH`];

      if (!username || !oauth) {
        if (i === 1) {
          throw new Error(`BOT1 credentials are required!`);
        }
        continue;
      }

      try {
        // В режиме обучения используем специальную личность "learning"
        const personalityId = aiService.isLearningMode()
          ? 'learning'
          : availablePersonalities[personalityIndex % availablePersonalities.length];

        personalityIndex++;

        const isPrimary = i === 1; // Первый бот запускает захват голоса

        const bot = new Bot({
          username: username.trim(),
          oauth: oauth.trim(),
          channel: channelName,
          aiService,
          personalityId,
          isPrimary
        });

        bots.push(bot);
        bot.connect();

        if (aiService.isLearningMode()) {
          logger.info(`Бот для обучения подключен: ${username}`);
        } else {
          logger.info(`Бот ${i} создан: ${username} (личность: ${personalityId})`);
        }

        // В режиме обучения не создаем задержек между подключениями
        if (!aiService.isLearningMode() && i < maxBots && process.env[`BOT${i + 1}_USERNAME`]) {
          await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 9000));
        }
      } catch (error) {
        logger.error(`Ошибка создания бота ${username}:`, error);
      }
    }

    if (bots.length === 0) {
      throw new Error('No bots were successfully created');
    }

    if (aiService.isLearningMode()) {
      logger.info('=== ОБУЧЕНИЕ НАЧАТО ===');
      logger.info('Бот слушает стрим, анализирует речь, чат и экран');
      logger.info('Данные сохраняются в глобальную базу знаний');
      logger.info('Для остановки нажмите Ctrl+C');
      logger.info('========================');
    } else {
      logger.info(`=== СИСТЕМА ЗАПУЩЕНА ===`);
      logger.info(`Всего ботов: ${bots.length}`);
      logger.info(`Канал: ${channelName}`);
      logger.info(`Глобальных знаний доступно: ${aiService.getGlobalKnowledgeCount()}`);

      // Показываем статистику эмоциональных моментов
      try {
        const emotionStats = aiService.getEmotionStats();
        if (emotionStats && emotionStats.totalMoments > 0) {
          logger.info(`Эмоциональных моментов в памяти: ${emotionStats.totalMoments}`);
        }
      } catch (error) {
        // Игнорируем ошибки
      }

      logger.info('========================');
    }

    // Обработка завершения процесса
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (error) => {
      logger.error('Необработанное исключение:', error);
      shutdown();
    });
    process.on('unhandledRejection', (error) => {
      logger.error('Необработанный промис:', error);
      shutdown();
    });

    // Периодическая информация о состоянии системы
    setInterval(async () => {
      if (aiService.isLearningMode()) {
        const learningManager = aiService.getLearningManager();
        const stats = learningManager.getLearningStats();

        logger.info(`=== СТАТУС ОБУЧЕНИЯ ===`);
        logger.info(`Событий речи: ${stats.speechEvents}`);
        logger.info(`Событий чата: ${stats.chatEvents}`);
        logger.info(`Событий экрана: ${stats.screenEvents}`);
        logger.info(`Тем изучено: ${stats.uniqueTopicsCount}`);
        logger.info(`Фактов извлечено: ${stats.factsExtracted}`);
        logger.info(`=======================`);

        // Каждые 15 минут показываем подробную статистику знаний
        const knowledgeCount = aiService.getGlobalKnowledgeCount();
        if (knowledgeCount > 0 && Math.random() < 0.3) { // 30% шанс каждые 5 минут
          try {
            const knowledgeStats = await aiService.getKnowledgeStats();
            if (knowledgeStats) {
              logger.info(`Глобальных знаний: ${knowledgeStats.total}`);
              logger.info('Распределение:');
              Object.entries(knowledgeStats.byCategory).forEach(([category, count]) => {
                logger.info(`  ${category}: ${count}`);
              });
            }
          } catch (error) {
            // Игнорируем ошибки статистики
          }
        }
      } else {
        // В обычном режиме показываем общую статистику
        const activeBots = bots.filter(bot => !bot.isInLearningMode()).length;
        const knowledgeCount = aiService.getGlobalKnowledgeCount();

        logger.info(`=== СТАТУС СИСТЕМЫ ===`);
        logger.info(`Активных ботов: ${activeBots}`);
        logger.info(`Канал: ${channelName}`);
        logger.info(`Глобальных знаний: ${knowledgeCount}`);

        // Показываем статистику эмоций каждые 15 минут
        try {
          const emotionStats = aiService.getEmotionStats();
          if (emotionStats && emotionStats.totalMoments > 0) {
            logger.info(`Эмоциональных моментов: ${emotionStats.totalMoments}`);

            // Показываем распределение эмоций
            if (Object.keys(emotionStats.byEmotion).length > 0) {
              const topEmotion = Object.entries(emotionStats.byEmotion)
                .sort(([, a], [, b]) => (b as number) - (a as number))[0];
              if (topEmotion) {
                logger.info(`Самая частая эмоция: ${topEmotion[0]} (${topEmotion[1]})`);
              }
            }
          }
        } catch (error) {
          // Игнорируем ошибки
        }

        // Показываем примеры знаний каждые 30 минут
        if (knowledgeCount > 0 && Math.random() < 0.1) { // 10% шанс каждые 5 минут
          try {
            const knowledgeStats = await aiService.getKnowledgeStats();
            if (knowledgeStats && knowledgeStats.mostUsed.length > 0) {
              logger.info(`Самые используемые знания:`);
              knowledgeStats.mostUsed.slice(0, 2).forEach((k: any, i: number) => {
                logger.info(`  ${i + 1}. ${k.text.substring(0, 60)}...`);
              });
            }
          } catch (error) {
            // Игнорируем ошибки
          }
        }
        logger.info(`=====================`);
      }
    }, 300000); // Каждые 5 минут

    // Дополнительный интервал для показа ярких эмоциональных моментов (только в обычном режиме)
    if (!aiService.isLearningMode()) {
      setInterval(() => {
        try {
          const recentMoments = aiService.getRecentEmotionalMoments(3);
          if (recentMoments.length > 0) {
            const intenseMoments = recentMoments.filter(m => m.intensity >= 3);
            if (intenseMoments.length > 0) {
              const moment = intenseMoments[0];
              logger.info(`=== ЯРКИЙ ЭМОЦИОНАЛЬНЫЙ МОМЕНТ ===`);
              logger.info(`Тип: ${moment.emotionType}, Интенсивность: ${moment.intensity}/5`);
              logger.info(`Речь: "${moment.streamerSpeech.substring(0, 80)}..."`);
              logger.info(`Реакций: ${moment.chatReactions.length}`);
              logger.info(`================================`);
            }
          }
        } catch (error) {
          // Игнорируем ошибки
        }
      }, 900000); // Каждые 15 минут
    }

    // Выводим подсказку для пользователя
    logger.info('');
    logger.info('Команды для управления:');
    logger.info('  Ctrl+C - Остановить систему');
    logger.info('');

    if (aiService.isLearningMode()) {
      logger.info('Система работает в режиме обучения. Для выхода из режима обучения:');
      logger.info('  1. Установите LEARNING_MODE=0 в .env файле');
      logger.info('  2. Перезапустите приложение');
    } else {
      logger.info('Система работает в обычном режиме. Боты будут общаться в чате.');
      logger.info('Эмоциональные моменты автоматически анализируются и сохраняются.');
    }
    logger.info('');

  } catch (error) {
    logger.error('Ошибка в main:', error);
    await shutdown();
  }
}

// Запуск основного приложения
main();