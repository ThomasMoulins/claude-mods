# claude-mods

Sept mods Claude Code pour développer un jeu Unity sans quitter Claude : erreurs de compilation, tests, CI, SoundBanks Wwise, cartes GitHub, sorties Unity résumées, et une garde sur les fichiers Unity.

| Mod | Ce qu'il fait | Commandes |
| --- | --- | --- |
| `unity-console` | Lit l'`Editor.log` de Unity toutes les 3 s et résume la dernière compilation : nombre d'erreurs C#, fichier, ligne et code de chaque erreur. Ligne d'état « ✗ 2 erreurs C# », panneau avec **Envoyer à Claude** et **Copier**. | `/unity-errors`, `/unity-project` |
| `unity-test-runner` | Lance les tests Unity (EditMode, PlayMode ou les deux) avec la CLI Unity, sans tour de Claude, même pendant que Claude travaille. Panneau « ✗ 1 en échec · 41 réussis · 12 s », chaque échec avec son fichier et sa ligne, et les boutons **Envoyer les échecs à Claude**, **Relancer** et **Arrêter**. | `/unity-test [edit\|play\|all] [filtre]` |
| `unity-ci-status` | Ligne d'état du dernier run de chaque workflow GitHub Actions de ta branche (« CI ma-branche : ✗ Unity CI (Run all tests) »), notification quand un run échoue, panneau avec les jobs en échec et **Analyser avec Claude**. Lecture seule, via `gh`. | `/ci` |
| `unity-log-digest` | Quand Claude lance `unity test`, `unity build` ou `unity run`, Unity en `-batchmode`, ou lit `Editor.log`, il reçoit un résumé au lieu de milliers de lignes : totaux des tests, erreurs C# avec fichier et ligne, autres lignes d'erreur, fin de la sortie, et le chemin de la sortie complète. Il refuse aussi une commande `unity` qui ne vise pas le projet Unity. | — |
| `wwise-soundbank-check` | Ligne d'état quand les SoundBanks Wwise sont absentes (le jeu sera muet) ou plus anciennes que le projet Wwise, d'après `Assets/WwiseSettings.xml`. Silencieux dans un projet sans Wwise. | `/wwise` |
| `project-board` | Affiche tes cartes ouvertes d'un projet GitHub par statut et priorité, avec **Travailler dessus**, qui envoie la carte à Claude. Lecture seule, via `gh`. | `/board`, `/board-project` |
| `unity-asset-guard` | Refuse ou demande avant que Claude modifie à la main un `.meta`, une scène, un prefab ou un asset YAML, déplace ou supprime un asset sans son `.meta`, modifie `.lfsconfig` ou les dossiers générés (`Library/`, `Temp/`…), ou jette des modifications non commitées (`git reset --hard`, `git clean -f`…). | `/unity-project` |

**`/claude-mods`** liste les commandes des mods installés, quel que soit le mod qui l'a enregistrée.

## Installation

Il faut Claude Code **2.1.287** ou plus dans le terminal, et l'extension **2.1.299** ou plus pour l'affichage dans VS Code. Le dépôt est privé : ton compte GitHub doit y avoir accès, et ta machine doit déjà avoir un identifiant git pour github.com (une clé SSH, ou `gh auth login` puis `gh auth setup-git`). L'installation n'en demande pas.

Dans le terminal, à l'invite de Claude Code, une ligne par mod voulu :

```
/plugin install unity-console --marketplace ThomasMoulins/claude-mods
/plugin install unity-test-runner --marketplace ThomasMoulins/claude-mods
/plugin install unity-ci-status --marketplace ThomasMoulins/claude-mods
/plugin install unity-log-digest --marketplace ThomasMoulins/claude-mods
/plugin install wwise-soundbank-check --marketplace ThomasMoulins/claude-mods
/plugin install project-board --marketplace ThomasMoulins/claude-mods
/plugin install unity-asset-guard --marketplace ThomasMoulins/claude-mods
```

Depuis un shell :

```
claude plugin install unity-console --marketplace ThomasMoulins/claude-mods
```

Dans l'app Desktop (onglet Code), où `/plugin` ne marche pas : clique sur **+** à côté du prompt, puis **Plugins**, **Add marketplace** avec `ThomasMoulins/claude-mods`, puis **Add plugin**.

Chaque mod fonctionne seul : installe ceux qui te servent. `unity-test-runner` a besoin de la CLI Unity (`unity`), `unity-ci-status` et `project-board` de `gh`.

## Réglages

Les mods lisent `.claude/claude-mods.json` à la racine du dossier où tu lances Claude Code :

```json
{
  "unityProject": "MonJeu",
  "github": { "owner": "mon-orga", "number": 12 },
  "ciWorkflows": ["Unity CI"],
  "unityCli": "/chemin/vers/unity",
  "editorLog": "/chemin/vers/Editor.log"
}
```

Tous les champs sont facultatifs. Les deux premiers s'écrivent avec des commandes :

- **`/unity-project`** affiche le projet Unity suivi. Sans réglage, les mods le cherchent à la racine et jusqu'à deux niveaux en dessous (un dossier avec `ProjectSettings/ProjectVersion.txt` et un `Assets/` non vide).
  - `/unity-project MonJeu` choisit un dossier, relatif à la racine ou absolu.
  - `/unity-project auto` revient à la détection.
- **`/board-project https://github.com/orgs/<owner>/projects/<n>`** (ou `<owner>/<n>`) choisit le projet GitHub. `/board-project none` l'oublie.
- **`ciWorkflows`** limite `unity-ci-status` à ces workflows ; sans lui, tous sont montrés.
- **`unityCli`** est le chemin de la CLI Unity, si `unity` n'est ni sur le PATH de l'app ni dans `~/.unity/bin/`.
- **`editorLog`** remplace le chemin du log Unity. Il n'est à régler que si Unity l'écrit ailleurs que :
  - macOS : `~/Library/Logs/Unity/Editor.log`
  - Windows : `%LOCALAPPDATA%\Unity\Editor\Editor.log`
  - Linux : `~/.config/unity3d/Editor.log`

Commite `.claude/claude-mods.json` dans le dépôt du jeu pour que toute l'équipe ait les mêmes réglages. Changer de projet, c'est relancer `/unity-project` ou `/board-project`, ou ouvrir Claude Code dans un autre dossier : les mods suivent la racine de la session.

## Ce que chaque mod fait sur ta machine

Un mod s'exécute avec tes droits et sans sandbox.

- **`unity-console`** lit `Editor.log` et `.claude/claude-mods.json`. Il n'écrit que ce fichier de réglages, via `/unity-project`. Il ne lance un processus (`tail`, ou `powershell` sous Windows) que si le log dépasse 4 Mo.
- **`unity-test-runner`** lance `unity test <projet> --mode … --output <projet>/Logs/claude-tests-<mode>.xml`, une instance Unity en batch, seulement sur `/unity-test` ou **Relancer**. Unity écrit dans `Library/` et dans ce rapport. Il refuse de démarrer si l'Editor a le projet ouvert.
- **`unity-ci-status`** lance `git branch --show-current`, `gh run list` et, pour un run en échec, `gh run view --json jobs`, à l'ouverture puis toutes les 90 s. Rien n'est jamais modifié sur GitHub.
- **`unity-log-digest`** change ce que Claude lit après une commande Unity, sans rien défaire de ce qu'elle a fait. Il écrit la sortie complète dans `<projet>/Logs/claude-unity-output-<horodatage>.log` (dossier ignoré par git). S'il plante, Claude reçoit la sortie brute.
- **`wwise-soundbank-check`** lit `WwiseSettings.xml` et liste les dossiers du projet Wwise et des SoundBanks, toutes les 60 s. Il n'écrit rien et ne lance rien.
- **`project-board`** lance `gh api user`, `gh project view`, `gh project item-list` et `git branch --show-current` à l'ouverture, puis toutes les 5 minutes. Il utilise le compte `gh` actif, qui doit avoir le droit `read:project`. Il n'écrit que `.claude/claude-mods.json`, via `/board-project`.
- **`unity-asset-guard`** ne lance aucun processus et n'approuve jamais rien à ta place : il refuse, ou te pose la question. Si la garde elle-même plante, l'appel est refusé par prudence. Sa lecture des commandes shell est une heuristique : un script qui écrit une scène sans passer par Edit, Write, `rm`, `mv`, `cp`, `sed -i`, `tee` ou une redirection n'est pas vu. Le contenu d'un here-document n'est pas lu comme des commandes.

## Limites connues

- `Editor.log` est unique par machine : avec plusieurs Editors ouverts, `unity-console` lit celui du dernier lancé et ignore le log s'il concerne un autre projet.
- L'Editor est considéré ouvert quand `<projet>/Temp/UnityLockfile` existe.
- `unity-test-runner` lit le rapport NUnit 3 de Unity. **Arrêter** coupe la run à la prochaine ligne que Unity écrit.
- `unity-ci-status` lit les runs de la branche courante : la plupart démarrent à l'ouverture d'une PR, donc une branche sans PR n'a souvent aucun run.
- `wwise-soundbank-check` compare les dates des `.bnk` et des `.wwu` : une modification qui ne touche aucun `.wwu` n'est pas vue.
- Sous Windows, la garde lit les commandes `rm`, `mv` et `git` de PowerShell, pas `Remove-Item` ni `Move-Item`.
- Le support de Windows est testé par des tests unitaires, pas encore sur une vraie machine Windows.

## Développer

Chaque mod a ses tests :

```
claude plugin validate unity-test-runner
claude plugin test unity-test-runner
```

`hooks/project.ts` est le même fichier dans les sept mods, et `hooks/nunit.ts` le même dans `unity-test-runner` et `unity-log-digest` : modifie chaque copie.
