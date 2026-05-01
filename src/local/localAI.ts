import path from 'path';
import { logger } from '../logger';
import { VoskSTT } from './voskSTT';
import { TransformersNLP } from './transformersNLP';
import type { MemoryEvent, MemoryFact } from '../memory';
import type { Personality } from '../personality';

let stt: VoskSTT | null = null;
let nlp: TransformersNLP | null = null;

async function ensureInit() {
  const modelsPath = process.env.LOCAL_MODELS_PATH || path.join(process.cwd(), 'models');
  const voskModelPath = process.env.VOSK_MODEL_PATH || path.join(modelsPath, 'vosk-model-small-ru-0.22');

  if (!stt) {
    stt = new VoskSTT(voskModelPath);
    await stt.init();
    logger.info('✅ Local STT ready (Vosk)');
  }

  if (!nlp) {
    nlp = new TransformersNLP();
    // Можно переопределить модель переменной окружения
    const modelName = process.env.LOCAL_NLP_MODEL || 'Xenova/LaMini-Flan-T5-783M';
    await nlp.init(modelName);
    logger.info('✅ Local NLP ready (@xenova/transformers)');
  }
}

// =====================================================
// 1) SPEECH-TO-TEXT
// =====================================================
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  await ensureInit();
  return stt!.recognize(audioBuffer);
}

// =====================================================
// 2) KNOWLEDGE EXTRACTION (локальная замена GPT)
// =====================================================
export async function extractKnowledge(
  text: string,
  type: 'chat' | 'screen' | 'speech' | 'vision' = 'chat'
): Promise<any[]> {
  await ensureInit();

  // Чуть подсказываем модели источник
  const wrapped = `[source=${type}] ${text}`.slice(0, 4000);
  return nlp!.extractKnowledge(wrapped);
}

// =====================================================
// 3) FACTS UPDATE
// =====================================================
export async function updateFacts(events: MemoryEvent[], existingFacts: MemoryFact[]): Promise<MemoryFact[]> {
  // В локальном режиме пока не пересчитываем факты — оставляем как есть.
  // (Иначе можно случайно "потерять" факты из памяти)
  return existingFacts;
}

// =====================================================
// 4) BOT MESSAGE GENERATION
// =====================================================
export async function generateBotMessage(
  _personality: Personality,
  _context: {
    contextText: string;
    triggerReason: string;
    interactionWith?: string;
    currentChannelInfo?: any;
    recentChat?: any[];
    lastBotMessages?: string[];
    shortEvents?: any[];
    facts?: any[];
  }
): Promise<string> {
  // В локальном режиме по умолчанию отключаем генерацию сообщений (без LLM).
  return '';
}
