import type { AssetFormat } from "../renderer/lib/modelLoader";

function extensionFormat(fileName: string): AssetFormat | null {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (ext === ".dae") return "COLLADA";
  if (ext === ".fbx") return "FBX";
  if (ext === ".glb") return "GLB";
  return null;
}

const urls = import.meta.glob("./*.{dae,fbx,glb}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export type LibraryItem = {
  id: string;
  name: string;
  format: AssetFormat;
  url: string;
};

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

export const LIBRARY_ITEMS: LibraryItem[] = Object.entries(urls)
  .map(([path, url]) => {
    const name = path.replace(/^\.\//, "");
    const fmt = extensionFormat(name);
    if (!fmt) return null;
    return {
      id: slug(name.replace(/\.[^.]+$/, "")),
      name,
      format: fmt,
      url,
    };
  })
  .filter((x): x is LibraryItem => x !== null)
  .sort((a, b) => a.name.localeCompare(b.name));
