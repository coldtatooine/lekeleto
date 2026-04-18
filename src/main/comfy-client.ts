import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ComfyInjectionMap, ComfySettings } from "./comfy-settings";

export function normalizeBaseUrl(url: string): string {
  const t = url.trim().replace(/\/+$/, "");
  if (!t) return "http://127.0.0.1:8188";
  return t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ComfyWorkflow = Record<string, unknown>;

export async function loadWorkflowFromFileAsync(
  workflowPath: string
): Promise<ComfyWorkflow> {
  const raw = await fs.readFile(workflowPath, "utf8");
  return JSON.parse(raw) as ComfyWorkflow;
}

function cloneWorkflow(w: ComfyWorkflow): ComfyWorkflow {
  return JSON.parse(JSON.stringify(w)) as ComfyWorkflow;
}

export function injectV2VIntoWorkflow(
  workflow: ComfyWorkflow,
  injection: ComfyInjectionMap,
  uploadedVideoFilename: string,
  promptText: string
): ComfyWorkflow {
  const w = cloneWorkflow(workflow);
  const { videoNodeId, videoInputKey, promptNodeId, promptInputKey } =
    injection;
  if (!videoNodeId || !promptNodeId) {
    throw new Error(
      "Configure videoNodeId e promptNodeId nas definições ComfyUI (mapa de injeção)."
    );
  }
  const vNode = w[videoNodeId];
  if (!vNode || typeof vNode !== "object") {
    throw new Error(`Nó de vídeo "${videoNodeId}" não encontrado no workflow.`);
  }
  const vObj = vNode as { inputs?: Record<string, unknown> };
  if (!vObj.inputs) vObj.inputs = {};
  vObj.inputs[videoInputKey] = uploadedVideoFilename;

  const pNode = w[promptNodeId];
  if (!pNode || typeof pNode !== "object") {
    throw new Error(`Nó de prompt "${promptNodeId}" não encontrado no workflow.`);
  }
  const pObj = pNode as { inputs?: Record<string, unknown> };
  if (!pObj.inputs) pObj.inputs = {};
  pObj.inputs[promptInputKey] = promptText;

  return w;
}

async function tryUpload(
  baseUrl: string,
  filePath: string,
  uploadName: string,
  endpoint: "/upload/image" | "/upload/video"
): Promise<{ name: string }> {
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append("image", new Blob([buf]), uploadName);
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(
      `Upload falhou (${endpoint}) ${res.status}: ${t.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as { name?: string };
  if (!data.name) {
    throw new Error(`Resposta de upload sem "name": ${JSON.stringify(data)}`);
  }
  return { name: data.name };
}

/**
 * Envia o ficheiro para a pasta input do ComfyUI.
 * Tenta `/upload/image` (comum) e depois `/upload/video`.
 */
export async function uploadInputFile(
  baseUrl: string,
  filePath: string,
  uploadName: string
): Promise<{ name: string }> {
  const root = normalizeBaseUrl(baseUrl);
  try {
    return await tryUpload(root, filePath, uploadName, "/upload/image");
  } catch (e1) {
    try {
      return await tryUpload(root, filePath, uploadName, "/upload/video");
    } catch {
      throw e1;
    }
  }
}

type PromptResponse = { prompt_id: string; number?: number };

export async function queuePrompt(
  baseUrl: string,
  workflow: ComfyWorkflow,
  clientId: string
): Promise<PromptResponse> {
  const root = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${root}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST /prompt ${res.status}: ${t.slice(0, 800)}`);
  }
  const data = (await res.json()) as PromptResponse;
  if (!data.prompt_id) {
    throw new Error(`Resposta /prompt inválida: ${JSON.stringify(data)}`);
  }
  return data;
}

function isVideoFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".mp4") ||
    lower.endsWith(".webm") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".mkv")
  );
}

type FileRef = { filename: string; subfolder?: string; type?: string };

function collectFileRefsFromOutput(
  output: Record<string, unknown>,
  acc: FileRef[]
): void {
  const pushArray = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === "object" && "filename" in item) {
        const o = item as FileRef;
        acc.push({
          filename: o.filename,
          subfolder: o.subfolder ?? "",
          type: o.type ?? "output",
        });
      }
    }
  };
  for (const [k, v] of Object.entries(output)) {
    if (k === "images" || k === "gifs" || k === "videos") {
      pushArray(v);
    } else if (typeof v === "object" && v !== null) {
      collectFileRefsFromOutput(v as Record<string, unknown>, acc);
    }
  }
}

export function firstVideoOutputFromHistoryEntry(
  historyEntry: unknown
): FileRef | null {
  if (!historyEntry || typeof historyEntry !== "object") return null;
  const outputs = (historyEntry as { outputs?: Record<string, unknown> })
    .outputs;
  if (!outputs) return null;
  const acc: FileRef[] = [];
  for (const nodeOut of Object.values(outputs)) {
    if (nodeOut && typeof nodeOut === "object") {
      collectFileRefsFromOutput(nodeOut as Record<string, unknown>, acc);
    }
  }
  for (const ref of acc) {
    if (isVideoFilename(ref.filename)) return ref;
  }
  return acc.length > 0 ? acc[acc.length - 1]! : null;
}

async function fetchHistoryForPrompt(
  baseUrl: string,
  promptId: string
): Promise<unknown | null> {
  const root = normalizeBaseUrl(baseUrl);
  const res = await fetch(
    `${root}/history/${encodeURIComponent(promptId)}`
  );
  if (res.ok) {
    const data = (await res.json()) as unknown;
    if (
      data &&
      typeof data === "object" &&
      Object.keys(data as object).length > 0
    ) {
      return data;
    }
  }
  const res2 = await fetch(`${root}/history?max_items=200`);
  if (res2.ok) {
    const data = (await res2.json()) as Record<string, unknown>;
    if (data && promptId in data) {
      return data[promptId];
    }
  }
  return null;
}

function historyHasOutputs(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const o = (entry as { outputs?: unknown }).outputs;
  return typeof o === "object" && o !== null && Object.keys(o).length > 0;
}

function historyIsError(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const st = (entry as { status?: { status_str?: string } }).status;
  if (st?.status_str === "error") {
    return JSON.stringify(st);
  }
  return null;
}

export async function waitForPromptInHistory(
  baseUrl: string,
  promptId: string,
  timeoutMs: number,
  pollMs = 1500
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const entry = await fetchHistoryForPrompt(baseUrl, promptId);
      if (entry !== null && entry !== undefined) {
        const errMsg = historyIsError(entry);
        if (errMsg) {
          throw new Error(`ComfyUI: execução falhou: ${errMsg}`);
        }
        if (historyHasOutputs(entry)) {
          return entry;
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("ComfyUI:")) throw e;
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
    await sleep(pollMs);
  }
  throw lastErr ?? new Error(`Timeout à espera do histórico (${promptId}).`);
}

export async function downloadComfyOutputFile(
  baseUrl: string,
  ref: FileRef,
  destPath: string
): Promise<void> {
  const root = normalizeBaseUrl(baseUrl);
  const sub = ref.subfolder ?? "";
  const typ = ref.type ?? "output";
  const q = new URLSearchParams({
    filename: ref.filename,
    type: typ,
  });
  if (sub) q.set("subfolder", sub);
  const res = await fetch(`${root}/view?${q.toString()}`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GET /view ${res.status}: ${t.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

export type RunV2VArgs = {
  settings: ComfySettings;
  inputVideoPath: string;
  prompt: string;
  outputDir: string;
  outputBasename: string;
};

export type RunV2VResult = { outputPath: string; promptId: string };

/**
 * Orquestra upload → injeção → fila → histórico → download para outputDir.
 */
export async function runComfyV2V(args: RunV2VArgs): Promise<RunV2VResult> {
  const {
    settings,
    inputVideoPath,
    prompt,
    outputDir,
    outputBasename,
  } = args;
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!settings.workflowApiPath) {
    throw new Error(
      "Defina o caminho do workflow API (JSON) nas definições ComfyUI."
    );
  }
  await fs.mkdir(outputDir, { recursive: true });

  const origName = path.basename(inputVideoPath);
  const uploadName = `lekeleto_${Date.now()}_${origName}`;
  const { name: uploadedName } = await uploadInputFile(
    baseUrl,
    inputVideoPath,
    uploadName
  );

  const workflow = await loadWorkflowFromFileAsync(
    settings.workflowApiPath
  );
  const merged = injectV2VIntoWorkflow(
    workflow,
    settings.injection,
    uploadedName,
    prompt
  );

  const clientId = randomUUID();
  const { prompt_id } = await queuePrompt(baseUrl, merged, clientId);

  const historyEntry = await waitForPromptInHistory(
    baseUrl,
    prompt_id,
    settings.clientTimeoutMs
  );

  const fileRef = firstVideoOutputFromHistoryEntry(historyEntry);
  if (!fileRef) {
    throw new Error(
      "O workflow concluiu mas não foi encontrada saída de vídeo no histórico. Verifique o nó de saída."
    );
  }

  const ext = path.extname(fileRef.filename) || ".mp4";
  const safeBase =
    outputBasename.replace(/[^\w.\-]+/g, "_").replace(/\.[^.]+$/, "") ||
    "lekeleto_comfy";
  const outputPath = path.join(outputDir, `${safeBase}${ext}`);

  await downloadComfyOutputFile(baseUrl, fileRef, outputPath);

  return { outputPath, promptId: prompt_id };
}
