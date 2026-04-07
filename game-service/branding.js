import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _branding = null;

export function loadBranding() {
  if (_branding) return _branding;
  const brandingPath = resolve(__dirname, "../branding.json");
  try {
    if (existsSync(brandingPath)) {
      _branding = JSON.parse(readFileSync(brandingPath, "utf-8"));
      return _branding;
    }
  } catch (e) {
    console.warn("[branding] Failed to load branding.json:", e.message);
  }
  _branding = {};
  return _branding;
}
