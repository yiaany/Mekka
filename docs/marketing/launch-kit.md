# Mekka Launch Kit

Prepared for Product Hunt, Hacker News, and Reddit on August 9, 2026.

All public copy below is written in English. Product Hunt and Reddit drafts can be adapted and published. Hacker News currently prohibits generated or AI-edited text, so its section is a factual writing brief that the founder must rewrite personally before posting.

## Strategy Brief

### Audience

- Primary: solo developers, small product teams, and AI-native builders who want data, Auth, Storage, Realtime, Studio, and MCP without operating a PostgreSQL platform.
- Secondary: Bun and SQLite users who have outgrown a bare database but do not want a multi-service backend stack.
- Tertiary: self-hosters who want local ownership, ordinary SQLite files, and a browser control surface.

### Offer

Mekka is a self-hosted backend built in public on Bun and SQLite. It currently ships a usable local stack with Data, Auth, Storage, Realtime, an embedded Studio, isolated preview branches, and scoped MCP access for coding agents.

### Main Angle

**The agent-native Supabase killer for teams that want the product surface without the PostgreSQL fleet.**

Use the phrase "Supabase killer" as the attention hook, then immediately earn it with a narrower, credible claim:

> Mekka is not trying to reproduce every PostgreSQL feature. It keeps the backend surfaces many products actually use, puts them on Bun and SQLite, and makes guarded agent access part of the architecture.

### Aggressive Hook Bank

Use these for social cards, gallery covers, founder posts, and replies. Do not force them into Product Hunt or Hacker News fields where platform norms favor clarity.

1. The Supabase killer that fits in your head
2. Supabase without the PostgreSQL tax
3. A complete backend on Bun and one SQLite file
4. Stop operating a database platform for a side project
5. Your coding agent should never get a production database key
6. Data, Auth, Storage, Realtime, and Studio without the fleet
7. The backend for teams shipping product, not infrastructure
8. What if Supabase were SQLite-native and agent-safe?
9. Give agents a preview, not your production database
10. The local engine is only Mekka's opening move

### Desired Action

1. Open the GitHub repository.
2. Start the complete local stack with `npx mekka`.
3. Star the repository if Mekka solves a real problem for them.
4. Open an issue with the missing feature that would make them adopt it.

### Main Objections

- "SQLite cannot replace PostgreSQL for every workload."
- "This is too early for production."
- "Why use a source-available license?"
- "The Studio is derived from Supabase Studio."
- "The cloud and additional engines do not exist yet."
- "Why should an agent receive database access at all?"

### Honest Positioning

- Do not claim full Supabase or PostgreSQL compatibility.
- Describe the license through its benefit: the complete source is public and qualifying small organizations can use Mekka inside their products, while third parties cannot repackage it as a competing hosted backend or cloud service without a commercial agreement.
- Do not call Mekka OSI open source. Use "built in public" or "source-available" when a precise classification is needed.
- Do not describe libSQL, PGlite, or Mekka Cloud as shipped.
- Do not call PGlite itself "the cloud version." Say "PGlite engine support and a hosted Mekka Cloud."
- State that production deployments still need monitoring, backups, restore testing, and independent security review.

### License Positioning Line

Use this when the license needs a short explanation:

> Mekka is built in public for builders, not cloud extraction. Qualifying small organizations can use it inside their products, but a large company or cloud vendor cannot rebrand Mekka and sell it as a competing hosted backend without a commercial agreement.

## Roadmap Line

Use this exact wording across launch channels:

> Today, Mekka runs on Bun's native SQLite driver. Next, I plan to add a remote libSQL/Turso data plane, then a PGlite compatibility track and Mekka Cloud. Those are roadmap items, not shipped features.

The public README now follows this sequence: libSQL/Turso next, then PGlite, then Mekka Cloud.

## Product Hunt

### Recommended Fields

**Product name**

Mekka

**Tagline**

Supabase-style backend on Bun and SQLite

**Tagline alternatives**

1. A complete backend without the PostgreSQL fleet
2. Supabase-style developer experience on Bun and SQLite
3. The backend platform built for coding agents
4. Data, Auth, Storage, Realtime, Studio, and safe agents
5. Your backend on Bun and ordinary SQLite files
6. A smaller backend for AI-native products
7. The backend surface you need, with less platform weight

Product Hunt limits the tagline to 60 characters and explicitly discourages gimmicks and over-the-top language. Keep "Supabase killer" in the gallery hook and supporting story instead of risking the primary tagline.

**Primary URL**

https://github.com/yiaany/Mekka

Use the direct repository URL. Do not route Product Hunt visitors through a generic link shortener.

**Additional links**

Leave empty until there is a separate documentation site, hosted demo, package page, or downloadable application. Do not duplicate the primary GitHub URL.

**X handle**

Use the official Mekka product account if one exists. Otherwise leave this blank rather than using an unrelated personal handle.

**Description**

Mekka gives you Data, Auth, Storage, Realtime, Studio, and scoped MCP on Bun and SQLite. Start the full local backend with `npx mekka`. Agents change isolated previews, not production.

This version stays below Product Hunt's shortest documented description limit.

**Topics**

- Developer Tools
- Databases
- Artificial Intelligence

Select Open Source only if Product Hunt treats it as a broad source-code discovery category. If asked about the license, say Mekka is built in public and protected from cloud resale under the Mekka Business License 2.0.

**Pricing**

Select: Free

Position the license positively in the maker comment: small builders can build with Mekka, but a large company cannot strip-mine the work and resell it as a competing cloud backend without an agreement.

**Status**

Available now

**Call to action**

Visit website

The destination is the GitHub repository until a dedicated website or live demo exists.

**Makers**

Add the founder and every person who made a material contribution. Each maker needs a Product Hunt account before launch.

**Hunter**

Submit the product yourself. Product Hunt no longer requires a separate hunter, and a famous hunter is not a substitute for a strong page or active maker discussion.

**Shoutouts**

Use up to three real tools that materially enabled the release. Recommended choices, if their Product Hunt pages are available:

1. Bun
2. SQLite
3. Supabase

Supabase is an honest shoutout because Mekka Studio preserves Apache-licensed upstream provenance.

**Promo**

Leave empty. There is no paid plan or truthful launch-only discount to offer today.

**Video**

Add the full public YouTube URL for the product walkthrough. Product Hunt currently accepts YouTube links for launch videos.

**Interactive demo**

Optional but recommended after the core launch assets are ready. Build a short click-through that ends at the GitHub setup instructions.

### Gallery Order

1. A new 60 to 90 second product video or GIF: clone, start, open Studio, edit a table, show Agent Access, show an isolated preview. Cover copy: "The Supabase killer for apps that do not need Postgres."
2. `docs/assets/studio/table-editor.jpg`: caption "A real local backend, not a mockup."
3. `docs/assets/studio/agent-access.jpg`: caption "Agents read by default and write only inside isolated previews."
4. `docs/assets/studio/sql-editor.jpg`: caption "Inspect and change your database from one embedded Studio."
5. `docs/assets/studio/auth-users.jpg`: caption "Data, users, files, branches, and approvals in one control surface."

Export dedicated gallery images at Product Hunt's recommended 1270x760 size rather than uploading the current 1440x900 screenshots without adjustment. Keep all key UI and text inside a safe central area for mobile crops.

### Thumbnail

Use `docs/assets/mekka-readme-logo.png` as the source. Product Hunt recommends a 240x240 square, so the current 256x256 file is large enough. A simple looping GIF that moves from the mark to "Bun + SQLite" would communicate more in the feed.

### First Maker Comment

Hey Product Hunt,

I built Mekka because I kept seeing the same tradeoff: use a bare SQLite file and rebuild every backend surface yourself, or adopt a PostgreSQL platform that is larger than the product needs.

Mekka takes a different path. Run `npx mekka` and it creates the project, installs dependencies, and starts Data, Auth, Storage, Realtime, an embedded Studio, database previews, and scoped MCP access on Bun and SQLite.

The part I care about most is agent safety. An agent gets read access by default. If it needs to change the database, Mekka creates an isolated preview, records the exact SQL, validates it, and requires explicit approval before promotion. A bad migration can break the preview, but it cannot silently rewrite production.

This is an early release, not a claim of full Supabase or PostgreSQL parity. Today the local SQLite path is real and runnable. Next, I plan to add a remote libSQL/Turso data plane, then a PGlite compatibility track and Mekka Cloud.

The full source is public. The license is designed for builders, not cloud extraction: qualifying small organizations can use Mekka inside their products, while third parties cannot repackage it as a competing hosted backend without a commercial agreement.

I would value blunt feedback on two things:

1. Which missing backend feature would stop you from using Mekka today?
2. Is the preview-first agent workflow safer enough to let a coding agent touch your schema?

You can start it with `npx mekka`. I will be here all day answering questions and fixing anything people find.

### Short Maker Reply Bank

**Why not just use Supabase?**

If you need deep PostgreSQL compatibility, extensions, or the full Supabase platform, you should use Supabase. Mekka is for the narrower case where you want the common backend surfaces, ordinary SQLite files, and less infrastructure.

**Can SQLite really scale?**

Not for every workload, and I do not pretend otherwise. The current goal is to make the local and single-primary path excellent. The remote libSQL/Turso adapter is the planned distributed path.

**Is this open source?**

The complete source is public under the Mekka Business License 2.0. It is designed so individuals can inspect, modify, test, and learn from Mekka, and qualifying small organizations can use it inside their products. What it blocks is cloud extraction: a third party cannot repackage Mekka as a competing hosted backend without a commercial agreement.

**Did you fork Supabase Studio?**

Parts of Mekka Studio are derived from Supabase Studio under Apache License 2.0. The repository preserves the upstream license and provenance. The data plane, SQLite contracts, branch workflow, and scoped agent path are Mekka's product architecture.

**Is Mekka production-ready?**

It is under active development. The reviewed paths have tests and a release gate, but a serious production deployment still needs monitoring, backups, restore tests, and independent security review.

**Why should an AI agent touch production data?**

It should not receive unrestricted production execution. Mekka gives agents short-lived scoped access, keeps writes in disposable previews, records exact SQL, and requires an artifact-bound approval before promotion.

### Product Hunt Launch Checklist

- Working launch target: Tuesday, August 18, 2026 at 12:01 AM Pacific, but only if every P0 asset is complete by Sunday, August 16. Otherwise move to the next day when the maker can protect a full 24-hour response window.
- Schedule the launch for 12:01 AM Pacific so the product receives the full launch day.
- Add every real maker and contributor before launch.
- Prepare the maker comment before the page goes live.
- Reply quickly and specifically to every substantive comment.
- Ask supporters to visit the launch and give honest feedback. Do not ask for upvotes, trade votes, use voting groups, or coordinate artificial engagement.
- Keep launch-day posts personal. Do not paste the Product Hunt tagline into every social channel.
- Add the Product Hunt badge to the README only after the launch page is live.

## Hacker News

### Title Concept

Show HN: Mekka - A self-hosted Bun + SQLite backend with agent-safe database previews

Write the final title yourself too. Keep the required `Show HN:` prefix, the product name, and one concrete technical distinction.

### Title Alternatives

1. Show HN: Mekka - A self-hosted backend built around bun:sqlite
2. Show HN: Mekka - Preview-first database access for coding agents
3. Show HN: Mekka - Data, Auth, Storage, Realtime, and MCP on SQLite
4. Show HN: Mekka - Guarded schema changes for agents on Bun and SQLite
5. Show HN: Mekka - A local backend with isolated database previews

Do not use "Supabase," "Supabase-style," or "Supabase killer" in the Hacker News title or opening line. Lead with the implementation and the preview-first safety model.

### Submission URL

https://github.com/yiaany/Mekka

### Founder Writing Brief

Do not paste the prose below into Hacker News. Current HN guidelines prohibit generated and AI-edited text. Use these verified facts to write a shorter version in your own natural English, including your own reasons, tradeoffs, and phrasing.

### Facts To Cover

Opening fact: Mekka is a backend built in public that puts Data, Auth, Storage, Realtime, a browser Studio, and scoped MCP access on top of Bun and SQLite. Its production and commercial terms are defined by the Mekka Business License 2.0.

Founder motivation to express personally: many small products want the useful surface of a backend platform, but do not need to operate a PostgreSQL fleet. Mekka stores data in ordinary SQLite files through `bun:sqlite` and starts with `npx mekka`.

Technical center: agent tokens are short-lived and read-only by default. A write request creates an isolated database preview. Mekka records the migration artifact and exact SQL, validates the result, and requires a one-time approval bound to that artifact before it can be promoted. Promotion rechecks authorization and the production schema hash.

Shipped today:

- typed reads and mutations, migrations, backup, and restore
- Auth, JWT/JWKS, OAuth, sessions, and audit
- local or S3-compatible object storage
- realtime changefeeds, private channels, and presence
- an embedded Studio with table, SQL, user, provider, branch, and agent controls
- a selected `supabase-js` Data API compatibility layer

Not shipped today:

- full PostgreSQL or PostgREST parity
- a production libSQL adapter
- PGlite support
- a hosted Mekka Cloud

Roadmap: a remote libSQL/Turso data plane, then a PGlite compatibility track and Mekka Cloud. Explicitly label all three as roadmap work.

Close with one question you genuinely care about. Best options: feedback on the branch promotion model, or examples of workloads where SQLite would be the wrong default.

### HN Rules For This Launch

- Use the product page or repository as the URL, not a launch announcement article.
- Keep "Show HN" for something people can run and inspect now.
- Do not ask friends, communities, or mailing lists to upvote or comment.
- Do not include calls for stars or Product Hunt votes in the submission.
- Be available to answer detailed technical criticism.
- Do not repost quickly if the submission performs poorly.
- Write the submission and every reply yourself. HN's current guidelines prohibit generated and AI-edited comments as well as submissions.
- Do not send your final HN draft back for AI polishing. Publish your own wording, including any imperfections.

## Reddit Rollout

Do not publish identical posts to five communities on the same day. Stagger them over one to two weeks, participate in the comments, and adapt the value proposition to each audience. Check each community's sidebar immediately before posting because rules and recurring thread schedules can change.

### 1. r/SideProject

**Format:** standalone text post with the Self Promotion flair

**Title**

I built a Supabase killer that runs on Bun + SQLite instead of a Postgres stack

**Body**

I have been building Mekka around a simple bet: most small products need Data, Auth, Storage, Realtime, and a decent admin UI, but they do not need PostgreSQL infrastructure as a lifestyle.

Mekka puts those surfaces into one self-hosted stack using Bun's native SQLite driver. Run `npx mekka` and get a working Studio against ordinary local database files.

The feature I could not find elsewhere was safe database access for coding agents. Mekka gives agents read-only, short-lived MCP tokens by default. Writes happen in an isolated preview. The exact SQL is recorded and validated, and production promotion requires explicit approval.

What is real today:

- Data, Auth, Storage, and Realtime
- table and SQL editors
- preview database branches
- scoped MCP access
- backup, restore, audit, and guarded promotion

What is not real yet:

- full Postgres compatibility
- the libSQL remote adapter
- PGlite support
- Mekka Cloud

The roadmap is to add libSQL/Turso for the distributed data plane, then PGlite support and a hosted cloud layer.

Start it: `npx mekka`

Repo: https://github.com/yiaany/Mekka

Mekka is source-available under the Mekka Business License 2.0. Builders can inspect and modify the complete code, while third parties cannot rebrand it as a competing cloud backend without a commercial agreement.

The sharpest feedback would be useful: what is the first missing feature that would stop you from trying this for a real side project?

### 2. r/bun

**Format:** standalone technical text post

No dedicated promotional thread was found during research. Recheck the live sidebar before posting and keep this version technical, scoped, and explicit about limitations.

**Title**

I used bun:sqlite to build a complete local backend with Auth, Realtime, Studio, and MCP

**Body**

I built Mekka to see how far Bun's native SQLite driver could carry a backend platform before a separate database service became necessary.

The current stack uses `bun:sqlite` for the data plane and adds:

- typed query compilation with prepared values
- schema manifests, migrations, checkpoints, and restore
- Auth sessions, JWT/JWKS, OAuth, and audit
- local and S3-compatible object storage
- realtime changefeeds, channels, and presence
- an embedded Studio
- isolated database previews for coding-agent writes

The agent workflow is the unusual part. Access tokens are short-lived and read-only by default. A requested write is applied to a disposable preview first. Mekka stores the exact SQL and schema hashes, then requires an explicit one-time approval before promotion.

I am not claiming SQLite is the correct engine for every workload. The next data-plane adapter is planned for libSQL/Turso, followed by a PGlite compatibility track. The goal is to keep one Studio and one agent protocol while making the engine an explicit capability choice.

Start it: `npx mekka`

Repo and architecture: https://github.com/yiaany/Mekka

The complete source is public under the Mekka Business License 2.0, which protects Mekka from being repackaged as somebody else's competing cloud service.

I would like feedback from people who have pushed `bun:sqlite` hard: which concurrency, durability, or deployment edge would you test first?

### 3. r/selfhosted

**Format:** comment in the current weekly New Project Megathread, not a standalone promotional post

Current thread on August 9, 2026: https://www.reddit.com/r/selfhosted/comments/1vhi4mk/new_project_megathread_week_of_06_aug_2026/

**Comment**

**Project Name:** Mekka

**Repo/Website Link:** https://github.com/yiaany/Mekka

**Description:**

I built Mekka for small teams that want Data, Auth, Storage, Realtime, and a browser Studio without running a PostgreSQL stack.

It uses ordinary SQLite files through Bun's native driver and starts with `npx mekka`. The current release includes table and SQL editors, user and Auth provider management, local or S3-compatible storage, realtime channels, preview branches, backup and restore, and scoped MCP access.

Agent writes are preview-first: short-lived tokens are read-only by default, changes run in an isolated database snapshot, exact SQL is recorded, and production promotion requires explicit approval.

**Deployment:**

Run `npx mekka`. It creates the project directory, installs with Bun, and starts Studio at `http://127.0.0.1:8082`. A production build and Dockerfile are included, but there is not yet a published Docker image or Compose file.

**License:** built in public under the Mekka Business License 2.0. Qualifying small organizations can use it inside their products. Third parties cannot repackage it as a competing hosted backend or cloud service without a commercial agreement.

**AI Involvement:** AI-assisted development was used. The repository includes tests, upstream provenance, security boundaries, and explicit compatibility limits. Mekka itself is designed to give coding agents scoped, preview-first database access.

**Roadmap:** local Bun + SQLite is current. A libSQL/Turso remote data plane, PGlite support, and Mekka Cloud are planned rather than shipped.

I would appreciate feedback on deployment expectations for a self-hosted v0.1, especially backup automation, reverse-proxy examples, and which container targets matter most.

### 4. r/indiehackers

**Format:** standalone post with the Self Promotion flair

Use an established account that has already contributed useful comments. Current moderation guidance warns that new accounts and promotion-only behavior may be filtered.

**Title**

I am betting most products do not need a PostgreSQL platform, so I built Mekka

**Body**

The product thesis behind Mekka is deliberately opinionated:

Most teams do not wake up wanting PostgreSQL operations. They want durable data, login, file uploads, realtime updates, and a control panel so they can get back to the product.

Supabase proved how valuable that integrated experience is. Mekka asks whether the same product surface can be smaller, SQLite-native, and designed for a world where coding agents are first-class operators.

The v0.1 stack is now runnable. It includes Data, Auth, Storage, Realtime, an embedded Studio, preview database branches, and scoped MCP access. Agent writes cannot jump directly to production. They run in an isolated preview, produce exact SQL, and wait for explicit approval.

The wedge is local and self-hosted development on Bun + SQLite. The next step is a libSQL/Turso remote data plane, followed by PGlite support and Mekka Cloud.

Repo: https://github.com/yiaany/Mekka

Start it: `npx mekka`

Mekka is source-available under the Mekka Business License 2.0. Qualifying small organizations can build with it, but a cloud vendor cannot rebrand and resell it as a competing hosted backend without an agreement.

I am not looking for polite encouragement. I want to know whether the positioning is sharp enough: does "the backend surface without the PostgreSQL fleet" describe a painful problem, or only a technical preference?

### 5. r/ChatGPTCoding

**Format:** comment in the current weekly Self Promotion Thread

Current thread on August 9, 2026: https://www.reddit.com/r/ChatGPTCoding/comments/1ve6yi1/weekly_self_promotion_thread/

**Comment**

**Mekka: a backend that lets coding agents change a database without handing them production**

I built Mekka around a problem I expect more teams to hit: agents are useful enough to propose schema and data changes, but a permanent production credential is an unacceptable trust model.

Mekka exposes scoped MCP access over a self-hosted Bun + SQLite backend. Read access is the default and tokens are short-lived. A write request creates an isolated database preview, records the migration artifact and exact SQL, validates the new schema, and waits for a one-time human approval before promotion.

The rest of the stack includes Data, Auth, Storage, Realtime, and an embedded Studio, so the agent workflow is connected to an actual backend rather than a database demo.

Models and tools: Mekka is model-agnostic and exposes an HTTP MCP endpoint. It is not tied to one coding agent or model provider.

Repo: https://github.com/yiaany/Mekka

Start it: `npx mekka`

The complete source is public under the Mekka Business License 2.0. It is available to builders but protected from being repackaged as a competing cloud backend. libSQL/Turso, PGlite, and Mekka Cloud are roadmap work.

I would like feedback on the approval boundary: what evidence would you need to see before approving an agent-generated migration?

### Optional Backup: r/webdev

Use only on Saturday and include implementation details. Do not make this a link-only showcase.

**Title**

I built a Bun + SQLite backend with an embedded Studio and preview-first agent writes

**Body**

For the last release cycle I have been building Mekka, a backend built in public that combines Data, Auth, Storage, Realtime, a browser Studio, and scoped MCP access.

The main implementation constraint was keeping tenant identity explicit across every request while still using ordinary SQLite files. Each request is bound to organization, project, environment, branch, and generation. Public query values become prepared parameters, while identifiers resolve through a schema manifest rather than being accepted as raw SQL fragments.

For agent-generated changes, Mekka creates an independent SQLite preview with `VACUUM INTO`, scrubs user rows, applies the migration artifact, validates the result, and records the exact SQL and schema hashes. Promotion requires a short-lived approval bound to that artifact and rechecks the production schema before applying it.

The current release runs on Bun's native SQLite driver. libSQL/Turso and PGlite are planned adapters rather than shipped features.

Code, screenshots, setup, and architecture: https://github.com/yiaany/Mekka

Start it: `npx mekka`

The complete source is public under the Mekka Business License 2.0. The license allows inspection and modification while preventing third parties from reselling Mekka as a competing hosted backend without an agreement.

I would value a technical review of the tenant boundary and promotion model more than general launch feedback.

## Conversion Assets To Prepare Before Launch

### P0

- Record a 60 to 90 second demo showing install, Studio, a table edit, Agent Access, preview creation, and approval.
- Create a dedicated landing page or a repository social preview that repeats the Product Hunt promise above the fold.
- Test `npx mekka` from a clean machine immediately before launch.

### P1

- Capture a measured cold start time, idle memory use, and a representative local query benchmark.
- Publish the exact test command and current passing test count.
- Add a 2 minute architecture walkthrough for technical visitors from Hacker News.
- Create issue templates for adoption blockers, engine requests, and deployment feedback.
- Prepare a public roadmap issue for libSQL/Turso, PGlite, and Mekka Cloud.

### Proof Shopping List

- One quote from a developer who successfully ran Mekka from a clean clone.
- One example application using Data, Auth, Storage, and Realtime together.
- One recorded agent migration from preview through approval and promotion.
- Restore-test evidence from a real backup artifact.
- Measured setup time on macOS, Linux, and Windows.
- Current test count and CI duration.
- Current repository stars, forks, and release downloads captured on launch morning.

Do not invent proof. As of August 9, 2026, the repository has 4 stars, 0 forks, and no uploaded `v0.1.0` release assets. These numbers should not be used as social proof yet.

## Suggested Rollout

1. Finish the P0 assets and create the Product Hunt draft.
2. Publish Show HN first and use the technical objections to improve the Product Hunt page.
3. Launch on Product Hunt at 12:01 AM Pacific on a day when the maker can answer for the full 24-hour window.
4. Publish the `r/bun` and `r/SideProject` posts on separate days.
5. Use the next eligible weekly threads for `r/selfhosted` and `r/ChatGPTCoding`.
6. Publish to `r/indiehackers` only with the required flair and after genuine community participation.
7. Use `r/webdev` on a later Saturday as a technical retrospective, not as another launch blast.

## Universal CTA Variations

1. Start Mekka with `npx mekka`
2. Inspect the architecture on GitHub
3. Try the preview-first agent workflow
4. Tell me what blocks real adoption
5. Star it if you want the libSQL adapter shipped sooner

Use option 5 only on Reddit or your own channels. Do not use it on Product Hunt or Hacker News as a request for coordinated engagement.

## Mobile Copy Notes

- Put "Bun + SQLite" in the first two lines because Reddit and Product Hunt truncate aggressively.
- Keep the first screenshot visually understandable without reading small UI labels.
- Use one idea per paragraph and keep paragraphs to three lines where possible.
- Put the repository link once near the end of Reddit posts. Repeating it looks promotional.
- Make the first Product Hunt gallery frame explain the whole category in under five seconds.

## Research References

- Product Hunt launch guide: https://www.producthunt.com/launch
- Product Hunt launch dashboard guide: https://help.producthunt.com/en/articles/479557-how-to-launch-a-product-on-product-hunt
- Product Hunt launch scheduling: https://help.producthunt.com/en/articles/484988-how-do-i-schedule-my-post
- Product Hunt community guidelines: https://help.producthunt.com/en/articles/2726886-community-guidelines
- Product Hunt launch-day guidance: https://www.producthunt.com/launch/preparing-for-launch-day
- Show HN guidelines: https://news.ycombinator.com/showhn.html
- Hacker News guidelines: https://news.ycombinator.com/newsguidelines.html
- Hacker News FAQ: https://news.ycombinator.com/newsfaq.html
- r/selfhosted rules: https://www.reddit.com/r/selfhosted/about/rules
- r/SideProject rules: https://www.reddit.com/r/SideProject/about/rules
- r/bun rules: https://www.reddit.com/r/bun/about/rules
- r/indiehackers rules: https://www.reddit.com/r/indiehackers/about/rules
- r/ChatGPTCoding rules: https://www.reddit.com/r/ChatGPTCoding/about/rules
- r/webdev rules: https://www.reddit.com/r/webdev/about/rules
