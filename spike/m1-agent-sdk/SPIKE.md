# M1 Spike — Claude Agent SDK validation

**Date :** 2026-05-28
**Statut :** ⏳ En attente d'exécution par Marc (API key requise)
**Environnement :** macOS 26.5, Node v22.22.0, arch arm64

## Objectif

Valider que `@anthropic-ai/claude-agent-sdk` est le bon backend pour la chat UI Nova (chemin B de notre exploration architecturale), avant d'investir dans le sprint complet.

## Ce qu'on a vérifié sans clé API

### Install propre

```bash
npm install --no-audit --no-fund
# added 101 packages in 4s — pas d'erreurs, pas de node-gyp
```

### Distribution : excellente

Le SDK suit le **même pattern de prebuilds que @lydell/node-pty** — optional dependencies par plateforme :

```
@anthropic-ai/claude-agent-sdk-darwin-arm64     ← sélectionné sur ce Mac
@anthropic-ai/claude-agent-sdk-darwin-x64
@anthropic-ai/claude-agent-sdk-linux-{x64,arm64,…}
@anthropic-ai/claude-agent-sdk-win32-{x64,arm64}
```

Le `darwin-arm64` package contient le binaire `claude` standalone (le SDK est en fait un wrapper Node autour du CLI Claude Code). **Aucun build chez l'utilisateur final**, npm sélectionne automatiquement la bonne arch.

### API publique confirmée

```typescript
// Streaming d'events (ce qu'on veut pour la chat UI)
function query(params: { prompt: string | AsyncIterable<...>; options?: Options }): Query;
// Query est un AsyncGenerator<SDKMessage, void>

// In-process tool (pour wrapper les opérations Nova)
function tool<Schema>(name, description, zodSchema, handler): SdkMcpToolDefinition;

// Wrapping en serveur MCP in-process
function createSdkMcpServer({ name, tools }): McpSdkServerConfigWithInstance;
```

### Event types (extrait du sdk.d.ts)

```
SDKMessage =
  | SDKAssistantMessage          ← text chunks + tool_use blocks (le pain pour la chat UI)
  | SDKUserMessage               ← tool_result blocks viennent ici
  | SDKResultMessage             ← final (success/error, usage, cost)
  | SDKSystemMessage             ← init avec session_id, model, tools available
  | SDKPartialAssistantMessage   ← fine-grained streaming
  | SDKToolProgressMessage       ← started/in_progress/completed
  | SDKThinkingTokensMessage     ← extended thinking
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskUpdatedMessage
  | SDKTaskProgressMessage
  | SDKMemoryRecallMessage
  | SDKRateLimitEvent
  | SDKAuthStatusMessage
  | ... (32 types au total)
```

Riche taxonomie — on a tout pour faire une UI live (progress bars, sessions, hooks visibility, rate limit warnings, memory recall, etc.).

### Peer dependencies

- `@anthropic-ai/sdk` >= 0.93.0 (sous-jacent)
- `@modelcontextprotocol/sdk` ^1.29.0 (MCP types)
- `zod` ^4.0.0 (schemas d'outils)

Tous installés automatiquement.

## Ce que les tests valideront (Marc à exécuter)

### Prérequis : ANTHROPIC_API_KEY

Option A — depuis le shell :
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Option B — via 1Password (recommandé selon tes conventions) :
```bash
eval $(op signin)
export ANTHROPIC_API_KEY=$(op read "op://Private/Anthropic API Key/credential")
```

Si tu n'as pas encore de clé, en générer une à :
https://console.anthropic.com/settings/keys

### Test 1 — query basique sans tools

```bash
cd /Users/mbourget/Projects/okapi-ca/claudecode-nova/spike/m1-agent-sdk
node test1-basic.mjs
```

**Ce qu'on doit voir :**
- Connexion à l'API
- Stream des chunks de texte (la réponse de Claude s'affiche progressivement)
- Event `[system:init]` avec session_id
- Event `[result]` final avec usage tokens et coût
- Compteurs par type d'event en fin

**Valide :** install, auth, streaming basique, mapping event → UI.

### Test 2 — query avec tool in-process

```bash
node test2-with-tool.mjs
```

**Ce qu'on doit voir :**
- Claude appelle `nova_listFiles` puis `nova_openFile("src/auth.ts")`
- Nos handlers in-process s'exécutent (logs `[tool:...] called`)
- Tool results streams back vers Claude
- Claude répond en identifiant le bypass admin

**Valide :** le pattern in-process tool — c'est exactement ce qu'on utilisera dans ws-server.js pour wrapper les opérations Nova.

## Architecture résultante pour le sprint complet

```
[Nova main.js]
    ↕ JSON lines (existant)
[ws-server.js]
    ├── WebSocket MCP /mcp        ← Mode CLI : claude externe (inchangé)
    │
    └── HTTP/WS /chat              ← Mode Chat UI : Preview tab WebKit
        ├── @anthropic-ai/claude-agent-sdk
        │   └── createSdkMcpServer("nova", [
        │         tool("nova_openFile", schema, async (args) => {
        │           // round-trip JSON ligne → main.js → résultat
        │         }),
        │         tool("nova_openDiff", ...),
        │         tool("nova_getDiagnostics", ...),
        │         // ... wrapper les 10+ tools existants
        │       ])
        └── render des events SDKMessage en chat UI HTML
```

Aucun changement protocolaire entre `main.js` et `ws-server.js` — les tools existants sont juste exposés deux fois : via le WebSocket MCP (pour le CLI externe) ET via les wrappers in-process (pour le SDK).

## Findings — distribution

Pour packager l'extension Nova finale :

| Stratégie | Taille | Complexité install user |
|---|---|---|
| Bundler `@anthropic-ai/claude-agent-sdk` complet (avec tout `node_modules/`) | ~50-80 MB | Zéro (rien à faire) |
| Ne bundler que le SDK + darwin-arm64 + darwin-x64 + peer deps | ~15-25 MB | Zéro |
| Ne bundler que le `pty.node` et faire npm install à l'activation | ~1 MB | Nécessite `node` + `npm` sur le PATH (fragile) |

**Recommandation pour M3** : bundle la deuxième option. ~20 MB, install zéro-friction, marche partout sur darwin.

## Coût estimé d'usage (à valider par Marc en lançant les tests)

D'après le pricing public Anthropic à la date du spike :
- Sonnet 4.6 : ~$3/M tokens input, ~$15/M output
- Opus 4.7 : ~$15/M input, ~$75/M output

Un test simple comme test1 (3 phrases) devrait coûter < $0.01. Test2 (avec 2 tool calls) ~$0.02.

À partir du **15 juin 2026**, les abonnements Claude Pro/Max incluent un crédit SDK distinct (à confirmer dans les docs Anthropic à la sortie de la feature).

## Verdict (préliminaire, à confirmer après run)

**Architecturalement** : le chemin B (SDK direct) est solide. Pattern de distribution propre, API riche, event taxonomy adéquate pour une chat UI, in-process tools pour wrapper Nova sans MCP intermédiaire.

**À confirmer** : il faut que tu lances les deux tests pour valider que :
1. L'auth API key marche (sanity check)
2. Le pricing est acceptable pour ton workflow
3. La latence du stream est confortable (sub-second sur les premiers chunks)

Si les deux tests passent, on s'engage sur le sprint Chat UI complet.

## Fichiers du spike

- `package.json` — dépendance unique (`@anthropic-ai/claude-agent-sdk`)
- `test1-basic.mjs` — query streaming sans tools
- `test2-with-tool.mjs` — query + in-process tools mockés (pattern Nova)
- `SPIKE.md` — ce fichier

## Notes complémentaires

- Le SDK ne supporte **pas** WebSocket comme transport MCP. Pour Nova on utilise **in-process** tools, pas un MCP server externe.
- Le SDK ne réutilise **pas** les credentials `~/.claude/` du CLI. Auth = API key uniquement.
- Le SDK utilise **Zod v4** (pas v3) pour les schemas d'outils — important pour TypeScript.
- Le binaire `claude` bundlé dans `@anthropic-ai/claude-agent-sdk-darwin-arm64` est le même que le CLI standalone, contrôlé par le SDK via flags non-interactifs.
