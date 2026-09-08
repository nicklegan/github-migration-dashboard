import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembles the deployable dashboard: copies the action's prebuilt web assets
// into outputPath and writes the fresh migration data alongside them, so the
// consumer workflow can upload outputPath straight to GitHub Pages.
//
// The action itself does the "build" — the heavy Vite compile happens once when
// the action is released (committed to dist/web/), and here we only combine
// those static assets with the current data.
// Publishes only what the dashboard reads. The event log and repository state
// stay in the data directory; they are the store, not the payload.
const PUBLISHED = ["summary.json", "rows", "detail"];

function assembleSite(outputPath, dataDir) {
  const webRoot = prebuiltWebRoot();
  if (!fs.existsSync(webRoot)) {
    throw new Error(
      `Prebuilt dashboard assets not found at ${webRoot}. The action bundle is incomplete.`,
    );
  }

  fs.rmSync(outputPath, { recursive: true, force: true });
  fs.cpSync(webRoot, outputPath, { recursive: true });

  const target = path.join(outputPath, "data");
  // A local run leaves its data inside the prebuilt bundle, and copying merges
  // rather than replaces — so drop whatever came along before writing the
  // current payload, or a stale chunk could outlive the data it belonged to.
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of PUBLISHED) {
    const source = path.join(dataDir, entry);
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(target, entry), { recursive: true });
    }
  }

  return outputPath;
}

// The prebuilt dashboard ships in the action repo under dist/web/.
// GITHUB_ACTION_PATH points at the action checkout at runtime; fall back to a
// path relative to this module for local runs.
function prebuiltWebRoot() {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  if (actionPath) return path.join(actionPath, "dist", "web");
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
}

export { assembleSite };
