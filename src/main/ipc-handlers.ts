import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BLENDER_PATH, SCRIPTS_PATH } from "./binary-paths";
import { runComfyV2V } from "./comfy-client";
import { loadComfySettings, saveComfySettings } from "./comfy-settings";
import type { ComfySettings } from "./comfy-settings";
import { resolveFfmpegExecutable } from "./ffmpeg-resolve";

function rejectSpawnFfmpegError(err: Error): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new Error(
      "FFmpeg não encontrado. Na pasta do projeto execute: npm install (instala ffmpeg-static). Em alternativa, instale o FFmpeg no Windows e adicione-o ao PATH."
    );
  }
  return err;
}

export function getExportsRoot(): string {
  return path.join(app.getPath("userData"), "exports");
}

export function registerIpcHandlers(): void {
  ipcMain.handle(
    "export:showInExplorer",
    (_event, payload: { filePath: string }) => {
      shell.showItemInFolder(path.normalize(payload.filePath));
    }
  );

  ipcMain.handle("export:getExportsDir", () => getExportsRoot());

  ipcMain.handle("export:videoFileUrl", (_, filePath: string) => {
    return pathToFileURL(path.normalize(filePath)).href;
  });

  ipcMain.handle("export:listVideos", async () => {
    const root = getExportsRoot();
    await fs.mkdir(root, { recursive: true });
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch {
      return [] as { name: string; fullPath: string; mtimeMs: number }[];
    }
    const out: { name: string; fullPath: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".mp4")) continue;
      const fullPath = path.join(root, name);
      try {
        const st = await fs.stat(fullPath);
        if (!st.isFile()) continue;
        out.push({ name, fullPath, mtimeMs: st.mtimeMs });
      } catch {
        /* ficheiro removido entre readdir e stat */
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  });

  ipcMain.handle("export:mkdir", async (_, dir: string) => {
    await fs.mkdir(dir, { recursive: true });
  });

  ipcMain.handle("export:createFramesDir", async () => {
    const root = getExportsRoot();
    await fs.mkdir(root, { recursive: true });
    const framesDir = path.join(root, `frames_${Date.now()}`);
    await fs.mkdir(framesDir, { recursive: true });
    return { exportsRoot: root, framesDir };
  });

  ipcMain.handle("export:nextExportPath", async () => {
    const root = getExportsRoot();
    await fs.mkdir(root, { recursive: true });
    const name = `lekeleto_${Date.now()}.mp4`;
    return path.join(root, name);
  });

  ipcMain.handle(
    "export:writeFrame",
    async (
      _,
      payload: { framesDir: string; frameIndex: number; buffer: ArrayBuffer }
    ) => {
      const name = `frame_${String(payload.frameIndex).padStart(4, "0")}.png`;
      const filePath = path.join(payload.framesDir, name);
      await fs.writeFile(filePath, Buffer.from(payload.buffer));
    }
  );

  ipcMain.handle(
    "export:encodeVideo",
    async (
      _,
      payload: { framesDir: string; outputFile: string; fps: number }
    ) => {
      const { framesDir, outputFile, fps } = payload;
      const ff = resolveFfmpegExecutable();
      return new Promise<{ outputFile: string }>((resolve, reject) => {
        const proc = spawn(ff, [
          "-y",
          "-framerate",
          String(fps),
          "-start_number",
          "0",
          "-i",
          path.join(framesDir, "frame_%04d.png"),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "18",
          outputFile,
        ]);
        let errBuf = "";
        proc.stderr?.on("data", (d) => {
          errBuf += d.toString();
        });
        proc.on("error", (err) => reject(rejectSpawnFfmpegError(err)));
        proc.on("close", (code) => {
          if (code === 0) resolve({ outputFile });
          else
            reject(
              new Error(
                `FFmpeg exit ${code}${errBuf ? `: ${errBuf.slice(-400)}` : ""}`
              )
            );
        });
      });
    }
  );

  ipcMain.handle("export:rmDir", async (_, dir: string) => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  ipcMain.handle(
    "render:start",
    async (event, payload: { sequencePath: string; outputDir: string }) => {
      const { sequencePath, outputDir } = payload;
      return new Promise((resolve, reject) => {
        const script = path.join(SCRIPTS_PATH, "render_sequence.py");
        const proc = spawn(BLENDER_PATH, [
          "--background",
          "--python",
          script,
          "--",
          "--sequence",
          sequencePath,
          "--output",
          outputDir,
        ]);
        proc.stdout.on("data", (data) => {
          event.sender.send("render:progress", data.toString());
        });
        proc.stderr.on("data", (data) => {
          event.sender.send("render:progress", data.toString());
        });
        proc.on("error", (err) => reject(err));
        proc.on("close", (code) => {
          if (code === 0) resolve({ success: true });
          else reject(new Error(`Blender exit ${code}`));
        });
      });
    }
  );

  ipcMain.handle(
    "ffmpeg:encode",
    async (_, payload: { framesDir: string; outputFile: string }) => {
      const { framesDir, outputFile } = payload;
      const ff = resolveFfmpegExecutable();
      return new Promise((resolve, reject) => {
        const proc = spawn(ff, [
          "-y",
          "-framerate",
          "24",
          "-start_number",
          "0",
          "-i",
          path.join(framesDir, "frame_%04d.png"),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "18",
          outputFile,
        ]);
        proc.on("error", (err) => reject(rejectSpawnFfmpegError(err)));
        proc.on("close", (code) => {
          if (code === 0) resolve({ outputFile });
          else reject(new Error(`FFmpeg exit ${code}`));
        });
      });
    }
  );

  ipcMain.handle("comfy:getSettings", async () => loadComfySettings());

  ipcMain.handle(
    "comfy:setSettings",
    async (_, partial: Partial<ComfySettings>) => saveComfySettings(partial)
  );

  ipcMain.handle("comfy:pickWorkflowFile", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOpts: Electron.OpenDialogOptions = {
      title: "Workflow ComfyUI (formato API)",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    };
    const r = await (win
      ? dialog.showOpenDialog(win, dialogOpts)
      : dialog.showOpenDialog(dialogOpts));
    if (r.canceled || !r.filePaths[0]) {
      return { canceled: true as const };
    }
    const filePath = r.filePaths[0];
    await saveComfySettings({ workflowApiPath: filePath });
    return { canceled: false as const, path: filePath };
  });

  ipcMain.handle(
    "comfy:v2v",
    async (
      _,
      payload: { inputVideoPath: string; prompt: string }
    ): Promise<{ outputPath: string }> => {
      const { inputVideoPath, prompt } = payload;
      const resolved = path.resolve(path.normalize(inputVideoPath));
      if (!existsSync(resolved)) {
        throw new Error("Ficheiro de vídeo não encontrado.");
      }
      const exportsRoot = path.resolve(getExportsRoot());
      const relToExports = path.relative(exportsRoot, resolved);
      if (
        relToExports.startsWith("..") ||
        path.isAbsolute(relToExports) ||
        relToExports === ""
      ) {
        throw new Error(
          "O vídeo de entrada tem de estar na pasta de exportações da app."
        );
      }
      const trimmed = prompt.trim();
      if (!trimmed) {
        throw new Error("Indique um prompt.");
      }

      const settings = await loadComfySettings();
      const outName = `lekeleto_comfy_${Date.now()}`;
      const { outputPath } = await runComfyV2V({
        settings,
        inputVideoPath: resolved,
        prompt: trimmed,
        outputDir: exportsRoot,
        outputBasename: outName,
      });
      return { outputPath };
    }
  );
}
