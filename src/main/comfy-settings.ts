import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

export type ComfyInjectionMap = {
  /** ID do nó (string) no JSON API, ex.: `"12"` */
  videoNodeId: string;
  /** Chave em `inputs` onde entra o nome do ficheiro de vídeo, ex.: `video` */
  videoInputKey: string;
  promptNodeId: string;
  /** Chave em `inputs` do texto positivo, ex.: `text` */
  promptInputKey: string;
};

export type ComfySettings = {
  baseUrl: string;
  /** Caminho absoluto para o workflow exportado em formato API */
  workflowApiPath: string;
  injection: ComfyInjectionMap;
  /** Tempo máximo de espera pelo histórico (ms) */
  clientTimeoutMs: number;
};

const DEFAULTS: ComfySettings = {
  baseUrl: "http://127.0.0.1:8188",
  workflowApiPath: "",
  injection: {
    videoNodeId: "",
    videoInputKey: "video",
    promptNodeId: "",
    promptInputKey: "text",
  },
  clientTimeoutMs: 3_600_000,
};

function settingsPath(): string {
  return path.join(app.getPath("userData"), "comfy-settings.json");
}

export function getDefaultComfySettings(): ComfySettings {
  return { ...DEFAULTS, injection: { ...DEFAULTS.injection } };
}

export async function loadComfySettings(): Promise<ComfySettings> {
  const p = settingsPath();
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<ComfySettings>;
    return {
      ...DEFAULTS,
      ...parsed,
      injection: {
        ...DEFAULTS.injection,
        ...parsed.injection,
      },
    };
  } catch {
    return getDefaultComfySettings();
  }
}

export async function saveComfySettings(
  partial: Partial<ComfySettings>
): Promise<ComfySettings> {
  const current = await loadComfySettings();
  const next: ComfySettings = {
    ...current,
    ...partial,
    injection: {
      ...current.injection,
      ...partial.injection,
    },
  };
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
