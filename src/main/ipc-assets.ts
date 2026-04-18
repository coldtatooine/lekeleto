import { dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

const ALLOWED_EXT = new Set([".dae", ".fbx", ".glb"]);
const MAX_BYTES = 500 * 1024 * 1024;

function assertAllowedPath(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Extensão não permitida: ${ext || "(vazia)"}`);
  }
}

export function registerAssetHandlers(): void {
  ipcMain.handle("assets:openDialog", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "COLLADA / FBX / GLB", extensions: ["dae", "fbx", "glb"] },
      ],
    });
    if (result.canceled) return { canceled: true as const };
    return { canceled: false as const, paths: result.filePaths };
  });

  ipcMain.handle(
    "assets:readFile",
    async (_event, payload: { path: string }) => {
      const filePath = path.normalize(payload.path);
      assertAllowedPath(filePath);
      const st = await fs.stat(filePath);
      if (!st.isFile()) throw new Error("Caminho inválido");
      if (st.size > MAX_BYTES) {
        throw new Error("Ficheiro excede o limite de 500 MB");
      }
      const buf = await fs.readFile(filePath);
      return {
        name: path.basename(filePath),
        size: st.size,
        buffer: buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength
        ),
      };
    }
  );
}
