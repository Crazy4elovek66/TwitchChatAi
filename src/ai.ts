import { EventEmitter } from 'events';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FfmpegCommand } from 'fluent-ffmpeg';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { logger } from './logger';
import { analyzePcm16le } from './audioDebug';
import { MemoryStore, MemoryEvent, MemoryFact, GlobalKnowledge } from './memory';
import { Personality, PersonalityManager } from './personality';
import { MessageFilter } from './messageFilter';
import { LearningManager } from './learning';
import { VisionAnalyzer, ImageAnalysis } from './vision';
import { EmotionAnalyzer, EmotionalMoment } from './emotionAnalysis';
import axios from 'axios';
import * as yandexAI from './yandex/yandexAI';
import * as localAI from './local/localAI';
import {
  mergeFactsSimple,
  clamp,
  normalizeMessage,
  extractJsonObject,
  addHumanLikeErrors
} from './utils';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface TwitchChannelInfo {
  title: string;
  description: string;
  gameName: string;
  viewerCount: number;
  isLive: boolean;
}

interface ChatContext {
  username: string;
  message: string;
  timestamp: number;
  isBot: boolean;
}

type AIHandler = typeof yandexAI;

export class AIService extends EventEmitter {
  private isCapturing = false;
  private isProcessing = false;
  private currentProcess: FfmpegCommand | null = null;
  private tempAudioFile: string | null = null;

  private accessToken: string | null = null;
  private _currentChannelInfo: TwitchChannelInfo | null = null;
  private currentHlsUrl: string | null = null;
  private currentHlsUrlCreatedAt: number = 0;

  private yandexApiKey: string;
  private yandexFolderId: string;

  // ===== pacing / anti-spam =====
  private aiMinIntervalMs: number;
  private aiJitter: number;

  // ===== VAD =====
  private aiRmsMin: number;

  // ===== dedupe =====
  private lastNonEmptyTranscription = '';
  private lastSentMessages: string[] = [];
  private botLastMessageTs: Map<string, number> = new Map();

  // ===== Memory =====
  private memoryStore = new MemoryStore();
  private channelIdForMemory = '';
  private facts: MemoryFact[] = [];
  private lastFactsUpdateTs = 0;

  // ===== Глобальные знания =====
  private globalKnowledge: GlobalKnowledge[] = [];
  private lastGlobalUpdateTs = 0;
  private globalUpdateIntervalMs = 1800000; // 30 минут

  // ===== Эмоциональный анализ =====
  private emotionAnalyzer: EmotionAnalyzer;

  // short-term context
  private shortEvents: MemoryEvent[] = [];
  private recentChatMessages: ChatContext[] = [];

  // ===== bot identities =====
  private personalityManager = new PersonalityManager();
  private activeBots: Set<string> = new Set();

  // ===== screen OCR & Vision =====
  private ocrEnabled: boolean;
  private ocrIntervalMs: number;
  private lastOcrTs = 0;
  private lastScreenText = '';

  // ===== Speech buffer для полных предложений =====
  private speechBuffer: string[] = [];
  private lastSpeechTs = 0;
  private speechTimeoutMs = 3000;

  // ===== Координация ботов =====
  private lastEventTimestamp = 0;
  private botsRespondedToLastEvent = new Set<string>();
  private maxBotsPerEvent: number;
  private betweenBotDelayMs: number;

  // ===== Learning mode =====
  private learningManager: LearningManager;
  private learningMode: boolean;
  private learningChannel: string;

  // ===== Vision analysis =====
  private visionAnalyzer: VisionAnalyzer;
  private visionAnalysisIntervalMs: number;
  private lastVisionAnalysisTs = 0;
  private lastVisionAnalysis: ImageAnalysis | null = null;

  // ===== Learning updates =====
  private learningUpdateIntervalMs: number;

  // ===== Выбранный AI‑движок =====
  private ai: AIHandler;
  private mode: string;

  constructor() {
    super();
    logger.info('AIService initialized with multi-bot support');

    this.mode = process.env.MODE || 'yandex';

    // Инициализация AI‑движка
    if (this.mode === 'local') {
      this.ai = localAI;
      logger.info('=== ЛОКАЛЬНЫЙ РЕЖИМ (БЕЗ YANDEX) ===');
    } else {
      this.ai = yandexAI;
      logger.info('=== РЕЖИМ YANDEX ===');
    }

    // Yandex‑ключи могут быть не нужны в локальном режиме, но оставляем их чтение
    this.yandexApiKey = process.env.YANDEX_API_KEY || '';
    this.yandexFolderId = process.env.YANDEX_FOLDER_ID || '';

    if (this.mode !== 'local' && (!this.yandexApiKey || !this.yandexFolderId)) {
      logger.warn('Yandex credentials are missing: set YANDEX_API_KEY and YANDEX_FOLDER_ID');
    } else if (this.mode === 'yandex') {
      logger.info('Yandex client configured');
    }

    this.aiMinIntervalMs = parseInt(process.env.AI_MIN_INTERVAL_MS || '120000', 10);
    this.aiJitter = clamp(Number(process.env.AI_JITTER || '0.5'), 0, 0.9);
    this.aiRmsMin = clamp(Number(process.env.AI_RMS_MIN || '0.003'), 0, 1);

    this.ocrEnabled = (process.env.OCR_ENABLED || '').trim() === '1';
    this.ocrIntervalMs = parseInt(process.env.OCR_INTERVAL_MS || '30000', 10);

    this.maxBotsPerEvent = parseInt(process.env.MAX_BOTS_PER_EVENT || '2', 10);
    this.betweenBotDelayMs = parseInt(process.env.BETWEEN_BOT_DELAY_MS || '10000', 10);

    // Инициализация менеджера обучения
    this.learningManager = new LearningManager(this);
    this.learningMode = this.learningManager.isLearningMode();
    this.learningChannel = process.env.LEARNING_CHANNEL || '';
    this.learningUpdateIntervalMs = parseInt(process.env.LEARNING_MEMORY_UPDATE_INTERVAL_MS || '30000', 10);

    // Инициализация Vision анализатора
    this.visionAnalyzer = new VisionAnalyzer();
    this.visionAnalysisIntervalMs = parseInt(process.env.VISION_ANALYSIS_INTERVAL_MS || '45000', 10);

    // Инициализация анализатора эмоций
    this.emotionAnalyzer = new EmotionAnalyzer();

    if (this.learningMode) {
      logger.info('=== РЕЖИМ ОБУЧЕНИЯ АКТИВИРОВАН ===');
      logger.info('Собираем глобальные знания (игровые термины, мемы, культуру)');
      logger.info('Боты будут только слушать и анализировать, не отправлять сообщения');

      // В режиме обучения загружаем существующие глобальные знания
      this.loadGlobalKnowledge().catch(error => {
        logger.error('Ошибка загрузки глобальных знаний:', error);
      });

      // В режиме обучения уменьшаем интервалы для более частого обновления
      this.aiMinIntervalMs = 60000; // 1 минута вместо 2
      this.visionAnalysisIntervalMs = 30000; // 30 секунд вместо 45
      this.learningUpdateIntervalMs = 15000; // 15 секунд вместо 30
      logger.info('Настройки оптимизированы для режима обучения');
    } else {
      logger.info('=== ОБЫЧНЫЙ РЕЖИМ ===');
      logger.info('Боты будут общаться, используя накопленные знания');
      logger.info('Анализ эмоциональных моментов активирован');
    }

    if (this.learningMode && this.learningChannel) {
      logger.info(`Канал для обучения: ${this.learningChannel}`);
    }

    this.on('chatMessage', (payload: string) => {
      try {
        const ctx = JSON.parse(payload);
        const user = String(ctx.username || 'viewer');
        const msg = String(ctx.chatMessage || '').trim();
        const isBot = Boolean(ctx.isBot);

        if (!msg) return;

        const chatContext: ChatContext = {
          username: user,
          message: msg,
          timestamp: Date.now(),
          isBot
        };

        this.recentChatMessages.push(chatContext);
        if (this.recentChatMessages.length > 50) {
          this.recentChatMessages = this.recentChatMessages.slice(-50);
        }

        this.recordEvent({
          ts: Date.now(),
          type: 'chat',
          text: `${user}: ${msg}`,
          meta: { user, raw: msg, isBot }
        });

        // В режиме обучения извлекаем знания из чата
        if (this.learningMode && !isBot) {
          this.extractKnowledgeFromChat(msg).catch(error => {
            logger.debug('Ошибка извлечения знаний из чата:', error);
          });
        }

        // В обычном режиме добавляем реакцию для анализа эмоций
        if (!this.learningMode && !isBot) {
          this.emotionAnalyzer.addChatReaction(user, msg, Date.now());
        }

        if (isBot && user !== ctx.botUsername) {
          this.checkForBotInteraction(user, msg);
        }
      } catch (e) {
        logger.error('Failed to parse chatMessage payload:', e);
      }
    });

    // Обработчик для сохранения эмоциональных знаний
    this.emotionAnalyzer.on('emotionalKnowledge', (knowledge: any) => {
      this.saveEmotionalKnowledge(knowledge);
    });
  }

  // ========== Работа с глобальными знаниями ==========
  private async loadGlobalKnowledge(): Promise<void> {
    try {
      this.globalKnowledge = await this.memoryStore.loadGlobal();
      logger.info(`Загружено ${this.globalKnowledge.length} глобальных знаний`);

      if (this.globalKnowledge.length > 0) {
        const stats = await this.memoryStore.getKnowledgeStats();
        logger.info('Статистика знаний:');
        Object.entries(stats.byCategory).forEach(([category, count]) => {
          logger.info(`  ${category}: ${count}`);
        });
      }
    } catch (error) {
      logger.error('Ошибка загрузки глобальных знаний:', error);
      this.globalKnowledge = [];
    }
  }

  private async extractKnowledgeFromChat(chatMessage: string): Promise<void> {
    if (!this.learningMode || chatMessage.length < 10) return;
    try {
      const knowledgeItems = await this.ai.extractKnowledge(chatMessage, 'chat');
      for (const item of knowledgeItems) {
        await this.processAndSaveKnowledge(item);
      }
    } catch (error) {
      logger.debug('Ошибка извлечения знаний из чата:', error);
    }
  }

  private async extractKnowledgeFromScreen(screenText: string): Promise<void> {
    if (!this.learningMode || screenText.length < 30) return;
    try {
      const knowledgeItems = await this.ai.extractKnowledge(screenText, 'screen');
      for (const item of knowledgeItems) {
        await this.processAndSaveKnowledge(item);
      }
    } catch (error) {
      logger.debug('Ошибка извлечения знаний с экрана:', error);
    }
  }

  private async extractKnowledgeFromVision(analysis: ImageAnalysis): Promise<void> {
    if (!this.learningMode) return;
    try {
      const visionText = this.visionAnalyzer.formatAnalysisForPrompt(analysis);
      const gameplayAnalysis = this.visionAnalyzer.analyzeGameplay(analysis);
      const combinedText = `Визуальный анализ: ${visionText}\nГеймплей: ${gameplayAnalysis || 'не определен'}`;
      const knowledgeItems = await this.ai.extractKnowledge(combinedText, 'vision');
      for (const item of knowledgeItems) {
        await this.processAndSaveKnowledge(item);
      }
    } catch (error) {
      logger.debug('Ошибка извлечения знаний из визуального анализа:', error);
    }
  }

  private async processAndSaveKnowledge(item: any): Promise<void> {
    if (!item.category || !item.text || !item.examples) return;

    const validCategories = ['game_terms', 'twitch_terms', 'humor', 'behavior', 'culture'];
    if (!validCategories.includes(item.category)) return;

    const text = String(item.text || '').trim();
    if (text.length < 10 || text.length > 200) return;

    const examples = Array.isArray(item.examples)
      ? item.examples.map((e: any) => String(e || '').trim()).filter((e: string) => e.length > 0)
      : [];
    if (examples.length === 0) return;

    const usageContext = Array.isArray(item.usageContext)
      ? item.usageContext.map((u: any) => String(u || '').trim()).filter((u: string) => u.length > 0)
      : ['общий контекст'];

    const confidence = clamp(Number(item.confidence || 0.7), 0.1, 1.0);

    const newKnowledge: Omit<GlobalKnowledge, 'id' | 'lastUsed' | 'usageCount'> = {
      category: item.category as GlobalKnowledge['category'],
      text,
      examples,
      usageContext,
      learnedFrom: [this.channelIdForMemory || 'unknown', new Date().toISOString().split('T')[0]],
      confidence
    };

    const id = await this.memoryStore.addGlobalKnowledge(newKnowledge);
    if (id) {
      this.globalKnowledge.push({
        ...newKnowledge,
        id,
        lastUsed: Date.now(),
        usageCount: 0
      });
      logger.debug(`[Глобальное знание] Добавлено: ${text.substring(0, 50)}...`);
    }
  }

  private async saveEmotionalKnowledge(knowledge: any): Promise<void> {
    try {
      const newKnowledge: Omit<GlobalKnowledge, 'id' | 'lastUsed' | 'usageCount'> = {
        category: 'behavior',
        text: knowledge.text,
        examples: knowledge.examples || [],
        usageContext: ['эмоциональные реакции', 'взаимодействие с чатом'],
        learnedFrom: ['emotion_analyzer', new Date().toISOString().split('T')[0]],
        confidence: 0.8
      };

      const id = await this.memoryStore.addGlobalKnowledge(newKnowledge);
      if (id) {
        this.globalKnowledge.push({
          ...newKnowledge,
          id,
          lastUsed: Date.now(),
          usageCount: 0
        });
        logger.info(`[Эмоции] Сохранено знание: ${knowledge.text.substring(0, 60)}...`);
      }
    } catch (error) {
      logger.error('Ошибка сохранения эмоционального знания:', error);
    }
  }

  // ========== Регистрация ботов ==========
  public registerBot(username: string, personalityId: string): boolean {
    const personality = this.personalityManager.assignPersonality(username, personalityId);
    if (personality) {
      this.activeBots.add(username);
      if (this.learningMode && personality.id === 'learning') {
        logger.info(`Зарегистрирован бот для обучения: ${username}`);
      } else {
        logger.info(`Registered bot ${username} with personality ${personality.name}`);
      }
      return true;
    }
    return false;
  }

  public getPersonality(username: string): Personality | undefined {
    return this.personalityManager.getPersonality(username);
  }

  public getAllActiveBots(): string[] {
    return Array.from(this.activeBots);
  }

  public get currentChannelInfo(): TwitchChannelInfo | null {
    return this._currentChannelInfo;
  }

  private set currentChannelInfo(info: TwitchChannelInfo | null) {
    this._currentChannelInfo = info;
  }

  public isLearningMode(): boolean {
    return this.learningMode;
  }

  public getLearningManager(): LearningManager {
    return this.learningManager;
  }

  public async getKnowledgeStats(): Promise<any> {
    return await this.memoryStore.getKnowledgeStats();
  }

  public getGlobalKnowledgeCount(): number {
    return this.globalKnowledge.length;
  }

  public getEmotionStats(): any {
    return this.emotionAnalyzer.getEmotionStats();
  }

  public getRecentEmotionalMoments(limit: number = 5): EmotionalMoment[] {
    return this.emotionAnalyzer.getRecentMoments(limit);
  }

  // ========== Контекст экрана ==========
  public recordScreenContext(text: string, meta?: Record<string, any>) {
    const t = (text || '').trim();
    if (!t) return;
    this.lastScreenText = t;
    this.recordEvent({ ts: Date.now(), type: 'screen', text: t, meta });

    if (this.learningMode && t.length > 20) {
      this.extractKnowledgeFromScreen(t).catch(error => {
        logger.debug('Ошибка извлечения знаний с экрана:', error);
      });
    }
  }

  private recordEvent(ev: MemoryEvent) {
    this.shortEvents.push(ev);
    if (this.shortEvents.length > 100) this.shortEvents = this.shortEvents.slice(-100);
  }

  // ========== Обработка речи ==========
  private addToSpeechBuffer(text: string): void {
    const now = Date.now();

    if (now - this.lastSpeechTs > this.speechTimeoutMs) {
      this.speechBuffer = [];
    }

    this.speechBuffer.push(text);
    this.lastSpeechTs = now;

    const hasEnding = /[.!?…]\s*$/.test(text) || text.length > 50;

    if (hasEnding || this.speechBuffer.length >= 3) {
      const completeThought = this.speechBuffer.join(' ');
      this.processCompleteThought(completeThought);
      this.speechBuffer = [];
    }
  }

  private processCompleteThought(thought: string): void {
    const now = Date.now();
    const t = normalizeMessage(thought);
    if (!t || t === this.lastNonEmptyTranscription) return;

    this.lastNonEmptyTranscription = t;
    this.recordEvent({
      ts: now,
      type: 'speech',
      text: t,
      meta: { isCompleteThought: true }
    });

    if (!this.learningMode && t.length > 20) {
      this.emotionAnalyzer.registerStreamerSpeech(t, now);
    }

    if (this.learningMode && t.length > 20) {
      this.learningManager.recordEvent('speech', t);
      this.learningUpdateMemory(t);

      if (now - this.lastGlobalUpdateTs > this.globalUpdateIntervalMs) {
        this.loadGlobalKnowledge().catch(error => {
          logger.error('Ошибка обновления глобальных знаний:', error);
        });
        this.lastGlobalUpdateTs = now;
      }
    }

    logger.info(`Complete thought: "${t}"`);

    // Обновляем факты асинхронно, не блокируя поток
    this.scheduleFactsUpdate();

    if (now - this.lastEventTimestamp < 30000) {
      return;
    }

    this.evaluateResponseForAllBots(t);
  }

  private async learningUpdateMemory(transcription: string): Promise<void> {
    if (!this.learningMode || !this.channelIdForMemory) return;
    try {
      const recentChat = this.recentChatMessages
        .slice(-10)
        .map(msg => `${msg.username}: ${msg.message}`)
        .join('\n');

      const existingGlobal = await this.memoryStore.findRelevantGlobalKnowledge(transcription);
      const existingText = existingGlobal
        .slice(0, 5)
        .map(k => `- ${k.text} (${k.category})`)
        .join('\n');

      const knowledgeItems = await this.ai.extractKnowledge(
        `Речь стримера: ${transcription}\n\nНедавний чат:\n${recentChat || '(нет)'}\n\nСуществующие знания:\n${existingText || '(нет)'}`,
        'speech'
      );

      let addedCount = 0;
      for (const item of knowledgeItems) {
        if (!item.category || !item.text || !item.examples) continue;
        const validCategories = ['game_terms', 'twitch_terms', 'humor', 'behavior', 'culture'];
        if (!validCategories.includes(item.category)) continue;

        const text = String(item.text || '').trim();
        if (text.length < 10 || text.length > 200) continue;

        const examples = Array.isArray(item.examples)
          ? item.examples.map((e: any) => String(e || '').trim()).filter((e: string) => e.length > 0)
          : [];
        if (examples.length === 0) continue;

        const usageContext = Array.isArray(item.usageContext)
          ? item.usageContext.map((u: any) => String(u || '').trim()).filter((u: string) => u.length > 0)
          : ['общий контекст'];

        const confidence = clamp(Number(item.confidence || 0.7), 0.1, 1.0);

        const newKnowledge: Omit<GlobalKnowledge, 'id' | 'lastUsed' | 'usageCount'> = {
          category: item.category as GlobalKnowledge['category'],
          text,
          examples,
          usageContext,
          learnedFrom: [this.channelIdForMemory, new Date().toISOString().split('T')[0]],
          confidence
        };

        const id = await this.memoryStore.addGlobalKnowledge(newKnowledge);
        if (id) {
          addedCount++;
          this.globalKnowledge.push({
            ...newKnowledge,
            id,
            lastUsed: Date.now(),
            usageCount: 0
          });
        }
      }

      if (addedCount > 0) {
        logger.info(`[Глобальное обучение] Добавлено ${addedCount} новых знаний`);
      }
    } catch (error) {
      logger.error('Ошибка при обновлении глобальных знаний:', error);
    }
  }

  private scheduleFactsUpdate() {
    // Запускаем обновление фактов не чаще чем раз в 3 минуты
    if (Date.now() - this.lastFactsUpdateTs < 180000) return;
    this.lastFactsUpdateTs = Date.now();

    // Откладываем выполнение, чтобы не блокировать обработку речи
    setImmediate(async () => {
      await this.performFactsUpdate();
    });
  }

  private async performFactsUpdate(): Promise<void> {
    if (!this.channelIdForMemory) return;

    const events = [...this.shortEvents];
    try {
      const newFacts = await this.ai.updateFacts(events, this.facts);
      if (newFacts.length) {
        this.facts = mergeFactsSimple(this.facts, newFacts);
        await this.memoryStore.save({
          channel: this.channelIdForMemory,
          updatedAt: Date.now(),
          facts: this.facts
        });
        logger.info(`Memory updated: +${newFacts.length} facts`);
      }
    } catch (e) {
      logger.warn('Failed to update facts:', e);
    }
  }

  // ========== Управление ответами ботов ==========
  private evaluateResponseForAllBots(transcription: string): void {
    const now = Date.now();

    if (now - this.lastEventTimestamp < 30000) {
      return;
    }

    this.lastEventTimestamp = now;
    this.botsRespondedToLastEvent.clear();

    if (this.learningMode) {
      logger.debug('[Обучение] Бот слушает и анализирует, ответы отключены');
      return;
    }

    const activeBotsArray = Array.from(this.activeBots);
    if (activeBotsArray.length === 0) return;

    const sortedBots = activeBotsArray.sort((a, b) => {
      const personalityA = this.personalityManager.getPersonality(a);
      const personalityB = this.personalityManager.getPersonality(b);
      return (personalityA?.activityLevel || 3) - (personalityB?.activityLevel || 3);
    });

    const numToRespond = Math.min(
      this.maxBotsPerEvent,
      Math.floor(activeBotsArray.length / 2) + 1
    );

    const selectedBots: string[] = [];
    for (const bot of sortedBots) {
      if (selectedBots.length >= numToRespond) break;

      const personality = this.personalityManager.getPersonality(bot);
      if (!personality) continue;

      const chance = personality.activityLevel / 10;
      if (Math.random() < chance) {
        selectedBots.push(bot);
      }
    }

    if (selectedBots.length === 0 && activeBotsArray.length > 0) {
      selectedBots.push(activeBotsArray[Math.floor(Math.random() * activeBotsArray.length)]);
    }

    selectedBots.forEach((botUsername, index) => {
      const personality = this.personalityManager.getPersonality(botUsername);
      if (!personality) return;

      const shouldRespond = this.shouldBotRespond(botUsername, now, transcription);
      if (!shouldRespond.ok) return;

      if (!this.canBotCallAi(botUsername, now)) {
        return;
      }

      const delay = index * this.betweenBotDelayMs + Math.random() * 3000;

      setTimeout(() => {
        this.generateBotResponse(botUsername, transcription, shouldRespond.reason);
        this.botsRespondedToLastEvent.add(botUsername);
      }, delay);
    });
  }

  private checkForBotInteraction(senderBot: string, message: string): void {
    const now = Date.now();

    if (this.learningMode) return;

    for (const botUsername of this.activeBots) {
      if (botUsername === senderBot) continue;

      const personality = this.personalityManager.getPersonality(botUsername);
      if (!personality) continue;

      const mentionsBot = message.toLowerCase().includes(botUsername.toLowerCase()) ||
        message.toLowerCase().includes(personality.name.toLowerCase());

      const isQuestion = message.includes('?') ||
        /(ответь|скажи|как думаешь|согласен)/i.test(message);

      if ((mentionsBot || isQuestion) && this.canBotCallAi(botUsername, now)) {
        setTimeout(() => {
          this.generateBotResponse(botUsername, message, 'bot_interaction', senderBot);
        }, Math.random() * 3000 + 1000);
      }
    }
  }

  private shouldBotRespond(botUsername: string, now: number, transcription: string): { ok: boolean; reason: string } {
    const personality = this.personalityManager.getPersonality(botUsername);
    if (!personality) return { ok: false, reason: 'no_personality' };

    if (this.learningMode) return { ok: false, reason: 'learning_mode' };

    if (this.botsRespondedToLastEvent.has(botUsername)) {
      return { ok: false, reason: 'already_responded' };
    }

    const directAddress = this.isStreamerAddressing(botUsername, transcription);
    if (directAddress) return { ok: true, reason: 'direct_address' };

    const recentChat = this.getRecentChat(now, 30000);
    const questionToBot = recentChat.some(msg => {
      if (!msg.message.includes('?')) return false;
      const botName = botUsername.toLowerCase();
      const personName = personality.name.toLowerCase();
      return msg.message.toLowerCase().includes(botName) ||
        msg.message.toLowerCase().includes(personName);
    });

    if (questionToBot) return { ok: true, reason: 'question_to_bot' };

    if (this.isChatActive(now, 20000, 5)) {
      if (personality.activityLevel >= 3) {
        return { ok: true, reason: 'very_active_chat' };
      }
    }

    if (this.hasBrightEmotion(transcription)) {
      if (personality.responseStyle === 'эмоциональный') {
        return { ok: true, reason: 'emotional_speech' };
      }
    }

    const randomChance = personality.activityLevel / 20;
    if (Math.random() < randomChance) {
      return { ok: true, reason: 'random_chance' };
    }

    return { ok: false, reason: 'no_trigger' };
  }

  private isStreamerAddressing(botUsername: string, transcription: string): boolean {
    const personality = this.personalityManager.getPersonality(botUsername);
    if (!personality) return false;

    const text = transcription.toLowerCase();
    const botName = botUsername.toLowerCase();
    const personName = personality.name.toLowerCase();

    const patterns = [
      new RegExp(`(эй|слушай|скажи)\\s+(${botName}|${personName})`, 'i'),
      new RegExp(`(${botName}|${personName})\\s*(ты|а\\s+ты)`, 'i'),
      new RegExp(`вопрос\\s+(${botName}|${personName})`, 'i')
    ];

    return patterns.some(pattern => pattern.test(text));
  }

  private hasBrightEmotion(transcription: string): boolean {
    const t = transcription.toLowerCase();

    const strongEmotions = [
      /!{3,}/,
      /\?{3,}/,
      /(ахаха+|хахаха+)/i,
      /(о[х]? боже|боже мой)/i,
      /(нич[её] себе|ничего себе)/i,
      /(ёбаный|блядский|пиздец)/i,
      /(ура+|вау+)/i
    ];

    return strongEmotions.some(pattern => pattern.test(t));
  }

  private isChatActive(now: number, windowMs = 20000, minMsgs = 3): boolean {
    const msgs = this.recentChatMessages.filter(msg => now - msg.timestamp <= windowMs);
    return msgs.length >= minMsgs;
  }

  private getRecentChat(now: number, windowMs: number): ChatContext[] {
    return this.recentChatMessages.filter(msg => now - msg.timestamp <= windowMs);
  }

  private canBotCallAi(botUsername: string, now: number): boolean {
    const lastMessageTs = this.botLastMessageTs.get(botUsername) || 0;
    const minInterval = this.aiMinIntervalMs;

    if (now - lastMessageTs < minInterval) {
      return false;
    }

    return true;
  }

  // ========== Twitch авторизация и HLS ==========
  private async generateAccessToken(): Promise<string> {
    logger.info('Generating new access token...');
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
      }
    });

    const { access_token } = response.data;
    logger.info('New access token generated successfully');
    return access_token;
  }

  private async getChannelInfo(channelName: string): Promise<TwitchChannelInfo> {
    logger.info('Fetching channel info for:', channelName);

    if (!this.accessToken) this.accessToken = await this.generateAccessToken();

    const userResponse = await axios.get(`https://api.twitch.tv/helix/users?login=${channelName}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${this.accessToken}`
      }
    });

    const userData = userResponse.data.data[0];
    if (!userData) throw new Error(`Channel not found: ${channelName}`);

    const channelId = userData.id;
    this.channelIdForMemory = channelId;

    const streamResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${channelId}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${this.accessToken}`
      }
    });

    const streamData = streamResponse.data.data[0];
    const isLive = !!streamData;

    const title = streamData?.title || userData?.description || 'Stream';
    const gameName = streamData?.game_name || 'Just Chatting';
    const viewerCount = streamData?.viewer_count || 0;

    const info: TwitchChannelInfo = {
      title,
      description: userData?.description || '',
      gameName,
      viewerCount,
      isLive
    };

    logger.info('Channel info retrieved:', {
      title: info.title,
      game: info.gameName,
      viewers: info.viewerCount,
      isLive: info.isLive
    });

    return info;
  }

  private async getTwitchHlsUrl(channel: string): Promise<string> {
    const TWITCH_WEB_CLIENT_ID = process.env.TWITCH_WEB_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    if (!this.accessToken) this.accessToken = await this.generateAccessToken();

    const body = [
      {
        operationName: 'PlaybackAccessToken',
        variables: { login: channel, playerType: 'site' },
        query: `
          query PlaybackAccessToken($login: String!, $playerType: String!) {
            streamPlaybackAccessToken(
              channelName: $login,
              params: { platform: "web", playerBackend: "mediaplayer", playerType: $playerType }
            ) {
              value
              signature
            }
          }
        `
      }
    ];

    const r = await axios.post('https://gql.twitch.tv/gql', body, {
      headers: {
        'Client-ID': TWITCH_WEB_CLIENT_ID,
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json'
      },
      timeout: 15000
    });

    const payload = Array.isArray(r.data) ? r.data[0] : r.data;

    if (payload?.errors?.length) {
      logger.error('Twitch GQL errors:', JSON.stringify(payload.errors, null, 2));
    }

    const tokenObj = payload?.data?.streamPlaybackAccessToken;
    const sig = tokenObj?.signature;
    const token = tokenObj?.value;

    if (!sig || !token) {
      logger.error('Twitch GQL payload:', JSON.stringify(payload, null, 2));
      throw new Error(`Failed to get playback token for channel ${channel}`);
    }

    const encodedToken = encodeURIComponent(token);

    return (
      `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8` +
      `?sig=${sig}` +
      `&token=${encodedToken}` +
      `&allow_source=true` +
      `&allow_audio_only=true`
    );
  }

  private buildTwitchFfmpegHeaders(channel?: string): string {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    return (
      `User-Agent: ${ua}\r\n` +
      `Accept: */*\r\n` +
      `Origin: https://www.twitch.tv\r\n` +
      `Referer: https://www.twitch.tv/${channel || ''}\r\n`
    );
  }

  private async refreshTwitchHlsUrl(channel: string, reason?: string): Promise<void> {
    try {
      if (reason) logger.warn(`[HLS] Refreshing HLS URL for ${channel}. Reason: ${reason}`);
      this.currentHlsUrl = await this.getTwitchHlsUrl(channel);
      this.currentHlsUrlCreatedAt = Date.now();
    } catch (e) {
      logger.error(`[HLS] Failed to refresh HLS URL for ${channel}:`, e);
      this.accessToken = null;
      throw e;
    }
  }

  // ========== Захват голоса ==========
  public async startVoiceCapture(channel: string): Promise<void> {
    if (this.isCapturing) return;

    this.isCapturing = true;

    const targetChannel = this.learningMode && this.learningChannel
      ? this.learningChannel
      : channel;

    this.currentChannelInfo = await this.getChannelInfo(targetChannel);

    if (this.learningMode) {
      this.learningManager.startLearningSession(targetChannel);
      logger.info(`[Обучение] Начато обучение на канале: ${targetChannel}`);
    }

    try {
      const mem = await this.memoryStore.load(this.channelIdForMemory);
      this.facts = mem.facts || [];
      logger.info(`Loaded ${this.facts.length} memory facts for channel ${targetChannel}`);
    } catch (e) {
      logger.warn('Failed to load memory facts:', e);
      this.facts = [];
    }

    const durationMs = parseInt(process.env.TRANSCRIPT_DURATION || '15000', 10);
    const output = join(tmpdir(), `twitch_audio_${Date.now()}.wav`);

    await this.refreshTwitchHlsUrl(targetChannel, 'initial');

    logger.info(`Voice capture chunk: ${durationMs}ms`);

    while (this.isCapturing) {
      try {
        if (!this.currentHlsUrl || (Date.now() - this.currentHlsUrlCreatedAt) > 8 * 60 * 1000) {
          await this.refreshTwitchHlsUrl(targetChannel, 'periodic refresh');
        }

        this.tempAudioFile = output;

        await new Promise<void>((resolve) => {
          let isProcessing = false;

          this.currentProcess = ffmpeg()
            .input(this.currentHlsUrl!)
            .inputOptions(
              '-reconnect', '1',
              '-reconnect_streamed', '1',
              '-reconnect_delay_max', '5',
              '-headers', this.buildTwitchFfmpegHeaders(targetChannel),
              '-user_agent', 'Mozilla/5.0'
            )
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(16000)
            .format('wav')
            .duration(durationMs / 1000)
            .on('start', () => logger.debug('Spawning ffmpeg for live PCM capture...'))
            .on('end', async () => {
              if (!isProcessing) {
                isProcessing = true;
                try {
                  await this.processAudioChunk();
                } finally {
                  isProcessing = false;
                }
                resolve();
              } else {
                resolve();
              }
            })
            .on('error', async (err) => {
              const msg = (err as any)?.message ? String((err as any).message) : String(err);
              logger.error('ffmpeg error:', err);

              if (/\b(401|403)\b/.test(msg) || /Forbidden/i.test(msg) || /access denied/i.test(msg)) {
                try {
                  await this.refreshTwitchHlsUrl(targetChannel, msg.slice(0, 180));
                } catch {
                  // already logged in refreshTwitchHlsUrl
                }
              }

              await new Promise(r => setTimeout(r, 2000));
              resolve();
            })
            .save(this.tempAudioFile!);
        });

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error('Error in capture loop:', error);
        this.stopVoiceCapture();
      }
    }
  }

  public stopVoiceCapture(): void {
    if (!this.isCapturing) return;

    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }

    if (this.tempAudioFile) {
      try { unlinkSync(this.tempAudioFile); } catch { /* noop */ }
      this.tempAudioFile = null;
    }

    if (this.learningMode) {
      this.learningManager.forceStopLearning();
    }

    this.isCapturing = false;
    logger.info('Voice capture stopped');
  }

  private readAudioFile(filePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      fs.readFile(filePath, (err: Error | null, data: Buffer) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  private wavToLpcm(wav: Buffer): Buffer {
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

  // ========== Обработка аудио ==========
  private async processAudioChunk(): Promise<void> {
    if (!this.tempAudioFile || this.isProcessing) return;

    this.isProcessing = true;

    try {
      if (!existsSync(this.tempAudioFile)) return;

      const wav = await this.readAudioFile(this.tempAudioFile);
      if (!Buffer.isBuffer(wav) || wav.length === 0) return;

      const stats = analyzePcm16le(wav);

      if (stats.rms < this.aiRmsMin) {
        logger.debug(`RMS below threshold (${stats.rms.toFixed(6)} < ${this.aiRmsMin}), skipping`);
        return;
      }

      const transcribedText = await this.ai.transcribeAudio(wav);
      const t = normalizeMessage(transcribedText);

      if (!t) return;

      this.addToSpeechBuffer(t);

      await this.maybeUpdateScreenFromStream();

    } catch (error) {
      logger.error('Error processing audio chunk:', error);
    } finally {
      try {
        if (this.tempAudioFile && existsSync(this.tempAudioFile)) {
          unlinkSync(this.tempAudioFile);
        }
      } catch (error) {
        logger.error('Error cleaning up temporary file:', error);
      }
      this.tempAudioFile = null;
      this.isProcessing = false;
    }
  }

  // ========== Скриншоты и визуальный анализ ==========
  private async captureFramePng(hlsUrl: string, timeoutMs = 15000): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const args = [
        '-user_agent', 'Mozilla/5.0',
        '-headers', this.buildTwitchFfmpegHeaders(),
        '-loglevel', 'error',
        '-y',
        '-i', hlsUrl,
        '-frames:v', '1',
        '-vf', 'scale=1280:-1',
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1'
      ];

      const proc = spawn(ffmpegInstaller.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
        reject(new Error(`ffmpeg screenshot timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d));

      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf8').trim();
          return reject(new Error(`ffmpeg screenshot failed (code=${code}): ${stderr}`));
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  private async analyzeStreamImage(): Promise<void> {
    if (!this.visionAnalyzer.isEnabled() || !this.currentHlsUrl) return;

    const now = Date.now();
    if (now - this.lastVisionAnalysisTs < this.visionAnalysisIntervalMs) return;

    this.lastVisionAnalysisTs = now;

    try {
      const png = await this.captureFramePng(this.currentHlsUrl);
      const analysis = await this.visionAnalyzer.analyzeImage(png);

      if (analysis) {
        this.lastVisionAnalysis = analysis;

        const analysisText = this.visionAnalyzer.formatAnalysisForPrompt(analysis);
        if (analysisText) {
          this.recordEvent({
            ts: now,
            type: 'screen',
            text: `Визуальный анализ: ${analysisText}`,
            meta: { source: 'vision', fullAnalysis: analysis }
          });

          if (this.learningMode) {
            this.learningManager.recordEvent('screen', analysisText);
            await this.extractKnowledgeFromVision(analysis);
          }

          await this.updateMemoryWithVisualContext(analysis);

          logger.info(`Vision analysis completed: ${analysis.faces.length} faces, ${analysis.objects.length} objects`);
        }
      }
    } catch (error) {
      logger.debug('Vision analysis failed:', error);
    }
  }

  private async updateMemoryWithVisualContext(analysis: ImageAnalysis): Promise<void> {
    if (!this.channelIdForMemory) return;

    const visionFacts: Omit<MemoryFact, 'id' | 'ts'>[] = [];
    const now = Date.now();

    if (analysis.faces.length > 0) {
      analysis.faces.forEach(face => {
        const parts = [];
        if (face.gender) parts.push(face.gender);
        if (face.age) parts.push(face.age);
        if (face.emotion) parts.push(face.emotion);

        if (parts.length > 0) {
          visionFacts.push({
            text: `На стриме ${parts.join(', ')}`,
            importance: 3,
            tags: ['визуальный', 'внешность']
          });
        }
      });
    }

    const significantObjects = analysis.objects
      .filter(obj => obj.confidence > 0.5)
      .slice(0, 5);

    if (significantObjects.length > 0) {
      const objectsText = significantObjects.map(obj => obj.name).join(', ');
      visionFacts.push({
        text: `На стриме видны: ${objectsText}`,
        importance: 2,
        tags: ['визуальный', 'объекты']
      });
    }

    const gameplayAnalysis = this.visionAnalyzer.analyzeGameplay(analysis);
    if (gameplayAnalysis) {
      visionFacts.push({
        text: `Стример играет в ${gameplayAnalysis}`,
        importance: 4,
        tags: ['визуальный', 'геймплей', 'игра']
      });
    }

    if (analysis.text && analysis.text.length > 10) {
      const shortText = analysis.text.length > 50
        ? analysis.text.substring(0, 50) + '...'
        : analysis.text;
      visionFacts.push({
        text: `На экране текст: ${shortText}`,
        importance: 2,
        tags: ['визуальный', 'текст']
      });
    }

    if (visionFacts.length > 0) {
      this.facts = mergeFactsSimple(this.facts, visionFacts);

      try {
        await this.memoryStore.save({
          channel: this.channelIdForMemory,
          updatedAt: now,
          facts: this.facts
        });

        logger.info(`Visual memory updated: +${visionFacts.length} facts`);
      } catch (error) {
        logger.warn('Failed to save visual memory:', error);
      }
    }
  }

  private async maybeUpdateScreenFromStream(): Promise<void> {
    if (!this.ocrEnabled && !this.visionAnalyzer.isEnabled()) return;
    if (!this.currentHlsUrl) return;

    const now = Date.now();

    if (this.ocrEnabled && now - this.lastOcrTs >= this.ocrIntervalMs) {
      this.lastOcrTs = now;
      await this.updateOCR();
    }

    if (this.visionAnalyzer.isEnabled()) {
      await this.analyzeStreamImage();
    }
  }

  private async updateOCR(): Promise<void> {
    try {
      const png = await this.captureFramePng(this.currentHlsUrl!);

      if (!this.yandexApiKey) throw new Error('YANDEX_API_KEY is missing');
      if (!this.yandexFolderId) throw new Error('YANDEX_FOLDER_ID is missing');

      const url = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText';
      const body = {
        mimeType: 'PNG',
        languageCodes: ['ru', 'en'],
        model: 'page',
        content: png.toString('base64')
      };

      const r = await axios.post(url, body, {
        headers: {
          Authorization: `Api-Key ${this.yandexApiKey}`,
          'x-folder-id': this.yandexFolderId,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const fullText = r.data?.textAnnotation?.fullText;
      const text = String(fullText || '').trim();
      const cleaned = normalizeMessage(text);

      if (cleaned && cleaned !== this.lastScreenText) {
        this.lastScreenText = cleaned;
        this.recordEvent({
          ts: Date.now(),
          type: 'screen',
          text: cleaned,
          meta: { source: 'ocr' }
        });

        if (this.learningMode && cleaned.length > 30) {
          this.learningManager.recordEvent('screen', cleaned);
          await this.extractKnowledgeFromScreen(cleaned);
        }

        await this.performFactsUpdate(); // можно вызвать сразу
      }
    } catch (e) {
      logger.debug('OCR failed:', e);
    }
  }

  // ========== Генерация сообщений для бота (только Yandex) ==========
  private async generateBotResponse(
    botUsername: string,
    contextText: string,
    triggerReason: string,
    interactionWith?: string
  ): Promise<void> {
    try {
      const personality = this.personalityManager.getPersonality(botUsername);
      if (!personality) return;

      if (this.learningMode) {
        logger.debug(`[Обучение] Бот ${botUsername} слушает: "${contextText}"`);
        return;
      }

      if (!this.ai.generateBotMessage) {
        logger.debug(`AI handler does not support generateBotMessage (local mode?)`);
        return;
      }

      const message = await this.ai.generateBotMessage(personality, {
        contextText,
        triggerReason,
        interactionWith,
        currentChannelInfo: this.currentChannelInfo,
        recentChat: this.recentChatMessages.slice(-8),
        recentSpeech: this.shortEvents.filter(e => e.type === 'speech').slice(-4).map(e => e.text),
        lastVisionAnalysis: this.lastVisionAnalysis,
        visionAnalyzer: this.visionAnalyzer,
        globalKnowledge: this.globalKnowledge,
        facts: this.facts,
        memoryStore: this.memoryStore
      });

      if (!message) return;

      const filteredMessage = MessageFilter.filterMessage(message);
      if (!filteredMessage) {
        logger.debug(`Message filtered out for ${botUsername}: ${message}`);
        return;
      }

      if (MessageFilter.isTooSimilar(this.lastSentMessages.slice(-10), filteredMessage)) {
        logger.debug(`Similar message detected for ${botUsername}: ${filteredMessage}`);
        return;
      }

      this.lastSentMessages.push(filteredMessage);
      if (this.lastSentMessages.length > 20) {
        this.lastSentMessages = this.lastSentMessages.slice(-20);
      }

      this.botLastMessageTs.set(botUsername, Date.now());

      this.emit('botMessage', {
        username: botUsername,
        message: filteredMessage,
        personality: personality.name
      });

      logger.info(`Bot ${botUsername} (${personality.name}): ${filteredMessage}`);

    } catch (error) {
      logger.error(`Error generating response for ${botUsername}:`, error);
    }
  }

  public async generateMessageForBot(
    botUsername: string,
    context: any
  ): Promise<string> {
    // Этот метод теперь только проксирует вызов в ai.generateBotMessage, если он есть
    // В локальном режиме он вернёт пустую строку
    if (!this.ai.generateBotMessage) return '';
    return this.ai.generateBotMessage(
      this.personalityManager.getPersonality(botUsername)!,
      {
        ...context,
        currentChannelInfo: this.currentChannelInfo,
        recentChat: this.recentChatMessages.slice(-8),
        recentSpeech: this.shortEvents.filter(e => e.type === 'speech').slice(-4).map(e => e.text),
        lastVisionAnalysis: this.lastVisionAnalysis,
        visionAnalyzer: this.visionAnalyzer,
        globalKnowledge: this.globalKnowledge,
        facts: this.facts,
        memoryStore: this.memoryStore
      }
    );
  }
}
