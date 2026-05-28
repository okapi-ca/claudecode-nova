# M0 Spike — node-pty validation report

**Date :** 2026-05-28
**Statut :** ✅ PASS — feu vert pour M1
**Environnement testé :** macOS 26.5 (Darwin), arm64, Node v22.22.0 (nvm)

## Objectif

Valider qu'on peut charger `node-pty` (module natif) dans le subprocess Node spawné par Nova, et spawn le binaire `claude` à travers une vraie PTY, avant d'engager 3-5 semaines sur M1-M3.

## Résultats

| Test | Description | Statut | Détails |
|---|---|---|---|
| T1 | `pty.spawn('/bin/zsh')` + écho d'un sentinel | ✅ PASS | Sentinel reçu en < 500 ms |
| T2 | `pty.spawn(claude, ['--version'])` | ✅ PASS | Capture « 2.1.153 (Claude Code) » |
| T3 | Même test depuis subprocess avec PATH dépouillé (`/usr/bin:/bin:/usr/sbin:/sbin`), env Nova-like | ✅ PASS | node-pty charge et fonctionne sans dépendre du PATH |

## Caractéristiques du binaire natif

```
File:     pty.node (Mach-O 64-bit bundle arm64)
Size:     84 KB
Linkage:  /usr/lib/libc++.1.dylib + /usr/lib/libSystem.B.dylib
Signing:  adhoc, linker-signed (CodeDirectory v=20400)
```

**Implications :**
- Aucune dépendance dynamique externe → pas de runtime à shipper
- Ad-hoc signed → Gatekeeper laisse passer le chargement in-process (pas de quarantaine sur les fichiers livrés via Nova Extensions)
- 84 KB par architecture → bundling de 2 arches = ~170 KB de surcharge pour l'extension, acceptable

## Surprise : @homebridge ne ship PAS de prebuilds darwin

Malgré son nom (`node-pty-prebuilt-multiarch`), `@homebridge/node-pty-prebuilt-multiarch@0.13.1` ne fournit que des prebuilds **Linux** (arm, arm64, ia32, x64). Sur macOS, le binaire a été **compilé localement** par `node-gyp` pendant `npm install` — ce qui a marché uniquement parce que Xcode est installé sur la machine de dev.

**→ Inutilisable tel quel pour la distribution.** Un user qui installe l'extension Nova sans Xcode CLI tools verrait `npm install` échouer.

## Recommandation pour M1/M3 — utiliser `@lydell/node-pty`

`@lydell/node-pty@1.2.0-beta.12` (publié mars 2025) ship des prebuilds **par plateforme via optionalDependencies**, pattern identique à esbuild/swc :

```
@lydell/node-pty-darwin-arm64    ← celui qu'on veut
@lydell/node-pty-darwin-x64      ← pour Macs Intel
@lydell/node-pty-linux-x64
@lydell/node-pty-linux-arm64
@lydell/node-pty-win32-x64
@lydell/node-pty-win32-arm64
```

npm sélectionne automatiquement le bon paquet selon `process.platform` + `process.arch` au moment de l'install. Pas de node-gyp, pas de Xcode requis chez l'utilisateur final.

**À valider en M1 :** refaire les 3 tests avec `@lydell/node-pty` pour confirmer feature parity. API publique identique (basée sur le node-pty officiel 1.x).

## Stratégie de packaging recommandée (à finaliser en M3)

1. **Pendant le dev** : `@lydell/node-pty` comme dépendance normale dans `Scripts/package.json`
2. **Build de release** : un script `npm run bundle-native` qui :
   - Installe `@lydell/node-pty-darwin-arm64` et `@lydell/node-pty-darwin-x64` séparément
   - Extrait les `.node` dans `Scripts/native/darwin-arm64/pty.node` et `Scripts/native/darwin-x64/pty.node`
   - Modifie ws-server.js pour faire `require('./native/${process.arch}/pty.node')`
3. **Extension finale** : ne ship que les fichiers nécessaires, pas tout `node_modules/`
4. **Estimation taille** : ~170 KB pour les 2 binaires (vs ~12 MB de `node_modules/@homebridge/...` complet)

## Risques résiduels (acceptables)

| Risque | Probabilité | Mitigation |
|---|---|---|
| `@lydell/node-pty` est en beta (1.2.0-beta.12) | Faible | API stable depuis node-pty 1.x officiel ; fallback `node-pty-prebuilt-multiarch` 0.10.x si besoin |
| Nova bumpe son Node interne et casse ABI | Très faible | node-pty 1.x utilise N-API → ABI stable across Node versions |
| macOS update casse signature ad-hoc | Très faible | Pattern utilisé par des milliers d'extensions VS Code via Electron — couvert par Apple |
| User sur Mac Intel ancien | Faible | Bundling darwin-x64 + darwin-arm64 couvre tout depuis macOS 10.15 |

## Verdict

**M0 est un go.** Aucun blocker technique pour M1. La distribution (M3) a un chemin propre via `@lydell/node-pty`. Le coût en taille d'extension est négligeable (~170 KB).

## Prochaines étapes (M1)

1. Refaire T1-T3 avec `@lydell/node-pty` pour confirmer parité
2. Coder le bridge minimal : xterm.js dans Preview tab + WS `/pty` côté ws-server, sans encore intégrer `claude` (juste `/bin/zsh`)
3. Valider que xterm.js dans le WebKit de Nova Preview se comporte correctement (resize, ANSI colors, mouse events)

## Fichiers du spike

- `package.json` — deps de test
- `test1-basic.js` — spawn zsh + sentinel
- `test2-claude.js` — claude --version
- `test3-isolated.js` + `test3-child.js` — subprocess Nova-like
- `SPIKE.md` — ce fichier
