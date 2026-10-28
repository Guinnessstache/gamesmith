# Gamesmith

**Website and download: https://guinnessstache.github.io/gamesmith/**

Build browser games by describing them. Gamesmith is a desktop app (Electron) that pairs a live game preview and code editor with an AI agent running on your own model server, such as a Mac Studio on your network.

**Version 0.8 (this build)**
- New games from a 2D (Phaser 3) or 3D (Three.js) starter template. Engines are bundled, so games run offline and deploy as plain static files.
- Live preview with hot reload, a console panel, and "Open in browser".
- An AI agent that reads and edits files, runs the game, reads the console errors, and fixes them on its own (up to 3 rounds by default).
- Works with any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, MLX, vLLM.
- Version history with one-click Undo for every AI change (built-in git, no install needed).
- Monaco code editor (the same editor as VS Code), file tree, and asset import.
- **Publish:** connect GitHub, create a repo and upload in one click, then publish to GitHub Pages and/or Render. Every later "Save to GitHub" updates the live game automatically.

- **Assets:** browse and search Poly Haven's free CC0 library (3D models, tileable textures, HDRI skies) in the Assets tab, or import any asset pack zip (Kenney, itch.io). The AI can search for and download assets itself. Credits are kept in `assets/CREDITS.md`.

- **Bring in existing games** from GitHub or a folder on your PC, including games with their own server (Gamesmith runs `npm install` / `npm start` and previews through the server, Socket.io included).
- **Deploy check:** after each publish, every file is loaded from the live site; **Live** is only shown when they all load.

- **Blender tab:** describe a 3D model and the AI builds it in Blender, which runs invisibly in the background. Models go into your own library, can be added to any game, and back up to a private GitHub repo.

**Next:** a scene editor for placing objects.

## Blender tab: your own 3D models

Open the **Blender** tab in any game, or **My 3D models** on the home screen.

- **Getting Blender.** Gamesmith uses an installed Blender 4.2 or newer if it finds one (Program Files, Steam, or a path in Settings). If not, **Get Blender** downloads the official portable build from blender.org (about 400 MB), checks it against Blender's published checksum, and keeps it in Gamesmith's own folder. Forks built on Blender 4.2+ (such as Mixar) work too: point Settings at their program.
- **Making a model.** Click **+ New**, name it, and describe it to the AI on the right. The AI writes a Blender Python script (`model.py`), Gamesmith runs it in Blender, measures the result (size in meters, triangles, materials), renders a preview, and sends any error back to the AI to fix. Every version is saved, and a failed build never replaces the last good model.
- **Detail, real surfaces and terrain.** Ask for "real textures", "make it smoother" or a landscape. The AI has three helpers for this:
  - `smooth(obj, level=2, bevel=0.03, noise=0.08, max_tris=8000)` rounds a blocky shape into a smooth or organic one (subdivision, optional bumps for rocks and bark), then trims it back to a triangle budget.
  - `texture("rock_face", tile=2.0)` is a photo-scanned surface from Poly Haven (CC0): color, normal and roughness maps. Gamesmith downloads each texture once (1k) into its cache and packs it into `model.glb` as JPEG. The AI can search Poly Haven for ids itself. A texture that can't be downloaded falls back to a plain color and the AI is told.
  - `terrain(size=80, height=15, style="mountains", snow_line=11, water=2)` makes a landscape (hills, mountains, islands, valley, plains or dunes) with grass, rock on steep slopes, snow up high and sand by the water. `ground(t, x, y)` gives the height at a point for placing trees and rocks on it.
  Textured models are bigger (a few MB with several textures) and every build is versioned in your library, so the library repo grows faster with them.
- **Animating it.** Ask for movement ("make the lid open", "give it idle, walk and attack"). The AI adds a skeleton with the `Rig` helper, attaches parts to bones (or lets one mesh bend with them), and keys each named clip. The clips are saved inside `model.glb`; buttons under the 3D view play them, and games play them with Three.js's `AnimationMixer`. The game AI is told every clip's name, length and whether it loops.
- **Recording your own moves.** In the Blender tab, switch to **Motions** and click **● Record**. Film yourself with the webcam (or choose a video), and Gamesmith tracks your body on your own computer with Google's MediaPipe Pose (Apache-2.0; the 9 MB model downloads once, checked against its published checksum). Review it with the tracked stick figure drawn over the video, trim it, mark it as a loop, and save it. Then pick a character and click **Add to character**: the modeling AI puts it on a person-shaped skeleton (`Rig.humanoid()`) with `rig.apply_motion("Wave")`. Only the tracked motion is backed up to GitHub; the video of you stays on your computer.
- **A character that looks like you.** Open a recorded motion and click **Make a character that looks like me**. Gamesmith picks the frame that shows you best, reads your proportions (scaled to the height you type in) and the colors of your skin, hair, shirt, pants and shoes, and can put a photo of your face on the head. You can change any color, the sleeves, legs and hair before clicking **Create character**; it builds a blocky character on the person skeleton, with the recorded motion already on it. A desk webcam that only sees your upper body works too (legs get average lengths). It's an ordinary model script afterwards, so the modeling AI can restyle it. The face photo is saved with the model and backed up to GitHub with it; leave it off to keep your face private.
  - Works best with your whole body in view, a still camera and even light. One camera can't judge depth well, feet may slide a little, and fingers aren't tracked.
- **Looking at it.** **3D view** spins the model on a 1 m grid; **Render** shows Blender's image; **Script** lets you edit `model.py` yourself (Ctrl+S builds).
- **Using it.** **Add to <game>** copies `model.glb` into `assets/models/<name>/`. The game AI also searches your library first when it looks for models, and is told each model's real size.
- **Keeping it.** The library is a folder (Documents\Gamesmith Library by default) with its own history. **Back up to GitHub** creates a private `gamesmith-assets` repository; on another computer, **Get my library from GitHub** downloads it.

Each model folder holds `asset.json`, `model.py`, `model.glb` and `preview.png`. Models are built in meters, Z-up in Blender (exported Y-up for the web), standing on the ground at the origin.

## Bringing in an existing game

On the home screen, click **Bring in a game**.

- **From GitHub:** type `owner/name` or pick from your repositories (connect GitHub first to see private ones). Gamesmith clones it into your games folder, and **Save to GitHub** pushes back to the same repo.
- **From a single HTML file:** a whole game in one `.html` file (like one an AI chat wrote) becomes a new game in your games folder. Gamesmith keeps the original file as the first version in History, then splits the inline CSS and JavaScript into `style.css` and `game.js` next to `index.html` so the AI can work on it piece by piece (the game behaves exactly the same). It tells you about files the page refers to that weren't included, and about libraries it loads from a CDN; the AI is told to keep those exact versions.
- **From a folder:** opens the game where it is; nothing is copied. If the folder isn't a git repo yet, Gamesmith starts tracking it so Undo and History work. If it's a Windows checkout with converted line endings, Gamesmith turns on `core.autocrlf` for that repo so files don't all look changed.

Gamesmith's own data (chat, settings) lives in a hidden `.gamesmith/` folder that's excluded through `.git/info/exclude`; your `.gitignore` isn't touched.

**Games with their own server** (a `package.json` with a `start` or `dev` script) need Node.js installed. Gamesmith gives the server a free port through `PORT`, shows its output in the console (tagged *server*), restarts it when server code changes and reloads the page when browser code changes. Publishing such a game needs a Render **web service**; if the repo already has one, the Publish panel finds it.

The AI gets a different briefing for existing games: the README, scripts, a compact file list, and rules to follow the code's existing style and make small edits. It can search the code (`search_files`) and read big files in slices.

## Assets

Open the **Assets** tab next to **Game**.

- **Models / Textures / Skies** search [Poly Haven](https://polyhaven.com). Pick one, choose the detail level (1k is right for most web games), and click **Add to game**. Files go to `assets/models`, `assets/textures` or `assets/skies`.
- **Import pack (.zip)** unpacks a downloaded asset pack into `assets/packs/`. Kenney's packs at kenney.nl are free (CC0) and suit 2D games. Gamesmith reads the pack's license file and records it.
- **In this game** lists what's been added. **Ask AI to use it** starts a chat message for you.
- You can also just ask: "add a wooden barrel near the start" and the AI will search, download and place it, limited to 6 downloads per request.

Every asset is recorded in `assets/ASSETS.json`, which the AI reads so it only uses files that exist.

## Publishing

Click **Publish** in a game's top bar.

1. **Connect GitHub.** Paste a token with the `repo` scope ([create one](https://github.com/settings/tokens/new?scopes=repo&description=Gamesmith)). The token is stored encrypted with Windows' own credential protection. For a "Sign in with GitHub" button instead, create a GitHub OAuth App with **Enable Device Flow** ticked and put its Client ID in Settings.
2. **Create and upload.** Gamesmith creates the repository and pushes the game. No git install is needed. If the repo is edited on github.com, those changes are merged in on the next save.
3. **Put it on the web.**
   - *GitHub Pages:* free, needs a public repository on a free GitHub plan.
   - *Render:* paste a [Render API key](https://dashboard.render.com/u/settings#api-keys). Render must already be connected to your GitHub account with access to the repo (Render dashboard, then Account settings).

Then use **Save to GitHub** in the top bar whenever you want the live version updated. The number badge shows how many versions haven't been uploaded yet.

## Run it (Windows)

Requires Node.js 20 or newer. In a terminal, from this folder:

```
npm install
```

```
npm run dev
```

`npm install` also copies the Phaser and Three.js engine files into `resources/vendor`.

To build the Windows installer (`release/Gamesmith-Setup.exe`) on your own PC:

```
npm run dist
```

### Updates

The installed app checks GitHub Releases a few seconds after it starts and every 6 hours. When there's a newer version, a notice in the corner offers **Update now** (downloads in the background and checks it against the release's checksum) and then **Restart to update**. Settings, Updates shows your version and has **Check for updates**. Games, models, motions and settings aren't touched by an update. A copy run from source (`npm run dev`) doesn't update itself; use git.

### Releasing a new version

GitHub builds the installer for you (`.github/workflows/release.yml`). Set `"version"` in `package.json`, commit and push, then push a tag with the same number:

```
git tag v0.5.0
```

```
git push origin v0.5.0
```

About 10 minutes later the installer is on the [Releases page](https://github.com/Guinnessstache/gamesmith/releases), the website's Download button points to it, and installed copies offer the update. The release must include `latest.yml` (the workflow uploads it); that file is how installed copies learn about the new version. The website itself is `docs/index.html`, published with GitHub Pages (Settings, Pages, branch `main`, folder `/docs`). Its screenshots come from `scripts/showcase-shots.cjs`.

## Connect the Mac Studio

Open **Settings** (the dot in the top right), choose your server type, enter the Mac's name or IP, and click **Test connection**. Then pick a model.

### Ollama on the Mac

Ollama only listens on the Mac itself by default. Run these on the Mac, then quit and reopen Ollama:

```
launchctl setenv OLLAMA_HOST "0.0.0.0"
```

```
launchctl setenv OLLAMA_CONTEXT_LENGTH "32768"
```

The second line matters. Ollama's default context window is small, and when the agent's file contents get cut off the model starts making broken edits without any visible error.

### LM Studio on the Mac

In the Developer tab, start the server and turn on **Serve on Local Network**. When loading a model, set the context length to 32k or more.

### llama.cpp / MLX

```
llama-server -m model.gguf --host 0.0.0.0 --port 8080 --jinja -c 32768
```

`--jinja` is required for tool calling.

### Which model

Pick a coding model that supports tool calling, such as a Qwen Coder model. On 128 GB of unified memory, a 30B-class MoE coder model gives the best speed-to-quality trade-off for this kind of agent loop. Larger dense models are smarter but much slower per step, and each request can take 5 to 20 steps.

If `Mac-Studio.local` doesn't resolve from Windows, use the Mac's IP address (System Settings → Network). If the connection is refused, allow the server through the macOS firewall.

## How the AI works

Each request runs a loop:

1. The model gets the file list, `GAME_DESIGN.md`, and the last 10 chat turns.
2. It uses small tools: `read_file`, `edit_file` (exact search and replace), `write_file`, `delete_file`, `list_files`, `check_game`.
3. When it says it's done, Gamesmith reloads the game, collects console errors and missing-file 404s, and sends them back for a fix.
4. Gamesmith saves a version before and after every request, so **Undo these changes** always works.

Models that write tool calls as text (`<tool_call>{...}</tool_call>`) instead of native calls are handled too.

## Project layout

```
src/main/          Electron main process (Node)
  agent.js         AI agent loop, tools, system prompt
  aiClient.js      OpenAI-compatible streaming client
  previewServer.js Static server, hot reload, console capture
  projects.js      Project creation and sandboxed file access
  git.js           Version history (isomorphic-git)
  github.js        GitHub sign-in, repo creation, push and merge
  deploy.js        GitHub Pages and Render publishing
  assets.js        Poly Haven library, zip pack import, asset manifest
  polypizza.js     Poly Pizza low-poly model library
  importer.js      Import from GitHub / open folder, project detection
  gameServer.js    Runs games' own servers (npm install/start)
  secretStore.js   Encrypted storage for saved keys
  blender.js       Find, download and run Blender in the background
  library.js       Your 3D model library (folders, builds, GitHub backup)
  modelAgent.js    The modeling AI (writes and fixes Blender scripts)
resources/blender/runner.py  Runs one model script: export .glb, measure, render preview
src/preload/       Safe bridge between the UI and main process
src/renderer/      React UI
resources/templates/  Starter games
scripts/           Vendor copy and tests
```

## Tests

```
npm run test:agent
```

This runs the agent loop against a scripted mock model.

```
npm run test:assets
```

This covers the asset library against a mock Poly Haven shaped like the real API.

```
npm run test:blender
```

The modeling AI, library and Blender harness against real Blender. Set `GAMESMITH_BLENDER` to a Blender program, or `pip install bpy` and it uses `scripts/fake-blender.py`.

```
npm run test:mocap
```

```
npm run test:updater
```

The updater against a local update server: finds a newer version, downloads and verifies it, refuses a corrupted download, handles being offline (Linux: `xvfb-run -a npx electron --no-sandbox scripts/test-updater.cjs`).

Motion clean-up (gap filling, smoothing, mirroring, jump height, loops, trimming). The Blender suite also checks retargeting: a posed skeleton turned into tracker landmarks and back must match within 3 degrees per bone. The full recording flow runs in the app with a fake webcam: `GAMESMITH_POSE_MODEL=pose_landmarker_full.task xvfb-run -a npx electron --no-sandbox scripts/smoke-mocap.cjs --camera=person.y4m`.

```
npm run test:import -- path/to/a/game/repo
```

Detection, Windows line endings, and (with a repo path) a full import of a real game: clone, install, start its server, proxy HTTP and Socket.io, restart, crash reporting.

```
npm run test:github
```

This pushes to a real local git server (needs git on PATH) with mock GitHub and Render APIs, including merging an edit made on "github.com".

For the full UI test on Linux with Xvfb, which clicks through building with AI and the whole Publish flow:

```
npm run build
```

```
xvfb-run -a npx electron --no-sandbox scripts/smoke-electron.cjs
```
