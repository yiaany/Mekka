# Коммерческий lightweight BaaS: стратегия продукта, архитектура и план запуска

> Рабочее описание проекта для YC, команды и первых design partners.
>
> Статус исследования: 2 августа 2026 года.
>
> `Litebase` нельзя считать финальным названием: оно уже используется существующим SQLite-проектом. До публичного запуска нужны отдельный нейминг, проверка доменов и товарных знаков.

## 1. Резюме

Мы строим коммерческую backend-as-a-service платформу класса Supabase для приложений, которые создаются людьми и AI-агентами.

Каждый проект получает легковесную SQL-базу, REST API, Auth, Storage, Realtime, Functions, политики доступа, backups, observability, preview-ветки, web Studio, SDK и MCP. Разработчик создает backend одной кнопкой в облаке или одной командой локально; AI-агент получает те же возможности через безопасные MCP-tools.

Прямое продуктовое обещание:

> **Самый простой и экономичный полноценный backend для людей и AI: Supabase-подобный DX без постоянной стоимости отдельного PostgreSQL-инстанса на каждый маленький проект.**

Agent-safe runtime остается важнейшим дифференциатором, но не заменяет BaaS. Пользователь покупает законченный backend, а не отдельный инструмент миграций.

У продукта три равноправных способа начать работу:

1. **Connect Project**: разработчик одной кнопкой подключает существующий GitHub/Vercel/локальный проект к уже созданному backend. Платформа определяет framework, устанавливает SDK, создает безопасные environment variables, генерирует types, добавляет MCP-конфигурацию и показывает готовый pull request или patch до применения.
2. **Create Backend Manually**: разработчик сам создает backend через короткий Studio wizard, выбирает регион, Auth, Storage и шаблон схемы, после чего получает URL, keys и точные snippets. Все расширенные настройки доступны, но не обязательны.
3. **Build with AI**: AI-агент через MCP создает таблицы, Auth, Storage, policies, Functions и preview-ветки теми же domain operations, которые использует Studio.

Во всех трех путях результат одинаков: полноценный backend с Database, API, Auth, Storage, Realtime, Functions, Studio, observability и безопасным lifecycle изменений.

Первый коммерческий клин:

- разработчики, использующие Cursor, Claude Code, Windsurf и другие coding agents;
- агентные конструкторы и платформы, создающие много временных приложений;
- небольшие SaaS-команды, которым нужны preview environments без отдельного PostgreSQL-инстанса на каждую ветку;
- образовательные платформы, хакатоны и internal tools с большим количеством маленьких изолированных баз.

## 2. YC-позиционирование

### Одно предложение

**Мы создаем коммерческую Supabase-класса платформу на SQLite-compatible storage: backend одной кнопкой для разработчика, MCP для AI-агента и значительно более дешевая экономика большого числа небольших проектов.**

### Короткий питч

Supabase доказал спрос на единый продукт из database, Auth, Storage, Realtime, Functions и Studio, но его модель выделенного PostgreSQL compute создает минимальную стоимость и заметный idle footprint на каждый проект. Это особенно больно пользователям, создающим десятки прототипов, preview environments и agent-generated приложений. На 2 августа 2026 года Supabase ограничивает Free двумя активными проектами; его Micro compute имеет 1 GB RAM и стоит около $10 в месяц сверх структуры тарифа, тогда как Turso уже подтверждает экономику 100 баз на бесплатном плане. Это не означает, что любой SQLite workload дешевле или быстрее PostgreSQL, но означает, что database-per-project можно упаковать принципиально плотнее.

Мы превращаем эту экономику в полноценный BaaS: красивое Studio, знакомый клиентский API, Auth, Storage, Realtime, Functions, branching и managed operations. MCP является вторым полноценным интерфейсом продукта: все, что человек делает мышкой, агент может сделать структурированным tool call, но с capability scope, preview, approval и audit.

### Какую категорию мы создаем

Категория: **AI-native lightweight BaaS**.

Это полноценный BaaS со следующими обязательными свойствами:

- database, Auth, Storage, Realtime, Functions и Studio;
- one-click cloud provisioning и простой local development;
- REST API и SDK для обычного приложения;
- schema manifest как единый источник истины;
- MCP как равноправный интерфейс для агента;
- policy firewall между агентом и данными;
- database-per-branch/task как базовая единица изоляции;
- preview, validation, approval и rollback как обязательный lifecycle изменений;
- возможность перейти с pooled/serverless режима на dedicated topology без смены SDK.

### Почему сейчас

- Coding agents научились создавать значительную часть приложения, но операции с данными остаются высокорисковыми.
- MCP стал стандартным каналом подключения инструментов, поэтому платформе не нужно изобретать собственный протокол интеграции с каждым агентом.
- SQLite/libSQL делает экономически возможным большое число изолированных баз и веток, но конкретный cloud engine должен оставаться заменяемым.
- Пользователи уже понимают интерфейс Supabase-подобного SDK, поэтому можно снизить стоимость перехода.
- Конкуренты подтвердили спрос на MCP, branching и database-per-tenant, но эти возможности пока существуют как отдельные функции, а не единый безопасный workflow агента.

## 3. Проблема

### Проблема AI-разработки

AI-агент часто работает с неполным или устаревшим контекстом:

- не видит актуальную схему;
- придумывает несуществующие таблицы и поля;
- генерирует необратимые миграции;
- получает слишком широкие production-права;
- не понимает фактические policy и ownership rules;
- выполняет SQL без плана отката;
- не оставляет понятный человеку журнал причин и последствий.

MCP решает доставку контекста и вызов инструментов, но не решает безопасность по умолчанию. Если MCP-сервер предоставляет `execute_sql` с административным токеном, он превращает удобство в новый привилегированный attack surface.

### Проблема разработчика

Для маленького приложения традиционный backend часто означает:

- базу данных;
- auth;
- REST или GraphQL API;
- миграции;
- объектное хранилище;
- роли и политики;
- dashboard;
- preview environments;
- monitoring и backups.

Каждый компонент требует настройки и создает отдельную точку отказа. Для прототипов и множества небольших tenant-проектов стоимость эксплуатации непропорциональна полезной нагрузке.

### Проблема платформ и агентных конструкторов

Платформе, создающей сотни или тысячи приложений, нужны:

- сильная изоляция данных между приложениями;
- дешевые базы с near-zero idle cost;
- программное создание и удаление проектов;
- лимиты и metering на уровне проекта;
- короткоживущие preview-базы;
- единая политика безопасности для агентов;
- понятная модель восстановления после ошибочного действия.

Именно этот B2B2D-сценарий может стать самым крупным контрактным сегментом.

## 4. Что мы не обещаем

Критично убрать из презентации недоказанные или неверные тезисы.

### Не обещаем 100% drop-in replacement Supabase

Supabase SDK опирается не только на простые REST-фильтры. Совместимость затрагивает PostgREST semantics, resource embedding, count, ranges, upsert, RPC, auth lifecycle, Realtime, Storage, Edge Functions и PostgreSQL-specific поведение.

Правильное обещание:

> **Проверяемая совместимость с определенным подмножеством `supabase-js`, опубликованная в виде versioned compatibility matrix и contract test suite.**

Цель первого релиза: наиболее частые операции `from(...).select/insert/update/delete/upsert` и базовый auth adapter. Не поддерживаемый запрос обязан вернуть явную ошибку, а не тихо изменить семантику.

### Не форкаем GoTrue под SQLite

GoTrue тесно связан с PostgreSQL и всей auth-моделью Supabase. Перенос persistence layer на SQLite создает большой постоянный fork, усложняет обновления безопасности и не дает продуктового преимущества.

Решение:

- использовать Better Auth как MIT-licensed auth foundation;
- написать свой тонкий service layer и собственную схему данных;
- сначала выпустить нативный auth API и SDK;
- затем добавить ограниченный `/auth/v1` compatibility adapter для подтвержденных сценариев `supabase-js`;
- хранить signing keys и OAuth secrets только в control plane secret store.

### Форкаем Supabase Studio, но не копируем бренд

Репозиторий Supabase распространяется по Apache-2.0, поэтому Studio можно использовать и модифицировать в коммерческом продукте при выполнении требований лицензии. Это ускоряет выход на знакомый и функциональный интерфейс. Лицензия не дает права называться Supabase, использовать их логотипы, домены или создавать впечатление аффилированности.

Стратегия Studio:

- создать pinned fork `apps/studio` с сохраненными LICENSE/NOTICE и историей attribution;
- сразу удалить Supabase branding, analytics, hosted URLs и cloud-specific integrations;
- заменить API access на собственный typed `Studio Backend API`, не вызывать data plane напрямую из UI;
- сохранить знакомую информационную архитектуру: Table Editor, SQL Editor, Auth, Storage, API, Logs, Settings;
- добавить собственные экраны Branches, MCP, Agent Sessions, Migration Review, Usage и Billing;
- скрыть все неподдерживаемые PostgreSQL-функции вместо создания неработающих кнопок;
- вести upstream merge queue только для security, accessibility и полезных generic UI changes;
- постепенно переписывать наиболее связанные с Supabase экраны, чтобы fork не стал вечной блокировкой.

Приоритет адаптации:

1. Projects, organizations, API keys и onboarding.
2. Table Editor и SQL Editor.
3. Auth users/providers/templates.
4. Storage buckets/files/policies.
5. Logs, metrics и usage.
6. Realtime inspector и Functions.
7. Branches, MCP и agent-safe workflows.

Studio является ключевым каналом для людей. MCP является программным отражением тех же domain operations для агентов. Оба интерфейса вызывают один control/data API и сохраняют одинаковую semantics, но MCP намеренно получает более узкие capabilities и дополнительные approval policies.

### Что именно берем у Supabase

Да: базой web-продукта становится не новый dashboard «по мотивам», а полноценный private fork Supabase Studio. Мы сохраняем зрелые UI-компоненты и пользовательские сценарии управления таблицами, строками, SQL, пользователями, файлами, logs и settings, затем подключаем их к нашей платформе через adapter layer.

Цель: пользователь Supabase должен узнавать структуру интерфейса и сразу понимать, где создать таблицу, добавить колонку, изменить строку, настроить Auth или открыть Storage. При этом branding, цвета, название, тексты, cloud navigation, pricing и уникальные agent/MCP surfaces принадлежат нашему продукту.

Supabase состоит не из одного репозитория и не из одного универсального backend. Studio управляет PostgreSQL через набор отдельных сервисов. Поэтому переиспользование делится на три уровня:

| Компонент Supabase | Сколько берем | Что сохраняем | Что заменяем |
|---|---:|---|---|
| `supabase/supabase/apps/studio` | почти целиком | layout, Table Editor, row grid, SQL Editor, Auth/Storage UI, forms, navigation, generic components | branding, Supabase Cloud API, PostgreSQL-only screens, billing, project model и backend clients |
| `supabase/postgres-meta` | частично | REST contract, TypeScript types, request schemas, generic validation, тестовые идеи | PostgreSQL catalog queries и DDL compiler заменяются собственным `sqlite-meta` |
| `supabase/storage` | частичный fork или reference | HTTP/S3/TUS contracts, object-store abstractions, upload flows | PostgreSQL metadata repository и PostgreSQL RLS заменяются SQLite metadata + нашим policy engine |
| `supabase/realtime` | выборочно | WebSocket protocol compatibility, Broadcast/Presence semantics, client contract | Postgres logical replication заменяется transactional outbox/changefeed adapter для SQLite-compatible engine |
| `supabase/edge-runtime` | возможен почти целиком | изоляция JavaScript/TypeScript functions, main/user runtime model | deployment control plane, quotas, secrets, routing и billing |
| `supabase/supabase-js` | как compatibility target | знакомый public client API и contract tests | backend endpoints реализует наша платформа |
| GoTrue/Supabase Auth | только API/reference | endpoint semantics, email/OAuth user journeys, compatibility fixtures | сервер и persistence: Better Auth + собственный adapter, потому что GoTrue поддерживает только PostgreSQL |
| PostgREST | только specification/reference | URL query dialect, headers, response/error semantics | весь query parser/compiler для SQLite пишется самостоятельно |

### Studio Adapter Layer

Нельзя в каждом React-компоненте заменять отдельный Supabase fetch на новый endpoint. Между Studio и backend вводится стабильный слой:

```text
Supabase Studio fork
        |
        v
Studio Domain SDK
        |
        v
Studio Backend API
        |
        +--> sqlite-meta
        +--> auth-admin
        +--> storage-admin
        +--> realtime-admin
        +--> functions-admin
        +--> branches/migrations
        +--> billing/usage/MCP
```

`Studio Domain SDK` предоставляет операции уровня продукта:

- `listTables`, `createTable`, `updateColumn`, `deleteRows`;
- `runSql`, `explainQuery`, `getSchemaDiff`;
- `listAuthUsers`, `configureAuthProvider`;
- `createBucket`, `uploadObject`, `updateStoragePolicy`;
- `configureRealtime`, `deployFunction`;
- `createBranch`, `reviewMigration`, `configureMcp`.

Благодаря этому:

- Table Editor можно сохранить почти без визуальной переписки;
- один adapter используется Studio, CLI и MCP;
- PostgreSQL-specific assumptions локализованы;
- обновления upstream Studio можно переносить контролируемыми batches;
- UI не получает прямые database credentials;
- backend можно менять без второго полного переписывания dashboard.

### `sqlite-meta`: замена `postgres-meta`

Для работы кнопок создания и редактирования таблиц нужен собственный management backend. Он повторяет полезную часть API `postgres-meta`, но выполняет SQLite/libSQL operations.

MVP endpoints:

- schemas/namespaces;
- tables;
- columns;
- primary/foreign keys;
- indexes и unique constraints;
- rows CRUD и pagination;
- SQL query/format/history;
- migrations и schema diff;
- database size, health и connection metadata.

Каждая операция Table Editor компилируется в versioned migration artifact. Даже если человек нажал `Add column`, Studio не отправляет произвольный SQL напрямую: `sqlite-meta` валидирует изменение, показывает generated DDL, делает checkpoint и применяет его транзакционно там, где SQLite это позволяет.

PostgreSQL-only элементы Studio должны быть скрыты или заменены:

- extensions;
- roles как PostgreSQL database roles;
- publications и logical replication slots;
- PostgreSQL functions/triggers без поддержанного аналога;
- schemas/search path, если выбранный engine не поддерживает их семантику;
- `EXPLAIN` и index advisors, завязанные на PostgreSQL planner;
- native RLS editor заменяется нашим policy editor.

Это дает именно желаемый результат: мы не тратим год на рисование Table Editor, но и не притворяемся, что PostgreSQL-management backend автоматически заработает на SQLite.

### Не обещаем автоматический merge произвольных данных

Создать копию базы значительно проще, чем корректно объединить две независимо изменившиеся базы. В MVP:

- ветка создается из snapshot/restore point;
- schema changes представлены миграциями;
- merge означает replay проверенных schema migrations в target;
- тестовые данные ветки по умолчанию не переносятся;
- перенос production data выполняется отдельной явной migration/job;
- конфликтующие DDL и destructive operations требуют ручного подтверждения.

### Не обещаем конкретный RPS или RAM без бенчмарка

Фразы «десятки тысяч запросов на $5» и «10-20 MB RAM» нельзя использовать как продуктовые гарантии. Производительность зависит от запроса, индексов, durability, сети, размера ответа, шифрования и write contention.

Вместо этого публикуем воспроизводимый benchmark harness и SLO по конкретным профилям нагрузки.

## 5. Продукт

### Основные сущности

- **Organization**: команда, billing и общие политики.
- **Project**: логическое приложение со стабильным API endpoint.
- **Environment**: production, staging или preview.
- **Branch**: изолированная база, созданная из конкретной версии родителя.
- **Schema manifest**: каноническое описание таблиц, связей, индексов и политик.
- **Migration**: versioned изменение схемы с forward plan, validation и metadata.
- **Capability**: минимальный набор разрешений для человека, приложения или агента.
- **Agent session**: ограниченная по времени сессия с целью, веткой и журналом.
- **Policy**: правило доступа, исполняемое gateway до SQL.
- **Audit event**: неизменяемая запись о действии и результате.

### Продуктовые поверхности

#### Три входа в один продукт

Простота не является отдельным позиционированием. Это обязательное качество всего BaaS. Пользователь не должен выбирать между «простым урезанным режимом» и «настоящим backend»: Connect Project, ручной Studio и MCP управляют одной моделью ресурсов и приводят к одному production-ready результату.

| Вход | Пользователь | Что происходит |
|---|---|---|
| Connect Project | существующее приложение | автоматическое подключение репозитория, SDK, env, types и MCP |
| Manual Studio | разработчик, желающий контроль | понятная пошаговая настройка каждого BaaS-модуля |
| MCP | coding agent | структурированные операции над теми же проектами с capabilities и audit |

Ни один путь не блокирует другой. Проект, подключенный автоматически, сразу полностью редактируется вручную. Проект, созданный вручную, сразу доступен AI через MCP. Изменение агента всегда видно в Studio.

#### Connect Project: подключение одной кнопкой

Это главная activation feature, но не вся ценность продукта.

Поддерживаемый сценарий:

1. Пользователь нажимает `Connect Project`.
2. Подключает GitHub repository, выбирает локальную папку через CLI или выбирает deployment в Vercel/другой интеграции.
3. Scanner определяет framework, package manager, существующий data client, `.env.example`, routes и deployment target.
4. Пользователь выбирает существующий backend project или создает новый.
5. Платформа показывает plan изменений: packages, files, environment variables, migrations и MCP config.
6. После подтверждения создается pull request, безопасный patch или CLI transaction; платформа не переписывает код молча.
7. Интеграция запускает install/build/typecheck и smoke test соединения.
8. Studio показывает статус `Connected`, framework, environments, последнюю проверку и кнопку rollback generated changes.

Автоматизация по возможности выполняет:

- установку нативного SDK или compatibility adapter;
- создание typed client module;
- настройку public URL и publishable key;
- запись server-only secret только в secret store deployment provider;
- генерацию TypeScript types из schema manifest;
- создание `.mcp.json` или provider-specific MCP config без помещения production secrets в repository;
- добавление starter migration и policy template, если проект пустой;
- обновление deployment environment variables;
- проверку CORS, redirect URLs и callback routes;
- health check реального чтения/записи в test environment;
- создание preview environment для pull request.

Безопасные правила:

- никаких скрытых commit/push;
- перед изменением показывается diff;
- существующие `.env`, auth и database integrations не перезаписываются без решения пользователя;
- secrets никогда не попадают в git diff, MCP resources или клиентский bundle;
- повторный Connect Project идемпотентен;
- generated changes имеют manifest и могут быть удалены/обновлены;
- при неоднозначности wizard задает один конкретный вопрос, а не падает с generic error.

Целевые activation SLO после подтверждения бенчмарками:

- новый поддерживаемый проект подключен за медиану менее двух минут;
- не более трех решений пользователя для стандартного Next.js/Vite-сценария;
- первая успешная database operation без чтения отдельного installation guide;
- 90% поддерживаемых starter templates проходят automated smoke test.

#### Ручная настройка

Ручной режим не является запасным или усложненным продуктом. Он должен быть понятным даже начинающему разработчику и одновременно давать полный контроль опытному.

Quick Setup спрашивает только:

- название проекта;
- регион;
- framework или `Other`;
- нужные модули: Auth, Storage, Realtime, Functions;
- стартовый шаблон: Empty, SaaS, Marketplace, Chat, Mobile или Import.

Остальное получает безопасные defaults. После создания показывается один экран `Connect your app` с install command, environment variables, client snippet и live connection test.

Advanced Mode позволяет вручную настроить:

- engine/placement class и limits;
- schema, indexes, migrations и seed;
- auth providers, URLs, email templates, sessions и MFA;
- Storage buckets, MIME/size limits и policies;
- Realtime channels и replication scope;
- Function secrets, network policy, timeout, cron и concurrency;
- CORS, domains, rate limits, backups, retention и observability;
- MCP capabilities, allowed tools, branch policy и approvals.

Quick Setup и Advanced Mode используют одинаковую конфигурационную модель. Пользователь может начать с defaults, затем открыть любое автоматически принятое решение и изменить его без пересоздания проекта.

#### Настройка через MCP

AI получает не отдельную упрощенную систему, а безопасный программный доступ к тому же BaaS:

- `create_project` и `inspect_project`;
- `connect_repository` и `generate_integration_plan`;
- `create_table`, `alter_schema` и `generate_types`;
- `configure_auth_provider`;
- `create_bucket` и `set_storage_policy`;
- `configure_realtime`;
- `deploy_function` и `set_function_secret_reference`;
- `create_preview_branch`, `validate_changes` и `request_promotion`.

Агент сначала формирует plan/diff, затем выполняет разрешенные операции. Создание production secret, destructive migration и production promotion требуют step-up capability или подтверждения в Studio. Так MCP дает максимальную скорость без превращения AI в безлимитного администратора.

#### Полный BaaS contract

Чтобы продукт честно назывался альтернативой Supabase, целевой General Availability включает:

- **Database**: SQL, migrations, indexes, relations, backups, restore и branches;
- **Data API**: REST, generated OpenAPI, native SDK и совместимый subset `supabase-js`;
- **Auth**: password, magic link/OTP, OAuth, sessions, JWT/JWKS, MFA и admin API;
- **Storage**: buckets, multipart upload, signed URLs, policies, transformations через внешний image worker;
- **Realtime**: database changes, broadcast и presence;
- **Functions**: deploy TypeScript handlers, secrets, logs, cron и webhooks;
- **Studio**: визуальное управление всеми перечисленными модулями;
- **MCP**: безопасное управление теми же ресурсами агентом;
- **Operations**: metrics, logs, quotas, billing, backups, regions и support.

Не все модули обязаны появиться в первой beta, но их API boundaries и место в архитектуре проектируются заранее. Публичный маркетинг должен различать `Beta subset` и `GA BaaS contract`.

#### Local runtime

Одна команда поднимает:

- API gateway;
- auth;
- локальную libSQL/SQLite-базу;
- schema inspector;
- MCP endpoint;
- минимальный dashboard;
- generated types и SDK config.

Цель: первый запрос менее чем через 60 секунд после установки на поддерживаемой машине.

#### Managed cloud

Облако предоставляет:

- создание проектов и веток;
- routing и TLS;
- backups и restore;
- metering и квоты;
- secret management;
- deployment history;
- team access;
- audit retention;
- managed upgrades.

Основной коммерческий продукт является hosted cloud. Self-hosted edition нужна для trust, local development и enterprise deployment, но не должна диктовать минимальный набор cloud-функций.

#### SDK

Нужны два режима:

- нативный SDK, полностью отражающий возможности продукта;
- Supabase-compatible subset для простой миграции существующих приложений.

Нативный SDK является долгосрочным интерфейсом. Совместимый слой является стратегическим каналом привлечения: пользователь должен переносить простые Supabase-проекты заменой URL/key и только затем встречать четкую compatibility matrix для сложных возможностей.

#### MCP server

MCP не должен быть универсальной SQL-консолью с production admin token.

Resources:

- `schema://current`;
- `schema://branch/{id}`;
- `policies://current`;
- `migrations://history`;
- `logs://recent` с redaction;
- `capabilities://session`.

Read-only tools:

- `inspect_schema`;
- `explain_query`;
- `list_migrations`;
- `get_policy_summary`;
- `validate_migration`;
- `compare_branches`.

Mutating tools:

- `create_preview_branch`;
- `propose_migration`;
- `apply_migration_to_preview`;
- `run_seed_in_preview`;
- `request_promotion`;
- `rollback_preview`.

Production-mutating tools выключены по умолчанию. Их включение требует отдельной capability, короткого TTL и approval policy.

### Killer feature: Agent Change Protocol

Главной функцией должен быть не чат и не генерация SQL, а детерминированный протокол изменения backend:

1. Агент получает schema manifest и capability scope.
2. Агент формирует структурированный migration proposal.
3. Runtime статически анализирует proposal.
4. Создается preview branch.
5. Миграция применяется к preview.
6. Запускаются schema checks, policy checks и пользовательские тесты.
7. Runtime строит diff и risk score.
8. Человек или organization policy подтверждает promotion.
9. Runtime проверяет, что `parent_checkpoint`, `schema_hash` и `policy_hash` target не изменились, создает backup checkpoint и идемпотентно применяет migration.
10. Результат и actor записываются в audit log.

Это и есть защищаемый workflow, которого нет в простом MCP-to-SQL сервере.

## 6. Архитектура

### Принцип разделения

Система делится на control plane и data plane.

#### Control plane

Отвечает за:

- организации и пользователей;
- каталог проектов и routing metadata;
- OAuth configuration и secrets;
- billing и metering;
- orchestration веток и backups;
- deployment state;
- глобальный audit index;
- policy templates;
- выдачу короткоживущих capability tokens.

Control plane может использовать PostgreSQL как внутреннюю системную базу, если это упростит надежность и транзакции. Продуктовая ценность не требует догматично использовать SQLite для каждого внутреннего компонента.

Нормативная идентичность любого ресурса задается tuple:

```text
organization_id / project_id / environment_id / branch_id / generation
```

`generation` меняется при удалении и повторном создании логического ресурса, поэтому старые токены и cache entries нельзя применить к новому объекту с тем же пользовательским именем. Provisioning каталога, credentials и routing state выполняется одной идемпотентной state machine. При недоступном или противоречивом каталоге router выбирает deny, а не fallback к последнему предположению.

#### Data plane

Отвечает за запросы приложения:

- REST/SDK API;
- auth endpoints проекта;
- policy enforcement;
- query compilation;
- выполнение запросов в libSQL;
- project-local schema cache;
- realtime/change events в будущих версиях;
- tenant-level metrics.

Разделение позволяет независимо масштабировать metadata workloads и пользовательские запросы.

### Размещение и владение базой

Для обычного SQLite/libSQL-файла действует single-writer ownership:

- только один data-plane owner одновременно имеет write lease на конкретный `branch_id + generation`;
- lease содержит fencing token, монотонно увеличивающийся при failover;
- старый owner после потери lease не может подтвердить запись или опубликовать audit success;
- read replicas получают только явно поддерживаемый механизм репликации/snapshot, а не общий файл на произвольной network filesystem;
- router направляет writes к текущему owner и проверяет generation;
- failover включает revoke, drain, integrity verification и только затем выдачу нового lease;
- shared NFS/SMB volume запрещен без отдельного доказательства корректной locking semantics;
- placement, lease и backup metadata регулярно reconciled с фактическим состоянием.

Если выбран managed Turso, эквивалентные гарантии должны быть подтверждены API, документацией, договором и failure tests, а не предполагаться.

### Поток запроса

```text
Client / SDK / MCP
        |
        v
TLS + Router + Rate Limits
        |
        v
Authentication + Capability Verification
        |
        v
REST Parser -> Typed AST -> Policy Rewriter -> SQL Compiler
        |                                      |
        |                                      v
        |                               Prepared Statement
        |                                      |
        v                                      v
Schema Cache ------------------------------> libSQL
                                               |
                                               v
                         JSON Encoder + Audit + Metrics
```

### Почему нужен AST, а не конкатенация SQL

Gateway обязан разбирать запрос в типизированное промежуточное представление:

```ts
type QueryAst = {
  operation: "select" | "insert" | "update" | "delete" | "upsert"
  table: SchemaTableRef
  columns: SelectNode[]
  filters: FilterNode[]
  order: OrderNode[]
  pagination?: PaginationNode
  returning?: ReturningMode
}
```

Правила:

- значения всегда передаются параметрами;
- identifiers разрешаются только через schema cache;
- неизвестные столбцы и операторы отклоняются до SQL;
- policy conditions добавляются в AST, а не строкой после компиляции;
- сложность запроса ограничивается depth, node count и result size;
- каждый endpoint имеет statement timeout и quota budget;
- unsupported semantics возвращает стабильный error code.

### Первый уровень совместимости PostgREST

Поддержать в MVP:

- `GET /rest/v1/{table}`;
- `POST /rest/v1/{table}`;
- `PATCH /rest/v1/{table}`;
- `DELETE /rest/v1/{table}`;
- `HEAD` для поддерживаемых count-сценариев;
- `select` простых колонок;
- `eq`, `neq`, `gt`, `gte`, `lt`, `lte`;
- `like`, `ilike` с явно задокументированной SQLite-семантикой;
- `in`, `is`, `not` для ограниченного набора выражений;
- `and`, `or` с ограничением глубины;
- `order`, `limit`, `offset` и HTTP Range;
- insert одного объекта и массива объектов;
- update/delete с обязательным filter guard;
- update/delete без доказуемо ограниченного предиката требуют отдельной `bulk_mutation` capability и affected-row preflight;
- upsert по явно указанному unique key;
- `Prefer: return=representation|minimal`;
- exact count для разрешенных запросов.

Отложить:

- произвольный RPC;
- PostgreSQL functions и casts;
- full-text search parity;
- массивы и range types PostgreSQL;
- deeply nested resource embedding;
- arbitrary views с security semantics;
- Realtime protocol parity;
- Storage и Edge Functions parity.

### Resource embedding

Это наиболее сложная часть совместимости. Реализовывать поэтапно:

1. Только одна явная foreign key relationship.
2. Один уровень вложенности.
3. Отдельные SQL-запросы с batching и deterministic assembly в gateway внутри одного read snapshot/transaction.
4. Затем оптимизация через SQLite JSON functions там, где семантика доказана тестами.
5. Ограничение fan-out, depth и общего количества строк.

Не следует пытаться механически копировать SQL, генерируемый PostgREST для PostgreSQL.

### Schema manifest

Runtime строит manifest из SQLite metadata:

- `PRAGMA table_list`;
- `PRAGMA table_xinfo`;
- `PRAGMA foreign_key_list`;
- `PRAGMA index_list` и `index_xinfo`;
- migration metadata;
- policy metadata из системных таблиц runtime.

Manifest versioned, имеет hash и используется одновременно:

- SDK type generation;
- MCP resources;
- dashboard;
- migration diff;
- query validation;
- compatibility tests.

### Auth

Auth foundation: Better Auth, но доменная модель остается нашей.

Auth metadata не хранится в пользовательском branch snapshot. Для каждого проекта существует отдельное auth-хранилище с таблицами Better Auth `user`, `session`, `account`, `verification` и нашими project bindings. Production sessions, password hashes, OAuth accounts и one-time tokens никогда автоматически не копируются в preview.

Preview environment получает отдельный issuer/audience и один из режимов:

- пустое auth-хранилище;
- synthetic test users без production credentials;
- явно разрешенный anonymized identity fixture.

Better Auth используется через поддерживаемый SQLite adapter и максимально стандартную core schema. Любое изменение adapter/schema покрывается upstream adapter tests; нельзя одновременно обещать автоматические security updates Better Auth и бесконтрольно менять его persistence contract.

MVP:

- email/password;
- email verification;
- password reset;
- GitHub и Google OAuth;
- session management;
- JWT/JWKS для data plane;
- service keys;
- organization membership в control plane;
- audit событий входа и смены credential.

Security requirements:

- asymmetric signing keys;
- `kid` и JWKS rotation;
- overlap старого и нового JWKS на период жизни выпущенных токенов;
- короткий access token и rotating refresh token;
- refresh-token reuse detection;
- немедленная revocation сессий при удалении/блокировке пользователя;
- OAuth state и PKCE;
- точный redirect allowlist и защита custom-domain ownership;
- hashed one-time tokens;
- постоянное по времени сообщение для защиты от email enumeration;
- versioned password-hash parameters и rehash-on-login;
- rate limits по IP, identity и project;
- secret redaction в логах;
- запрет хранения production secrets в project database;
- documented signing-key compromise procedure;
- допустимый clock skew и token validation matrix;
- documented account recovery path.

Совместимость `/auth/v1` реализуется только после contract tests с конкретными версиями `supabase-js`.

### Политики вместо нативного PostgreSQL RLS

SQLite не предоставляет эквивалент PostgreSQL RLS. Поэтому политики исполняются gateway.

Пример декларативной политики:

```yaml
table: documents
actions:
  select:
    any:
      - auth.role == "admin"
      - row.owner_id == auth.user_id
  update:
    all:
      - row.owner_id == auth.user_id
      - input.owner_id == row.owner_id
```

Компилятор преобразует policy в AST predicates и field constraints.

Обязательные ограничения модели:

- клиент приложения никогда не получает прямые credentials к libSQL;
- публичный доступ идет только через gateway;
- административный direct SQL считается обходом policy и доступен только trusted backend;
- policy применяется к `SELECT`, affected-row selection в `UPDATE/DELETE` и `WITH CHECK`-эквиваленту для новых значений;
- политика versioned и входит в migration review;
- deny by default;
- policy simulator показывает результат для конкретного actor и row fixture.

Untrusted application schemas по умолчанию не могут создавать или изменять:

- triggers и views с побочными эффектами;
- virtual tables и loadable extensions;
- user-defined functions;
- `ATTACH DATABASE`;
- опасные `PRAGMA`;
- произвольные generated expressions;
- cascading actions, не прошедшие transitive write analysis.

Разрешение таких конструкций требует отдельного schema capability, статического анализа полного migration artifact и security review. Иначе trigger или cascade может выполнить запись, которую исходный AST policy не контролировал.

### Prompt-to-policy

LLM не должен напрямую устанавливать security policy.

Безопасный поток:

1. Пользователь описывает правило естественным языком.
2. Модель генерирует декларативный policy draft.
3. Детерминированный валидатор проверяет типы, поля и запрещенные конструкции.
4. Система генерирует positive и negative test cases.
5. Пользователь видит эквивалент правила и примеры разрешений.
6. Policy применяется к preview branch.
7. Только после тестов и approval policy продвигается в target.

### Storage engine strategy

На дату исследования `tursodatabase/libsql` остается открытым и активно поддерживаемым проектом, но новые функции команда Turso преимущественно разрабатывает в отдельном open-source движке Turso Database. Это два разных проекта: libSQL наследует single-writer ограничения SQLite, тогда как новый Rust-движок развивает concurrent writes и другие возможности. Поэтому конкретный engine все равно нельзя делать неразрывной частью продуктовой семантики.

Практическая стратегия:

- общий `StorageAdapter` и conformance suite отделяют продуктовую семантику от конкретного hosted engine;
- local mode использует обычный SQLite или pinned libSQL-compatible build;
- hosted beta может использовать Turso Cloud, если SLA, branching API и unit economics подтверждены договором и нагрузочными тестами;
- self-hosted community edition может использовать SQLite, libSQL или Turso Database после прохождения conformance suite; команда публикует support matrix;
- собственный fork движка не создавать до появления инженера уровня SQLite internals и коммерческой необходимости;
- экспорт в стандартный SQLite-файл является обязательной функцией отсутствия data lock-in;
- каждые шесть месяцев проводится engine review: безопасность, активность upstream, стоимость, portability и recoverability.

Архитектурная цель продукта не «работает только на libSQL», а «дает database-per-branch economics на SQLite-compatible engine». Это позволяет в будущем добавить другой backend, не переписывая API, policy model и Agent Change Protocol.

### Модель масштабирования

Фраза «весь BaaS работает на 1 GB RAM и выдерживает любое число пользователей» технически неверна. Правильное преимущество состоит не в магическом сервере, а в плотной упаковке множества маленьких баз и горизонтальном добавлении data-plane nodes.

Уровни размещения:

| Класс | Topology | Для чего |
|---|---|---|
| Dormant | только durable database object и metadata, без постоянно выделенного процесса | неактивные Free-проекты |
| Pooled | много project databases на одном data-plane node с memory/CPU/IO quotas | большинство Free/Default/Extended приложений |
| Warm isolated | закрепленный worker/process и предсказуемый cache budget | Pro приложения со стабильной нагрузкой |
| Dedicated | отдельный node/VM/cluster и повышенные limits | hot, write-heavy и Enterprise workloads |

Масштабирование происходит по двум независимым осям:

- **много проектов**: consistent placement, sharding каталога, pooled nodes, auto-suspend и перенос database ownership между nodes;
- **один популярный проект**: вертикальное увеличение resources, read replicas/cache, dedicated placement, partitioning отдельных workloads и при необходимости migration на engine/topology с более высокой write concurrency.

Обязательные механизмы:

- admission control и per-project token buckets;
- ограничения CPU time, memory, open connections, response bytes и concurrent writes;
- fair scheduling между tenant databases;
- hot-project detection и автоматическое предложение/выполнение migration в другой placement class;
- global edge router, но writes направляются к authoritative owner;
- CDN и signed URLs для Storage, чтобы бинарный трафик не проходил через database gateway;
- Realtime fan-out масштабируется отдельно от SQL workers;
- Functions исполняются отдельно от database nodes;
- backpressure вместо бесконтрольного накопления запросов;
- нагрузочные тесты noisy-neighbor и failover.

Product claim после бенчмарков должен звучать так: «платформа обслуживает большое число небольших проектов значительно плотнее dedicated-Postgres модели и переводит горячие проекты на отдельный compute». Конкретные RPS, latency и RAM публикуются только для фиксированного workload profile.

### Branching и восстановление

MVP semantics:

- branch имеет immutable parent checkpoint;
- создание ветки асинхронно, но API возвращает operation ID немедленно;
- ветка получает отдельные credentials и URL;
- schema migration history наследуется;
- preview secrets по умолчанию заменяются безопасными значениями;
- production PII не копируется в preview без явной data policy;
- TTL удаляет забытые ветки;
- promotion применяет migration artifact, а не подменяет production-файл базы;
- migration artifact подписан hash и связан с исходными `parent_checkpoint`, `schema_hash` и `policy_hash`;
- promotion использует compare-and-swap, idempotency key и монотонную state machine, поэтому retry не применит изменение дважды;
- если target изменился после preview validation, promotion отклоняется и требует rebase/revalidation;
- перед production migration создается restore point.

Это менее эффектно, чем обещание «merge базы в один клик», но значительно надежнее.

### Backup и SQLite invariants

Backup нельзя реализовывать копированием открытого файла. Для каждого engine фиксируются:

- поддерживаемый online backup/snapshot primitive;
- consistency boundary и обработка WAL/journal;
- `fsync`/durability profile;
- encryption key backup и recovery;
- `PRAGMA integrity_check` или эквивалент после restore;
- измеренные RPO/RTO;
- регулярные automated restore drills.

Каждое SQLite-соединение проходит обязательный bootstrap и conformance check:

- `PRAGMA foreign_keys = ON`;
- согласованные `journal_mode`, `synchronous` и `busy_timeout`;
- `STRICT` tables для runtime-managed schemas;
- pinned engine/version/compile-options matrix;
- запрет неизвестных extensions и опасных PRAGMA;
- лимиты transaction duration и busy retries.

### Realtime

Не включать полную Realtime-совместимость в первый MVP.

Порядок развития:

1. Server-Sent Events для project events и dashboard.
2. Transactional outbox в project database.
3. WebSocket subscriptions для table changes.
4. Presence и broadcast.
5. Только затем оценить совместимость с Supabase Realtime protocol.

Нужно заранее решить delivery semantics. Реалистичная первая гарантия: at-least-once delivery с event ID и client deduplication.

### Storage

Storage является обязательной частью публичного BaaS, но не требует собственного object-storage engine:

- metadata и access policy живут в runtime;
- бинарные объекты хранятся в S3-compatible storage;
- upload/download выполняются через signed URLs;
- локальная разработка использует filesystem adapter;
- managed cloud может использовать существующего object-storage provider.

Для public beta достаточно S3-compatible provider abstraction, resumable uploads, signed URLs и gateway policies. Не нужно писать собственное распределенное object storage.

### Functions

Functions нужны для webhook handlers, trusted backend logic, scheduled jobs и интеграций, но запуск произвольного пользовательского кода нельзя помещать внутрь gateway-процесса.

Архитектура:

- TypeScript function bundle собирается Bun;
- каждый deployment immutable и content-addressed;
- execution идет в отдельном sandbox worker pool;
- secrets выдаются только на время invocation;
- outbound network имеет plan-level policy;
- CPU, memory, duration, request/response size и concurrency жестко ограничены;
- logs и traces связаны с invocation ID;
- cron и webhook delivery используют durable queue;
- первый cloud release может опираться на managed isolate/container provider, пока собственный scheduler не дает экономического преимущества.

Совместимость Supabase Edge Functions не обещается автоматически: проверяются routing, headers, environment variables и client invocation contract.

## 7. Технологический стек

### Runtime и API

- **Bun**: runtime, package manager, test runner и сборка TypeScript-сервисов.
- **Elysia**: HTTP framework для data plane и внутренних сервисов.
- **TypeScript strict mode**: единые типы AST, schema manifest, policies и SDK.
- **SQLite / pinned libSQL-compatible build**: локальные project databases и self-hosted режим.
- **`@libsql/client`**: клиент доступа к local/remote libSQL.
- **Drizzle ORM/Kit**: только для control-plane persistence и собственных системных таблиц; не использовать как замену query compiler.
- **Better Auth**: auth foundation.
- **`jose`**: JWT/JWK primitives там, где они не закрыты Better Auth.

### Frontend

- **Next.js + React + TypeScript**: dashboard и documentation site.
- **Tailwind CSS**: styling.
- **shadcn/ui**: доступные исходники UI-компонентов без тяжелого vendor lock-in.
- **TanStack Query**: server state и cache в dashboard.
- **Monaco Editor**: SQL/policy editor, если размер bundle оправдан; иначе CodeMirror.

### Agent interface

- **Model Context Protocol TypeScript SDK** с versioned protocol compatibility matrix.
- Stateless HTTP transport для managed MCP по спецификации `2026-07-28`; временный legacy adapter только для явно поддерживаемых клиентов.
- stdio transport для локального CLI.
- OAuth 2.1 profile для remote MCP: Protected Resource Metadata, issuer discovery, exact redirect URI, PKCE, Resource Indicators, audience validation, step-up scopes и запрет token passthrough.

### Observability и инфраструктура

- **OpenTelemetry JS**: traces, metrics и logs correlation.
- S3-compatible object storage для backups и artifacts.
- Managed secret store/KMS для cloud secrets.
- OCI images для облачного data plane, даже если локальный DX не требует Docker.
- Infrastructure as code после стабилизации deployment topology.

### Monorepo

```text
apps/
  cloud-api/          # control plane API
  studio/             # private Supabase Studio fork and web console
  docs/               # documentation
  gateway/            # REST/auth data plane
  sqlite-meta/        # management API for tables, columns, indexes and SQL
  mcp/                # local and remote MCP server
  router/             # project routing, limits, token verification
packages/
  studio-domain-sdk/  # stable adapter between Studio and platform services
  query-ast/          # parser, AST, compiler
  schema-manifest/    # introspection and schema model
  policy-engine/      # policy DSL, compiler, simulator
  migration-engine/   # proposal, validation, promotion
  auth-core/          # project auth domain layer
  sdk-js/             # native TypeScript SDK
  supabase-compat/     # compatibility adapter and contract tests
  protocol/           # shared API schemas and error codes
  telemetry/          # tracing and metrics helpers
  testkit/             # fixtures, golden tests, benchmark harness
  cli/                 # init, dev, link, deploy, branch
```

## 8. Сторонний код и лицензии

Лицензии ниже должны повторно проверяться и фиксироваться в SBOM на дату каждого релиза. Нельзя полагаться только на описание GitHub.

| Проект | Роль | Лицензия по состоянию исследования | Решение |
|---|---|---:|---|
| `tursodatabase/libsql` | SQLite-compatible engine | MIT; активно поддерживается, новые features преимущественно развиваются в Turso Database | использовать за adapter boundary и учитывать single-writer model |
| `tursodatabase/turso` | новый SQLite-compatible Rust engine | MIT | оценить beta maturity и conformance, не делать обязательным для MVP |
| `tursodatabase/libsql-client-ts` / `@libsql/client` | TS-клиент | MIT | использовать напрямую |
| `oven-sh/bun` | runtime/toolchain | MIT для основного проекта; учитывать лицензии bundled components | использовать и вести third-party notices |
| `elysiajs/elysia` | HTTP framework | MIT | использовать напрямую |
| `better-auth/better-auth` | auth foundation | MIT | использовать через собственный service layer |
| `drizzle-team/drizzle-orm` | typed persistence/migrations | Apache-2.0 | использовать ограниченно |
| `modelcontextprotocol/typescript-sdk` | MCP | mixed transition: новые contributions Apache-2.0, существующий код MIT; проверять LICENSE pinned commit | использовать SDK/protocol для `2026-07-28`, сохранить compatibility matrix по клиентам |
| `supabase/supabase-js` | compatibility target и contract tests | MIT | не форкать как backend; тестировать публичное поведение клиента |
| `PostgREST/postgrest` | спецификация поведения и reference implementation | MIT | изучать и использовать для differential tests, не переносить PostgreSQL SQL |
| `supabase/supabase`, `apps/studio` | основа web Studio | Apache-2.0 в репозитории | использовать pinned private fork с LICENSE/NOTICE, полностью заменить branding и backend adapters |
| `supabase/postgres-meta` | reference/API contract для management backend | Apache-2.0 | переиспользовать generic types/schemas при возможности; PostgreSQL SQL заменить `sqlite-meta` |
| `supabase/storage` | Storage API/reference | Apache-2.0 | оценить частичный fork object layer; заменить PostgreSQL repository и RLS integration |
| `supabase/realtime` | Realtime protocol/reference | Apache-2.0 | переиспользовать protocol/semantics выборочно; SQLite change source написать отдельно |
| `supabase/edge-runtime` | Functions runtime candidate | MIT | провести security/performance spike и либо использовать, либо заменить managed sandbox provider |
| `shadcn-ui/ui` | UI components | MIT | использовать в собственном dashboard |
| `panva/jose` | JOSE/JWT/JWK | MIT | использовать при необходимости |
| `open-telemetry/opentelemetry-js` | observability | Apache-2.0 | использовать напрямую |

### Лицензионная стратегия собственного продукта

Проект является коммерческим. Нельзя называть restrictive-лицензию open source: корректный термин `source-available`.

Рекомендуемая модель:

- hosted control plane, billing, scheduler, abuse prevention, cloud orchestration и Studio fork: private proprietary repositories;
- self-hosted server/data plane: source-available по собственной лицензии либо BSL 1.1 с Additional Use Grant;
- запрет в self-hosted license: предлагать продукт третьим лицам как конкурентный managed BaaS, перепродавать multi-tenant service или обходить license keys/plan limits;
- разрешение: internal business use, development, testing, education и self-hosting собственных приложений в явно заданных пределах;
- enterprise получает отдельную commercial license для production self-hosting/BYOC;
- SDK, CLI protocol types и минимальный MCP connector можно оставить permissive MIT/Apache-2.0 ради adoption; серверная ценность от этого не раскрывается;
- формат экспорта данных и public API specification должны оставаться открытыми, чтобы отсутствие data lock-in повышало доверие.

Варианты лицензии:

| Модель | Плюсы | Минусы | Вердикт |
|---|---|---|---|
| BSL 1.1 | исходники видны, можно запретить competing service | код обязан перейти на Change License не позднее установленной даты, максимум через 4 года | подходит, если будущий переход в permissive-лицензию приемлем |
| Elastic License 2.0 | прямо запрещает предоставлять продукт как managed service | не является open source; меньше ecosystem adoption | подходит для server/data plane после юридической адаптации |
| Собственная source-available license | можно точно определить hosted-service и commercial restrictions | дороже юридически, риск неясных формулировок | лучший контроль, только через профильного юриста |
| Полностью proprietary | максимальная защита кода | слабее self-hosted distribution и community trust | использовать для control plane и Studio fork |

Рекомендуемая стартовая комбинация: proprietary cloud/control plane + private Studio fork + permissive SDK/CLI + source-available self-hosted runtime после появления реального спроса. Не публиковать весь server code только ради маркетингового ярлыка.

Важно: Apache-2.0 код Supabase Studio сохраняет свои Apache-права. Собственные файлы и модификации можно держать закрытыми в SaaS, но нельзя отнимать у получателя права на исходные Apache-компоненты при их распространении. Конкретную упаковку и NOTICE проверяет юрист до self-hosted release.

### Обязательные юридические меры

- не использовать названия, логотипы и визуальную идентичность Supabase/Turso;
- описывать совместимость как совместимость, а не аффилированность;
- сохранить copyright и NOTICE для Apache-компонентов;
- не пытаться перелицензировать исходные Apache-файлы так, будто сторонних прав не существует;
- генерировать SBOM для релизов;
- автоматизировать license allowlist в CI;
- запретить зависимости GPL/AGPL/SSPL без отдельного review;
- провести юридическую проверку API compatibility, Studio fork, source-available license и торговых марок до публичного маркетинга;
- получить DPA и security terms у cloud subprocessors.

## 9. Что писать самостоятельно

Именно эти компоненты являются интеллектуальной собственностью и moat продукта:

- `Studio Domain SDK` и адаптация полного Supabase Studio к нашей resource model;
- `sqlite-meta`, который обеспечивает Table Editor/SQL Editor поверх SQLite-compatible engines;
- PostgREST-compatible parser и typed AST;
- SQLite/libSQL SQL compiler;
- compatibility matrix и differential contract suite;
- schema manifest и schema diff;
- policy DSL, compiler и simulator;
- capability-scoped MCP authorization;
- Agent Change Protocol;
- branch lifecycle и promotion semantics;
- per-project metering и isolation;
- safe migration analyzer;
- local-to-cloud deployment workflow;
- audit model, redaction и human-readable change review.

Не являются moat:

- очередная форма логина;
- очередной table editor;
- обычная обертка над `@libsql/client`;
- чат с SQL;
- форк чужого dashboard;
- прокси к hosted Turso без собственного workflow и control plane.

## 10. Безопасность

### Threat model

Основные угрозы:

- prompt injection заставляет агента прочитать или изменить чужие данные;
- агент получает production credential через context или logs;
- SQL injection через REST filter/parser;
- обход policy через write operation или nested relation;
- confused deputy между organization, project и branch;
- утечка PII в preview branch;
- OAuth account linking attack;
- украденный refresh token;
- malicious migration создает trigger/view для обхода ограничений;
- resource exhaustion дорогим query;
- cross-tenant routing bug;
- supply-chain compromise npm dependency.

### Базовые контрмеры

- deny-by-default capabilities;
- отдельный audience и scope для каждого типа токена;
- branch-bound credentials;
- короткий TTL MCP sessions;
- prepared statements;
- schema allowlist для identifiers;
- AST complexity limits;
- запрет multi-statement SQL в публичном API;
- transaction, row и response limits;
- immutable audit events;
- PII redaction;
- encrypted backups и secret store;
- restore drills;
- dependency pinning, lockfile, SBOM и provenance;
- security.txt и vulnerability disclosure process;
- external penetration test перед general availability.

### Уровни MCP-доступа

| Уровень | Возможности | По умолчанию |
|---|---|---:|
| Observe | схема, explain, sanitized logs | да |
| Preview Write | создать ветку, миграция и seed только в preview | да для dev |
| Request Promotion | создать запрос на promotion | да |
| Production Write | применить подтвержденный migration artifact | нет |
| Direct SQL Admin | произвольный SQL | никогда для удаленного агента по умолчанию |

## 11. План разработки

### Этап 0: validation sprint, недели 1-2

Цель: проверить не абстрактный интерес к AI, а готовность перейти на более легкий BaaS.

Сделать только disposable prototypes:

- 20 интервью с solo developers и маленькими SaaS-командами, у которых больше двух backend-проектов;
- 10 разборов реальных Supabase-проектов: какие Auth, REST, Storage, Realtime и Functions вызовы используются;
- clickable Studio fork с onboarding, Table Editor и MCP screen;
- demo `Create project -> copy SDK snippet -> working CRUD`;
- demo `agent reads schema -> creates preview migration -> approval`;
- pricing landing page с Free, Default, Extended, Pro и Enterprise `Contact Sales`;
- получить минимум 5 design partners и 2 платных design contracts/LOI.

Этап 1 начинается только после validation gate. Код прототипов можно выбросить.

### Этап 1: closed alpha database product, недели 3-8

Deliverables:

- monorepo, CI и release process;
- hosted provisioning через один выбранный storage provider;
- schema introspection и manifest;
- REST parser, typed AST и SQLite compiler;
- CRUD, filters, pagination, upsert и generated OpenAPI;
- policy engine v1;
- deterministic migrations и backups;
- native TypeScript SDK;
- адаптированные Projects, Table Editor, SQL Editor и API screens Studio;
- MCP read-only schema/query tools;
- golden, fuzz, security и benchmark suites.

Exit criteria:

- demo-приложение работает без ручной инфраструктуры;
- tenant identity и routing isolation tests проходят;
- restore drill успешен;
- zero known critical injection/policy bypass;
- пять design partners используют alpha еженедельно.

### Этап 2: private beta полноценного ядра, месяцы 3-4

Deliverables:

- Better Auth: password, magic link/OTP, Google и GitHub;
- auth screens Studio;
- S3-compatible Storage, buckets, signed URLs и policies;
- Storage screens Studio;
- Realtime database changes v1;
- MCP preview-write tools, capabilities, audit и migration review;
- branches, schema diff и rollback;
- CLI `init`, `link`, `dev`, `deploy`;
- routing, quotas, metering и abuse controls.

Exit criteria:

- один реальный full-stack app использует Database + Auth + Storage + Realtime;
- агент не имеет direct production SQL;
- каждое изменение связано с branch и audit event;
- documented beta RPO/RTO;
- первый платящий пользователь.

### Этап 3: public beta и монетизация, месяцы 5-7

Deliverables:

- Functions v1 на managed sandbox provider;
- cron, webhooks, secrets и function logs;
- billing/entitlements для Free, Default, Extended и Pro; Enterprise contract entitlements;
- team roles и invitations;
- GitHub preview integration;
- `supabase-js` compatibility package и pinned reference stack;
- migration guide и automated import для поддерживаемого subset;
- usage, logs и billing screens Studio;
- status page, support workflow и public documentation.

Exit criteria:

- compatibility matrix опубликована;
- минимум 10 приложений мигрированы с Supabase-compatible subset;
- 50 weekly active teams;
- 20 платящих клиентов;
- измерены activation, D30 retention, COGS и gross margin.

### Этап 4: production hardening, месяцы 8-12

Deliverables:

- multi-region routing и controlled failover;
- PITR или доказанный эквивалент restore points;
- MFA и расширенный auth abuse protection;
- Realtime broadcast/presence;
- resumable/multipart Storage и image transformations;
- dedicated compute для hot/write-heavy проектов;
- SLO, incident process, external penetration test;
- data masking для preview branches;
- platform provisioning API.

Exit criteria:

- 99.9% измеренный SLO на платных планах;
- восстановление проверяется автоматически;
- нет cross-tenant incidents;
- unit economics дают не менее 70% gross margin;
- подтвержден product-market pull, а не только free-tier registrations.

### Этап 5: GA BaaS и enterprise, месяцы 13-24

При подтвержденном retention:

- Enterprise SSO/SCIM, DPA, audit export и SLA;
- BYOC/dedicated regions;
- high-availability topology для write-heavy workloads;
- расширенная совместимость SDK/Auth/Realtime/Functions;
- marketplace templates и integrations;
- volume platform contracts на тысячи проектов;
- постепенная замена наиболее дорогих частей Studio fork собственными модулями.

Цель не выпустить все функции Supabase за 12 недель. Цель первых четырех месяцев: уже полезный BaaS из Database + Auth + Storage + базового Realtime + Studio + MCP, после чего расширять ширину без потери надежности.

## 12. Тестирование

### Compatibility suite

Для каждого поддерживаемого вызова:

1. Создать одинаковую логическую fixture schema в reference Supabase/PostgREST и нашем runtime.
2. Выполнить запрос через одну pinned версию `supabase-js`.
3. Сравнить status, headers, body, ordering, null semantics и errors.
4. Зафиксировать различия как unsupported или intentional deviation.
5. Запускать suite при каждом изменении parser/compiler.

### Security tests

- property-based и fuzz testing query parser;
- SQL injection corpus;
- policy bypass matrix для каждой операции;
- cross-project и cross-branch token tests;
- OAuth flow tests;
- malicious migration fixtures;
- log redaction tests;
- restore integrity tests;
- dependency and container scanning.

### Performance tests

Публикуемые профили:

- indexed point read;
- paginated list;
- filtered write;
- mixed 90/10 read/write;
- burst cold project;
- 1,000 mostly idle project databases;
- branch creation и restore;
- policy overhead on/off;
- local, same-region remote и cross-region latency.

Метрики:

- p50/p95/p99 latency;
- throughput;
- error rate;
- memory per active/idle project;
- CPU per request;
- storage amplification;
- branch creation time by database size;
- cost per million requests;
- recovery time and recovery point.

## 13. Бизнес-модель

### Модель продаж

Commercial managed cloud + source-available self-hosting + enterprise/platform contracts.

Доход:

- подписка команды;
- usage по compute/request units, storage, egress и backup retention;
- enterprise governance и support;
- dedicated region/BYOC;
- platform API с оптовым pricing для тысяч tenant databases;
- premium audit/compliance retention;
- paid add-ons: extra branches, PITR retention, image transformations, function compute, AI credits и dedicated compute.

Не брать деньги за базовую безопасность. Policy enforcement, data export и безопасные defaults должны работать на всех планах. Коммерциализируются объем, retention, performance, collaboration, compliance и managed operations.

### Предлагаемые тарифы для проверки

Это гипотеза, а не финальный прайс.

| План | Ориентир цены | Для кого | Основные ограничения и ценность |
|---|---:|---|---|
| Free | $0 | обучение, prototypes, vibe coding | до 100 созданных projects/namespaces, один ephemeral preview branch, ограничение общего storage/egress/function compute; один активный production workload; auto-suspend; короткие logs/backups |
| Default | $15/мес + usage | solo developers и маленькие production apps | несколько активных проектов, Auth/Storage/Realtime/Functions, daily backups, custom domains, базовый MCP |
| Extended | $39/мес + usage | активные стартапы | больше quotas, несколько concurrent preview branches, longer branch TTL/retention, team seats, scheduled functions, priority build queue |
| Pro | $99/мес + usage | команды и критичные приложения | advanced approvals, PITR, audit, higher concurrency, dedicated compute option, priority support |
| Enterprise | annual contract | платформы и регулируемые компании | SSO/SCIM, SLA, BYOC/dedicated region, DPA, volume namespaces, security review и support |

Главный принцип free tier: дать психологически огромную свободу создавать проекты, но считать дорогие ресурсы общим pooled budget. «100 проектов бесплатно» не означает 100 постоянно активных серверов по 1 GB. Неактивные базы занимают дешевое durable storage, hot projects получают ограниченный общий compute, а abuse controls запрещают использовать Free как бесплатный production hosting fleet.

Перед launch цены проверяются через landing-page tests и интервью. Нельзя одновременно быть радикально дешевле рынка, давать unlimited active compute и сохранять здоровую маржу.

### Unit economics

Целевая валовая маржа managed cloud: не менее 70%, затем 80%+ при масштабе.

Для тарифа $19 месячный COGS должен быть ниже $5.70 при 70% gross margin.

Считать по каждому workspace:

```text
COGS = compute
     + durable storage
     + backup storage
     + egress
     + email/SMS auth
     + observability ingestion
     + support allocation
     + payment fees
```

Опасные статьи:

- auth email/SMS abuse;
- бесплатный egress;
- excessive logs;
- большое число неограниченно активных баз;
- backup retention;
- AI inference для prompt-to-policy;
- support у бесплатных пользователей.

LLM-функции должны использовать credits или BYOK, иначе они разрушат предсказуемость маржи.

### Bottom-up revenue model

Не нужно придумывать огромный TAM без данных. Для YC достаточно показать путь:

- 10,000 платящих пользователей при среднем $29 MRR = $3.48M ARR;
- 100,000 платящих пользователей при среднем $29 MRR = $34.8M ARR;
- 200 platform-клиентов со средним $2,000 MRR = еще $4.8M ARR;
- enterprise expansion увеличивает ACV через governance, regions и support.

Долгосрочный рынок шире BaaS: runtime и governance layer для программно создаваемых приложений и агентов.

## 14. Go-to-market

### Wedge 1: coding-agent developers

Бесплатный продукт:

- `init` одной командой;
- готовая MCP-конфигурация;
- локальная база;
- preview branch перед каждой migration;
- generated types;
- шаблоны для популярных frontend stacks.

Контент:

- реальные разборы «как агент сломал production schema»;
- benchmark и compatibility matrix;
- migration recipes;
- GitHub examples;
- short demos: prompt -> preview -> tests -> approve.

### Wedge 2: AI builders и платформы

Оффер:

> «Мы дадим каждому сгенерированному приложению отдельную базу, auth и preview lifecycle через API, без отдельного постоянно работающего PostgreSQL-инстанса и без выдачи агенту production admin credential».

Продажа через founder-led pilots:

- 30-дневный pilot;
- ограниченный набор приложений;
- совместно измеряем COGS, provisioning latency и failure rate;
- затем platform contract и volume tiers.

### Wedge 3: preview databases для SaaS-команд

GitHub integration:

- PR создает branch database;
- применяет migrations;
- выдает scoped secrets preview deployment;
- запускает tests;
- публикует schema/policy diff в PR;
- удаляет environment по TTL после merge/close.

### Distribution loops

- каждый generated starter содержит attribution link, отключаемый на платном плане;
- public templates создают новые проекты;
- MCP directory listings;
- GitHub App и marketplace integrations;
- open compatibility suite привлекает contributors;
- образовательный free tier создает привычку у новых разработчиков.

## 15. Конкуренты

### Supabase

Сильные стороны:

- зрелая PostgreSQL-платформа;
- большой ecosystem;
- auth, storage, realtime, functions и dashboard;
- официальный MCP;
- понятная developer brand.

Наше отличие:

- database-per-task/branch как базовая модель;
- local lightweight runtime;
- agent capability firewall;
- обязательный preview/approval workflow;
- economics для огромного числа маленьких изолированных баз.

Конечная цель — конкурировать с Supabase как законченный BaaS. В первый год нельзя пытаться повторить каждую PostgreSQL extension и enterprise-функцию; выигрывать нужно простотой, плотностью проектов, Studio + MCP и быстрым путем от идеи до production.

### Turso

Сильные стороны:

- libSQL и глубокая SQLite-экспертиза;
- database-per-tenant;
- branching;
- большое число баз;
- agent-oriented positioning и MCP.

Это самый прямой стратегический конкурент и одновременно возможный infrastructure partner.

Наше отличие обязано быть выше уровня database hosting:

- auth и application API;
- PostgREST-compatible subset;
- policy engine;
- Agent Change Protocol;
- human approvals и audit;
- local-to-cloud developer workflow.

Если продукт останется просто UI/API поверх Turso, у него не будет устойчивого moat.

### Neon

Сильные стороны:

- serverless Postgres;
- database branching;
- большой уровень PostgreSQL compatibility;
- MCP и agent integrations.

Наше отличие:

- более легкая project-per-task модель;
- embedded/local runtime;
- BaaS-функции поверх базы;
- безопасный agent workflow как центр продукта.

### Cloudflare D1 и Durable Objects

Сильные стороны:

- глобальная edge distribution;
- интеграция с Workers;
- простая эксплуатация.

Наше отличие:

- переносимость и self-hosting;
- полноценный auth/policy/MCP workflow;
- Supabase-like client experience;
- отсутствие привязки к одному edge runtime.

### Firebase и Appwrite/PocketBase-подобные продукты

Конкурируют за простоту BaaS. Наше отличие: SQL, branches, agent safety и database-per-project economics. PocketBase особенно силен как простой single-binary local backend, поэтому local DX должен быть не хуже по времени до первого результата.

## 16. Moat

Код parser сам по себе не moat. Устойчивость формируется из нескольких слоев:

- крупнейший открытый corpus реальных agent database mistakes;
- compatibility test corpus;
- policy test corpus;
- надежный migration risk analyzer;
- workflow, встроенный в IDE, GitHub и builders;
- доверие к audit и recovery;
- platform contracts и data gravity;
- operational expertise управления огромным числом маленьких баз;
- стандарт Agent Change Protocol, принятый сторонними инструментами.

Главный data moat не должен содержать пользовательские данные. Собирать можно обезличенные структуры ошибок, latency profiles и outcomes только с явным согласием.

## 17. Метрики

### North Star

**Количество weekly active production projects, использующих минимум два BaaS-модуля и выполняющих успешные пользовательские запросы.**

Например, Database + Auth, Database + Storage или Database + Functions. Это измеряет использование законченного backend, а не пустые созданные базы. Agent-driven changes остаются отдельной ключевой product metric.

### Activation

- local runtime запущен;
- создана первая таблица;
- MCP подключен;
- первая migration прошла через preview;
- приложение выполнило первый API-запрос.

Цель MVP: 40% зарегистрированных разработчиков завершают activation flow.

### Retention

- weekly active projects;
- доля проектов с повторной migration на следующей неделе;
- D30 retained teams;
- active databases per organization;
- agent sessions per active project.

### Reliability

- API availability;
- p95 latency по профилю;
- failed promotions;
- restore success rate;
- policy-denied events;
- cross-tenant incidents: целевое значение всегда ноль.

### Business

- free-to-paid conversion;
- net revenue retention;
- gross margin;
- COGS per active project;
- platform pipeline и pilot-to-contract conversion;
- support load per 100 customers.

## 18. Главные риски и способы снижения

### Риск 1: совместимость съест команду

Вероятность высокая.

Меры:

- versioned compatibility levels;
- начать с CRUD и измерить реальные запросы design partners;
- не поддерживать редкие PostgreSQL features;
- differential contract tests;
- native SDK остается главным интерфейсом.

### Риск 2: SQLite write contention

Одна маленькая база отлично подходит не для каждого workload. Write-heavy analytics, большие транзакции и сложная параллельная запись могут потребовать PostgreSQL или другой архитектуры.

Меры:

- честно определить workload envelope;
- per-project queue/backpressure;
- короткие транзакции;
- observability write contention;
- экспорт и migration path;
- в будущем pluggable storage engine для enterprise, если спрос оправдает сложность.

### Риск 3: gateway-policy не равна нативной RLS

Любой direct database access обходит gateway policy.

Меры:

- не выдавать прямые credentials untrusted clients;
- разделить public и admin paths;
- проверять policy во всех операциях;
- security review compiler;
- формально описать trust boundary.

### Риск 4: конкуренты копируют функции

Supabase, Turso и Neon могут добавить approvals и agent sandbox.

Меры:

- быстрее занять workflow и integrations;
- open protocol;
- лучший local DX;
- platform API;
- corpus и trust;
- не зависеть от одной killer feature.

### Риск 5: чрезмерная ширина продукта

Auth, API, realtime, storage, functions, dashboard и AI одновременно убьют маленькую команду.

Меры:

- closed alpha только Database API + адаптированный Studio + read-only MCP;
- private beta добавляет Auth, Storage и Realtime v1, а Functions выходят в public beta;
- Studio форкается поэкранно: неподдерживаемые модули скрыты, а не имитируются;
- покупать managed infrastructure, пока собственная не дает advantage.

### Риск 6: multi-tenant cloud operations

Тысячи SQLite-файлов создают задачи routing, backups, file descriptors, noisy neighbors и recovery.

Меры:

- workload simulation до free-tier launch;
- hard quotas;
- auto-suspend;
- bounded connection pools;
- catalog reconciliation;
- restore drills;
- staged regional rollout.

### Риск 7: MCP security

Удаленный MCP увеличивает поверхность атаки.

Меры:

- no production write by default;
- per-session capabilities;
- explicit branch binding;
- no secrets in resources;
- tool-level authorization;
- confirmation и organization policies;
- complete audit.

### Риск 8: зависимость от libSQL/Turso roadmap

Меры:

- признать, что открытый репозиторий libSQL архивирован, и не обещать активный upstream;
- использовать открытый protocol/client только за abstraction boundary;
- изолировать storage adapter;
- поддерживать local mode на стандартном SQLite;
- не завязывать product semantics на недокументированную hosted-функцию;
- иметь экспорт обычной SQLite-базы.
- до hosted beta выбрать один из трех путей: Turso как поставщик, поддерживаемый внутренний fork или другой SQLite-compatible backend; решение принять по security, SLA и COGS, а не по маркетингу.

## 19. Команда

Минимальная сильная founding team:

- founder/CEO с developer-tools distribution и продажами design partners;
- systems/backend engineer: parsers, SQLite/libSQL, isolation, performance;
- product/full-stack engineer: CLI, dashboard, SDK, integrations;
- part-time security advisor до найма security engineer.

Первый найм после seed зависит от bottleneck:

- infrastructure/SRE при росте hosted traffic;
- developer relations при сильном OSS pull;
- security engineer до enterprise rollout.

## 20. Что показать в YC demo

Демо должно занимать до двух минут:

1. Пустой Next.js-проект и подключенный coding agent.
2. Команда `init` создает local backend.
3. Агент через MCP видит реальную схему.
4. Пользователь просит добавить billing table и правила ownership.
5. Агент создает preview branch и migration proposal.
6. Runtime показывает policy diff и блокирует намеренно опасный `DROP COLUMN`.
7. После исправления запускаются тесты.
8. Пользователь нажимает approve.
9. Frontend сразу работает через знакомый SDK.
10. Audit log показывает actor, diff, tests и restore point.

Главная эмоция: «Агент может реально менять backend, но больше не держит production за горло».

## 21. Ответы на типовые вопросы YC

### Что вы делаете?

Коммерческий lightweight BaaS класса Supabase с Database, Auth, Storage, Realtime, Functions и Studio. Разработчик подключает существующий проект одной кнопкой или настраивает backend вручную, а AI управляет теми же ресурсами через безопасный MCP.

### Кто пользователь?

Сначала разработчики с AI IDE и платформы, программно создающие много приложений. Затем SaaS-команды с большим числом preview environments и enterprise governance needs.

### Почему существующие решения недостаточны?

Они дают базу, branching или MCP как отдельные возможности. Мы соединяем их в constrained workflow: актуальная схема, минимальные capabilities, preview, validation, approval, promotion и audit.

### Как вы зарабатываете?

Managed cloud subscriptions, usage, platform contracts, enterprise governance/BYOC и коммерческие self-hosted licenses. SDK и connectors могут быть открытыми, сервер и cloud control plane остаются proprietary/source-available.

### Почему это может стать большой компанией?

Если приложения все чаще создаются программно агентами, backend должен стать безопасно программируемой инфраструктурой. Победитель будет обслуживать не одну базу на компанию, а базы для каждого приложения, tenant, branch и agent task.

### Что трудно скопировать?

Не отдельная функция, а corpus совместимости и ошибок, policy/migration verification, operations на миллионах изолированных баз, integrations и доверие к recovery workflow.

### Почему вы выиграете у Turso/Supabase/Neon?

Мы не копируем PostgreSQL feature-for-feature. Мы даем тот же законченный BaaS outcome через более легкую database-per-project архитектуру, знакомое Studio и лучший интерфейс для AI-агентов. На старте Turso или другой engine/provider может быть infrastructure layer, но продуктовые API, Auth, Storage, Realtime, Functions, Studio, billing и customer relationship принадлежат нам.

## 22. Решения, которые нужно принять до начала кода

1. Выбрать один ICP для первых десяти design partners: individual agent developers или AI builder platform.
2. Зафиксировать MVP compatibility surface на одной странице.
3. Выбрать deployment model libSQL для hosted beta и подтвердить backup semantics прототипом.
4. Написать threat model до mutating MCP tools.
5. Определить policy DSL и запретить raw production SQL для агента.
6. Зафиксировать лицензионные границы: proprietary cloud/Studio, source-available self-hosted runtime, permissive SDK/CLI/protocol; заказать юридический текст и contributor policy.
7. Провести naming/trademark search.
8. Определить telemetry consent и privacy policy.
9. Получить пять design partners до разработки dashboard.
10. Назначить kill criteria для идеи через 12 недель.

## 23. Kill criteria

Проект нужно существенно изменить или остановить, если после 12 недель:

- менее пяти команд регулярно используют preview workflow;
- пользователи обходят MCP workflow и предпочитают raw SQL;
- ни одна платформа не подтверждает ценность database-per-task;
- стоимость совместимости превышает ценность миграционного канала;
- hosted COGS не позволяет получить 70% gross margin;
- branch/restore semantics libSQL не дают надежного recovery;
- основной спрос оказывается только на бесплатный SQLite dashboard.

## 24. Итоговая стратегия

Строить следует в таком порядке:

1. **Работающий Database API + Studio onboarding**, чтобы человек получил backend одной кнопкой.
2. **Schema manifest, AST и policy engine**, а не fork GoTrue/PostgREST.
3. **Auth + Storage + базовый Realtime**, чтобы продукт стал реальным BaaS.
4. **Branches, schema diff и promotion artifacts**, необходимые до mutating MCP.
5. **MCP и agent-safe change workflow** как равноправный интерфейс и дифференциатор.
6. **Native SDK**, затем измеряемый Supabase-compatible subset и Functions.
7. **Design partners**, затем экономически ограниченный широкий free tier.

Самая сильная версия компании звучит так:

> Мы создаем самый простой полноценный backend: одна кнопка для разработчика, MCP для агента и экономика, позволяющая держать сотни проектов вместо двух.

## 25. Источники и материалы для проверки

### Основные проекты и лицензии

- libSQL repository and license: https://github.com/tursodatabase/libsql
- Turso Database repository and license: https://github.com/tursodatabase/turso
- libSQL TypeScript client: https://github.com/tursodatabase/libsql-client-ts
- Bun repository and license: https://github.com/oven-sh/bun
- Elysia repository and license: https://github.com/elysiajs/elysia
- Better Auth repository: https://github.com/better-auth/better-auth
- Drizzle ORM repository: https://github.com/drizzle-team/drizzle-orm
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP TypeScript SDK license: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE
- MCP 2026-07-28 release: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- Business Source License 1.1: https://mariadb.com/bsl11/
- Elastic License 2.0: https://www.elastic.co/licensing/elastic-license
- Supabase JavaScript client: https://github.com/supabase/supabase-js
- PostgREST repository: https://github.com/PostgREST/postgrest
- Supabase monorepo/Studio: https://github.com/supabase/supabase
- shadcn/ui: https://github.com/shadcn-ui/ui
- jose: https://github.com/panva/jose
- OpenTelemetry JS: https://github.com/open-telemetry/opentelemetry-js

### Технические документы

- SQLite JSON functions: https://sqlite.org/json1.html
- SQLite Write-Ahead Logging: https://sqlite.org/wal.html
- SQLite isolation: https://sqlite.org/isolation.html
- Supabase REST API/PostgREST reference: https://supabase.com/docs/guides/api
- Supabase MCP security guidance: https://supabase.com/docs/guides/getting-started/mcp
- Turso branching documentation: https://docs.turso.tech/features/branching
- Turso MCP documentation: https://docs.turso.tech/cli/mcp
- Neon branching documentation: https://neon.com/docs/introduction/branching

### Рыночный контекст

- Turso pricing: https://turso.tech/pricing
- Turso database-per-tenant: https://turso.tech/multi-tenancy
- Turso agent workloads: https://turso.tech/agentfs
- Supabase pricing: https://supabase.com/pricing
- Neon pricing: https://neon.com/pricing

Перед использованием любых чисел из pricing pages в pitch deck их необходимо обновить в день отправки: тарифы и лимиты меняются.
