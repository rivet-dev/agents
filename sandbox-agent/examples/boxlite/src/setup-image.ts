import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

export const DOCKER_IMAGE = "sandbox-agent-boxlite";
export const OCI_DIR = new URL("../oci-image", import.meta.url).pathname;

export function setupImage() {
  console.log(`Building image "${DOCKER_IMAGE}" (cached after first run)...`);
  execSync(`docker build -t ${DOCKER_IMAGE} ${new URL("..", import.meta.url).pathname}`, { stdio: "inherit" });

  if (!existsSync(`${OCI_DIR}/oci-layout`)) {
    console.log("Exporting to OCI layout...");
    mkdirSync(OCI_DIR, { recursive: true });
    execSync(`docker save ${DOCKER_IMAGE} | tar -xf - -C ${OCI_DIR}`, { stdio: "inherit" });
  }
}
