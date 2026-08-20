# Ручное тестирование Mekka на self-hosted libSQL

Этот документ предназначен для ручной проверки продукта перед следующим этапом разработки. Его можно проходить без знания кода: открывай указанные экраны, нажимай кнопки и сравнивай результат с разделом **Что должно произойти**.

Дата чеклиста: **20 августа 2026 года**.

## Что мы проверяем

В этой сборке пользовательские таблицы, строки, схема, SQL Editor и read-only MCP работают через удаленный self-hosted libSQL.

Локально на сервере остаются только служебные данные: Auth, сессии, approvals и другая control-plane информация. Это нормально. Пользовательская project database не должна незаметно переключаться на локальный SQLite.

## Важные ограничения

Следующие возможности намеренно недоступны в этой версии и не считаются багом:

- Storage отсутствует в меню Studio.
- Realtime, Functions, Logs, Observability, Integrations и Project Settings отсутствуют в меню.
- Turso preview databases недоступны.
- Read-write MCP для self-hosted libSQL недоступен.
- Удаление remote-таблицы заблокировано, пока не подключен внешний backup provider.
- MCP не выполняет произвольный SQL. Чтение строк доступно только после отдельного явного opt-in в Agent Access и только через bounded `query_rows` с policy checks.
- SQL Editor не выполняет DDL, `PRAGMA`, транзакционные команды и несколько statements за один запуск.

Если вместо понятного сообщения `unsupported` появляется белый экран, бесконечная загрузка, `500`, stack trace или секрет, это баг.

## Что подготовить

Заполни перед началом:

| Поле | Значение |
| --- | --- |
| URL Studio |  |
| Версия или commit | `764d4f0` или более новый |
| Операционная система |  |
| Браузер и версия |  |
| Размер экрана |  |
| Дата и время теста |  |
| Имя тестировщика |  |

Понадобятся:

- пароль доступа к Studio, переданный отдельно;
- тестовый email, на который можно получить verification code;
- возможность открыть DevTools браузера;
- OpenCode или другой MCP-клиент для проверки Agent Access;
- возможность попросить разработчика перезапустить Studio и libSQL для проверки сохранности данных.

Не вставляй реальные токены, пароли, JWT и OAuth secrets в баг-репорты или скриншоты.

## Как отмечать результат

Используй один статус для каждого пункта:

| Статус | Значение |
| --- | --- |
| `PASS` | Получилось ровно то, что описано |
| `FAIL` | Результат отличается или функция сломана |
| `BLOCKED` | Невозможно проверить из-за отсутствия доступа или данных |
| `NOT APPLICABLE` | Проверка не относится к выданной сборке |

Для каждого `FAIL` создай отдельный баг-репорт по шаблону в конце документа.

## Тестовые данные

Используй эти названия, чтобы результаты было легко найти и удалить:

```text
Таблица: cofounder_items
Новое имя таблицы: cofounder_notes
Колонки:
  id INTEGER PRIMARY KEY
  title TEXT
  description TEXT
```

Тестовые строки:

```json
{"id":1,"title":"First note","description":"alpha"}
```

```json
{"id":2,"title":"Second note","description":"beta"}
```

## 1. Вход и стартовая страница

### 1.1 Доступ без пароля

1. Открой URL Studio в приватном окне.
2. Закрой окно авторизации или введи неправильный пароль.

**Что должно произойти:** Studio не открывается, сервер отвечает `401 Unauthorized`. Не должно быть части интерфейса, данных проекта или подробного текста внутренней ошибки.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 1.2 Доступ с правильным паролем

1. Обнови страницу.
2. Введи выданные credentials.

**Что должно произойти:** открывается `/project/local/editor`. Нет белого экрана, циклического redirect или ошибки загрузки.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 1.3 Главное меню

Проверь левую панель.

**Что должно произойти:** видны только основные продуктовые разделы:

- `Table Editor`;
- `SQL Editor`;
- `Authentication`.

Storage, Database, Realtime, Functions, Logs, Observability, Integrations и Project Settings не должны появляться.

Результат: `[ ] PASS  [ ] FAIL`

### 1.4 Прямые ссылки на скрытые разделы

По очереди открой:

```text
/project/local/storage/files
/project/local/settings/general
/project/local/logs
/project/local/realtime/inspector
```

**Что должно произойти:** приложение безопасно возвращает тебя в Table Editor. Скрытый upstream-экран не должен частично открываться или отправлять запросы к несуществующему backend.

Результат: `[ ] PASS  [ ] FAIL`

## 2. Table Editor: создание таблицы

### 2.1 Кнопка New table

1. Открой `Table Editor`.
2. Нажми `New table`.

**Что должно произойти:** появляется форма создания таблицы с полем имени, колонками, типами, primary key и preview миграции.

Результат: `[ ] PASS  [ ] FAIL`

### 2.2 Проверка формы создания

1. Введи имя `cofounder_items`.
2. Первой колонке задай имя `id`.
3. Выбери тип `INTEGER`.
4. Отметь `Primary key`.
5. Нажми `Add another column`.
6. Добавь колонку `title` типа `TEXT`.
7. Проверь блок `Migration preview`.

**Что должно произойти:** preview показывает создание `cofounder_items` и обеих колонок. В SQL preview нет введенных паролей, токенов или посторонних данных.

Результат: `[ ] PASS  [ ] FAIL`

### 2.3 Создание таблицы

1. Нажми `Create table` один раз.
2. Не нажимай кнопку повторно во время сохранения.

**Что должно произойти:** появляется успешный результат, открывается экран новой таблицы, а в списке слева появляется `cofounder_items`. Должны отображаться колонки `id` и `title`.

Результат: `[ ] PASS  [ ] FAIL`

### 2.4 Повторное создание той же таблицы

1. Снова нажми `New table`.
2. Попробуй создать `cofounder_items` еще раз.

**Что должно произойти:** появляется понятная conflict/validation ошибка. Уже существующая таблица и ее данные не меняются.

Результат: `[ ] PASS  [ ] FAIL`

### 2.5 Невалидные названия

Попробуй по одному имени:

```text
bad-name
123table
sqlite_shadow
_mekka_private
```

**Что должно произойти:** каждое опасное или зарезервированное имя отклоняется. Таблица не появляется в списке. Ошибка не содержит stack trace, URL базы или token.

Результат: `[ ] PASS  [ ] FAIL`

## 3. Table Editor: изменение схемы

### 3.1 Add column

1. Открой `cofounder_items`.
2. Нажми `Add column`.
3. Введи `description`.
4. Выбери `TEXT`.
5. Проверь migration preview.
6. Подтверди добавление.

**Что должно произойти:** колонка `description` появляется в списке. После обновления страницы она остается на месте.

Результат: `[ ] PASS  [ ] FAIL`

### 3.2 Rename table

1. Нажми `Rename table`.
2. Введи `cofounder_notes`.
3. Подтверди rename.

**Что должно произойти:** заголовок, URL и пункт в левом меню меняются на `cofounder_notes`. Старое имя исчезает. Колонки и строки сохраняются.

Результат: `[ ] PASS  [ ] FAIL`

### 3.3 Rename с невалидным именем

1. Нажми `Rename table`.
2. Попробуй имя `bad-name`.

**Что должно произойти:** rename блокируется. Таблица остается `cofounder_notes`.

Результат: `[ ] PASS  [ ] FAIL`

### 3.4 Delete table

1. Нажми `Delete table`.
2. Отметь checkbox подтверждения.
3. Нажми финальную кнопку удаления.

**Что должно произойти в self-hosted libSQL:** появляется понятное сообщение, что destructive remote DDL требует backup provider или не поддерживается. Таблица остается на месте.

Это ожидаемое ограничение, а не баг. Багом считается исчезновение таблицы без restore point, `500`, зависание или непонятная пустая ошибка.

Результат: `[ ] PASS  [ ] FAIL`

## 4. Строки таблицы

### 4.1 Insert row

1. Открой `cofounder_notes`.
2. В поле `New row JSON` вставь:

```json
{"id":1,"title":"First note","description":"alpha"}
```

3. Нажми `Insert row`.
4. Повтори для второй строки:

```json
{"id":2,"title":"Second note","description":"beta"}
```

**Что должно произойти:** обе строки появляются в таблице. Индикатор сохранения завершается. После обновления страницы строки остаются.

Результат: `[ ] PASS  [ ] FAIL`

### 4.2 Ошибочный JSON

По очереди попробуй:

```text
не JSON
```

```json
[]
```

```json
{"id":3,"title":{"nested":"not allowed"}}
```

**Что должно произойти:** форма показывает validation error. Новая строка не создается.

Результат: `[ ] PASS  [ ] FAIL`

### 4.3 Duplicate primary key

Попробуй еще раз вставить строку с `"id":1`.

**Что должно произойти:** появляется conflict error. Исходная строка с `id=1` не меняется.

Результат: `[ ] PASS  [ ] FAIL`

### 4.4 Edit row

1. У строки `id=1` нажми `Edit`.
2. Измени JSON на:

```json
{"id":1,"title":"Updated note","description":"gamma"}
```

3. Нажми `Save row`.

**Что должно произойти:** строка обновляется, остальные строки остаются без изменений.

Результат: `[ ] PASS  [ ] FAIL`

### 4.5 Cancel edit

1. Нажми `Edit` у строки `id=2`.
2. Измени текст.
3. Нажми `Cancel`.

**Что должно произойти:** несохраненное изменение исчезает, исходное значение остается.

Результат: `[ ] PASS  [ ] FAIL`

### 4.6 Delete row

1. У строки `id=2` нажми `Delete`.
2. Проверь ID в confirmation dialog.
3. Нажми `Delete row`.

**Что должно произойти:** удаляется только строка `id=2`. Строка `id=1` остается.

Результат: `[ ] PASS  [ ] FAIL`

### 4.7 Filter

1. Создай несколько строк с ID `10`, `11` и `21`.
2. В поле фильтра по primary key введи `1`.
3. Очисти фильтр.

**Что должно произойти:** фильтр использует поиск по вхождению, поэтому могут появиться `1`, `10`, `11`, `21`. После очистки снова видны все строки.

Результат: `[ ] PASS  [ ] FAIL`

### 4.8 Pagination

1. Если возможно, создай не менее 55 строк.
2. Проверь счетчик строк.
3. Нажми `Next`.
4. Нажми `Previous`.

**Что должно произойти:** первая страница показывает до 50 строк. `Next` открывает оставшиеся строки. На первой странице `Previous` disabled, на последней странице `Next` disabled.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 4.9 Reload schema или Reload data

Нажми доступную кнопку reload на экране таблицы.

**Что должно произойти:** данные перечитываются, интерфейс не дублирует строки и не сбрасывает таблицу.

Результат: `[ ] PASS  [ ] FAIL`

## 5. SQL Editor

### 5.1 Открытие SQL Editor

1. Нажми `SQL Editor`.
2. Нажми создание нового query, если это требуется.

**Что должно произойти:** открывается рабочая SQL-сессия с textarea, кнопками `Run query` и `Cancel`, checkbox guarded writes, Result и Session activity.

Результат: `[ ] PASS  [ ] FAIL`

### 5.2 Простой SELECT

Выполни:

```sql
SELECT id, title, description FROM cofounder_notes LIMIT 20
```

**Что должно произойти:** в Result появляется JSON со строками. Показывается `0 rows changed`. В Session activity появляется успешный read event.

Результат: `[ ] PASS  [ ] FAIL`

### 5.3 SELECT без LIMIT

Выполни:

```sql
SELECT * FROM cofounder_notes
```

**Что должно произойти:** запрос отклоняется с понятной validation error. Данные не меняются.

Результат: `[ ] PASS  [ ] FAIL`

### 5.4 Слишком большой LIMIT

Выполни:

```sql
SELECT * FROM cofounder_notes LIMIT 201
```

**Что должно произойти:** запрос отклоняется. Максимум равен 200 строкам.

Результат: `[ ] PASS  [ ] FAIL`

### 5.5 Guarded INSERT

1. Не отмечая guarded writes, выполни:

```sql
INSERT INTO cofounder_notes (id, title, description) VALUES (100, 'SQL note', 'sql')
```

2. Отметь `Enable guarded write statements`.
3. Запусти тот же запрос еще раз.

**Что должно произойти:** первый запуск блокируется интерфейсом. Второй создает одну строку и показывает `1 rows changed`.

Результат: `[ ] PASS  [ ] FAIL`

### 5.6 Guarded UPDATE

Выполни с включенным guarded writes:

```sql
UPDATE cofounder_notes SET title = 'SQL updated' WHERE id = 100
```

**Что должно произойти:** изменяется одна строка. Изменение видно в Table Editor.

Результат: `[ ] PASS  [ ] FAIL`

### 5.7 UPDATE и DELETE без WHERE

По очереди выполни:

```sql
UPDATE cofounder_notes SET title = 'broken'
```

```sql
DELETE FROM cofounder_notes
```

**Что должно произойти:** оба запроса отклоняются. Массовое изменение или удаление не происходит.

Результат: `[ ] PASS  [ ] FAIL`

### 5.8 Запрещенный SQL

По очереди выполни:

```sql
PRAGMA foreign_keys = OFF
```

```sql
DROP TABLE cofounder_notes
```

```sql
SELECT 1 LIMIT 1; SELECT 2 LIMIT 1
```

```sql
SELECT * FROM sqlite_schema LIMIT 10
```

**Что должно произойти:** каждый запрос безопасно отклоняется. Не должно быть stack trace или изменений базы.

Результат: `[ ] PASS  [ ] FAIL`

### 5.9 Cancel query

1. Запусти запрос.
2. Пока виден running state, нажми `Cancel`.

**Что должно произойти:** UI возвращается в обычное состояние и не отправляет повторный write. Если запрос завершился слишком быстро и кнопку нажать невозможно, поставь `BLOCKED`.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 5.10 Несколько SQL tabs

1. Открой две SQL tabs.
2. Введи разные запросы.
3. Переключись между tabs.
4. Закрой одну tab.
5. Полностью обнови страницу.

**Что должно произойти:** до reload каждая tab хранит собственный текст и результат. Закрытие одной tab не ломает другую. После полного reload сохранение SQL не гарантируется и потеря текста не считается багом этой версии.

Результат: `[ ] PASS  [ ] FAIL`

## 6. Authentication: регистрация и вход

### 6.1 Открытие Register / Sign in

1. Нажми `Authentication`.
2. Выбери `Register / Sign in`.

**Что должно произойти:** открывается форма создания application user, verification и sign-in.

Результат: `[ ] PASS  [ ] FAIL`

### 6.2 Слабый пароль

1. Заполни Name и Email.
2. Введи пароль короче 12 символов.
3. Нажми `Register user`.

**Что должно произойти:** регистрация блокируется. Пользователь не появляется в Users.

Результат: `[ ] PASS  [ ] FAIL`

### 6.3 Регистрация пользователя

1. Введи уникальный тестовый email.
2. Введи имя.
3. Введи пароль длиной не менее 12 символов.
4. Нажми `Register user`.

**Что должно произойти:** появляется шаг подтверждения email. Пароль нигде не отображается после отправки.

Результат: `[ ] PASS  [ ] FAIL`

### 6.4 Неверный verification code

1. Введи заведомо неверный шестизначный code.
2. Нажми `Verify email`.

**Что должно произойти:** verification отклоняется, но форма остается рабочей.

Результат: `[ ] PASS  [ ] FAIL`

### 6.5 Верный verification code

1. Получи настоящий code из тестовой почты.
2. Введи code.
3. Нажми `Verify email`.

**Что должно произойти:** появляется сообщение об успешной verification. Повторное применение того же code должно быть отклонено.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 6.6 Sign in

1. Нажми `Sign in`.
2. Обнови страницу.
3. Перейди в Table Editor и вернись в Authentication.

**Что должно произойти:** отображается signed-in state. Сессия восстанавливается после reload и перехода между разделами.

Результат: `[ ] PASS  [ ] FAIL`

### 6.7 Проверка отсутствующей кнопки logout

На экране application sign-in отдельная кнопка logout может отсутствовать.

**Что должно произойти:** отсутствие кнопки является известным ограничением текущего UI. Если кнопка есть, она должна завершать application session. Не путай это с Basic Auth доступом к самой Studio.

Результат: `[ ] PASS  [ ] FAIL`

## 7. Authentication: Users

### 7.1 Список пользователей

1. В Authentication выбери `Users`.

**Что должно произойти:** зарегистрированный пользователь виден в списке. Отображаются email, verification status и число активных sessions.

Результат: `[ ] PASS  [ ] FAIL`

### 7.2 Revoke sessions

1. Нажми `Revoke sessions`.
2. Подтверди действие.
3. Вернись на `Register / Sign in` или обнови страницу.

**Что должно произойти:** появляется успешное уведомление. Старая application session больше не должна давать доступ к Agent Access.

Результат: `[ ] PASS  [ ] FAIL`

### 7.3 Delete user: неправильное подтверждение

1. Нажми `Delete user`.
2. Введи неправильный user ID.
3. Попробуй подтвердить.

**Что должно произойти:** удаление блокируется, пользователь остается.

Результат: `[ ] PASS  [ ] FAIL`

### 7.4 Delete user

1. Снова нажми `Delete user`.
2. Введи точный user ID.
3. Подтверди удаление.

**Что должно произойти:** пользователь исчезает. Вход с его email и паролем больше не работает.

Результат: `[ ] PASS  [ ] FAIL`

## 8. Authentication: Providers

### 8.1 Открытие Providers

1. В Authentication выбери `Sign In / Providers`.

**Что должно произойти:** видны Google и GitHub. Для каждого есть Enabled, Client ID, Client Secret и `Save provider`.

Результат: `[ ] PASS  [ ] FAIL`

### 8.2 Save provider без credentials

1. Не включая provider, нажми `Save provider` с пустыми полями.

**Что должно произойти:** disabled provider сохраняется или остается выключенным без ошибки сервера.

Результат: `[ ] PASS  [ ] FAIL`

### 8.3 Enable provider без полного набора данных

1. Отметь Enabled.
2. Оставь Client ID или Client Secret пустым.
3. Нажми `Save provider`.

**Что должно произойти:** появляется validation error. Provider не включается частично.

Результат: `[ ] PASS  [ ] FAIL`

### 8.4 Save test provider credentials

Выполняй только если выданы отдельные тестовые OAuth credentials.

1. Введи тестовые Client ID и Client Secret.
2. Включи provider.
3. Нажми `Save provider`.
4. Обнови страницу.

**Что должно произойти:** provider остается enabled. Secret не показывается обратно полностью и не появляется в URL, console или Network response.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

## 9. Authentication: URL Configuration

### 9.1 Сохранение разрешенного URL

1. Открой `URL Configuration`.
2. Введи тестовый HTTPS URL, например:

```text
https://app.example.test/auth/callback
```

3. Нажми `Save URLs`.
4. Обнови страницу.

**Что должно произойти:** URL сохраняется и остается в списке.

Результат: `[ ] PASS  [ ] FAIL`

### 9.2 Невалидные URLs

По очереди попробуй:

```text
http://example.test/callback
https://user:password@example.test/callback
https://*.example.test/callback
https://example.test/callback#fragment
```

**Что должно произойти:** каждый небезопасный URL отклоняется. Ранее сохраненные URLs остаются без изменений.

Результат: `[ ] PASS  [ ] FAIL`

### 9.3 Duplicate URL

Добавь один и тот же URL дважды и нажми `Save URLs`.

**Что должно произойти:** duplicate не должен создавать две разные записи или ломать страницу.

Результат: `[ ] PASS  [ ] FAIL`

## 10. Authentication: Email Templates

### 10.1 Открытие templates

1. Открой `Email Templates`.

**Что должно произойти:** видны формы `Email verification` и `Password reset`, поля Subject, Plain-text body и кнопки сохранения.

Результат: `[ ] PASS  [ ] FAIL`

### 10.2 Template без code placeholder

1. Удали `{{ code }}` из body.
2. Нажми `Save template`.

**Что должно произойти:** template отклоняется с validation error.

Результат: `[ ] PASS  [ ] FAIL`

### 10.3 Сохранение template

1. Верни `{{ code }}`.
2. Измени Subject и текст.
3. Нажми `Save template`.
4. Обнови страницу.

**Что должно произойти:** template сохраняется и восстанавливается после reload.

Результат: `[ ] PASS  [ ] FAIL`

## 11. Agent Access и MCP

### 11.1 Кнопка Agent Access в header

1. На любой project-странице нажми `Agent Access`.

**Что должно произойти:** открывается панель с MCP endpoint и примером конфигурации. Нет database password, libSQL JWT или других server secrets.

Результат: `[ ] PASS  [ ] FAIL`

### 11.2 Copy MCP configuration

1. Нажми `Copy`.
2. Вставь результат в безопасный локальный текстовый редактор.

**Что должно произойти:** копируется валидная конфигурация с публичным `/mcp` endpoint и placeholder для временного Agent Access token.

Результат: `[ ] PASS  [ ] FAIL`

### 11.3 Generate read-only token

1. Войди как application user в `Register / Sign in`.
2. Не отмечай read-write checkbox.
3. Нажми `Generate read-only token`.

**Что должно произойти:** появляется временный токен, mode `read` и срок действия примерно один час. Response не должен содержать libSQL token.

Результат: `[ ] PASS  [ ] FAIL`

### 11.4 Copy temporary token

1. Нажми `Copy temporary Agent Access token`.
2. Вставь token только в локальную конфигурацию MCP-клиента.

**Что должно произойти:** clipboard получает token. Не публикуй его в отчете.

Результат: `[ ] PASS  [ ] FAIL`

### 11.5 Row-data opt-in и query_rows

1. Выпусти read-only token без `Allow this token to read table rows`.
2. Вызови `query_rows` для `cofounder_notes` с колонками `id` и `title`.
3. Убедись, что запрос отклонен.
4. Выпусти новый read-only token с включенным checkbox и убедись, что Studio показывает `Row data: enabled`.
5. Вызови `query_rows` с `columns: ["id", "title"]`, одним filter, `orderBy`, `limit: 1`.

**Что должно произойти:** schema-only token не видит строки. Opt-in token получает только выбранные policy-authorized строки и колонки. MCP не принимает SQL text, wildcard, joins, mutations или internal columns. Не публикуй row values и токены в баг-репорте.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 11.6 MCP inspect_schema

1. Подключи OpenCode или другой MCP-клиент к `/mcp`.
2. Передай temporary token через environment variable или Authorization header.
3. Попроси вызвать `inspect_schema`.

Пример запроса:

```text
Используй Mekka MCP. Вызови inspect_schema и перечисли только имена таблиц и колонок.
```

**Что должно произойти:** MCP видит `cofounder_notes` и ее колонки. Он не возвращает строки таблицы и server secrets.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 11.7 Другие read-only MCP tools

Проверь:

```text
list_migrations
get_policy_summary
explain_query
```

**Что должно произойти:** tools возвращают только schema, migration и policy metadata. `explain_query` не выполняет запрос и не показывает bound values.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 11.8 Попытка write через read token

Попроси MCP вызвать `propose_migration` с read-only token.

**Что должно произойти:** операция отклоняется. Production schema не меняется.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 11.9 Read-write token в self-hosted profile

1. Отметь `Enable read-write MCP for this token`.
2. Нажми `Generate read-write token`.

**Что должно произойти:** появляется понятный ответ `unsupported`, потому что self-hosted preview provider еще не реализован. Не должно создаваться локальной копии production database.

Результат: `[ ] PASS  [ ] FAIL`

### 11.10 Refresh MCP approvals

Нажми `Refresh MCP approvals`.

**Что должно произойти:** список обновляется без ошибки. В self-hosted remote profile список обычно пуст, потому что write workflow недоступен.

Результат: `[ ] PASS  [ ] FAIL`

## 12. Дополнительные элементы интерфейса

### 12.1 Theme

1. Открой локальное меню в header.
2. Переключи доступные темы.
3. Обнови страницу.

**Что должно произойти:** тема меняется без нечитаемого текста и сохраняется после reload.

Результат: `[ ] PASS  [ ] FAIL`

### 12.2 Sidebar behavior

Проверь режимы:

```text
Expanded
Collapsed
Expand on hover
```

**Что должно произойти:** sidebar меняет ширину и остается пригодным для навигации. Активный раздел визуально выделен.

Результат: `[ ] PASS  [ ] FAIL`

### 12.3 Help

1. Нажми `Help`.
2. Проверь `Docs` и `Troubleshooting`.

**Что должно произойти:** ссылки открываются или показывают понятный destination. Не должно быть platform-only billing/support действий.

Результат: `[ ] PASS  [ ] FAIL`

### 12.4 Command menu

1. Открой command/search menu кнопкой или keyboard shortcut.
2. Найди Table Editor.
3. Найди SQL Editor.
4. Найди созданную таблицу.
5. Попробуй переключить тему.

**Что должно произойти:** команды ведут в правильные разделы и не открывают скрытые upstream-функции.

Результат: `[ ] PASS  [ ] FAIL`

### 12.5 Keyboard navigation

1. Пройди основные формы с помощью `Tab` и `Shift+Tab`.
2. Активируй кнопки через `Enter` или `Space`.
3. Закрой dialog через `Escape`.

**Что должно произойти:** focus виден, порядок логичный, destructive action нельзя случайно подтвердить одним нажатием.

Результат: `[ ] PASS  [ ] FAIL`

## 13. Mobile и разные браузеры

### 13.1 Mobile 375 px

В DevTools включи viewport шириной 375 px и проверь:

- Table Editor;
- создание таблицы;
- строки таблицы;
- SQL Editor;
- Register / Sign in;
- Users;
- Providers;
- Email Templates;
- Agent Access panel.

**Что должно произойти:** формы доступны, кнопки не уходят за экран, dialog можно закрыть, таблицы и JSON results прокручиваются горизонтально, текст не перекрывается.

Результат: `[ ] PASS  [ ] FAIL`

### 13.2 Desktop browsers

Минимально повтори вход, Table Editor read и SQL SELECT в:

```text
Chrome или Edge
Firefox
Safari, если доступен macOS
```

**Что должно произойти:** основной сценарий работает одинаково.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

## 14. Ошибки сети и восстановление

### 14.1 Offline read

1. Открой Table Editor.
2. В DevTools включи Offline.
3. Нажми reload данных.
4. Верни Online.
5. Повтори reload.

**Что должно произойти:** offline показывает безопасную ошибку и кнопку retry/reload. После возвращения сети данные снова загружаются.

Результат: `[ ] PASS  [ ] FAIL`

### 14.2 Обрыв во время mutation

1. Подготовь вставку новой строки с уникальным ID.
2. Во время отправки временно отключи сеть.
3. Верни сеть.
4. Нажми reload, не создавая новую mutation с другим содержимым.

**Что должно произойти:** Studio не делает бесконечные автоматические повторы. Интерфейс предлагает reconciliation или reload. После reload видно, применена операция или нет, без duplicate rows.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

## 15. Persistence и перезапуск

### 15.1 Перезапуск Studio

1. Убедись, что `cofounder_notes` и строка `id=1` существуют.
2. Попроси разработчика перезапустить Studio/sqlite-meta с тем же persistent data directory.
3. Обнови браузер.

**Что должно произойти:** remote table и строки остаются. Auth users и server-side настройки также должны сохраниться при неизменном persistent control-plane directory.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 15.2 Перезапуск libSQL

1. Попроси разработчика перезапустить libSQL container.
2. Дождись сообщения, что health восстановлен.
3. Обнови Table Editor.
4. Выполни SELECT в SQL Editor.

**Что должно произойти:** таблица, схема и строки сохраняются. Новые reads и writes снова работают.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

### 15.3 Проверка restore

Эту проверку выполняет разработчик или DevOps, не через UI.

**Что должно произойти:** backup восстанавливается в новый volume, данные до snapshot присутствуют, данные после snapshot отсутствуют, исходный active volume не перезаписывается.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

## 16. Базовая ручная security-проверка

### 16.1 Секреты в URL

Пройди Table Editor, SQL, Auth и Agent Access. Следи за адресной строкой.

**Что должно произойти:** в URL никогда нет password, application token, Agent Access token или libSQL JWT.

Результат: `[ ] PASS  [ ] FAIL`

### 16.2 Секреты в ошибках

Создай несколько validation и network ошибок.

**Что должно произойти:** UI не показывает stack trace, полный provider URL, JWT, Authorization header, database password или filesystem path.

Результат: `[ ] PASS  [ ] FAIL`

### 16.3 Browser storage

1. Открой DevTools → Application.
2. Проверь Local Storage и Session Storage.

**Что должно произойти:** там нет libSQL JWT, OAuth Client Secret, refresh token или database password. Temporary application access state может быть project-scoped, но server secrets отсутствуют.

Результат: `[ ] PASS  [ ] FAIL`

### 16.4 Tenant route

В адресе замени `/project/local/` на `/project/other/`.

**Что должно произойти:** приложение возвращает в local project или показывает безопасный not-found. Данные другого tenant не появляются.

Результат: `[ ] PASS  [ ] FAIL`

### 16.5 Direct MCP без token

Открой или вызови `/mcp` без Authorization header.

**Что должно произойти:** `401 Unauthorized`. Endpoint не выполняет tool и не раскрывает schema.

Результат: `[ ] PASS  [ ] FAIL  [ ] BLOCKED`

## 17. Финальная сводка тестирования

Заполни после прохождения:

```markdown
# Итог ручного тестирования Mekka

- Дата:
- Тестировщик:
- URL окружения:
- Commit/version:
- Браузеры:
- Desktop: PASS / FAIL / BLOCKED
- Mobile: PASS / FAIL / BLOCKED
- Table Editor: PASS / FAIL / BLOCKED
- Rows: PASS / FAIL / BLOCKED
- SQL Editor: PASS / FAIL / BLOCKED
- Authentication: PASS / FAIL / BLOCKED
- Auth administration: PASS / FAIL / BLOCKED
- Agent Access / MCP: PASS / FAIL / BLOCKED
- Restart persistence: PASS / FAIL / BLOCKED
- Security sanity checks: PASS / FAIL / BLOCKED
- Всего найдено багов:
- Blocker-багов:
- Critical/high security findings:
- Можно ли отдавать следующему тестировщику: YES / NO

## Что понравилось


## Что было непонятно


## Самые важные проблемы


```

## 18. Форма баг-репорта

Создавай отдельный отчет для каждой проблемы. Не объединяй несколько разных багов в один.

```markdown
# Bug: короткое понятное название

## Классификация

- Severity: Blocker / Critical / High / Medium / Low
- Тип: Functional / UI / Data loss / Security / Performance / Accessibility / Compatibility
- Повторяемость: Always / Often / Sometimes / Once
- Найдено: дата и время с timezone

## Окружение

- URL:
- Commit/version:
- OS:
- Browser и версия:
- Размер экрана:
- Desktop или mobile:
- Страница/route:
- libSQL был доступен: YES / NO / UNKNOWN

## Предусловия

Что уже было создано или настроено до начала проверки.

## Шаги воспроизведения

1.
2.
3.

## Ожидаемый результат

Что должно было произойти.

## Фактический результат

Что произошло на самом деле. Перепиши текст ошибки дословно, но удали секреты.

## Влияние

Что пользователь не может сделать. Есть ли потеря, повреждение или раскрытие данных.

## После reload

Что происходит после обычного обновления страницы.

## После повторного входа

Меняется ли результат после нового входа.

## Correlation ID

Скопируй correlation ID из UI или response headers, если он отображается.

## Network

- HTTP method:
- Path без query secrets:
- Status code:
- Response code/message без токенов:
- Request duration:

## Console

Вставь только относящиеся к багу сообщения. Удали токены, cookies, passwords и Authorization headers.

## Материалы

- Скриншот:
- Видео:
- HAR-файл приложен: YES / NO
- HAR очищен от cookies и Authorization: YES / NO

## Дополнительные наблюдения


```

## 19. Как выбрать Severity

| Severity | Когда использовать |
| --- | --- |
| `Blocker` | Studio не запускается, невозможно войти или основной сценарий полностью недоступен |
| `Critical` | Потеря данных, доступ к чужим данным, утечка токена/пароля, обход authentication или authorization |
| `High` | Не работает основной create/read/update flow, данные могут примениться дважды, backup/restore дает неверный результат |
| `Medium` | Одна функция сломана, но есть понятный обходной путь |
| `Low` | Текст, отступ, редкий визуальный дефект, не мешающий работе |

Security-проблему не проверяй агрессивно на production. Зафиксируй наблюдение, прекрати действия и передай отчет напрямую разработчику.

## 20. Когда тестирование считается завершенным

Ручной проход завершен, если:

- проверены все доступные пункты меню;
- пройдены Table Editor, rows и SQL Editor;
- проверены registration, verification, sign-in и Users;
- проверены Providers, URLs и Email Templates;
- read-only Agent Access подключен к реальному MCP-клиенту;
- ожидаемые `unsupported` сценарии возвращают понятную ошибку;
- выполнена desktop и mobile проверка;
- выполнена хотя бы одна restart persistence проверка;
- для каждого `FAIL` создан отдельный баг-репорт;
- итоговая сводка отправлена разработчику.
