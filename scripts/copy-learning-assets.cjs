/**
 * Copies the learning UI stylesheet into the distribution directory.
 *
 * `tsc` emits `dist/learning/ui/client.js` but never the stylesheet the page
 * links to, so without this step the learning UI would load unstyled while every
 * other check stayed green. The copy is verified (non-empty) before the build is
 * allowed to succeed.
 *
 * The source lands with the learning UI wave; until then this script reports
 * that it has nothing to copy and exits 0, so a build from a tree that has not
 * reached that wave still works.
 */
const { copyFileSync, existsSync, mkdirSync, statSync } = require("node:fs");
const path = require("node:path");

/** Browser assets required by the compiled learning UI. */
const ASSETS = [
  {
    source: path.resolve(__dirname, "..", "src", "learning", "ui", "styles.css"),
    destination: path.resolve(__dirname, "..", "dist", "learning", "ui", "styles.css"),
  },
];

/** Copy one asset and fail if the resulting destination is unusable. */
function copyAsset({ source, destination }) {
  if (!existsSync(source)) {
    throw new Error(`source asset is missing: ${source}`);
  }
  const destinationDir = path.dirname(destination);
  if (!existsSync(destinationDir)) {
    mkdirSync(destinationDir, { recursive: true });
  }
  copyFileSync(source, destination);
  if (!existsSync(destination) || statSync(destination).size === 0) {
    throw new Error(`destination asset is missing or empty: ${destination}`);
  }
}

function main() {
  const pending = ASSETS.filter((asset) => !existsSync(asset.source));
  if (pending.length > 0) {
    for (const asset of pending) {
      console.log(
        `copy-learning-assets: ${path.relative(path.resolve(__dirname, ".."), asset.source)} is not present yet; nothing to copy`,
      );
    }
    return;
  }
  for (const asset of ASSETS) copyAsset(asset);
  const noun = ASSETS.length === 1 ? "asset" : "assets";
  console.log(`copy-learning-assets: copied ${ASSETS.length} ${noun}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `copy-learning-assets failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}

module.exports = { ASSETS, copyAsset };
