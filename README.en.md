# 2Anh Zalo Bot

[Tiếng Việt](README.md) | **English**

<p align="center">
  <a href="https://zalo.me/g/5fli05n11mnwu4ntdqhq"><img alt="Tham gia nhóm Zalo cộng đồng 2Anh" src="https://img.shields.io/badge/Zalo-C%E1%BB%99ng%20%C4%91%E1%BB%93ng%202Anh-0068FF?style=for-the-badge"></a>
  <a href="https://2anhaieducation.pro.vn/"><img alt="Trang 2Anh AI Education" src="https://img.shields.io/badge/Web-2Anh%20AI%20Education-0F766E?style=for-the-badge"></a>
  <a href="https://www.facebook.com/luonghaianh1208"><img alt="Facebook Lương Hải Anh" src="https://img.shields.io/badge/Facebook-L%C6%B0%C6%A1ng%20H%E1%BA%A3i%20Anh-1877F2?style=for-the-badge"></a>
</p>

<!-- CTA-ZALO -->
<p align="center"><strong>💬 Join the 2Anh Zalo community to try the bot for free, ask setup questions and order your own bot:</strong><br><a href="https://zalo.me/g/5fli05n11mnwu4ntdqhq"><strong>zalo.me/g/5fli05n11mnwu4ntdqhq</strong></a></p>

Connect a personal Zalo account to [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a full messaging platform alongside Telegram, Discord, and Slack.

Messages sent through Zalo reach the same Hermes agent running on your computer, with its tools, memory, skills, and scheduled jobs.

```text
Zalo  <->  zca-js sidecar (Node.js)  <->  local WebSocket  <->  Python plugins  <->  Hermes Agent
```

## Screenshots

The dashboard of the **Uyển Nhi** bot running in production on a VPS. People's names, group names and message contents are blurred.

<p align="center"><img src="docs/images/screenshots/chat-perms.jpg" width="900" alt="Chats with the group permissions panel"></p>

**Chats:** read every conversation and reply as the bot, with quote, @mention, recall, image paste and file sending. The **Quyền** button opens the permissions panel next to the chat.

| | |
|---|---|
| <img src="docs/images/screenshots/permissions.jpg" alt="Bot permissions"> | <img src="docs/images/screenshots/insight.jpg" alt="Group insight"> |
| **Per-group permissions:** turn each member feature on or off; saving takes effect immediately. | **Group insight:** busy hours, top posters, bot replies and an AI topic summary. |
| <img src="docs/images/screenshots/skills.jpg" alt="Skills"> | <img src="docs/images/screenshots/health.jpg" alt="Server health"> |
| **Skills:** exams, lesson plans, teaching-innovation reports and official documents, each switchable. | **Server health:** 24-hour CPU, RAM and disk charts, service states, Telegram alerts. |
| <img src="docs/images/screenshots/maintenance.jpg" alt="Maintenance"> | <p align="center"><img src="docs/images/screenshots/mobile-permissions.jpg" width="260" alt="Dashboard on a phone"></p> |
| **One-click updates** with automatic backup and rollback. | **Works on phones:** bottom navigation, wide chat view. |

See the bot at work in the [2Anh Zalo community group](https://zalo.me/g/5fli05n11mnwu4ntdqhq).

## Highlights

- QR-code login with persisted sessions and automatic reconnects.
- Closed-by-default authorization for direct messages and group mentions.
- Separate `owner` and `public` toolsets, enforced again at execution time.
- SQLite message history, paginated backfill, audit logs, and runtime health reporting.
- Native Zalo formatting, reactions, read receipts, typing indicators, files, links, stickers, and voice bubbles.
- Two-step confirmation for destructive actions such as recalling messages or changing group membership.
- Optional offline Vietnamese TTS with VieNeu v3 Nano and an Edge TTS fallback.
- An idempotent installer and doctor command for existing Hermes deployments.

## What sets this apart

1. **Not a standalone chatbot — a full Hermes platform.** The bot shares tools, memory, skills, and cron jobs with the same Hermes agent running on the owner's machine. Messaging on Zalo talks to that agent directly, on equal footing with Telegram, Discord, and Slack in Hermes.

2. **Two layers of authorization, not one.** Splitting tools into `zalo_owner`/`zalo_public` toolsets only hides tools from the model's tool list. The real barrier is `_owner_only` in `hermes-plugin/zalo_tools/tools.py`, which checks the sender's identity at call time for every owner tool — a misconfiguration still can't let one through.

3. **Destructive actions stay owner-only, with optional two-step codes.** Recalling a message, renaming a group, changing membership and similar actions exist only in the owner toolset and are checked again by the sidecar — the owner just asks, in a group or a direct message. Set `ZALO_CONFIRM_DANGEROUS=true` to also require a random six-character code (`_PENDING_CONFIRMATIONS`) that the owner sends back in a fresh message, which blocks instructions hidden in documents or web pages the bot reads.

4. **A token-authenticated bridge.** The local WebSocket channel between the sidecar and Hermes rejects any connection carrying a browser `Origin` header outright, and compares the token with `timingSafeEqual` — another process on the same machine cannot just connect and take over the Zalo account.

5. **Built to avoid Zalo account bans.** The rate limiter is a token bucket: a burst of 5 messages goes out immediately, then throughput settles to a sustainable 20/minute, and conversational replies are prioritized ahead of bulk operations. Losing the account means losing the whole channel.

6. **Markdown translated into Zalo's native formatting against measured limits, not guesses.** Zalo caps messages at 3000 UTF-16 code units and also rejects payloads that are too heavy (UTF-8 bytes of the text plus the style JSON) — go over and Zalo just returns "Unknown error" with no hint why. The formatter splits at readable boundaries while keeping every style; if Zalo still rejects a styled chunk, the bridge resends that chunk as plain text, so formatting is lost but content is not.

7. **SQLite history and an audit trail.** Every message is stored in SQLite with age-based retention (365 days by default); every action with real-world effect is written to `audit_log` with the acting identity and the outcome.

8. **A re-runnable installer with diagnostics and a clean uninstall.** `install:hermes` merges configuration without overwriting values the customer already changed; `doctor` runs 9 checks from the Hermes layout to the bridge token; `uninstall:hermes` removes only the managed plugin directories, leaving `.env`, the Zalo session, and `config.yaml` untouched.

## Important risk notice

`zca-js` is an unofficial client built from Zalo Web behavior. Using it may violate Zalo's terms of service and can put the account at risk.

- Always use a secondary Zalo account.
- Do not automate bulk messaging or friend requests.
- Keep group replies mention-only unless you explicitly understand the risk.
- Never publish the sidecar `data/` directory, `.env`, cookies, IMEI, SQLite databases, or bridge token.
- The QR dashboard listens on `127.0.0.1` and has no password. Do not expose it to the internet.

## Requirements

- Node.js 22 or newer.
- An existing Hermes Agent installation.
- A secondary Zalo account.
- `ffmpeg` when using voice messages or the optional Edge fallback.

The optional VieNeu provider runs on CPU and does not require an API key. Its v3 Nano model downloads roughly 282 MB on first use. For an always-on Hermes installation, about 10 GB of available RAM is a comfortable baseline; a GPU is not required.

## Install with a coding agent

Tell the agent:

> Clone this repository, install it into my existing Hermes Agent according to `AGENTS.md`, run the doctor, and report every failed check.

Before installing, the agent must ask whether you want the optional offline Vietnamese voice provider. It should explain the local CPU/RAM/disk trade-offs and must not enable it without your approval.

## Manual installation

```bash
git clone https://github.com/luonghaianh1208/2anh-zalo-bot.git
cd 2anh-zalo-bot
npm ci
npm run install:hermes -- --hermes-home <path-to-Hermes-home>
npm run doctor -- --hermes-home <path-to-Hermes-home>
```

If Hermes is in a standard location or `HERMES_HOME` is already set, you may omit `--hermes-home`.

The installer creates the sidecar `.env` when missing, generates a private bridge token, installs both Zalo plugins, merges safe defaults without replacing customer values, installs `websockets` plus the optional `pillow-jxl-plugin` (Zalo images that exist only as JPEG XL are converted to JPEG; without it the bot says so instead of guessing), and runs its doctor checks. Repeated installation preserves Zalo sessions, SQLite data, `.env`, and customer configuration.

### Optional offline Vietnamese voice

Enable VieNeu only after the customer explicitly agrees:

```bash
npm run install:hermes -- --hermes-home <path-to-Hermes-home> --vieneu-tts
npm run doctor -- --hermes-home <path-to-Hermes-home>
```

This opt-in action:

- creates an isolated Python environment at `<HERMES_HOME>/tts/.venv`;
- installs `vieneu==3.6.4` and `edge-tts` without modifying Hermes' own environment;
- installs the provider at `<HERMES_HOME>/tts/vieneu_provider.py`;
- selects VieNeu v3 Nano on CPU/ONNX with the Northern Vietnamese male voice `Minh Quân`;
- falls back to `vi-VN-NamMinhNeural` through Edge TTS if VieNeu fails;
- preserves other customer-owned TTS provider configuration.

Without `--vieneu-tts`, the installer does not download, configure, or alter TTS.

### Start and connect

```bash
npm start
```

1. Open the dashboard (`http://127.0.0.1:3880`, or the setup link printed by the installer) → **Tài khoản Zalo** (Zalo account).
2. Create and scan the QR code with the secondary Zalo account. (Port 3872 no longer serves a web page; it redirects to the dashboard.)
3. From the owner's personal Zalo account, send `/sethome` as a direct message to the secondary account. The bot replies with your UID — this does **not** grant owner rights yet.
4. Add `ZALO_ALLOWED_USERS=<that UID>` to the **Hermes** `.env`.
5. Restart the sidecar (`npm start`), then start or restart the Hermes gateway using the service manager used by that installation.

Verify the bridge:

```bash
curl http://127.0.0.1:3872/api/status
```

The response should report `"status": "logged-in"` and `"hermesAttached": true`.

## Authorization model

| Capability | Owner | Other group members |
|---|---:|---:|
| Zalo toolsets | `hermes-zalo`, `zalo_owner`, `zalo_public` | `zalo_public` only |
| Core terminal and file tools | Yes | No |
| Browser and general web tools | Yes | No |
| Target another conversation | Yes | No |
| Direct-message access | Yes | Disabled by default |

Public tools are removed before the model sees the tool list, scoped to the current conversation, and checked again in the backend. Destructive owner actions run as soon as the owner asks; set `ZALO_CONFIRM_DANGEROUS=true` in the Hermes `.env` to require a fresh six-character confirmation code as well.

Identity is re-bound on every agent turn from the message that started it, so a member's message queued behind the owner's turn never inherits owner rights. Because a group shares one session, an owner message that was still waiting while a non-owner spoke in the same conversation runs with public tools — Hermes may have merged their text into it.

## Admin dashboard

The installer also sets up a separate web dashboard (service `zalo-dashboard`, listens on `127.0.0.1` only; default `http://localhost:3880`). It shows bot status, lets you re-scan the Zalo QR code after a logout, manages customer accounts (password or one-time code sent over Zalo), and sends alerts through a Telegram bot you create with @BotFather.

- On Linux (root + systemd) the installer writes `zalo-dashboard.service`; on Windows it adds a hidden `zalo-dashboard.vbs` to the Startup folder. Without root/systemd it prints how to run `npm run dashboard` manually. Skip it entirely with `--no-dashboard`.
- The installer prints a one-time setup link (`<ZALO_DASHBOARD_URL>/#/setup/<token>`, valid 24 h) to create the first admin. Re-issue it with `npm run dashboard:setup-link`; reset a lost admin password with `npm run dashboard:reset-admin -- --username <name> --password <new>`.
- For a public domain set `ZALO_DASHBOARD_URL=https://dashboard.<domain>` and put Caddy in front; the installer prints the `reverse_proxy 127.0.0.1:3880` block. Other variables: `ZALO_DASHBOARD_PORT`, `ZALO_SIDECAR_RESTART_CMD`, `ZALO_ASSISTANT_RESTART_CMD`.
- `npm run doctor` reports `dashboard-running`, `dashboard-admin` and `dashboard-telegram` as warnings only. `npm run uninstall:hermes` removes the dashboard service but keeps its data. See `README.md` (Vietnamese) for the full walkthrough.

Phase 2 adds **Chats** (conversation list with full-text search, message view with the bot's messages on the right, scroll up for older messages, and a compose box that sends as the bot — 10 messages per minute per user, existing conversations only) and **Activity log** (bot actions merged with dashboard actions, "errors only" filter; admins also see technical codes). The dashboard reads the bot's message history read-only, so it stays visible while the Zalo connection is down. The Overview now shows today's message counts and the five busiest groups.

Phase 3 adds **Bot permissions**: per-group switches stored in `<HERMES_HOME>/zalo/permissions.json` — *Active*, *Reply only when tagged*, and ten features (web search, files, voice, reminders, group schedules, knowledge base, people notes, academic search, video, **Conversation history lookup** — on by default; members can only look up the conversation they are in, max 30 days, 40 messages, 20 lookups per hour), plus a default for groups without their own entry. Saving takes effect on the bot's next turn without a restart: the Hermes plugin re-reads the file when it changes, refuses member tool calls for disabled features with a plain Vietnamese reason, and tells the model which features are off. The bot owner (`ZALO_ALLOWED_USERS`) is never restricted by this file, direct messages are not affected, and a missing or corrupt file means everything is on. The page warns before you leave with unsaved changes.

Phase 4 adds **Branding** and **Bot owners**. Branding (admins and bot owners) sets the dashboard name, a logo (PNG/JPEG/WebP, resized to ≤ 256 px in the browser and stored as PNG; SVG is refused) and a colour that must give white text a contrast of at least 4.5:1; the login page shows it before sign-in through the public, read-only `GET /api/brand` and a generated `/brand.css`. Bot owners (admins only) edits `ZALO_ALLOWED_USERS` in the Hermes `.env` — only that line, with a `.env.bak` — never allowing an empty list, then asks for a restart of the Zalo connection (the Hermes gateway reloads `.env` every turn, so the assistant sees the change at once; only the Zalo bridge reads the variable at start-up). Until then a newly added owner does not yet have the full owner commands. A `ZALO_ALLOWED_USERS` set in the bot folder's `.env` or in the service environment overrides the list, and the page warns about both. The Users page now shows each account's last sign-in.

Phase 5 adds **Direct messages** and **Server health**. Direct messages (Bot permissions -> "Nhắn riêng", both roles) chooses who may DM the bot — owners only, a list of people, or everyone — eight feature switches for DMs (the group switches minus group cron), and per-person overrides. It is stored as an optional `dm` section of `permissions.json` (still `version: 1`, ignored by older readers) and enforced twice: the Hermes plugin gates inbound DMs and tool calls, and the Zalo bridge refuses outgoing commands for DM turns of people who are not allowed (owners are always exempt; `/sethome` replies still go out). Without a saved `dm.who` the bot keeps following `ZALO_DM_POLICY`. Server health (both roles; systemd unit names, ports and PIDs for admins only) shows CPU, RAM, disk and uptime with 24-hour SVG charts sampled every minute, service states (`systemctl list-units` on Linux; port/PID probes on Windows), Telegram alerts for disk > 90 %, RAM > 90 % for 5 minutes or CPU > 90 % for 10 minutes, and AI calls and tokens per day read from the Hermes `state.db` (no money figures: neither Hermes nor 9router reports a reliable per-bot cost). The Hermes plugin, the Zalo bridge and the dashboard must be updated together.

Phase 6 adds the **Product studio** ("Xưởng tạo sản phẩm"). Non-owners (group members and people allowed to DM the bot) can ask for slides with AI or web images, lesson plans and official documents (ND30, Youth Union, Party), exams, SKKN, six quiz-game templates, virtual experiments, explainer videos (handwriting, cut-paper, Vox) and narrated lecture videos made with 2Anh Studio; the bot queues the job and posts the file back to the same chat. Each product type is a switch (off by default) in the defaults, each group, the DM section and each DM person; a per-person daily quota (default 3) is overridden by the group's quota, which in turn is overridden by a per-person quota (the most specific one wins; 0 means nobody, except people with their own quota); owners are unlimited. A quota is refunded only when a job fails on a machine error before spending anything (no images, negligible tokens), and at most `quota` refunds per person per day; a gateway restart mid-job counts against the quota if the job had already spent tokens or images. Security model: the public `zalo_studio` tool only accepts jobs; content is written by a host LLM call with **no tools** (`ctx.llm`) and may only *request* images (a prompt or search keywords); images are generated at the owner's image endpoint or fetched from Openverse by fixed plugin code in the parent process (https only, every resolved address must be public, connection pinned to the checked IP, PNG/JPEG magic bytes, 8 MB cap) and referenced by opaque ids; content is validated and rendered by fixed scripts in a child process with a scrubbed environment - on Linux inside a `systemd-run` sandbox as `nobody` with `/root` hidden and no network except for speech synthesis, which can only reach DNS (loopback, private ranges and the host's own addresses stay blocked). On Windows (no OS sandbox) video is always off. Usage, tokens and images per person are shown under Server health. New keys in `permissions.json` are ignored by older readers; missing or unreadable keys mean "off".

Phase 7A (1.26.0) adds six pages and regroups the sidebar into Overview · Conversations · Data · System · Admin. **Contacts**: the bot's friends, people who messaged it, people with profiles, and pending friend requests (Accept / Reject). **Schedules**: the assistant's Zalo-bound cron jobs (pause, resume, remove) and per-conversation Zalo reminders. **Memory**: edit or delete people-book profiles; admins can also edit the assistant's MEMORY.md / USER.md entries (temp file + `.bak`, refused with 409 if the bot just wrote). **Knowledge base**: list the documents the bot can read and upload .docx/.pdf/.md/.txt (≤ 10 MB) into a dedicated folder. **Group insight**: messages per day, top posters, busy hours, message types, and an on-demand AI "topic summary" (no tools; `ZALO_INSIGHT_DAILY` per day, default 10; `ZALO_INSIGHT_AI=off` disables it). **Second brain** (admins only, Linux/VPS only): search, browse and add notes to the OpenViking store on the same machine. It is off by default, enabled with `ZALO_SECOND_BRAIN_URL=http://127.0.0.1:1933` in the Hermes `.env` (loopback only; always off on Windows regardless of config; reads limited to three roots; writes limited to new notes under `so-tay-dashboard`; every write is logged). The installer only prints a hint when it sees OpenViking, and `npm run doctor` reports a `second-brain` line. Optional: `ZALO_HERMES_BIN`. Update the Zalo bridge, the Hermes plugin and the dashboard together; see `README.md` (Vietnamese) for the manual checklist.

Phase 7B (1.27.0) adds five admin-only pages (owners never see them; the API answers 403). **Agent**: switch the model (only names listed by the AI gateway; takes effect immediately, like `/model`), the reasoning level, and the SOUL.md persona with 30 snapshots plus the original. **Tools**: every Zalo tool, who can use it and which permission switch controls it; turn individual public tools off for non-owners (`tools.off` in `permissions.json`, immediate; owners are exempt). **Agent trace**: the assistant's sessions read-only from Hermes `state.db` (Zalo, cron, all), turn by turn, with tool calls (argument names and types only, never values), ok/error status, timings, tokens and model; tool results and system prompts are never shown, and secret-looking strings in previews are masked. **MCP connections**: the MCP servers in `config.yaml` (name, transport, host:port or command name — never env, headers, args or URL paths), whether members may use them (`ZALO_PUBLIC_MCP`), a status probe that only touches loopback addresses (stdio servers are not spawned), and enable/disable; adding servers stays a server-side `hermes mcp install`. **Settings**: a fixed allowlist of 13 non-secret settings with typed validation, each written where it is currently effective (`platforms.zalo.extra` in `config.yaml` or the Hermes `.env`, both with `.bak`, atomic writes and a 409 when `config.yaml` changed underneath), plus per-group welcome messages. Everything except the model, tools and welcome messages needs an assistant restart, shown in a shared yellow banner with a one-click restart. Update the Hermes plugin and the dashboard together; see `README.md` (Vietnamese) for the manual checklist.

### Bot owners can run system commands from Zalo

Every UID in `ZALO_ALLOWED_USERS` may type Hermes commands straight into a Zalo chat; the sidecar re-reads the variable when the Hermes `.env` changes, so a new owner works on the next message without restarting the bridge.

| Command | Who | Notes |
| --- | --- | --- |
| `/new` `/reset` `/clear` `/STOP` | every owner | `/STOP` stops the Hermes gateway (the assistant stops answering until started again) |
| `/model` `/skills` `hermes model list` `hermes skills list\|check\|search\|inspect\|audit` `hermes doctor` `hermes gateway status` `hermes sessions list\|resume` `hermes profile list` `hermes --profile <name> <read command>` | every owner | read-only; output is returned as text, secrets redacted |
| `/memory` `/remember <text>` | every owner | reads and appends to the assistant's long-term memory |
| `hermes update` `hermes setup` `hermes gateway start\|setup` `hermes skills install\|update` `hermes profile create` `hermes config set security.*` `hermes model <name>` | **main owner only**, plus the word `xác nhận` at the end (e.g. `hermes update xác nhận`) | machine-changing; the confirmation word is checked by the sidecar against the raw message, so the assistant cannot add it on a user's behalf |

Commands run as argument vectors (never through a shell), long ones (`update`, `gateway start`) run detached, and tokens or keys found in the output are replaced with `***`.

Hermes' own slash commands (`/new`, `/clear`, `/reset`, `/stop`, `/compress`, `/model`…) are owner-only; anyone else gets a plain Vietnamese refusal. Non-owners keep `/help`, `/whoami`, `/status`, `/context`.

### Long-term memory (self-learned, off by default — Linux servers only)

The bot extracts what is worth remembering from conversations (how people want to be addressed, preferences, unfinished work) and recalls it next time — **separately for every group and every person**: one group never sees another group's memory or anyone's private messages. For exact questions about the past ("who sent which file the other day") the bot looks up the real message history with `zalo_thread_history` instead of relying on memory. When the owner says "remember…" / "forget…", the bot writes or deletes inside the memory of the conversation it is speaking in.

Requires OpenViking running on the same machine (`127.0.0.1:1933`, `auth_mode: dev`, no API key). To enable:

1. In Hermes `config.yaml`: `memory.provider: zalo_memory` (keep `OPENVIKING_ENDPOINT=http://127.0.0.1:1933` in `.env`).
2. Restart the gateway. `npm run doctor` then shows `long-term-memory - bật — zalo_memory…`.

Dashboard › Memory › **Self-learned knowledge** (Vietnamese UI label "Kho tri thức tự học"): admins and bot owners view, search, edit and delete (the bot owner's private-message memory is visible to admins only, enforced server-side). Admins set the extraction interval (30–1440 minutes, default 120) and press "Rút trí nhớ ngay" (extract now; 3 per store per day). To turn off: set `memory.provider: ''` and restart the gateway (data is kept). Never enabled on Windows.

## Configuration

The installer manages these Hermes configuration areas without overwriting explicit customer values:

- `known_plugin_toolsets.zalo`
- `plugins.enabled`
- `platforms.zalo`
- `display.platforms.zalo`
- top-level `group_sessions_per_user`

Owner identity and gateway admission remain environment settings:

```env
ZALO_BRIDGE_URL=ws://127.0.0.1:3873
ZALO_BRIDGE_TOKEN=<same generated value as the sidecar>
ZALO_ALLOWED_USERS=<owner Zalo UID>
ZALO_HOME_CHANNEL=<owner Zalo UID>
ZALO_GROUP_REPLY_ONLY_TAGGED=true
```

A Zalo UID is normally a long 17–21 digit value and is not a phone number.

The plugin ships a message style guide and fixed rules (`hermes-plugin/zalo/style-guide.md`), distilled from months of running the bot for real: formatting, LaTeX, look things up before stating facts, use the real current time, keep internal chatter out of groups, wait for explicit orders on risky actions. It travels with the plugin and updates with every release; the installer removes old copies it once wrote into `platform_hints.zalo.append` and keeps whatever you wrote yourself. Customisable parts — how the bot addresses people, tone, length, emoji, text colours, file-name pattern, extra notes — live in the dashboard under Cấu hình › **Phong cách trả lời**, apply immediately and do not use the bot's memory. Memory is for facts only (about you, links, prices).

## Agent tools

48 tools total, split into three toolsets: 32 owner-only, 15 shared with everyone in a group, and 1 (`zalo_group_history`) that only exists inside group cron jobs. `ZALO_ALLOWED_USERS` decides who counts as the owner.

| Group | Tools |
|---|---|
| Facebook Page | `zalo_fb_pages` `zalo_fb_posts` `zalo_fb_comments` `zalo_fb_draft` `zalo_fb_publish` `zalo_fb_check` |
| Send content | `zalo_send_file` `zalo_make_file` `zalo_pdf` (PDF → Word, merge, split) `zalo_send_voice` `zalo_send_sticker` `zalo_send_link` `zalo_forward` |
| Read context | `zalo_read_history` `zalo_list_groups` `zalo_group_members` `zalo_find_user` `zalo_user_info` `zalo_list_friends` |
| Zalo-specific | `zalo_create_poll` `zalo_poll_detail` `zalo_lock_poll` `zalo_create_note` `zalo_create_reminder` `zalo_list_reminders` `zalo_remove_reminder` `zalo_pin_conversation` `zalo_mute` `zalo_group_welcome` |
| Fix mistakes & administration | `zalo_undo` `zalo_rename_group` `zalo_group_member_change` `zalo_group_deputy` `zalo_pending_members` `zalo_review_member` |
| Create groups & invites | `zalo_create_group` `zalo_invite_to_groups` `zalo_group_link` `zalo_join_group_link` |
| Friends (only with `ZALO_FRIEND_TOOLS=true`) | `zalo_send_friend_request` `zalo_accept_friend_request` `zalo_friend_group` |
| Bot profile | `zalo_set_bio` `zalo_set_active_status` |
| Knowledge base | `zalo_kb_list` `zalo_kb_read` |
| Web lookup | `zalo_web_search` `zalo_web_read` (incl. public Google Docs/Sheets/Slides) `zalo_academic_search` (PubMed, Europe PMC, arXiv, OpenAlex, CORE, Crossref; open-access PDF by DOI, PubMed Central full text, DOAJ journal check, citations) `zalo_weather` (Open-Meteo) `zalo_exchange_rate` (incl. VND; Frankfurter + Currency-api) `zalo_dictionary` (Free Dictionary + Wiktionary) `zalo_species` (iNaturalist + GBIF) — all keyless; the dashboard lists them with links under Khoá API & Model › **API miễn phí** |
| Video | `zalo_video_info` (title, description, transcript) `zalo_video_download` (Full HD, only when asked) |
| People notebook | `zalo_remember_person` `zalo_recall_person` `zalo_list_people` `zalo_forget_person` |
| Group cron jobs | `zalo_group_cron` `zalo_group_history` |

The bridge accepts only allowlisted `zca-js` operations. High-risk automation such as blocking users, dissolving groups, or money-related operations is deliberately excluded.

Friend tools are off by default. With `ZALO_FRIEND_TOOLS=true` the owner can send or accept a friend request, or run `zalo_friend_group`: the sidecar sends the requests, and as soon as the **first** person accepts it creates the group with that person and the owner, adding later accepters to it and reporting back to the chat the command came from (plans live in `data/friend-groups.json`, expire after 30 days, and are re-checked every 10 minutes in case an event was missed). Friend requests that strangers send to the bot are never accepted automatically; the owner gets a direct message instead.

### Group cron jobs

Anyone in a group can ask the bot to schedule a job for that group ("remind everyone at 7am every Monday", "summarize today's chat at 9pm"). `zalo_group_cron` creates the Hermes cron job itself and locks every dangerous field: results go only to that group, the job runs with `zalo_cron_member` (web search/read, knowledge base, and that group's own history — no terminal, no files, no MCP), and scripts, working directories, skills and model overrides are never accepted. Limits: repeats at most once a day, 3 active jobs per person, 10 per group. Only the creator or the owner can remove a job. Cron jobs the owner creates with Hermes' own cron tool keep full owner authority for Zalo tools when the job delivers to Zalo, and can now deliver to any group.

## Health and history

`GET /api/health` reports the Zalo session and listener state (`zalo.listener` other than `connected` marks health `degraded` — logged in but not receiving is still a deaf bot), Hermes connection state, SQLite and audit counts, backfill progress, recent traffic, and the last runtime error. Message history and audits are stored in the sidecar SQLite database; Hermes conversation memory remains in Hermes' own `state.db`.

## Troubleshooting

| Symptom | Common cause |
|---|---|
| `no saved session` | QR login has not completed or the saved cookie expired |
| `hermesAttached: false` | Hermes is stopped or the bridge URL/port is wrong |
| No direct-message reply | `/sethome` was not completed or the owner UID is absent |
| No group reply | The bot was not tagged; mention-only replies are the default |
| `Unauthorized user ... on zalo` | The sender is not admitted by the configured policy |
| Markdown markers appear literally | The sidecar is outdated; pull and restart it |
| Port already in use | Change `ZCA_PORT` or `ZALO_BRIDGE_PORT` consistently |
| VieNeu doctor check fails | Re-run the opt-in installer and confirm Python 3.10+, disk, and initial-download network access |

Sidecar logs are printed by `npm start` and also copied with timestamps to `logs/sidecar.log` (rotated to `logs/sidecar.log.1` past 5 MB), so a background sidecar can still be diagnosed. Hermes gateway logs live under `<HERMES_HOME>/logs/gateway.log`.

## Uninstall

```bash
npm run uninstall:hermes -- --hermes-home <path-to-Hermes-home>
```

The uninstaller removes only the managed Zalo plugin directories. It preserves the sidecar `.env`, Zalo session/history, and optional TTS environment, and does not edit Hermes `config.yaml` — the `plugins.enabled`, `platforms.zalo`, and `known_plugin_toolsets.zalo` entries stay behind, so remove them by hand if you are not reinstalling. Each install also keeps the previous file as `config.yaml.bak-<timestamp>`.

## Community

Try the bot before ordering, ask installation questions, or see what other people use it for: join the **2Anh Zalo community group**. It is open to everyone, not only teachers, and a live bot is in the group so you can talk to it.

- 💬 2Anh Zalo community group: <https://zalo.me/g/5fli05n11mnwu4ntdqhq>
- 🌐 2Anh AI Education: <https://2anhaieducation.pro.vn/>
- 👤 Author on Facebook (Lương Hải Anh): <https://www.facebook.com/luonghaianh1208>

The admin dashboard has the same link: the **Cộng đồng 2Anh** button on the status bar at the top of every page.

## Ủng hộ tác giả / Support the author

Nếu dự án này hay và hữu ích với anh chị, một ly cà phê ủng hộ sẽ giúp 2Anh AI có thêm động lực phát triển tiếp. Cảm ơn anh chị rất nhiều!

If this project is useful to you, you can buy the author a coffee via Vietnamese bank transfer (VietQR):

<p align="center">
  <img src="docs/images/donate-qr.jpg" width="240" alt="VietQR — MB Bank 0328186264 LUONG HAI ANH">
</p>

| Ngân hàng / Bank | Số tài khoản / Account | Chủ tài khoản / Name |
|---|---|---|
| MB Bank | `0328186264` | LUONG HAI ANH |

The same QR is in the admin dashboard (the **Ủng hộ tác giả** button on the status bar at the top of every page).

## License

MIT — see [LICENSE](LICENSE).

This project is not affiliated with Zalo or VNG. `zca-js` belongs to [RFS-ADRENO/zca-js](https://github.com/RFS-ADRENO/zca-js).
