# TwitchChatAi

![CI](https://github.com/Crazy4elovek66/TwitchChatAi/actions/workflows/ci.yml/badge.svg)


TwitchChatAi - экспериментальная система Twitch-ботов с AI-ядром, анализом речи, чата и визуального контекста стрима. Проект рассчитан на русскоязычные Twitch-каналы и умеет работать в двух сценариях: собирать знания в режиме обучения и использовать накопленный контекст для живых сообщений в чате.

## Возможности

- подключение одного или нескольких Twitch-аккаунтов через OAuth;
- анализ сообщений чата и истории последних событий;
- захват аудио Twitch-стрима через HLS/ffmpeg;
- распознавание речи через Yandex SpeechKit или локальный Vosk;
- извлечение знаний о мемах, игровых терминах, поведении чата и Twitch-культуре;
- отдельный режим обучения без отправки сообщений в чат;
- генерация сообщений через YandexGPT в обычном режиме;
- базовая антиспам-логика: интервалы, задержки, фильтр повторов;
- хранение локальной памяти в `data/memory` и сессий обучения в `data/learning`.

## Режимы работы

`MODE=yandex` - основной режим с Yandex Cloud. Использует Yandex SpeechKit для речи и YandexGPT для генерации/анализа.

`MODE=local` - локальный режим. Использует Vosk для распознавания речи и `@xenova/transformers` для локальной обработки. В текущей реализации локальный режим больше подходит для обучения и анализа: генерация сообщений в чат по умолчанию отключена.

`LEARNING_MODE=1` - режим обучения. Бот слушает стрим, анализирует речь, чат и визуальный контекст, сохраняет знания, но не пишет сообщения в чат.

`LEARNING_MODE=0` - обычный режим. Боты могут отвечать в чат с учетом накопленной памяти и настроенных задержек.

## Требования

- Node.js 16 или новее;
- npm 7 или новее;
- Twitch bot account и OAuth-токен в формате `oauth:...`;
- Twitch Client ID и Client Secret;
- для режима Yandex: API-ключ и Folder ID в Yandex Cloud;
- для локального режима: модель Vosk `vosk-model-small-ru-0.22`.

## Быстрый старт

```bash
npm install
```

Для режима Yandex:

```powershell
Copy-Item .env.example .env
```

Заполните `.env` реальными значениями и запустите:

```bash
npm run dev
```

Для локального режима:

```powershell
Copy-Item .env.local.example .env.local
npm run models:download
npm run dev:learning
```

На Windows команда `models:download` требует доступную команду `unzip`. Если ее нет, скачайте модель Vosk вручную с сайта Vosk и распакуйте в `models/vosk-model-small-ru-0.22`.

## Переменные окружения

Минимальный набор для обычного режима:

```env
MODE=yandex
LEARNING_MODE=0
TWITCH_CHANNEL=your_channel
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
YANDEX_API_KEY=your_yandex_api_key
YANDEX_FOLDER_ID=your_folder_id
BOT1_USERNAME=your_bot_username
BOT1_OAUTH=oauth:your_oauth_token
```

Для нескольких ботов добавьте пары:

```env
BOT2_USERNAME=second_bot_username
BOT2_OAUTH=oauth:second_oauth_token
```

Поддерживаются аккаунты `BOT1`...`BOT10`.

## Полезные команды

```bash
npm run dev              # запуск TypeScript-версии
npm run build            # сборка в dist
npm run start            # запуск собранной версии
npm run lint             # проверка TypeScript без сборки
npm run dev:learning     # локальный режим обучения
npm run models:download  # загрузка модели Vosk
npm run knowledge:view   # просмотр базы знаний
npm run knowledge:stats  # статистика по категориям знаний
npm run emotions:stats   # статистика эмоциональных моментов
```

## Структура проекта

```text
src/main.ts                  точка входа
src/bot.ts                   подключение Twitch-ботов и отправка сообщений
src/ai.ts                    центральный AI-сервис, память, аудио и контекст
src/yandex/yandexAI.ts       интеграция с Yandex Cloud
src/local/                   локальные STT/NLP-провайдеры
src/memory.ts                хранение событий и знаний
src/learning.ts              режим обучения
src/vision.ts                анализ визуального контекста
python/vosk_worker.py        Python worker для Vosk
data/memory/                 локальная память, не публикуется в Git
data/learning/               сессии обучения, не публикуются в Git
models/                      скачанные модели, не публикуются в Git
```

## Что не попадает в репозиторий

В Git намеренно не отправляются:

- `.env` и `.env.local`;
- `ACC.txt` и любые локальные дампы аккаунтов;
- `node_modules`;
- `.venv`;
- `models`;
- ZIP-архивы;
- накопленные данные `data/memory` и `data/learning`.

Если токен Twitch, Yandex API-ключ или другой секрет уже был опубликован случайно, его нужно перевыпустить в кабинете соответствующего сервиса.

## Статус проекта

Проект находится в рабочей экспериментальной стадии.

## Лицензия

ISC. Подробности в [LICENSE](LICENSE).
