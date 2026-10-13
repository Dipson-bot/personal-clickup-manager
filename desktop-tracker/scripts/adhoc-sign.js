// macOS: an ad-hoc signature for the packed app (no Apple account needed).
// Without any signature, macOS on Apple Silicon says the downloaded app "is
// damaged and can't be opened". Ad-hoc signed, it instead asks once whether to
// open an app from an unidentified developer (right-click > Open, or System
// Settings > Privacy & Security > Open Anyway). Runs after packing, before the dmg.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
