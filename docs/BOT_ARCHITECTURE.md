# Telegram Bot Architecture

## 1) Components

```mermaid
flowchart LR
  A["Telegram Update"] --> B["Express Webhook /webhook/{secret}"]
  B --> C{"Router"}
  C -->|"message"| D["Message Handler"]
  C -->|"callback_query"| E["Callback Handler"]
  D --> F["Session Store (in-memory)"]
  E --> F
  D --> G["LLM Draft Service (OpenAI)"]
  G --> H["Draft Composer"]
  H --> I["Telegram sendMessage/editMessageText"]
  E --> I
```

## 2) Screen Map

```mermaid
flowchart TD
  S["/start: Главное меню"] --> Q["✍️ Подготовить ответ"]
  S --> G["👥 Группы (подсказки)"]
  S --> U["💳 Подписка"]
  S --> H["❓ Помощь"]
  S --> T["⚙️ Настройки"]

  Q --> M["Выбор режима + задержки"]
  M --> I["✍️ Ввести текст"]
  I --> W["Ожидание N сек"]
  W --> R["📝 Готовый ответ"]
  R --> C["📋 Скопировать"]
  R --> N["🔄 Еще вариант"]
  R --> S2["🏠 Главное меню"]
```

## 3) Session Model

- `mode`: `normal | short | polite | tothepoint | refuse | busy`
- `delaySec`: `10 | 20`
- `awaitingInput`: bot waits for user message to draft
- `lastIncomingText`: latest source message for regenerate
- `lastDraft`: latest generated reply
- `trialActivated`: unlock premium modes
- `pendingTimer/pendingToken`: safe delayed generation

## 4) UX Principles (from reference)

- One clear action first: `✍️ Подготовить ответ`
- Always show explicit next step after each screen
- Keep answer card copy-friendly and compact
- Premium upsell only after user got first value
- Group mode explains limitation: bot does not send on behalf of user
