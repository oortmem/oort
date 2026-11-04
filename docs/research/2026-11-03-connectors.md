# Oort as a connector: Claude, ChatGPT, Codex and other MCP hosts

Date: 2026-11-03
Status: research note for Marcus to accept or reject item by item (see the last section)
Question: how should Oort be delivered as a connector to each host, and what does each host require?

Inputs read: design doc §6 (read and write paths), §7 (integration surfaces), §9 (cloud,
`managed` vs `zero-knowledge`), §13 (Observatory), §14 (data lifecycle); and
`packages/core/src/adapters.ts` (`Observation`), `recall.ts` and `model.ts`, because the shape of
`observe` decides what a chat-facing tool can take in.

Sources, all fetched or cloned on 2026-11-03:

| Source | What | Snapshot |
| --- | --- | --- |
| `https://claude.com/docs/llms-full.txt` | Claude connector, plugin, directory and MCP App docs (full export, 48,886 lines) | fetched 2026-11-03 |
| `https://code.claude.com/docs/en/{mcp,hooks,plugins/components}.md` | Claude Code MCP, hooks, plugin docs | fetched 2026-11-03 |
| `https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md` | Anthropic memory tool prompt | fetched 2026-11-03 |
| `https://support.claude.com/en/articles/13145358` | Anthropic Software Directory Policy (read with a fetch tool that returns short verbatim excerpts) | fetched 2026-11-03, page says "Updated this week" |
| `https://developers.openai.com/plugins/llms-full.txt` | OpenAI Plugins (formerly Apps SDK) docs, full export | fetched 2026-11-03 |
| `https://developers.openai.com/api/docs/guides/custom-mcp-server.md` | ChatGPT custom MCP server guide | fetched 2026-11-03 |
| `https://learn.chatgpt.com/docs/{extend/mcp,hooks,plugins,pricing,customization/memories,cloud}.md` | ChatGPT and Codex product docs | fetched 2026-11-03 |
| `https://modelcontextprotocol.io/specification/2026-07-28/...` | MCP spec (changelog, versioning, transports, authorization, discover) | fetched 2026-11-03 |
| `modelcontextprotocol/modelcontextprotocol` | `docs/extensions/client-matrix.mdx` | `3c4d91b`, 2026-11-02 |
| `modelcontextprotocol/ext-apps` | MCP Apps spec and SDK (`@modelcontextprotocol/ext-apps` 2.0.4) | `cf599cc`, 2026-10-29 |
| `modelcontextprotocol/servers` | `src/memory` reference server | `194cc86`, 2026-10-28 |
| `modelcontextprotocol/mcpb` | `MANIFEST.md` | `70fe3b3`, 2026-04-22 |
| `google-gemini/gemini-cli` | `docs/tools/mcp-server.md`, `docs/hooks/` | `0ac57c0`, 2026-11-02 |
| Cursor, Microsoft, Google Cloud, Cloudflare docs | read with a fetch tool (summaries plus quotes) | fetched 2026-11-03 |

Clones live under the session scratchpad (`research-connectors/`), not in the repo.

Things I could not reach: `help.openai.com` returns 403 to automated fetches, so ChatGPT
plan-by-plan gating for custom MCP servers is **unverified**. Perplexity's and the consumer
Gemini app's own help pages did not turn up; only third-party write-ups did, which this note does
not use as evidence.

---

## Recommendation

Build **one MCP server definition** (tool names, schemas, annotations, descriptions, server
instructions, and MCP Apps widgets) in a shared package, and ship it over two transports. The
**remote connector** is a Streamable HTTP server on Cloudflare Workers at
`https://mcp.oortcloud.dev/mcp`, sitting in front of the Oort Cloud `Memory` API. It runs its own
OAuth 2.1 authorization server, with CIMD first, DCR as a fallback, PKCE S256 and RFC 9207 `iss`.
It answers both the legacy (`initialize`) and the 2026-07-28 stateless protocol eras. People who
don't code can add it today as a custom connector by pasting a URL into Claude (web, desktop, and
mobile once added) and ChatGPT, with no review needed. The **local server** (CON-18) is a stdio
server shipped as an MCPB for Claude Desktop, as a Claude Code plugin, and as config snippets for
Codex, Cursor and Gemini CLI. It is the only way `zero-knowledge` users get memory in a host,
because only a local process can hold the DEK.

Chat hosts have no lifecycle hooks, so the chat tool set has to be **directory-safe**:
- `remember` takes one to five distilled facts, never a transcript.
- Recall-before-answer guidance goes in short server instructions and in a bundled skill, not in
  tool descriptions.
- Coding hosts (Claude Code, Codex, Gemini CLI) keep hook-based auto-capture, and can point those
  hooks at the remote server with `mcp_tool` hooks.

**Directory listings are the hard part, not the protocol.** Anthropic's Software Directory Policy
§1.G forbids software that "persistently store[s] … conversation content to build user profiles
or attempt[s] to make any changes to Claude's behavior across sessions". OpenAI requires
functionality "not natively supported by the products' built-in capabilities", and ChatGPT and
Codex both have built-in memory. Plan on running as a custom connector first, and clear policy
questions with both vendors before submitting.

---

## Per-host summary

| Host | Transport | Auth | How users install | UI (MCP Apps) | Write-tool rules | Directory / review | Plan limits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Claude web, desktop, mobile** | Remote Streamable HTTP; legacy HTTP+SSE still accepted | OAuth 2.0: DCR or CIMD by default; Anthropic-held client creds; static headers (beta, limited orgs); none | Customize > Connectors > Add custom connector > URL. Mobile shows connectors added on web or desktop | Yes on web and desktop; mobile renders in a native WebView | Every tool needs `title` plus `readOnlyHint` or `destructiveHint`. Read-only tools can run without per-call confirmation; destructive tools always prompt; users set Always allow, Needs approval or Blocked per tool | Custom connector: no review. Directory: automated scan, then Community label; may be escalated to Verified | Custom connectors on Free (one), Pro, Max, Ultra, Team, Enterprise. On Team and Enterprise an Owner adds them. Submitting needs a paid plan |
| **Claude Desktop (local)** | stdio via MCPB bundle or `claude_desktop_config.json` | None (local); `user_config` with `sensitive: true` for secrets | Double-click or drag in the `.mcpb`, or Settings > Extensions | Yes (MCP Apps examples run locally) | Same client rules | MCPB listings deprecated; local servers reach the directory only inside a plugin | Desktop app signed in to claude.ai; org can disable extensions |
| **Claude Code** | stdio, HTTP, SSE, WebSocket; claude.ai connectors sync in | OAuth with its own CIMD and a loopback redirect on any port; headers | `claude mcp add --transport http …`, a plugin (`.mcp.json` + skills + hooks), or a synced claude.ai connector | No (client matrix) | Permission rules; hooks, including `mcp_tool` hooks | Plugin directory (Pro and up) or your own marketplace | Any Claude Code user |
| **ChatGPT (web, desktop, mobile)** | Remote Streamable HTTP or SSE; Secure MCP Tunnel | OAuth 2.1: CIMD (`none` or `private_key_jwt`), DCR, or a predefined client; PKCE S256; RFC 9207 `iss`; no M2M grants or custom API keys | chatgpt.com/plugins > + > Add custom MCP server > URL > auth > "I understand" > Create as a plugin > install > `@` it | Yes: MCP Apps standard, plus optional `window.openai` extensions | Tools without `readOnlyHint` count as writes; writes need confirmation by default; approval can be remembered for one conversation | Plugin portal: org identity verification, domain challenge, scan, manual review; one live version per MCP integration | Custom MCP plan gating **unverified** (help center blocked). Workspace permissions and Lockdown apply |
| **Codex (ChatGPT desktop app, CLI, IDE)** | stdio and Streamable HTTP in `config.toml` | Bearer token env var, static headers, header helper, OAuth (CIMD and DCR) | `codex mcp add`, `[mcp_servers.oort]` in `~/.codex/config.toml`, or desktop Settings > MCP servers | No for local MCP (not documented) | `default_tools_approval_mode` = `auto`, `prompt`, `writes` or `approve`; per-tool overrides | Same universal plugin directory as ChatGPT; plugins with hooks can't go to the public directory | MCP, plugins and connectors listed for Plus, Pro, Business, Enterprise |
| **Codex Cloud** | Not documented | n/a | n/a | n/a | n/a | n/a | **Unverified**: no MCP in Codex Cloud docs |
| **Gemini CLI** | stdio, SSE, `httpUrl` streaming HTTP | OAuth auto-discovery with DCR; static headers; localhost redirect | `mcpServers` in `settings.json` | Not documented | Not researched | Extensions | Open source |
| **Gemini Enterprise** | Streamable HTTP only | OAuth 2.0 with a manually registered client, or none | Admin creates a custom MCP data store | Not documented | Every action needs confirmation unless `readOnlyHint`; at most 100 actions | Admin-only | Gemini Enterprise; admin role |
| **Gemini app (consumer)** | **Unverified** | **Unverified** | **Unverified** | **Unverified** | **Unverified** | **Unverified** | **Unverified** |
| **Cursor** | stdio, SSE, Streamable HTTP (`.cursor/mcp.json`) | OAuth PKCE, DCR (public client), static client ID | Edit `mcp.json` | Yes | Approval by default; run modes; enterprise allowlists | n/a | Not researched |
| **Microsoft 365 Copilot** | MCP plugins for declarative agents | Not researched | Developer or admin packages a declarative agent with the Agents Toolkit | Yes | Retrieval tools skip confirmation; modifying tools need it by default | Tenant or Microsoft certification | M365 Copilot licensing (not researched) |
| **Perplexity** | **Unverified** | **Unverified** | **Unverified** | **Unverified** | **Unverified** | **Unverified** | **Unverified** |

Sources for each cell are in the findings below.

---

## 1. Claude connectors

### 1.1 Remote MCP and transport

- Claude connects to one remote MCP server from claude.ai, Claude Desktop, Claude mobile, Cowork
  and Claude Code, and "the same connector infrastructure backs all of them".
  Source: https://claude.com/docs/connectors/building/index
- Transport: "Use Streamable HTTP … Claude also supports the legacy HTTP+SSE transport, which is
  being deprecated". A remote server is "the recommended kind for a directory listing".
  Source: https://claude.com/docs/connectors/building/index
- Claude does not yet support resource subscriptions, sampling, or "advanced or draft
  capabilities". It does support tools, prompts and resources, with text and image results.
  Source: https://claude.com/docs/connectors/building/index
- Limits: tool results up to about 150,000 characters and a 240-second tool timeout on claude.ai
  and Desktop. In Claude Code the limit is 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`) and the timeout
  is `MCP_TOOL_TIMEOUT`.
  Source: https://claude.com/docs/connectors/building/index
- Anthropic's traffic comes from `160.79.104.0/21`, and discovery requests to your authorization
  server come from the same range. A WAF in front of the identity provider can break sign-in.
  Source: https://claude.com/docs/connectors/building/authentication

### 1.2 Authentication

- Supported types, from the docs table:
  - `oauth_dcr`: default
  - `oauth_cimd`: default
  - `oauth_anthropic_creds`: entered in the developer portal
  - `custom_connection`: email `mcp-review@anthropic.com`
  - `static_headers`: "Beta, for a limited set of organizations"
  - `none`
  Source: https://claude.com/docs/connectors/building/authentication
- Claude follows the 2025-03-26, 2025-06-18 and 2025-11-25 authorization specs. 2026-07-28 is not
  listed. Source: https://claude.com/docs/connectors/building/index
- Where Claude is stricter than the spec:
  - A `401` is required to start sign-in; `WWW-Authenticate` on a `200` is ignored.
  - Only the first `authorization_servers` entry is used.
  - CIMD is used only when the authorization server metadata advertises both
    `"client_id_metadata_document_supported": true` and `"none"` in
    `token_endpoint_auth_methods_supported`; otherwise Claude falls back to DCR.
  - Discovery, registration and token endpoints get 10 seconds; refresh gets 30 seconds.
  - No `client_credentials` grant.
  Source: https://claude.com/docs/connectors/building/authentication
- "For servers expecting high traffic from the directory, prefer CIMD or `oauth_anthropic_creds`
  over DCR", because DCR registers a new client on every fresh connection.
  Source: https://claude.com/docs/connectors/building/authentication
- Redirects: hosted apps use exactly `https://claude.ai/api/mcp/auth_callback`. Claude Code uses
  an RFC 8252 loopback redirect on any port, declared as `http://localhost/callback` and
  `http://127.0.0.1/callback` in its CIMD. Match both while ignoring the port.
  Source: https://claude.com/docs/connectors/building/authentication
- PKCE S256 on every request; advertise `code_challenge_methods_supported: ["S256"]`. Claude
  appends `offline_access` when the authorization server lists it. The `resource` in protected
  resource metadata must equal the server URL exactly.
  Source: https://claude.com/docs/connectors/building/authentication
- Token refresh: reactive on `401`, and proactive up to five minutes before expiry. Return
  `invalid_grant` for a dead refresh token, rotate refresh tokens for public clients, and accept
  `application/x-www-form-urlencoded` at `/token`.
  Source: https://claude.com/docs/connectors/building/authentication
- With static headers, the credential is the organization's, not a person's: "don't use it to
  identify which user is calling".
  Source: https://claude.com/docs/connectors/building/authentication

### 1.3 How users add a custom connector, and plans

- "Add a connector by URL" works on "Free, Pro, Max, Ultra, Team, and Enterprise plans". "On the
  Free plan, you can add one custom connector."
  Source: https://claude.com/docs/connectors/custom/add-unlisted
- Free, Pro, Max and Ultra: Customize > Connectors > Add custom connector > URL > optional OAuth
  client > Add. Team and Enterprise: an Owner adds it under Organization settings > Connectors,
  then members click Connect. Auth choices are "Sign in now", "Sign in when needed" and
  "No sign-in"; client identity choices are Claude's published CIMD (recommended), automatic DCR,
  or your own client.
  Source: https://claude.com/docs/connectors/custom/add-unlisted
- Mobile: "users must add a connector on web or desktop before it appears on mobile".
  Source: https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
- Where connectors work: web (remote, including MCP Apps), desktop (remote plus local
  extensions), mobile (remote), and Claude Code (connectors added in claude.ai sync in).
  Source: https://claude.com/docs/connectors/getting-started
- Per-conversation toggles live under + > Connectors. Per-tool permissions are Always allow,
  Needs approval or Blocked.
  Source: https://claude.com/docs/connectors/getting-started

### 1.4 Directory review criteria and submission

- **Read/write split.** A catch-all tool that accepts both safe and unsafe methods is rejected:
  "Ideally, split write operations further by action type: create, update, and delete."
  Source: https://claude.com/docs/connectors/building/review-criteria
- **Annotations.** "Every tool must include a `title` and the applicable hint: `readOnlyHint: true`
  … `destructiveHint: true` … Read-only tools can run without per-call confirmation, and
  destructive tools always prompt."
  Source: https://claude.com/docs/connectors/building/review-criteria
- **Names.** "Tool names must be 64 characters or fewer." Listing: name up to 100 characters,
  one-liner up to 200, description up to 2,000, one to five categories, and a slug that is
  permanent once published.
  Source: https://claude.com/docs/connectors/building/review-criteria and
  https://claude.com/docs/connectors/building/submission
- **Prompt injection.** "Describe what the tool does, and don't tell Claude how to behave."
  Descriptions are rejected if they:
  - instruct Claude to call tools the user didn't request
  - interfere with other tools
  - direct Claude to pull instructions from external sources
  - contain hidden or encoded instructions
  - "Tell Claude to behave in ways unrelated to the tool's function, attempt to override system
    instructions, or promote products"
  Source: https://claude.com/docs/connectors/building/review-criteria
- **Data rules.** "Don't collect conversation data beyond what the tool needs for its function"
  and "Don't query Claude's memory, chat history, conversation summaries, or user files."
  Source: https://claude.com/docs/connectors/building/review-criteria
- **Software Directory Policy §1.G** (full text, quoted in pieces by the fetch tool): "Software
  must not query or extract data from Claude's memory, chat history, conversation summaries, or
  user-generated or uploaded files and must not persistently store or use conversation content to
  build user profiles or attempt to make any changes to Claude's behavior across sessions." §1.E:
  "Software must only collect data from the user's context that is necessary to perform their
  function. Software must not collect extraneous conversation data, even for logging purposes."
  The policy has no memory-service exception, and the fetch found no "unless" or "except".
  Source: https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- **Submission.**
  - Requirements: an HTTPS URL; OAuth 2.0 for authenticated services; test credentials for a
    "fully populated account"; documentation and privacy policy URLs; an icon.
  - MCP Apps: 3 to 5 PNG carousel screenshots, each at least 1000 px wide.
  - Ten portal steps, ending with seven compliance acknowledgments, including "prompt injection"
    and "conversation data collection".
  - The listing goes live as Community after an automated scan; Verified is escalated
    automatically.
  - Per-customer URL patterns publish only once Verified.
  Source: https://claude.com/docs/connectors/building/submission
- Who can submit: Pro, Max, Ultra, Team or Enterprise ("Free accounts can't submit"). On Team and
  Enterprise an Owner submits. If a plugin points at your remote server, also submit the server as
  a connector.
  Source: https://claude.com/docs/directory/publish

### 1.5 Tool count and description limits

- Hosted Claude surfaces: no documented cap on tool count or description length. **Unverified.**
- Claude Code: "doesn't impose a fixed per-server tool cap". It cuts server instructions and
  upfront tool descriptions at 4,096 characters, and descriptions loaded through tool search at
  16,384 (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`). The full tool name `mcp__<server>__<tool>`
  must be 128 characters or fewer. Only tool names and server instructions load at session start.
  Source: https://code.claude.com/docs/en/mcp

### 1.6 `clientInfo.name`

- "You may see `"name": "claude-ai"`, `"name": "Anthropic"`, sometimes with a service suffix, or
  `"name": "claude-code"` … Don't gate behavior on an exact `name` or `version` string … it must
  never feed an authorization decision."
  Source: https://claude.com/docs/connectors/building/testing

### 1.7 MCP Apps

- Build with the MCP Apps SDK. Register with `registerAppTool()` and `registerAppResource()`,
  "which generate each host's metadata for you". The app calls `App.connect()` with no transport.
  Source: https://claude.com/docs/connectors/building/mcp-apps/getting-started
- Claude's `ui.domain` is the first 32 hex characters of SHA-256(server URL) followed by
  `.claudemcpcontent.com`. Source: https://claude.com/docs/connectors/building/mcp-apps/getting-started
- Display modes are inline card, inline carousel and full screen. Mobile uses `WKWebView` and
  Android `WebView`, with no camera, microphone or location.
  Source: https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
- There is a migration path from the OpenAI Apps SDK to the MCP Apps SDK.
  Source: https://claude.com/docs/connectors/building/mcp-apps/getting-started
- Claude asks permission before displaying an app (Allow or Always allow).
  Source: https://claude.com/docs/connectors/building/mcp-apps/getting-started
- `ui/open-link` targets can be pre-declared as "Allowed link URIs" (owned origins only) to skip
  the confirmation prompt. Source: https://claude.com/docs/connectors/building/submission

### 1.8 Elicitation

- Hosted Claude surfaces: elicitation is not mentioned anywhere in the connector docs. **Unverified;
  treat as unsupported.**
- Claude Code supports form mode and URL mode in interactive terminal sessions, and an
  `Elicitation` hook can auto-respond.
  Source: https://code.claude.com/docs/en/mcp

### 1.9 MCPB for Claude Desktop

- An `.mcpb` is a zip of a local stdio server plus `manifest.json`. Node.js is "strongly
  recommended" because Desktop ships it. Platforms are `darwin` and `win32`. `user_config`
  generates a settings UI. Users install by double-click, drag and drop, or Settings > Extensions.
  Source: https://claude.com/docs/connectors/building/mcpb
- `sensitive: true` on a string field masks the input and stores it securely. `privacy_policies`
  is required when the extension talks to external services. The current `manifest_version` in
  examples is 0.3 or 0.4.
  Source: `modelcontextprotocol/mcpb` `MANIFEST.md` @ `70fe3b3`
- "Desktop extension listings in the directory are deprecated, and the directory no longer accepts
  MCPB submissions." Local servers reach the directory only inside a plugin, and the plugin
  checklist holds a `.mcpb` reference for a reviewer.
  Source: https://claude.com/docs/connectors/building/mcpb and
  https://claude.com/docs/plugins/pre-submission-checklist

### 1.10 Claude Code plugins wrapping an MCP server with skills

- A plugin is `.claude-plugin/plugin.json` plus `skills/`, `commands/`, `agents/`,
  `hooks/hooks.json` and `.mcp.json`. A remote server in `.mcp.json` appears on the plugin's
  Connectors tab in chat and Cowork, and Claude Code connects to it directly. "A connector alone
  leaves Claude to work out your workflow from tool names. The skill is where you put the
  sequence, the defaults, and what good output looks like."
  Source: https://claude.com/docs/plugins/build
- Support by surface:

  | Component | Chat | Cowork | Claude Code |
  | --- | --- | --- | --- |
  | Skills | loads | loads | loads |
  | Hooks | ignored | loads | loads |
  | Local MCP server | ignored | loads when the session runs on your computer | loads |
  | Top-level `bin/` | plugin can't be installed | plugin can't be installed | loads |

  Source: https://claude.com/docs/plugins/platform-support
- Claude Code hooks can be `type: "mcp_tool"`: "call a tool on a configured MCP server. The tool's
  text output is treated like command-hook stdout." `mcp_tool` hooks on `SessionStart` at launch
  are skipped because there is no MCP client context yet. The default timeout on
  `UserPromptSubmit` is 30 seconds.
  Source: https://code.claude.com/docs/en/hooks
- Plugin `userConfig` with `"sensitive": true` stores the value "in secure storage rather than
  `settings.json`". Source: https://code.claude.com/docs/en/plugins/components

---

## 2. ChatGPT

OpenAI has renamed the Apps SDK to **Plugins**. A plugin bundles skills, an optional MCP server,
optional UI and Codex lifecycle hooks, and ChatGPT and Codex share "one universal plugin
directory". Source: https://developers.openai.com/plugins/concepts/plugins.md (in llms-full)

### 2.1 Custom connectors, developer mode, plans

- To add one: chatgpt.com/plugins > + > **Add custom MCP server** > name > Server URL (or Secure
  MCP Tunnel) > authentication > "I understand and want to continue" > **Create as a plugin**,
  then install it and pick it with `@`. "ChatGPT supports both read and write tools from your
  server." Protocols are SSE and streaming HTTP. Auth is OAuth, none, or "OAuth or no
  authentication" (mixed, per tool `securitySchemes`). Access: "Use ChatGPT on the web. Workspace
  permissions and security restrictions, including Lockdown, apply."
  Source: https://developers.openai.com/api/docs/guides/custom-mcp-server.md
- The old "developer mode" anchor (`#what-is-chatgpt-developer-mode`) now lands on this flow. The
  page doesn't name developer mode as a required toggle. **Unverified** whether any plan still
  needs it.
- Plans: the ChatGPT Work and Codex feature table marks Plugins, Connectors and MCP "available" on
  Plus, Pro, Business and Enterprise. Free and Go are not columns in that table.
  Source: https://learn.chatgpt.com/docs/pricing.md. **Unverified** which plans can add a
  *custom* MCP server in ChatGPT web (help center returned 403).
- Plugins work in Chat and Work on web, desktop and mobile. "Desktop only" plugins (local MCP)
  can't be used on mobile. Source: https://learn.chatgpt.com/docs/plugins.md

### 2.2 Auth

- "you are expected to implement an OAuth 2.1 flow that conforms to the MCP authorization spec"
  (2025-11-25). Requirements:
  - protected resource metadata
  - authorization server metadata (RFC 8414 or OIDC)
  - echo `resource` into the token `aud`
  - `code_challenge_methods_supported` including `S256`, which is mandatory
  - CIMD with `token_endpoint_auth_methods_supported` of `none` or `private_key_jwt`; DCR still
    supported; predefined clients
  Source: https://developers.openai.com/plugins/build/auth.md
- RFC 9207 `iss`: if the authorization server sets `authorization_response_iss_parameter_supported:
  true` and returns a matching `iss` every time, ChatGPT uses the stable redirect
  `https://chatgpt.com/connector_platform_oauth_redirect` and the stable CIMD
  `https://chatgpt.com/oauth/client.json`. Otherwise it uses per-callback-ID URLs.
  Source: https://developers.openai.com/plugins/build/auth.md
- "ChatGPT does **not** support machine-to-machine OAuth grants … nor can it present custom API
  keys." ChatGPT presents an OpenAI mTLS client certificate with SAN
  `mtls.prod.connectors.openai.com`. Source: https://developers.openai.com/plugins/build/auth.md
- Enterprise domain restriction needs OIDC discovery, `openid` and `email` scopes, and a UserInfo
  endpoint returning `email` and `email_verified: true`. The OpenAI guide for converting Claude
  plugins lists this as a required setup step.
  Source: https://developers.openai.com/plugins/build/auth.md and
  https://developers.openai.com/plugins/guides/submit-claude-plugin.md
- Multi-account: an authenticated read-only profile tool marked `_meta["openai/profile"]: true`
  that returns a stable opaque `id`. Source: https://developers.openai.com/plugins/build/auth.md

### 2.3 Annotations and confirmation

- "Write actions by default require confirmation … We respect the `readOnlyHint` tool annotation …
  Tools without this hint are treated as write actions." Users can remember approve or deny for a
  tool "for a conversation"; "New conversations will prompt for confirmation again."
  Source: https://developers.openai.com/api/docs/guides/custom-mcp-server.md
- Directory rule: set `readOnlyHint`, `destructiveHint` and `openWorldHint` to explicit booleans.
  `readOnlyHint: false` covers "persisting artifacts". `destructiveHint: true` covers deletion and
  overwriting. "Being able to undo an action does not, by itself, justify setting
  `destructiveHint` to `false`." `openWorldHint: false` is allowed for "a bounded private account".
  Source: https://developers.openai.com/plugins/plugin-guidelines.md

### 2.4 UI widgets and cross-host rendering

- "ChatGPT implements the open MCP Apps standard": `_meta.ui.resourceUri`, plus the `ui/*` bridge
  over `postMessage`. `window.openai` is optional and feature-detected, and
  `_meta["openai/outputTemplate"]` is a legacy alias. "This standards-first foundation lets the
  same UI run in ChatGPT and other compatible MCP Apps hosts."
  Source: https://developers.openai.com/plugins/build/chatgpt-ui.md
- The MCP extensions client matrix marks MCP Apps supported in Claude (web), Claude Desktop,
  ChatGPT, Cursor, VS Code GitHub Copilot, Microsoft 365 Copilot and Goose, **but not Claude
  Code**. Source: `modelcontextprotocol/modelcontextprotocol` `docs/extensions/client-matrix.mdx`
  @ `3c4d91b`
- So one MCP Apps resource can render in both Claude and ChatGPT. The per-host differences are
  `ui.domain` (Claude's hash format) and CSP declarations. The SDK's register helpers emit host
  metadata. Rendering identically in both is **unverified**; it needs a test.
  Sources: https://claude.com/docs/connectors/building/mcp-apps/getting-started;
  https://developers.openai.com/plugins/build/chatgpt-ui.md

### 2.5 Submission and review

- The portal is at platform.openai.com/plugins. Requirements and process:
  - individual or business identity verification
  - the `api.apps.write` permission
  - a public domain
  - a CSP if the plugin has UI
  - a domain challenge at `/.well-known/openai-apps-challenge`
  - **Scan Tools**, which imports names, annotations and server `instructions`
  - test credentials with no MFA
  - automated and/or manual review
  - after approval, you choose to publish
  - "For each MCP server integration, only one version may be published at a time"
  - EU-data-residency projects cannot submit plugins with MCP servers
  Source: https://developers.openai.com/plugins/deploy/app-review.md
- Hooks must be removed before public directory submission. `userConfig` is not supported, so use
  OAuth and hosted storage. `.mcpb` files are not accepted.
  Source: https://developers.openai.com/plugins/guides/submit-claude-plugin.md
- Local-MCP ("desktop-only") submissions are "limited to approved partners".
  Source: https://developers.openai.com/plugins/deploy/desktop-only.md

### 2.6 Memory-related restrictions and overlap

- "Plugins should … provide functionality or workflows that are not natively supported by the
  products' built-in capabilities." ChatGPT has built-in memory (Settings > Personalization), and
  local Codex has its own memory store.
  Sources: https://developers.openai.com/plugins/plugin-guidelines.md;
  https://learn.chatgpt.com/docs/customization/memories.md
- "Do not request the full conversation history, raw chat transcripts, or broad contextual fields
  'just in case' … Do not request accumulated conversation context or prior-turn arrays." "Your MCP
  server must not pull, reconstruct, or infer the full chat log."
  Source: https://developers.openai.com/plugins/plugin-guidelines.md
- Restricted data: no PCI, **PHI**, government IDs or **credentials**. Sensitive categories only
  when strictly necessary, with consent and prominent disclosure. No surveillance or profiling
  "unless explicitly disclosed, narrowly scoped, subject to meaningful user control".
  Source: https://developers.openai.com/plugins/plugin-guidelines.md
- Descriptions "must not recommend overly broad triggering beyond the explicit user intent".
  Source: https://developers.openai.com/plugins/plugin-guidelines.md
- Commerce: a plugin "must not display subscription plans, initiate new subscriptions, or promote
  upgrades". It may explain that a feature isn't on the user's plan and link to an informational
  page, but not to checkout. Source: https://developers.openai.com/plugins/plugin-guidelines.md
- Response minimization: no timestamps or internal IDs "unless they are strictly required to
  fulfill the user's query". Source: https://developers.openai.com/plugins/plugin-guidelines.md
- "Company knowledge" can use an MCP server's read-only tools if it implements the standard
  `search` and `fetch` schemas. Source: https://developers.openai.com/plugins/build/mcp-server.md

---

## 3. Codex

- The ChatGPT desktop app, Codex CLI and the IDE extension share MCP config in
  `~/.codex/config.toml`, or in a project `.codex/config.toml` for trusted projects only.
  Each server is a `[mcp_servers.<name>]` table.
  - stdio: `command`, `args`, `env`, `env_vars`, `cwd`
  - Streamable HTTP: `url`, `auth = "oauth"` (default), `bearer_token_env_var`, `http_headers`,
    `env_http_headers`, `http_headers_helper`
  - also: `enabled_tools`, `disabled_tools`, `default_tools_approval_mode` (`auto`, `prompt`,
    `writes`, `approve`) and `tool_timeout_sec` (default 60)
  - CLI: `codex mcp add <name> -- <cmd>`, `codex mcp login <name>`
  Source: https://learn.chatgpt.com/docs/extend/mcp.md
- OAuth support includes CIMD and DCR. "Codex reads the MCP `instructions` field … Keep the first
  512 characters self-contained." Source: https://learn.chatgpt.com/docs/extend/mcp.md
- **Hooks exist and match Claude Code's model**:
  - events: `SessionStart`, `UserPromptSubmit` (with `prompt`), `Stop` (with
    `last_assistant_message`), `PreToolUse`, `PostToolUse`, `PreCompact`, `SessionEnd` and more
  - `additionalContext` output, default limit 2,500 tokens
  - discovered from `~/.codex/hooks.json`, `config.toml` `[hooks]`, repo `.codex/`, or a plugin's
    `hooks/hooks.json`
  - Codex sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` "for compatibility"
  - non-managed hooks must be reviewed and trusted by hash
  - the docs list "Summarize chats to create persistent memories automatically" as a use case
  Source: https://learn.chatgpt.com/docs/hooks.md
- `mcp_tool` hooks call a tool on an already-connected server, with `${field}` templating, and use
  "the same … output contract as a command hook". `SessionEnd` doesn't support them.
  Source: https://learn.chatgpt.com/docs/hooks.md
- Plugin hooks are not supported in cloud-orchestrated ChatGPT Work. "Consumers do not have hooks
  support in this feature."
  Source: https://learn.chatgpt.com/docs/plugins.md; https://learn.chatgpt.com/docs/extend/mcp.md
- Codex Cloud: its docs cover environments, repos and internet access, with no MCP or hooks.
  **Unverified** whether MCP servers work there.
  Source: https://learn.chatgpt.com/docs/cloud.md

---

## 4. Other hosts

- **Gemini CLI.**
  - MCP via `mcpServers` in `settings.json`, with `command`, `url` (SSE) or `httpUrl` (streaming
    HTTP), plus `headers`.
  - OAuth auto-discovery on `401`, "dynamic client registration if supported", localhost redirect.
  - Hooks: `SessionStart`, `BeforeAgent` (with `additionalContext`), `AfterAgent`, `SessionEnd`.
    The hook guide's worked example is a memory system ("SessionStart: Load project memories.
    BeforeAgent: Inject memories into context … SessionEnd: Consolidate memories.").
  Source: `google-gemini/gemini-cli` `docs/tools/mcp-server.md`, `docs/hooks/writing-hooks.md`
  @ `0ac57c0`
- **Gemini Enterprise.** Streamable HTTP only. OAuth 2.0 with a manually entered client, or none.
  An admin creates a custom MCP data store. "all calls to any action require confirmation from the
  user" unless `readOnlyHint`; at most 100 actions.
  Source: https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server
- **Gemini app (consumer).** No primary source found. **Unverified.**
- **Cursor.**
  - `.cursor/mcp.json` or `~/.cursor/mcp.json`; stdio, SSE and Streamable HTTP.
  - OAuth PKCE with RFC 9728 discovery and DCR as a public client; CIMD not mentioned.
  - MCP Apps and elicitation supported; approval by default.
  - Hooks in `hooks.json`; `sessionStart` and `postToolUse` can return `additional_context`, plus
    `beforeSubmitPrompt`, `stop` and `afterAgentResponse` events.
  Source: https://cursor.com/docs/context/mcp; https://cursor.com/docs/agent/hooks
- **Microsoft Copilot.**
  - Copilot Studio agents use MCP tools and resources (generative orchestration required).
  - M365 Copilot declarative agents use MCP plugins packaged with the Agents Toolkit.
  - MCP Apps work. Retrieval tools need no confirmation after the first connection; modifying tools
    do by default.
  - These are developer or admin deployments, not end-user "paste a URL".
  Source: https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp;
  https://learn.microsoft.com/microsoft-365-copilot/extensibility/overview-plugins
- **Perplexity.** No primary source reachable. **Unverified.**

---

## 5. The MCP specification

- **Current version is 2026-07-28.** Source: https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning.md
- Major changes since 2025-11-25:
  - No protocol-level sessions and no `Mcp-Session-Id`.
  - No `initialize` handshake: version, capabilities and `clientInfo` travel in each request's
    `_meta`.
  - A mandatory `server/discover`.
  - `subscriptions/listen` replaces GET and `resources/subscribe`.
  - Multi Round-Trip Requests (`resultType: "input_required"`) replace server-initiated
    `elicitation/create`, `sampling` and `roots`.
  - Required `Mcp-Method` and `Mcp-Name` headers.
  - `ttlMs` and `cacheScope` on list results.
  - **DCR deprecated in favour of CIMD**.
  - Roots, Sampling and Logging deprecated.
  Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog.md
- **Dual-era servers.** "A server that wishes to support both legacy clients (which expect an
  `initialize` handshake) and modern clients … MAY implement both." A legacy client talking to a
  modern-only server fails. Claude's hosted client documents only 2025-era authorization. Claude
  Code "asks HTTP, stdio, and claude.ai connector servers whether they support the newer revision
  and uses it with those that do."
  Sources: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md;
  https://code.claude.com/docs/en/mcp
- **Authorization (2026-07-28).**
  - Authorization servers MUST implement OAuth 2.1.
  - Servers MUST serve RFC 9728 protected resource metadata.
  - Clients MUST use RFC 8707 `resource`.
  - Servers MUST validate audience and MUST NOT pass tokens through.
  - Authorization servers SHOULD send RFC 9207 `iss`.
  - Client registration priority: pre-registered, then CIMD, then DCR, then prompt the user.
  - DCR clients MUST send `application_type`.
  - STDIO servers SHOULD NOT use this spec; they take credentials from the environment.
  Sources: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index.md;
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md
- **Streamable HTTP (2026-07-28).** Every client message is a new POST, there is no GET stream,
  and a broken stream loses the request (no `Last-Event-ID` resumption). Cross-call state goes
  through "explicit, server-minted handles passed as ordinary tool arguments".
  Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md;
  changelog item 1
- **Server `instructions`.** In 2026-07-28 they are returned by `server/discover` ("Optional
  natural-language guidance for LLMs on how to use this server effectively"); in 2025-era they
  come in the `initialize` result. ChatGPT and Codex use them, and the plugin scan imports them
  ("Keep the most important details in the first 512 characters. Do not repeat every tool
  description or try to change the model's personality."). Claude Code loads them at session
  start and cuts them at 4,096 characters. Claude's hosted surfaces don't document their use:
  **unverified**.
  Sources: https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md;
  https://developers.openai.com/plugins/build/mcp-server.md; https://code.claude.com/docs/en/mcp
- **MCP Apps.**
  - `@modelcontextprotocol/ext-apps` is at 2.0.4.
  - SEP-1865 has been "Status: Stable (2026-01-26)"; extension ID `io.modelcontextprotocol/ui`.
  - Tools declare `_meta.ui.resourceUri` pointing at a `ui://` resource, which the host renders in
    a sandboxed iframe.
  - Tool `visibility` can be `["app"]`, which hides a tool from the model ("Host MUST NOT include
    tools in the agent's tool list when their visibility does not include `model`").
  - `ui/update-model-context` lets the app update the model's context.
  Sources: `modelcontextprotocol/ext-apps` `package.json` and
  `specification/2026-01-26/apps.mdx` @ `cf599cc`; https://modelcontextprotocol.io/docs/extensions/apps.md

---

## 6. Memory capture without hooks

- **The official memory reference server** (`@modelcontextprotocol/server-memory`):
  - tools: `create_entities`, `create_relations`, `add_observations`, `delete_entities`,
    `delete_observations`, `delete_relations`, `read_graph`, `search_nodes`, `open_nodes`
  - descriptions are plain and descriptive ("Search for nodes in the knowledge graph based on a
    query")
  - every tool annotated: writes `readOnlyHint: false`, deletes `destructiveHint: true`, all
    `openWorldHint: false`
  - **no server `instructions`**
  - dual-era (`era: "legacy" | "modern"`)
  - the recall-and-capture policy lives in a **user-supplied system prompt**, placed in a Claude
    Project's custom instructions: "Always begin your chat by saying only 'Remembering...' and
    retrieve all relevant information from your knowledge graph … If any new information was
    gathered during the interaction, update your memory …"
  Source: `modelcontextprotocol/servers` `src/memory/index.ts` and `README.md` @ `194cc86`
- **Anthropic's own memory tool** gets its reliability from a system-prompt instruction that the
  API injects automatically: "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING
  ELSE. MEMORY PROTOCOL: 1. Use the `view` command … ASSUME INTERRUPTION …". A third-party
  connector can't inject a system prompt; the nearest equivalents are server instructions, skills,
  and the user's own custom or project instructions.
  Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md
- **OpenAI phrasing guidance**: start descriptions with "Use this when…", name the cases where the
  tool should not be used, and measure precision and recall against a golden set of direct,
  indirect and negative prompts. In custom MCP chats, users can force the tool by naming it.
  Sources: https://developers.openai.com/plugins/guides/optimize-metadata.md;
  https://developers.openai.com/api/docs/guides/custom-mcp-server.md
- **Limits on phrasing.**
  - Claude: "Describe what the tool does, and don't tell Claude how to behave"; policy §2.F and
    §2.G.
  - OpenAI: no "overly broad triggering".
  - An "ALWAYS call recall before answering" line in a tool description is therefore a rejection
    risk in both directories. Workflow guidance belongs in **skills**, which both vendors accept
    as procedural instructions, and in user-written project or custom instructions.
  Sources: https://claude.com/docs/connectors/building/review-criteria;
  https://developers.openai.com/plugins/plugin-guidelines.md; https://claude.com/docs/plugins/build
- **Host rules on user-data writes.**
  - Claude: write tools prompt unless the user sets Always allow; destructive tools always prompt.
  - ChatGPT: writes confirm per conversation.
  - Codex: `writes` mode prompts for tools not marked read-only.
  - Gemini Enterprise and M365 Copilot: confirm modifying tools.
  - Every vendor says mis-annotation is a rejection reason.
  Sources: in §§1–4 above.

---

## 7. Privacy and encryption with a remote connector

- **What a remote connector exposes.** Recall results go into the host model's context, so the
  host vendor processes and retains them under its own terms. That is inherent to the feature and
  holds whatever Oort's encryption mode. In `managed` mode Oort Cloud also holds plaintext in
  server memory while it embeds, reranks, decides and writes (design §9). A remote connector
  therefore lands squarely in `managed` mode, with the existing honest label ("we cannot read your
  data at rest without your key").
- **`zero-knowledge` and a cloud-hosted connector don't mix.** In zero-knowledge mode "we never
  hold a DEK" and "the pipeline runs on the customer's side" (design §9). A Worker that Oort
  operates would need the DEK and the model keys to answer `recall`, which ends the zero-knowledge
  property. What is possible:
  1. **Local server holds the key (recommended).** A stdio server, or an MCPB in Claude Desktop,
     holds the DEK in the OS keychain (`user_config` with `sensitive: true`, or Claude Code plugin
     `userConfig` in secure storage). It runs the pipeline locally against
     `oortCloudStore(key, dek)` with the user's own model keys. Works in Claude Desktop, Claude
     Code, Codex (desktop app, CLI, IDE), Cursor and Gemini CLI. **Doesn't work in web or mobile
     chat**: claude.ai chat ignores local servers, and ChatGPT local plugins are desktop-only.
     Sources: https://claude.com/docs/plugins/platform-support; https://learn.chatgpt.com/docs/plugins.md
  2. **The user hosts the relay.** The user runs the remote MCP endpoint themselves (their own
     Worker or an always-on machine behind their own tunnel) with the DEK, so Oort-the-operator
     still sees only ciphertext. Claude's managed MCP tunnels are Enterprise-only research preview;
     ChatGPT offers Secure MCP Tunnel. This is an operator-blind option for web and mobile, but
     the user's own infrastructure sees plaintext, and it's not a non-coder path.
     Sources: https://claude.com/docs/connectors/mcp-tunnels/overview;
     https://developers.openai.com/plugins/deploy/connect-chatgpt.md
  3. **Decrypt inside the widget (speculative, unverified).** An MCP App could decrypt ciphertext
     in its iframe from a user passphrase and show it to the user without the model ever seeing
     it, using app-only tools (`visibility: ["app"]`) for the fetch. This helps viewing and
     managing, not recall, because the model gets nothing. The host serves the sandbox (and on
     mobile it's a native WebView), so the trust claim is weaker than the local option.
  4. **Rejected: pasting the key into chat.** The key would end up in the host's transcript.
- **Scrubbing still applies.** Stage 0 (design §6.2) must run on `remember` input before anything
  else, because both vendors forbid storing credentials. OpenAI also forbids PHI, which personal
  memory can easily contain.

---

## Proposed design for Oort connectors

Each item is numbered so Marcus can accept or reject it on its own.

### D1. One shared server definition, two transports

`@oortmem/mcp-tools` holds tool names, zod schemas, annotations, descriptions, server
instructions and MCP Apps resources. `@oortmem/mcp` (CON-18) serves it over stdio against a local
`Memory`; `apps/mcp-remote` serves it over Streamable HTTP against `oortCloud({ … })`. Neither
transport adds or changes tools. The server is **dual-era**: it answers `initialize` (2025-06-18
and 2025-11-25) and stateless 2026-07-28 requests with `server/discover`, the way the reference
memory server does.

### D2. Chat-facing tool list (directory-safe)

All tools are bounded to the user's own account, so every tool sets `openWorldHint: false`. Tool
names stay well under 64 characters.

| Tool | One line | Annotations | Input schema |
| --- | --- | --- | --- |
| `recall` | Search the user's saved memories for facts relevant to a question; returns up to 10 current facts with date and why each matched | `title: "Recall memories"`, `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` | `{ query: string (1–500), project?: string, as_of?: string (ISO date-time), limit?: integer 1–10 = 5 }` |
| `remember` | Save one to five self-contained facts the user stated or confirmed; Oort dedupes, reinforces or supersedes older facts | `title: "Remember facts"`, `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` | `{ facts: string[] (1–5, each 1–500 chars, one standalone claim), type?: "semantic" \| "episodic" \| "procedural" \| "preference", project?: string }` |
| `forget` | Permanently delete one memory by id | `title: "Forget a memory"`, `readOnlyHint: false`, `destructiveHint: true` | `{ id: string, reason?: string (≤200) }` |
| `pin` | Keep a memory always available, or release it | `title: "Pin or unpin a memory"`, `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` | `{ id: string, pinned: boolean }` |
| `explain` | Show why a memory was stored and retrieved, its decisions, and what it superseded | `title: "Explain a memory"`, `readOnlyHint: true`, `destructiveHint: false` | `{ id: string }` |
| `list_recent` | List memories saved or changed recently, newest first | `title: "Recent memories"`, `readOnlyHint: true`, `destructiveHint: false` | `{ since?: string (ISO date), project?: string, limit?: integer 1–50 = 20 }` |
| `whoami` | Return the connected Oort account (stable id, display name, email) | `title: "Oort account"`, `readOnlyHint: true`, `destructiveHint: false`, `_meta["openai/profile"]: true` | `{}` |

How these tools behave:
- `remember` never takes `userText`/`assistantText`/transcripts. The host model acts as the Stage D
  writer: it supplies the decontextualized claim. The server still runs Stage 0 scrub, Stage A
  gate, and Stages B and C reconcile, and returns what it did per fact (`added`, `reinforced`,
  `superseded <id>`, `skipped: secret`, `skipped: not durable`). This keeps the tool inside "only
  the data needed" for both vendors.
- Supersede keeps the old memory with `valid_to` set (design §5.4), so `remember` stays
  `destructiveHint: false`. Reviewers may disagree; if they do, move supersede to a separate
  `update_memory` tool with `destructiveHint: true`.
- `recall` returns ids because `forget`, `explain` and `pin` need them, and dates because temporal
  validity is the product. Each result keeps only `id`, `text`, `type`, `valid_from`, `tier` and a
  short `why`; timings and decision traces go only through `explain`. This meets OpenAI's response
  minimization rule.
- `observe`, `consolidate`, `inspect` and `export` are **not** in the chat tool set. Export and
  account deletion link out to the console (§14.1), which is allowed under OpenAI's commerce rules
  as long as it links to an informational page, not checkout.

### D3. Harness endpoint for hooks

`https://mcp.oortcloud.dev/agent` exposes the D2 tools plus `observe`:
- input: `{ user_text: string ≤ 8k, assistant_text: string ≤ 8k, tool_summaries?: string[] ≤ 20, session_id?: string }`
- annotations: `readOnlyHint: false`, `destructiveHint: false`

It is used only by Claude Code and Codex `mcp_tool` hooks and SDKs, and is never submitted to a
directory. Keeping it on a separate URL keeps the reviewed `/mcp` surface free of
transcript-shaped inputs.

### D4. Server instructions

Under 512 characters, self-contained, describing rather than commanding:

> Oort is the user's own long-term memory, which they connected on purpose. `recall` searches
> facts the user chose to keep from earlier conversations: decisions, preferences, project
> details. Use it when the user refers to earlier work, or when their past context would change
> the answer; skip it for self-contained questions. Use `remember` only for durable facts the user
> stated or confirmed, one standalone sentence each, never secrets or credentials. `forget`
> deletes permanently.

A longer tail (under 4,096 characters total) covers `as_of` for "what was true then", and says
that a `superseded` result means the old fact is no longer current. It also asks for at most one
`remember` call per decision, batching facts.

### D5. Skill text carries the workflow

Ship an `oort-memory` skill in both the Claude plugin and the OpenAI plugin. Its description:
"Use when the user continues earlier work, mentions a past decision, preference or project, or
makes a decision worth keeping."

Steps:
1. At the start of such a task, `recall` with the user's topic.
2. Answer using the recalled facts, and say when a fact came from memory.
3. When a decision is made or a preference stated, propose the fact in one line and call
   `remember` once the user agrees, or immediately if they asked you to remember.
4. Never save secrets, health details or third parties' personal data.

Skill text is procedural guidance, which both platforms accept, so it can go further than tool
descriptions are allowed to. Docs also give non-coders a one-line custom-instructions snippet
("Check Oort before answering questions about my past work, and offer to save decisions"), the way
the reference memory server's README does.

### D6. Auth for Oort Cloud

The authorization server runs at `https://auth.oortcloud.dev` on Workers, using
`@cloudflare/workers-oauth-provider`, which supports CIMD (`clientIdMetadataDocumentEnabled`), DCR
and protected resource metadata. Source:
https://developers.cloudflare.com/agents/model-context-protocol/authorization/

Discovery and client registration:
- Protected resource metadata `resource` = `https://mcp.oortcloud.dev/mcp` exactly.
- `authorization_servers` = `["https://auth.oortcloud.dev"]`, a single entry.
- `401` responses carry `WWW-Authenticate: Bearer resource_metadata=…, scope="memory:read memory:write"`.
- AS metadata advertises:
  - `client_id_metadata_document_supported: true`
  - `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]` (CIMD for both Claude and
    ChatGPT)
  - a `registration_endpoint` (DCR fallback for Cursor and Gemini CLI)
  - `code_challenge_methods_supported: ["S256"]`
  - `authorization_response_iss_parameter_supported: true`, with `iss` on every response (gives
    ChatGPT its stable redirect)
  - OIDC discovery, `openid email` scopes and a UserInfo endpoint (ChatGPT workspace domain
    restriction)

Redirect allowlist:
- `https://claude.ai/api/mcp/auth_callback`
- `https://chatgpt.com/connector_platform_oauth_redirect`, plus the callback-ID form
- loopback `http://localhost/*` and `http://127.0.0.1/*` with any port (Claude Code, Gemini CLI,
  Cursor, Codex; the exact Codex callback shape is unverified)

Tokens:
- Scopes: `memory:read`, `memory:write`, `memory:delete`, `offline_access`.
- Access tokens: about 1 hour, audience-bound.
- Refresh tokens rotate; a dead one returns `invalid_grant`.
- Every endpoint answers well under 10 seconds.
- The Worker turns the token into the signed scope context token from design §5.2
  (`org_id`, `customer_id="self"` for personal accounts, `agent_id` = the host), so isolation is
  enforced at the store boundary.

For developer CLIs only, also accept a scoped Oort API key in `Authorization: Bearer`. Codex
`bearer_token_env_var`, Claude Code `--header`, Cursor and Gemini headers support this, and
ChatGPT can't send it. Keep the WAF open to `160.79.104.0/21` and OpenAI's egress ranges.

### D7. Deployment shape

- **Remote.** `apps/mcp-remote` is a Cloudflare Worker (`createMcpHandler`, stateless, no Durable
  Object session, matching 2026-07-28's sessionless model) at `mcp.oortcloud.dev`. It is a thin
  layer: it checks the token, resolves scope, and calls the Oort Cloud `Memory` API over HTTPS.
  It holds no Voyage, Jev or Anthropic keys (design §4: secrets stay server-side in the cloud) and
  serves the MCP Apps bundle as `ui://` resources. Whether Cloudflare's handler supports
  2026-07-28 is **unverified**; fall back to the official TypeScript SDK if it doesn't.
- **Local.** `@oortmem/mcp` is a stdio server built in Node, packaged four ways:
  1. an `.mcpb` (manifest 0.3+, `darwin` and `win32`, `user_config` for store path and optional
     Oort Cloud key and DEK, all `sensitive`, plus `privacy_policies`)
  2. a Claude Code plugin with `.mcp.json`
     `{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server/index.js"]}`, the `oort-memory`
     skill, and the existing hooks
  3. a Codex plugin (`.codex-plugin/plugin.json`, hooks that are Claude-compatible)
  4. copy-paste config for Cursor and Gemini CLI
- In `zero-knowledge` orgs the remote connector answers every tool with an actionable error ("This
  memory is end-to-end encrypted; use the Oort desktop extension or CLI") instead of fetching
  ciphertext. See §7.

### D8. UI widgets (MCP Apps)

Built once with `@modelcontextprotocol/ext-apps` `registerAppTool` and `registerAppResource`,
reusing Observatory React components in a single-file bundle.

| Widget | Attached to | Observatory view | Mode |
| --- | --- | --- | --- |
| **Dive card** | `recall` | Discover "dive": results orbiting the query, tier and age badges, tap to explain | inline card |
| **Memory card** | `explain` | star detail with decisions (design A6) and supersede trail | inline card |
| **Timeline** | `list_recent` | Timeline with supersede trails | inline, expandable to full screen |
| **Save card** | `remember` result | lists what was added, reinforced or superseded, with an Undo that calls `forget` | inline card |

The full-screen star map is optional and later; cap the star count for mobile WebViews.
**Settings is not rendered in chat** (keys, export, deletion); it uses `ui/open-link` to
`app.oortcloud.dev`, declared as an allowed link URI. Each tool returns useful text as well, for
Claude Code and other non-UI hosts. Set Claude's `ui.domain` hash and a tight CSP. Whether the
widgets render identically in Claude and ChatGPT is **unverified** until tested in both.

### D9. Memory capture without hooks

How capture works in each host:

| Host type | How it works |
| --- | --- |
| Chat hosts (claude.ai, ChatGPT, Gemini Enterprise, M365) | model-initiated, guided by D4, D5 and the user's optional custom instruction; capture is opt-in and confirmed |
| Claude Code | command hooks to the local daemon (Phase 1), or `mcp_tool` hooks to `/agent`: `UserPromptSubmit` → `recall { query: "${prompt}" }`, `Stop` → `observe` (cloud users, no install) |
| Codex | the same hook set, `UserPromptSubmit` and `Stop` (`last_assistant_message`) |
| Gemini CLI | `BeforeAgent`, `AfterAgent` |
| Cursor | `sessionStart` only for injection |

Two traps in Claude Code: `SessionStart` `mcp_tool` hooks don't run at launch, so inject hot
memories from a command hook or on the first `UserPromptSubmit`. The `UserPromptSubmit` timeout
is 30 seconds.

To measure it, adopt OpenAI's golden-set method (direct, indirect and negative prompts; precision
and recall of `recall` and `remember` calls) as a Phase 2 eval next to the long-horizon recall
eval.

### D10. Per-host install steps (for docs)

- **Claude (web, desktop, mobile).**
  1. Customize > Connectors > Add custom connector.
  2. Paste `https://mcp.oortcloud.dev/mcp` and choose Add.
  3. Connect, sign in to Oort, then approve.
  4. Turn Oort on under + > Connectors in a chat.
  5. Mobile shows it after it's added on web or desktop.
  Free: one custom connector. Team and Enterprise: an Owner adds it, then members connect.
- **Claude Desktop, local or zero-knowledge.** Download `oort.mcpb`, double-click it, then fill in
  settings.
- **Claude Code.** `claude mcp add --transport http oort https://mcp.oortcloud.dev/mcp`, or
  `/plugin install oort@<marketplace>` (local server, skills and hooks). A claude.ai connector also
  syncs in automatically.
- **ChatGPT.**
  1. chatgpt.com/plugins > + > Add custom MCP server.
  2. Name "Oort", URL `https://mcp.oortcloud.dev/mcp`, OAuth.
  3. "I understand and want to continue", then Create as a plugin.
  4. Install it, then type `@Oort` in a chat.
- **Codex.** Add `[mcp_servers.oort]` with `url = "https://mcp.oortcloud.dev/mcp"` to
  `~/.codex/config.toml`, then run `codex mcp login oort`. Or add it in desktop Settings > MCP
  servers. For local, `codex mcp add oort -- npx -y @oortmem/mcp`.
- **Cursor.** `~/.cursor/mcp.json`: `{"mcpServers":{"oort":{"url":"https://mcp.oortcloud.dev/mcp"}}}`.
- **Gemini CLI.** `settings.json`: `{"mcpServers":{"oort":{"httpUrl":"https://mcp.oortcloud.dev/mcp"}}}`.
- **Gemini Enterprise and M365 Copilot.** Admin-only paths (§4). Defer.

### D11. Directory strategy

1. Launch as a **custom connector** on both Claude and ChatGPT. Neither needs review.
2. Before submitting to Anthropic, email `mcp-review@anthropic.com` describing Oort as a
   *user-directed* memory: explicit `remember`, visible facts, user deletion, no profiling. Ask
   whether that is compatible with Software Directory Policy §1.G. Submit only once the answer is
   in writing.
3. For OpenAI, complete identity verification first, and frame the value as working across
   assistants, explainable and portable, rather than duplicating ChatGPT memory. Submit the remote
   `/mcp` only, with no hooks.
4. Requirements to meet before either submission: a privacy policy and docs (§14.4 already lists
   them), a populated test account with no MFA, and carousel screenshots for Claude MCP Apps.

### D12. Phasing

| Piece | Phase |
| --- | --- |
| D1 shared tool module, D2 tool set and D4/D5 text, applied to the local stdio server | **Phase 2 (CON-18)** |
| `.mcpb`, Claude Code plugin (local server, skill, hooks), Codex plugin and hooks port, Cursor and Gemini CLI docs | **Phase 2** |
| D9 golden-set eval for `recall` and `remember` triggering | **Phase 2** |
| D8 widgets served by the local server in Claude Desktop (MCP Apps examples already run locally over stdio) | **Late Phase 2**, alongside Observatory |
| D6 authorization server, D7 remote Worker, D3 `/agent` endpoint, ZK refusal path | **Phase 3** (needs Oort Cloud) |
| D8 widgets over the remote connector (Claude web and mobile, ChatGPT) | **Phase 3** |
| D11 custom-connector launch, policy pre-clearance | **Phase 3** |
| D11 directory submissions (Anthropic, OpenAI) | **Phase 3 end or Phase 4**, after pre-clearance |
| User-hosted ZK relay (§7 option 2), widget decryption (§7 option 3), Gemini Enterprise, M365 Copilot | **Phase 4**, if demand exists |

---

## Blockers and constraints

1. **Anthropic Software Directory Policy §1.G** ("must not persistently store or use conversation
   content to build user profiles or attempt to make any changes to Claude's behavior across
   sessions") reads directly on a memory connector. It does not affect custom connectors, which
   have no review. A directory listing needs written pre-clearance.
2. **OpenAI's "not natively supported by built-in capabilities" rule.** ChatGPT and Codex both
   ship memory. Expect questions in review.
3. **No transcripts in chat tools.** OpenAI forbids "raw chat transcripts" and "prior-turn arrays";
   Claude §1.E forbids extraneous conversation data. That is why chat `remember` takes distilled
   facts and `observe` stays on the separate harness endpoint.
4. **Restricted data.** OpenAI bans PHI and credentials outright. Oort scrubs secrets (A7) but has
   no health filter, so one is needed or the plugin needs scoping or disclosure.
5. **Confirmation friction.** In ChatGPT, `remember` prompts for confirmation in every new
   conversation, and annotating it read-only would be grounds for rejection. Claude lets users set
   Always allow per tool.
6. **Plan tiers.** Claude Free allows one custom connector; Team and Enterprise members need an
   Owner. ChatGPT custom-MCP plan gating is **unverified**. OpenAI desktop-only (local MCP)
   listings need partner allowlisting. Claude MCP tunnels are Enterprise-only research preview.
7. **Zero-knowledge doesn't work in web or mobile chat** without a user-hosted relay. The local
   server is the only zero-knowledge path.
8. **Commerce.** OpenAI plugins may not promote Oort Cloud upgrades. A §14.2 `402` read-only
   response must link to an informational billing page, not checkout.
9. **Protocol drift.** MCP 2026-07-28 removed sessions, `initialize` and server-initiated
   elicitation, while Claude's hosted client documents only 2025-era authorization. The server
   must be dual-era, and nothing should depend on elicitation.
10. **Unverified items to re-check before building:**
    - ChatGPT plans and the developer-mode toggle
    - Codex Cloud MCP
    - consumer Gemini app and Perplexity connectors
    - whether Claude's hosted surfaces use server `instructions`
    - Claude hosted tool-count and description limits
    - whether Cloudflare's `createMcpHandler` supports 2026-07-28
    - whether the widgets render the same in Claude and ChatGPT
