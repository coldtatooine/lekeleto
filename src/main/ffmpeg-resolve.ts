import { existsSync } from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { FFMPEG_PATH } from "./binary-paths";

/**
 * 1) resources/ffmpeg/ffmpeg.exe (empacotamento manual)
 * 2) ffmpeg-static (binário por plataforma em node_modules)
 * 3) "ffmpeg" no PATH (último recurso)
 */
export function resolveFfmpegExecutable(): string {
  if (existsSync(FFMPEG_PATH)) {
    return FFMPEG_PATH;
  }
  if (
    typeof ffmpegStatic === "string" &&
    ffmpegStatic.length > 0 &&
    existsSync(ffmpegStatic)
  ) {
    return path.normalize(ffmpegStatic);
  }
  return "ffmpeg";
}
