# M2 — Pure-browser chat UI demo

**Statut :** prêt à tester
**Date :** 2026-05-28

Démo browser-only du chat UI Nova alimenté par `@anthropic-ai/claude-agent-sdk`. Valide l'UX (rendu markdown, syntax highlighting, copy buttons, tool cards) avant d'intégrer dans le Preview tab de Nova.

## Lancer

```bash
cd spike/m2-chat-ui
npm install                          # une seule fois — ~100 packages, 4 sec
npm run start:1pass                  # lit la clé depuis 1Password puis démarre
# ou
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Puis ouvrir **http://127.0.0.1:5180/** dans Safari ou Firefox.

## Ce que tu peux tester

Trois prompts suggérés s'affichent au chargement :

1. **« List the files in the workspace and tell me what this project does. »** → Claude appelle `nova_listFiles`, reçoit la liste, résume.
2. **« Read src/auth.ts and identify any security issues. »** → Claude appelle `nova_openFile`, reçoit le code (qui contient un bypass admin volontaire), produit un audit.
3. **« Get the diagnostics for src/auth.ts. »** → Claude appelle `nova_getDiagnostics`.

Tu peux aussi taper tes propres prompts. Les **tools sont des mocks** — workspace fictif défini dans `chat-tool-mocks.mjs`. Quand on intégrera dans Nova, ces handlers feront un round-trip JSON-lines vers `main.js`.

## Ce que la démo prouve

| Capacité | Comment vérifier |
|---|---|
| **Streaming markdown** | La réponse de Claude apparaît progressivement, en HTML rendu (pas en raw text) |
| **Syntax highlighting** | Les blocs de code (```ts, ```bash, etc.) sont colorés via highlight.js |
| **Copy-to-clipboard** | Survole un bloc de code → bouton « Copy » apparaît, click → contenu copié |
| **Tool call cards** | Chaque appel d'outil s'affiche dans une carte pliable jaune. Click pour voir input + result |
| **Multi-turn session** | Le `session_id` est conservé entre messages — Claude se souvient de la conversation |
| **Cost tracking** | Footer affiche le coût + tokens du dernier échange (devrait être ~$0.005-0.02) |
| **Abort mid-stream** | Pendant que Claude répond, bouton « Stop » apparaît à droite. Click → query annulée |
| **Auto-reconnect** | Si tu kill le server, l'UI affiche « Disconnected » et reconnecte quand tu relances |

## Architecture du démo

```
[Safari/Firefox tab]
  ↕ WS ws://127.0.0.1:5180/ws (JSON messages)
[server.mjs (Node)]
  ├── http.createServer (sert /public/*)
  ├── ws.WebSocketServer (chat protocol)
  └── @anthropic-ai/claude-agent-sdk
      ├── query() loop → AsyncGenerator d'events SDKMessage
      └── mcpServers: { nova: createSdkMcpServer(... mocks ...) }
```

## Protocole WebSocket (pour référence)

**Client → Server :**
```json
{ "type": "user_message", "text": "..." }
{ "type": "abort" }
```

**Server → Client :**
```json
{ "type": "session_started",   "sessionId": "...", "model": "claude-sonnet-4-6" }
{ "type": "assistant_text",     "chunk": "..." }
{ "type": "assistant_tool_use", "name": "mcp__nova__nova_openFile", "input": {...} }
{ "type": "tool_result",        "name": "...", "text": "...", "isError": false }
{ "type": "result",             "success": true, "cost": 0.0094, "tokens": {"input":4,"output":236} }
{ "type": "error",              "message": "..." }
```

## Coût attendu par interaction

- Prompts courts (1 réponse, 0-1 tool call) : **~$0.005-0.01**
- Prompts complexes (multi-step, plusieurs tool calls) : **~$0.02-0.05**

Avec ton modèle `claude-sonnet-4-6` + isolation (pas de built-in tools, pas de settings auto-loadés) + auto-approval des tools Nova. Voir `spike/m1-agent-sdk/SPIKE.md` pour les détails de calibrage.

## Limitations connues du démo

- **Pas de persistance des sessions au reload de la page** — chaque rechargement = nouvelle conversation. La persistance arrivera dans M3 (intégration Nova) via `~/.claude/projects/.../`.
- **Pas de sélecteur de modèle dans l'UI** — Sonnet 4.6 hard-codé. Facile à exposer si on en a besoin.
- **CDN pour marked + highlight.js** — pour la prod (Preview tab Nova), on vendor-isera. CDN pour la démo = setup rapide.
- **Tools mockés** — bien sûr. Le but est de valider l'UX, pas les vraies opérations Nova.

## Prochaines étapes

Si l'UX te convient :
- **M3 — Intégration Nova réelle** : promotion de ce code vers `claudecode-nova.novaextension/Scripts/`, branchement des wrappers in-process sur les vrais tools Nova MCP, exposition via Preview tab.

Si l'UX te déçoit, on adapte avant d'intégrer.

## Fichiers

- `server.mjs` — backend HTTP + WS + SDK loop
- `chat-tool-mocks.mjs` — 3 tools Nova mockés
- `public/index.html` — layout
- `public/chat.css` — dark theme
- `public/chat.js` — WS client, render, tool cards, copy
- `package.json`, `.gitignore`, `README.md`
