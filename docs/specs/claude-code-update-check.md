# Spec — Vérification & mise à jour de Claude Code CLI

**Statut** : Draft
**Auteur** : Marc Bourget
**Date** : 2026-05-27
**Cible** : claudecode-nova v0.6.0

---

## 1. Contexte

L'extension `claudecode-nova` lance le subprocess `claude` (CLI Anthropic) via la commande `claudecode.launchClaude` et communique avec lui via WebSocket MCP. Aujourd'hui, l'utilisateur doit :

- vérifier manuellement sa version (`claude --version` dans un terminal),
- comparer à la dernière version publiée (npm / GitHub releases),
- exécuter la mise à jour (`claude update` ou `npm update -g @anthropic-ai/claude-code` selon la méthode d'install).

C'est friction inutile, et la dérive de version peut causer des incompatibilités silencieuses avec le protocole MCP (`2024-11-05` actuellement) ou avec les schémas d'outils alignés sur PROTOCOL.md (cf. v0.5.0).

## 2. Objectif

Permettre à l'utilisateur de **vérifier et mettre à jour Claude Code CLI sans quitter Nova**, avec un signal proactif et discret quand une nouvelle version est disponible.

## 3. Scope

### Inclus

- Commande explicite `Claude Code: Check for Updates` (menu Extensions + Command Palette).
- Check automatique léger au démarrage de l'extension, throttlé à **1× par 24 h** (timestamp persisté dans `nova.config`).
- Notification non-bloquante (`NotificationRequest`) quand une mise à jour est détectée, avec bouton `Update Now`.
- Exécution de la mise à jour avec arrêt propre du ws-server, update, redémarrage automatique, reconnexion.
- Setting pour désactiver le check automatique.

### Exclus

- Pas d'auto-update silencieuse (toujours opt-in via clic utilisateur).
- Pas de gestion multi-versions / version pinning (laisser au CLI).
- Pas de rollback automatique en cas d'échec d'update.
- Pas de support des installations gérées par un package manager d'OS exotique (Nix, Snap) — détection best-effort.

## 4. Solution

### 4.1 Détection de la version courante

Exécuter `<claudeCommand> --version` via l'API `Process` (réutilise `claudecode.claudeCommand` du workspace config). Output attendu : `claude-code/X.Y.Z (node)`. Parser avec `/^claude-code\/(\d+\.\d+\.\d+)(?:-([\w.]+))?/` pour capturer aussi les pre-releases (`X.Y.Z-beta.1`).

États possibles retournés par `getCurrentVersion()` :

| État | Condition | Trigger |
|---|---|---|
| `installed` | Process exit 0 + output parsable | version capturée, comparaison enclenchée |
| `not_installed` | Process échoue avec ENOENT / "command not found" | UX dédiée (§4.7) |
| `unknown` | Process exit 0 mais output non parsable, ou exit ≠ 0 avec stderr exploitable | log + notif diagnostique |

### 4.2 Détection de la dernière version publiée

Source primaire : **npm registry** via `fetch("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")`. Réponse JSON : extraire `.version`. C'est rapide (~150 ms), public, pas d'auth, déjà couvert par l'entitlement `requests`.

Fallback : GitHub releases (`https://api.github.com/repos/anthropics/claude-code/releases/latest`) — utile si npm est down ou si Anthropic publie hors-npm dans le futur.

### 4.3 Détection de la méthode d'install

Heuristique sur le chemin résolu de `claude` :

| Chemin matché | Méthode | Commande update |
|---|---|---|
| `~/.nvm/`, `/usr/local/lib/node_modules`, `*/node_modules/.bin/` | npm global | `npm update -g @anthropic-ai/claude-code` |
| `/opt/homebrew/`, `/usr/local/Cellar/` | Homebrew | `brew upgrade claude-code` |
| `~/.local/`, `~/.claude/`, `/usr/local/bin/claude` (standalone) | Installer standalone | `claude update` (updater intégré) |
| _autre_ | unknown | proposer `claude update` puis fallback message « update manually » |

Résoudre le chemin avec `which <claudeCommand>` (via Process + shell). Si `claude update` retourne un code de succès, l'utiliser en priorité quelle que soit la méthode — c'est ce que la CLI moderne supporte nativement.

### 4.4 Flow utilisateur

#### Vérification manuelle (`Claude Code: Check for Updates`)

```
1. Utilisateur invoque la commande.
2. Extension affiche "Checking…" via NotificationRequest (id stable, écrasable).
3. Parallèle : version courante (Process) + version distante (fetch).
4. Comparaison semver.
5. Trois cas :
   a. à jour     → NotificationRequest "Claude Code is up to date (vX.Y.Z)" + bouton OK.
   b. obsolète   → NotificationRequest "Update available: vA.B.C → vX.Y.Z" + boutons [Update Now] [Later] [Release Notes].
   c. introuvable → NotificationRequest "Claude Code CLI not found at '<path>'" + bouton [Open Settings].
```

#### Check automatique au startup

```
1. activate() lit `claudecode.updateCheck.lastCheckedAt` depuis nova.config.
2. Si > 24h ou jamais → check silencieux en background (Promise non bloquante).
3. Si update disponible → NotificationRequest cas (b) ci-dessus.
4. Si à jour ou erreur → écrit le timestamp, n'affiche rien.
5. Si setting `claudecode.updateCheck.autoCheck` est false → skip.
```

#### Exécution de l'update

```
1. NotificationRequest "Updating Claude Code… The bridge will restart automatically."
2. Si ws-server tourne :
   a. Envoyer un signal d'arrêt propre (claudecode.stop interne).
   b. Attendre exit code ou timeout 5s puis SIGTERM.
3. Lancer `<updateCommand>` via Process, capturer stdout/stderr.
4. À l'exit :
   - code 0 → re-vérifier la version, NotificationRequest "Updated to vX.Y.Z" + auto-redémarrer ws-server.
   - code ≠ 0 → NotificationRequest erreur avec stderr tronqué + bouton [Copy Log] + ne PAS redémarrer ws-server (laisser l'utilisateur diagnostiquer).
5. Mettre à jour `lastCheckedAt`.
```

### 4.5 Cas « Claude Code n'est pas installé »

L'extension fonctionne sans `claude` jusqu'à ce que l'utilisateur invoque `claudecode.launchClaude` — le ws-server tourne en autonomie sur Node. Le check de version sert justement à exposer ce gap proactivement.

#### Détection

`getCurrentVersion()` retourne `not_installed` quand :
- `Process` lance avec ENOENT (binaire absent du PATH),
- `which <claudeCommand>` ne renvoie rien,
- ou stderr contient `command not found` / `not recognized`.

#### Comportement au démarrage (auto-check)

- Notification one-shot : *« Claude Code CLI not found. Install it to use the bridge. »*
- Boutons : `[Install Guide]` (ouvre `https://docs.anthropic.com/claude-code/install` via `nova.openURL`) — `[Configure Path]` (ouvre les workspace settings sur la clé `claudecode.claudeCommand`) — `[Don't Show Again]` (set `claudecode.updateCheck.suppressNotInstalled = true`).
- `lastCheckedAt` est tout de même mis à jour pour respecter le throttling 24h.
- Le ws-server démarre normalement — l'absence de `claude` ne bloque rien d'autre.

#### Comportement sur invocation manuelle de `Check for Updates`

- Affiche la notification ci-dessus **sans** suppression (l'utilisateur a explicitement demandé).
- Ajoute un 4e bouton `[Install via npm]` qui lance `npm install -g @anthropic-ai/claude-code` via Process **uniquement** si npm est détecté sur le PATH (via `which npm`). Sinon le bouton n'apparaît pas — éviter de proposer une commande qui va échouer.

#### Comportement sur invocation de `Launch Claude Code`

Hors scope de cette spec (existe déjà), mais devrait à terme appeler `getCurrentVersion()` en pré-flight et afficher la même notification si `not_installed` — éviter un terminal qui ouvre sur un `command not found`. À documenter comme follow-up.

#### Sidebar

L'item version affiche : *« Claude Code: not installed »* en couleur d'alerte (via `image: "__builtin.warning"`). Clic invoque `claudecode.checkForUpdates` qui présente les boutons d'action.

### 4.6 Configuration ajoutée

Dans `extension.json` → `"config"` :

```json
{
  "key": "claudecode.updateCheck.autoCheck",
  "title": "Auto-check for Claude Code updates",
  "type": "boolean",
  "default": true,
  "description": "Check daily for new Claude Code CLI versions at extension startup. Only shows a notification when an update is available."
},
{
  "key": "claudecode.updateCheck.channel",
  "title": "Update channel",
  "type": "enum",
  "values": [
    ["stable", "Stable (npm latest)"],
    ["next", "Next (npm @next pre-releases)"]
  ],
  "default": "stable"
}
```

État interne (pas exposé dans UI, écrit via `nova.config.set`) :

- `claudecode.updateCheck.lastCheckedAt` (number, epoch ms)
- `claudecode.updateCheck.lastSeenVersion` (string)
- `claudecode.updateCheck.suppressNotInstalled` (boolean) — set par le bouton `[Don't Show Again]` de la notif « not installed »

### 4.7 Commandes ajoutées

Dans `extension.json` → `"commands"."extensions"` :

```json
{ "title": "Check for Claude Code Updates", "command": "claudecode.checkForUpdates" }
```

Pas de raccourci clavier par défaut — découverte via menu Extensions / Command Palette.

## 5. Détails d'implémentation

### Modules touchés

| Fichier | Modification |
|---|---|
| `claudecode-nova.novaextension/extension.json` | Ajouter 1 commande + 2 settings UI + 3 settings internes + 1 section sidebar |
| `claudecode-nova.novaextension/main.js` | Enregistrer `claudecode.checkForUpdates`, démarrer auto-check dans `activate()`, monter `VersionTreeProvider` pour la nouvelle section sidebar |
| `claudecode-nova.novaextension/Scripts/update-check.js` _(nouveau)_ | Module dédié avec `getCurrentVersion()`, `getLatestVersion()`, `detectInstallMethod()`, `runUpdate()`, sémaphore semver |
| `claudecode-nova.novaextension/Scripts/version-tree-provider.js` _(nouveau)_ | `TreeDataProvider` pour la section sidebar « Claude Code » (single-item, état dynamique) |

`update-check.js` tourne dans JavaScriptCore (pas Node) — utiliser `fetch()`, `Process`, pas de modules npm. Bundling déjà nécessaire si on veut `semver` ; sinon implémenter un comparateur semver minimal (~20 lignes) inline.

### Comparaison semver minimal

Nécessite le support pre-release dès v1 puisque le canal `next` est offert (Q1).

```javascript
function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

function semverCompare(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return null;
  const core = (pa.major - pb.major) || (pa.minor - pb.minor) || (pa.patch - pb.patch);
  if (core !== 0) return core;
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;   // X.Y.Z > X.Y.Z-anything
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1; // ordre lexico des pre-tags — suffisant pour `beta.N`, `rc.N`
}
```

~30 lignes, pas de dépendance, couvre les cas Anthropic actuels.

### Gestion des erreurs réseau

- Timeout `fetch` : 5 secondes via `AbortController`.
- Échec → log console, pas de notification (le check automatique reste silencieux par design).
- Le check manuel affiche une erreur explicite « Could not reach npm registry ».

## 6. Acceptance criteria

- [ ] La commande `Claude Code: Check for Updates` apparaît dans le menu Extensions et la Command Palette.
- [ ] Invoquer la commande quand Claude Code est à jour affiche une notification de confirmation avec la version.
- [ ] Invoquer la commande quand une mise à jour est disponible affiche une notification avec 3 boutons (Update Now, Later, Release Notes).
- [ ] Cliquer `Release Notes` ouvre `https://github.com/anthropics/claude-code/releases/tag/v<latest>` via `nova.openURL`.
- [ ] Cliquer `Update Now` arrête le ws-server, exécute l'update, redémarre le ws-server, affiche le succès.
- [ ] Une erreur d'update n'arrête pas le ws-server (état stable conservé).
- [ ] Au démarrage de l'extension, le check auto fire **une seule fois par 24h** (vérifiable via les timestamps).
- [ ] Désactiver `claudecode.updateCheck.autoCheck` supprime le check au démarrage.
- [ ] Le check auto échoue silencieusement si le réseau est indisponible (pas de notification d'erreur intempestive).
- [ ] Si `claudecode.claudeCommand` pointe vers un binaire inexistant, la notification d'erreur dirige vers les settings.
- [ ] Quand Claude Code n'est pas installé, la notification au démarrage propose `[Install Guide]`, `[Configure Path]`, `[Don't Show Again]`.
- [ ] Le bouton `[Don't Show Again]` set `suppressNotInstalled = true` ; la prochaine notif auto-startup ne s'affiche plus tant qu'un check manuel n'a pas réinitialisé l'état.
- [ ] Sur invocation manuelle de `Check for Updates` sans claude installé, un bouton `[Install via npm]` apparaît **uniquement** si `npm` est sur le PATH.
- [ ] La section sidebar « Claude Code » apparaît avec la version courante et un état visuel (à jour / update dispo / not installed / unknown).
- [ ] Cliquer sur l'item sidebar invoque `claudecode.checkForUpdates`.
- [ ] Le canal `next` interroge `dist-tags.next` du registre npm et compare correctement à la version courante (y compris si elle est elle-même une pre-release).

## 7. Risques & open questions

### Risques

1. **`claude update` non disponible sur toutes les versions / méthodes d'install.** Mitigation : tester en priorité, fallback vers la commande spécifique au package manager détecté.
2. **Restart du ws-server casse une session active.** Mitigation : prévenir clairement dans la notification ("The bridge will restart") et n'updater que sur action explicite. Optionnellement, refuser d'updater si une session est en cours et proposer "Update Later".
3. **npm registry rate limiting.** Très peu probable à 1 req/24h/user, mais : ajouter un User-Agent identifiant l'extension pour traçabilité.
4. **Le binaire `claude` n'est pas sur le PATH de Nova** (problème nvm documenté dans CLAUDE.md §Gotchas). Le setting `claudecode.claudeCommand` du workspace permet déjà l'override, donc réutiliser.

### Décisions

- **Q1 — Canal `@next` supporté** : enum `stable` / `next` dans les settings, default `stable`. Quand `next` est sélectionné, le check distant utilise `https://registry.npmjs.org/@anthropic-ai/claude-code` (root, pas `/latest`) et lit `dist-tags.next`.
- **Q2 — Version dans le sidebar** : nouvelle section `Claude Code` dans le sidebar existant, affichant un item avec la version courante et un état (à jour / update dispo / not installed / unknown). Clic = invoque `claudecode.checkForUpdates`. Mise à jour du label au démarrage et après chaque check.
- **Q3 — Check auto au lancement de l'extension** : fire dans `activate()`, donc à chaque ouverture de workspace Nova. Throttling 24h via `lastCheckedAt` évite la sur-fréquence pour l'utilisateur qui ouvre plusieurs workspaces / sessions par jour.

## 8. Out of scope explicite

- Vérifier la version de Node.js utilisée par le ws-server (déjà géré par le check au startup actuel).
- Vérifier la version du protocole MCP — couplée à la version de Claude Code, pas de check séparé.
- Notification UI in-editor (statut bar custom) — pas d'API stable côté Nova.

## 9. Plan de livraison

1. **PR 1** — `update-check.js` module + tests unitaires sur le comparateur semver et la détection de méthode d'install.
2. **PR 2** — Wire-up dans `main.js`, ajout des settings/commandes dans `extension.json`, smoke test manuel (commande explicite).
3. **PR 3** — Auto-check au startup avec throttling 24h, settings de désactivation.
4. **PR 4** — Update flow complet avec restart du ws-server, error handling, copy log.

Release ciblée : **v0.6.0**.
