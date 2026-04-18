import { app, BrowserWindow } from "electron";
import path from "node:path";
import Database from "better-sqlite3";
import { registerAssetHandlers } from "./ipc-assets";
import { registerIpcHandlers } from "./ipc-handlers";

const isDev = !app.isPackaged;

let db: InstanceType<typeof Database> | null = null;

function devServerUrl(): string {
  const env = process.env.VITE_DEV_SERVER_URL?.trim();
  if (env) return env;
  return "http://127.0.0.1:5173";
}

function openDatabase(): void {
  const dbPath = path.join(app.getPath("userData"), "lekeleto.db");
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      /** Com Vite em http://, <video src="file://..."> precisa disto para pré-visualizar exports locais. */
      webSecurity: !isDev,
    },
  });
  if (isDev) {
    void win.loadURL(devServerUrl());
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

void app.whenReady().then(() => {
  openDatabase();
  registerIpcHandlers();
  registerAssetHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  db?.close();
  db = null;
  if (process.platform !== "darwin") app.quit();
});
