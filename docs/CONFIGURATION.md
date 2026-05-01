# Настройка проекта

Этот файл дополняет README и фиксирует назначение основных переменных окружения.

## Общие переменные

| Переменная | Назначение |
| --- | --- |
| `MODE` | Движок AI: `yandex` или `local`. |
| `LEARNING_MODE` | `1` включает обучение без сообщений в чат, `0` включает обычный режим. |
| `TWITCH_CHANNEL` | Канал Twitch. Можно указать имя или ссылку `https://www.twitch.tv/channel`. |
| `LEARNING_CHANNEL` | Отдельный канал для обучения. Если пусто, используется `TWITCH_CHANNEL`. |

## Twitch

| Переменная | Назначение |
| --- | --- |
| `TWITCH_CLIENT_ID` | Client ID приложения Twitch. |
| `TWITCH_CLIENT_SECRET` | Client Secret приложения Twitch. |
| `TWITCH_WEB_CLIENT_ID` | Web Client ID для получения playback access token. |
| `BOT1_USERNAME` | Логин первого аккаунта-бота. |
| `BOT1_OAUTH` | OAuth-токен первого бота в формате `oauth:...`. |

Для дополнительных ботов используйте `BOT2_USERNAME`, `BOT2_OAUTH` и так далее до `BOT10`.

## Yandex Cloud

| Переменная | Назначение |
| --- | --- |
| `YANDEX_API_KEY` | API-ключ сервисного аккаунта. |
| `YANDEX_FOLDER_ID` | Folder ID каталога Yandex Cloud. |
| `YANDEX_STT_LANG` | Язык распознавания речи, например `ru-RU`. |
| `YANDEX_GPT_MODEL` | Модель YandexGPT. По умолчанию используется `yandexgpt-lite`. |

## Локальный режим

| Переменная | Назначение |
| --- | --- |
| `LOCAL_MODELS_PATH` | Папка с локальными моделями. |
| `VOSK_MODEL_PATH` | Путь к модели Vosk. |
| `VOSK_SAMPLE_RATE` | Частота дискретизации для Vosk. |
| `VOSK_PYTHON` | Необязательный путь к Python, если системный Python не подходит. |
| `LOCAL_NLP_MODEL` | Модель для `@xenova/transformers`. |

## Ограничения отправки сообщений

| Переменная | Назначение |
| --- | --- |
| `AI_MIN_INTERVAL_MS` | Минимальный интервал между AI-реакциями. |
| `AI_JITTER` | Разброс задержек, чтобы сообщения не выглядели механически. |
| `BOT_MIN_SEND_INTERVAL_MS` | Минимальный интервал отправки для одного бота. |
| `BOT_MAX_SEND_INTERVAL_MS` | Максимальный интервал отправки для одного бота. |
| `MAX_BOTS_PER_EVENT` | Сколько ботов максимум реагирует на одно событие. |
| `BETWEEN_BOT_DELAY_MS` | Пауза между сообщениями разных ботов. |

## Данные и секреты

Не коммитьте `.env`, `.env.local`, OAuth-токены, локальные сессии обучения, базу памяти и скачанные модели. Эти файлы завязаны на конкретный канал и аккаунты.
