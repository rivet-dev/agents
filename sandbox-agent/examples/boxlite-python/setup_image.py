"""Build the sandbox-agent Docker image and export it to OCI layout."""

import os
import subprocess

DOCKER_IMAGE = "sandbox-agent-boxlite"
OCI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oci-image")


def setup_image() -> None:
    dockerfile_dir = os.path.dirname(os.path.abspath(__file__))

    print(f'Building image "{DOCKER_IMAGE}" (cached after first run)...')
    subprocess.run(
        ["docker", "build", "-t", DOCKER_IMAGE, dockerfile_dir],
        check=True,
    )

    if not os.path.exists(os.path.join(OCI_DIR, "oci-layout")):
        print("Exporting to OCI layout...")
        os.makedirs(OCI_DIR, exist_ok=True)
        subprocess.run(
            [
                "skopeo", "copy",
                f"docker-daemon:{DOCKER_IMAGE}:latest",
                f"oci:{OCI_DIR}:latest",
            ],
            check=True,
        )
