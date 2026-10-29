# claude-mods

Trois mods Claude Code pour développer un jeu Unity sans quitter Claude : voir les erreurs de compilation, suivre ses cartes GitHub et protéger les fichiers Unity des modifications à la main.

| Mod | Ce qu'il fait | Commandes |
| --- | --- | --- |
| `unity-console` | Lit l'`Editor.log` de Unity toutes les 3 s et résume la dernière compilation : nombre d'erreurs C#, fichier, ligne et code de chaque erreur. Ligne d'état « ✗ 2 erreurs C# », panneau avec **Envoyer à Claude** et **Copier**. | `/unity-errors`, `/unity-project` |
| `project-board` | Affiche tes cartes ouvertes d'un projet GitHub par statut et priorité, avec **Travailler dessus**, qui envoie la carte à Claude. Lecture seule, via `gh`. | `/board`, `/board-project` |
| `unity-asset-guard` | Refuse ou demande avant que Claude modifie à la main un `.meta`, une scène, un prefab ou un asset YAML, déplace ou supprime un asset sans son `.meta`, touche `.lfsconfig` ou les dossiers générés (`Library/`, `Temp/`…), ou jette des modifications non commitées (`git reset --hard`, `git clean -f`…). | `/unity-project` |

## Installation

Il faut Claude Code **2.1.287** ou plus dans le terminal, et l'extension **2.1.299** ou plus pour l'affichage dans VS Code. Le dépôt est privé : ton compte GitHub doit y avoir accès, et ta machine doit déjà avoir un identifiant git pour github.com (une clé SSH, ou `gh auth login` puis `gh auth setup-git`). L'installation n'en demande pas.

Dans le terminal, à l'invite de Claude Code :

```
/plugin install unity-console --marketplace ThomasMoulins/claude-mods
/plugin install project-board --marketplace ThomasMoulins/claude-mods
/plugin install unity-asset-guard --marketplace ThomasMoulins/claude-mods
```

Depuis un shell :

```
claude plugin install unity-console --marketplace ThomasMoulins/claude-mods
```

Dans l'app Desktop (onglet Code), où `/plugin` ne marche pas : clique sur **+** à côté du prompt, puis **Plugins**, **Add marketplace** avec `ThomasMoulins/claude-mods`, puis **Add plugin**.

Installe seulement ceux qui te servent : chaque mod fonctionne seul.

## Réglages : quel projet Unity, quel projet GitHub

Les mods lisent `.claude/claude-mods.json` à la racine du dossier où tu lances Claude Code :

```json
{
  "unityProject": "MonJeu",
  "github": { "owner": "mon-orga", "number": 12 },
  "editorLog": "/chemin/vers/Editor.log"
}
```

Tous les champs sont facultatifs. Tu n'as pas à écrire ce fichier toi-même, les commandes le font :

- **`/unity-project`** affiche le projet Unity suivi. Sans réglage, les mods le cherchent à la racine et jusqu'à deux niveaux en dessous (un dossier avec `ProjectSettings/ProjectVersion.txt` et un `Assets/` non vide).
  - `/unity-project MonJeu` choisit un dossier, relatif à la racine ou absolu.
  - `/unity-project auto` revient à la détection.
- **`/board-project https://github.com/orgs/<owner>/projects/<n>`** (ou `<owner>/<n>`) choisit le projet GitHub. `/board-project none` l'oublie.
- **`editorLog`** remplace le chemin du log Unity. Il n'est à régler que si Unity l'écrit ailleurs que :
  - macOS : `~/Library/Logs/Unity/Editor.log`
  - Windows : `%LOCALAPPDATA%\Unity\Editor\Editor.log`
  - Linux : `~/.config/unity3d/Editor.log`

Commite `.claude/claude-mods.json` dans le dépôt du jeu pour que toute l'équipe ait les mêmes réglages. Changer de projet, c'est relancer `/unity-project` ou `/board-project`, ou ouvrir Claude Code dans un autre dossier : les mods suivent la racine de la session.

## Ce que chaque mod fait sur ta machine

Un mod s'exécute avec tes droits et sans sandbox.

- **`unity-console`** lit `Editor.log` et `.claude/claude-mods.json`. Il n'écrit que ce fichier de réglages, et seulement via `/unity-project`. Il ne lance un processus (`tail`, ou `powershell` sous Windows) que si le log dépasse 4 Mo.
- **`project-board`** lance `gh api user`, `gh project view`, `gh project item-list` et `git branch --show-current` à l'ouverture, puis toutes les 5 minutes. Rien n'est jamais modifié sur GitHub. Il utilise le compte `gh` actif, qui doit avoir le droit `read:project`. Il n'écrit que `.claude/claude-mods.json`, via `/board-project`.
- **`unity-asset-guard`** ne lance aucun processus et n'approuve jamais rien à ta place : il refuse, ou te pose la question. Si la garde elle-même plante, l'appel est refusé par prudence. Sa lecture des commandes shell est une heuristique : un script qui écrit une scène sans passer par Edit, Write, `rm`, `mv`, `sed -i` ou une redirection n'est pas vu.

## Limites connues

- `Editor.log` est unique par machine : avec plusieurs Editors ouverts, `unity-console` lit celui du dernier lancé et ignore le log s'il concerne un autre projet.
- L'Editor est considéré ouvert quand `<projet>/Temp/UnityLockfile` existe.
- Sous Windows, la garde lit les commandes `rm`, `mv` et `git` de PowerShell, pas `Remove-Item` ni `Move-Item`.
- Le support de Windows est testé par des tests unitaires, pas encore sur une vraie machine Windows.

## Développer

Chaque mod a ses tests :

```
claude plugin validate unity-console
claude plugin test unity-console
```

`hooks/project.ts` est le même fichier dans les trois mods : modifie-le dans les trois.
