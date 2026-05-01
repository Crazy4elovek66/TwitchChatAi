import tmi from 'tmi.js';
import { AIService } from './ai';
import { logger } from './logger';

interface BotConfig {
  username: string;
  oauth: string;
  channel: string;
  aiService: AIService;
  personalityId: string;
  isPrimary?: boolean;
}

function normalizeChannel(input: string): string {
  let c = (input || '').trim();
  if (c.includes('twitch.tv/')) {
    c = (c.split('twitch.tv/')[1] || c).split('/')[0].split('?')[0];
  }
  if (c.startsWith('#')) c = c.slice(1);
  return c.trim();
}

export class Bot {
  private client: tmi.Client;
  private aiService: AIService;

  private readonly channelName: string;
  private readonly username: string;
  private readonly personalityId: string;
  private isConnected = false;

  private readonly minSendIntervalMs: number;
  private readonly maxSendIntervalMs: number;
  private readonly jitter: number;
  private lastSendTs = 0;
  private nextAllowedSendTs = 0;

  private sending = false;
  private messageQueue: string[] = [];

  private pendingEcho: {
    msg: string;
    timeout: NodeJS.Timeout;
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;

  private learningMode: boolean;

  constructor(config: BotConfig) {
    this.aiService = config.aiService;
    this.channelName = normalizeChannel(config.channel);
    this.username = config.username;
    this.personalityId = config.personalityId;

    this.learningMode = this.aiService.isLearningMode();

    const registered = this.aiService.registerBot(this.username, this.personalityId);
    if (!registered) {
      throw new Error(`Failed to register bot ${this.username} with personality ${this.personalityId}`);
    }

    // В режиме обучения увеличиваем интервалы, так как сообщения не отправляются
    if (this.learningMode) {
      this.minSendIntervalMs = 600000; // 10 минут
      this.maxSendIntervalMs = 1200000; // 20 минут
      this.jitter = 0.3;
      logger.info(`[Обучение] Бот ${this.username} зарегистрирован для сбора знаний`);

      // Показываем статистику знаний через 10 секунд
      setTimeout(async () => {
        try {
          const knowledgeCount = this.aiService.getGlobalKnowledgeCount();
          logger.info(`[Обучение] Загружено глобальных знаний: ${knowledgeCount}`);

          const stats = await this.aiService.getKnowledgeStats();
          logger.info(`[Обучение] Статистика знаний:`);
          if (stats && stats.byCategory) {
            Object.entries(stats.byCategory).forEach(([category, count]) => {
              logger.info(`  ${category}: ${count}`);
            });
          }
        } catch (error) {
          logger.debug('Ошибка получения статистики знаний:', error);
        }
      }, 10000);
    } else {
      this.minSendIntervalMs = parseInt(process.env.BOT_MIN_SEND_INTERVAL_MS || '120000', 10);
      this.maxSendIntervalMs = parseInt(process.env.BOT_MAX_SEND_INTERVAL_MS || '300000', 10);
      this.jitter = parseFloat(process.env.BOT_JITTER || '0.5');
    }

    if (!config.oauth.startsWith('oauth:')) {
      throw new Error(`Invalid OAuth token format. Must start with oauth:`);
    }

    this.client = new tmi.Client({
      options: { debug: false, messagesLogLevel: 'info' },
      identity: { username: this.username, password: config.oauth },
      channels: [this.channelName],
      connection: { reconnect: true, secure: true }
    });

    this.setupHandlers();

    // Всегда запускаем захват голоса для первого бота (в режиме обучения - единственного)
    if (config.isPrimary) {
      // В режиме обучения используем указанный канал или основной
      const targetChannel = this.learningMode && process.env.LEARNING_CHANNEL
        ? process.env.LEARNING_CHANNEL
        : this.channelName;

      logger.info(`Запуск захвата голоса для канала: ${targetChannel} (режим обучения: ${this.learningMode})`);

      this.aiService.startVoiceCapture(targetChannel).then(() => {
        if (this.learningMode) {
          logger.info(`[Обучение] Начато прослушивание канала ${targetChannel} для сбора знаний`);
          logger.info(`[Обучение] Бот будет собирать: игровые термины, твич-культуру, интернет-мемы, паттерны общения`);
        }
      }).catch(err => {
        logger.error('Voice capture error:', err);
      });
    }
  }

  private setupHandlers(): void {
    this.client.on('message', (channel, tags, message, self) => {
      if (self) {
        if (this.pendingEcho && message === this.pendingEcho.msg) {
          clearTimeout(this.pendingEcho.timeout);
          this.pendingEcho.resolve();
          this.pendingEcho = null;
        }
        return;
      }

      const sender = tags['display-name'] || tags.username || 'viewer';

      try {
        this.aiService.emit('chatMessage', JSON.stringify({
          username: sender,
          chatMessage: message,
          isBot: this.aiService.getAllActiveBots().includes(sender),
          botUsername: this.username
        }));
      } catch (e) {
        logger.error('chatMessage emit failed:', e);
      }
    });

    this.client.on('connected', (addr, port) => {
      this.isConnected = true;

      if (this.learningMode) {
        logger.info(`[Обучение] Бот ${this.username} подключен к каналу ${this.channelName} (${addr}:${port})`);
        logger.info(`[Обучение] Режим анализа активирован. Сообщения не отправляются.`);

        // В режиме обучения периодически показываем статистику
        setInterval(async () => {
          try {
            const knowledgeCount = this.aiService.getGlobalKnowledgeCount();
            if (knowledgeCount > 0) {
              logger.info(`[Обучение] Собрано глобальных знаний: ${knowledgeCount}`);

              // Каждые 10 минут показываем детальную статистику
              if (Math.random() < 0.2) { // 20% шанс каждый интервал
                const stats = await this.aiService.getKnowledgeStats();
                if (stats && stats.byCategory) {
                  logger.info(`[Обучение] Распределение знаний по категориям:`);
                  Object.entries(stats.byCategory).forEach(([category, count]) => {
                    logger.info(`  ${category}: ${count}`);
                  });
                }
              }
            }
          } catch (error) {
            // Игнорируем ошибки статистики
          }
        }, 300000); // Каждые 5 минут
      } else {
        logger.info(`Bot ${this.username} connected to ${addr}:${port}`);
      }

      // В режиме обучения не отправляем приветственные сообщения
      if (!this.learningMode && Math.random() > 0.7) {
        setTimeout(() => {
          const greeting = this.getRandomGreeting();
          if (greeting) {
            this.messageQueue.push(greeting);
            this.flushQueue().catch(e => logger.error('Greeting send error:', e));
          }
        }, 10000 + Math.random() * 20000);
      }
    });

    this.client.on('disconnected', (reason) => {
      this.isConnected = false;

      if (this.learningMode) {
        logger.warn(`[Обучение] Бот ${this.username} отключен: ${reason}`);
      } else {
        logger.warn(`Bot ${this.username} disconnected: ${reason}`);
      }

      if (this.pendingEcho) {
        clearTimeout(this.pendingEcho.timeout);
        this.pendingEcho.reject(new Error('Disconnected before echo'));
        this.pendingEcho = null;
      }

      this.sending = false;
    });

    this.client.on('join', (channel, username, self) => {
      if (self && !this.learningMode) {
        logger.info(`${this.username} joined ${channel}`);
      }
    });

    // Обработка сообщений от AI сервиса для этого конкретного бота
    this.aiService.on('botMessage', (data: any) => {
      if (data.username === this.username) {
        const msg = String(data.message || '').trim();
        if (!msg) return;

        // В режиме обучения не добавляем сообщения в очередь, только логируем
        if (this.learningMode) {
          // В режиме обучения иногда показываем, какие сообщения могли бы быть сгенерированы
          if (Math.random() < 0.1) { // 10% шанс показать пример
            logger.debug(`[Обучение] Пример возможного сообщения от ${this.username}: "${msg.substring(0, 50)}..."`);
          }
          return;
        }

        // Проверяем на дубликаты в очереди
        const isDuplicate = this.messageQueue.some(queued =>
          queued.toLowerCase() === msg.toLowerCase()
        );

        if (!isDuplicate) {
          this.messageQueue.push(msg);
          this.flushQueue().catch(e => logger.error('Queue flush error:', e));
        }
      }
    });

    // Обработка ошибок (используем any для совместимости с tmi.js)
    (this.client as any).on('error', (error: any) => {
      if (this.learningMode) {
        logger.error(`[Обучение] Ошибка у бота ${this.username}:`, error);
      } else {
        logger.error(`Bot ${this.username} error:`, error);
      }
    });

    // Обработка переподключения (используем any для совместимости с tmi.js)
    (this.client as any).on('reconnect', () => {
      if (this.learningMode) {
        logger.info(`[Обучение] Бот ${this.username} переподключается...`);
      } else {
        logger.info(`Bot ${this.username} reconnecting...`);
      }
    });
  }

  private getRandomGreeting(): string {
    const greetings = [
      'привет',
      'здарова',
      'ку',
      'приветик',
      'здравствуйте',
      'салют',
      'добрый',
      'вечер в хату'
    ];

    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  private calculateNextSendTime(): number {
    const now = Date.now();
    const baseInterval = this.minSendIntervalMs +
      Math.random() * (this.maxSendIntervalMs - this.minSendIntervalMs);

    const jittered = baseInterval * ((1 - this.jitter) + Math.random() * (2 * this.jitter));
    return now + Math.floor(jittered);
  }

  private async flushQueue(): Promise<void> {
    if (this.sending || this.messageQueue.length === 0) return;

    this.sending = true;

    try {
      while (this.messageQueue.length > 0) {
        const now = Date.now();

        // Проверяем, можно ли отправить сейчас
        if (now < this.nextAllowedSendTs) {
          const waitTime = this.nextAllowedSendTs - now;
          await new Promise(r => setTimeout(r, waitTime));
        }

        const message = this.messageQueue.shift()!;
        await this.safeSend(message);

        // Обновляем время последней отправки
        this.lastSendTs = Date.now();
        this.nextAllowedSendTs = this.calculateNextSendTime();

        if (!this.learningMode) {
          logger.debug(`Next message from ${this.username} allowed at: ${new Date(this.nextAllowedSendTs).toLocaleTimeString()}`);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async safeSend(message: string): Promise<void> {
    if (!this.isConnected) {
      if (this.learningMode) {
        logger.warn(`[Обучение] Бот ${this.username} не подключен, пропускаем анализ`);
      } else {
        logger.warn(`${this.username} not connected, skipping send`);
      }
      return;
    }

    // В режиме обучения НИКОГДА не отправляем сообщения, только анализируем
    if (this.learningMode) {
      // В режиме обучения можем иногда логировать, что мы могли бы отправить
      if (Math.random() < 0.05) { // 5% шанс
        logger.debug(`[Обучение] Бот ${this.username} анализирует контекст, сообщение не отправляется: "${message.substring(0, 50)}..."`);
      }
      return;
    }

    const channel = `#${this.channelName}`;

    const echoPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingEcho) {
          this.pendingEcho = null;
          reject(new Error('No echo received'));
        }
      }, 5000);

      this.pendingEcho = {
        msg: message,
        timeout,
        resolve,
        reject
      };
    });

    try {
      await this.client.say(channel, message);
      logger.info(`${this.username} -> ${channel}: ${message}`);

      // Сообщаем AI сервису о нашем сообщении (чтобы другие боты видели)
      this.aiService.emit('chatMessage', JSON.stringify({
        username: this.username,
        chatMessage: message,
        isBot: true,
        botUsername: this.username
      }));
    } catch (e) {
      if (this.pendingEcho) {
        clearTimeout(this.pendingEcho.timeout);
        this.pendingEcho = null;
      }
      logger.error(`${this.username} send error:`, e);
      throw e;
    }

    try {
      await echoPromise;
      logger.debug(`${this.username} echo confirmed`);
    } catch (e) {
      logger.warn(`${this.username} echo timeout: ${(e as Error).message}`);
    }
  }

  public connect(): void {
    if (this.learningMode) {
      logger.info(`[Обучение] Подключение бота ${this.username} к каналу ${this.channelName}...`);
      logger.info(`[Обучение] Цель: сбор глобальных знаний об играх и твич-культуре`);
    } else {
      logger.info(`Connecting bot ${this.username}... (channel=${this.channelName})`);
    }

    this.client.connect().catch(e => {
      if (this.learningMode) {
        logger.error(`[Обучение] Ошибка подключения бота ${this.username}:`, e);
      } else {
        logger.error(`${this.username} connect error:`, e);
      }
    });
  }

  public disconnect(): void {
    if (this.learningMode) {
      logger.info(`[Обучение] Отключение бота ${this.username}...`);
    } else {
      logger.info(`Disconnecting bot ${this.username}...`);
    }

    this.client.disconnect();
  }

  public getUsername(): string {
    return this.username;
  }

  public isInLearningMode(): boolean {
    return this.learningMode;
  }

  public getChannel(): string {
    return this.channelName;
  }

  // Новый метод для получения статистики знаний (используется в main.ts)
  public async getKnowledgeInfo(): Promise<{ count: number; channel: string }> {
    const knowledgeCount = this.aiService.getGlobalKnowledgeCount();
    return {
      count: knowledgeCount,
      channel: this.channelName
    };
  }

  // Метод для принудительной очистки очереди (например, при завершении)
  public clearQueue(): void {
    this.messageQueue = [];
    if (this.pendingEcho) {
      clearTimeout(this.pendingEcho.timeout);
      this.pendingEcho = null;
    }
    this.sending = false;
  }

  // Метод для проверки состояния подключения
  public isConnectedToChat(): boolean {
    return this.isConnected;
  }
}