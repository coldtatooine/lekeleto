import { app } from "electron";
import path from "node:path";

const isDev = !app.isPackaged;

function resourcesPath(): string {
  if (isDev) {
    return path.join(__dirname, "../../resources");
  }
  return process.resourcesPath;
}

export const BLENDER_PATH = path.join(resourcesPath(), "blender", "blender.exe");

export const FFMPEG_PATH = path.join(resourcesPath(), "ffmpeg", "ffmpeg.exe");

export const SCRIPTS_PATH = path.join(resourcesPath(), "python-scripts");
