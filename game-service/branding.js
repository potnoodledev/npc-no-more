import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _branding = null;

export function loadBranding() {
  if (_branding) return _branding;
  // Check multiple locations: same dir (Docker mount), parent dir (dev)
  const paths = [
    resolve(__dirname, "branding.json"),
    resolve(__dirname, "../branding.json"),
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        _branding = JSON.parse(readFileSync(p, "utf-8"));
        return _branding;
      }
    } catch (e) {
      console.warn("[branding] Failed to load", p, e.message);
    }
  }
  _branding = {};
  return _branding;
}
