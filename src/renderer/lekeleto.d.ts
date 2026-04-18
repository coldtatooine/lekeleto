export type OpenDialogResult =
  | { canceled: true }
  | { canceled: false; paths: string[] };

export type ReadAssetFileResult = {
  name: string;
  size: number;
  buffer: ArrayBuffer | Uint8Array;
};

export type ComfyInjectionMap = {
  videoNodeId: string;
  videoInputKey: string;
  promptNodeId: string;
  promptInputKey: string;
};

export type ComfySettings = {
  baseUrl: string;
  workflowApiPath: string;
  injection: ComfyInjectionMap;
  clientTimeoutMs: number;
};

export type LekeletoApi = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  onRenderProgress: (callback: (data: string) => void) => () => void;
  openAssetDialog: () => Promise<OpenDialogResult>;
  readAssetFile: (filePath: string) => Promise<ReadAssetFileResult>;
};

declare global {
  interface Window {
    lekeleto?: LekeletoApi;
  }
}

export {};
