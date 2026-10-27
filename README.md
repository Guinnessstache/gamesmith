# Gamesmith

Build browser games by describing them. Gamesmith is a desktop app (Electron) that pairs a live game preview and code editor with an AI agent running on your own model server, such as a Mac Studio on your network.

**Version 0.1 (this build)**
- New games from a 2D (Phaser 3) or 3D (Three.js) starter template. Engines are bundled, so games run offline and deploy as plain static files.
- Live preview with hot reload, a console panel, and "Open in browser".
- An AI agent that reads and edits files, runs the game, reads the console errors, and fixes them on its own (up to 3 rounds by default).
- Works with any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, MLX, vLLM.
- Version history with one-click Undo for every AI change (built-in git, no install needed).
- Monaco code editor (the same editor as VS Code), file tree, and asset import.

**Next:** GitHub sign-in and push, one-click deploy to Render or GitHub Pages, then Blender asset generation.

## Run it (Windows)

Requires Node.js 20 or newer. In a terminal, from this folder:

```
npm install
```

```
npm run dev
```

`npm install` also copies the Phaser and Three.js engine files into `resources/vendor`.

To build a Windows installer into `release/`:

```
npm run dist
```

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
src/preload/       Safe bridge between the UI and main process
src/renderer/      React UI
resources/templates/  Starter games
scripts/           Vendor copy and tests
```

## Tests

```
npm run test:agent
```

This runs the agent loop against a scripted mock model. For the full UI test on Linux with Xvfb:

```
npm run build
```

```
xvfb-run -a npx electron --no-sandbox scripts/smoke-electron.cjs
```
