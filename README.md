# LEKELETO

**A small chaos machine for 3D clips, timelines, exports, and a little AI mischief.**

Lekeleto is a desktop-flavored creative playground built with `React`, `Vite`, `TypeScript`, `Three.js`, and `Electron`.
You can import animated 3D assets, preview them in a viewport, build a sequence, export video, and even send rendered results through a `ComfyUI` video-to-video workflow.

If Blender, a timeline, and a toy box had a slightly rebellious cousin, this would be it.

## What It Does

- Imports animated assets in `.dae`, `.fbx`, and `.glb`
- Shows them in a real-time `Three.js` viewport
- Lets you build a sequence from imported clips and bundled library motions
- Supports camera presets per clip
- Exports rendered video through the Electron app
- Keeps an output queue for previews and quick reopening
- Connects exported videos to a `ComfyUI` workflow for AI remixing
- Includes i18n support with `en-US`, `pt-BR`, and `es-MX`

## Built With

- `React 19`
- `TypeScript`
- `Vite 6`
- `Electron`
- `Three.js`
- `FFmpeg`
- `better-sqlite3`
- `i18next`

## Project Vibe

Lekeleto is not trying to be a spreadsheet.
It is trying to be a weirdly satisfying motion sandbox where you drop in a dancing skeleton, scrub a timeline, pick a dramatic camera angle, render a clip, and ask an AI to make it even stranger.

Respectfully.

## Getting Started

### Requirements

- `Node.js >=20 <25`
- `npm`

### Install

```bash
npm install
```

### Run The Web UI

```bash
npm run dev
```

### Run The Electron App

```bash
npm run dev:electron
```

### Production Build

```bash
npm run build
```

## How To Use

1. Launch the app.
2. Import a `.dae`, `.fbx`, or `.glb` animation.
3. Browse the built-in library in `src/library`.
4. Arrange clips into a sequence.
5. Scrub, preview, loop, and tweak camera presets.
6. Export a video from the Electron app.
7. Optionally feed that export into `ComfyUI` and mutate reality a little.

## Folder Tour

```text
src/
  main/        Electron main process + IPC handlers
  preload/     Safe bridge between Electron and renderer
  renderer/    React UI, viewport, timeline, export flow, i18n
  library/     Bundled sample 3D assets and animations
resources/
  python-scripts/  Export/render helper scripts
scripts/
  build-electron.mjs
```

## ComfyUI Notes

The AI generation flow lives in the Electron app and expects:

- A reachable `ComfyUI` base URL
- A workflow JSON in API format
- Configured node IDs for video and prompt injection

Translation: the magic is real, but it still wants proper wiring.

## Public Repo Disclaimer

This project is public, experimental, and proudly a little scrappy.
Some corners are still alpha-shaped.
That said, the core idea is already here: import motion, compose clips, export scenes, and have fun pushing it into unexpected territory.

## Contributing

Issues, experiments, polish, and beautifully cursed feature ideas are welcome.
If you open a PR that makes the app better *and* a bit more delightful, you are extremely in the spirit of the project.

## License

This project is licensed under the `MIT` License.
See [LICENSE](/d:/git/lekeleto/LICENSE:1) for the full text.

## Final Pitch

Lekeleto is for people who look at a 3D animation clip and think:

“Cool. But what if it was easier, faster, and a little more unhinged?”

That’s the whole energy.
