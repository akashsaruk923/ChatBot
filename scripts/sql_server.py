#!/usr/bin/env python3
"""Local SQL Server lifecycle; generated credentials stay in Docker metadata/memory."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import time

IMAGE = (
    "mcr.microsoft.com/mssql/server@"
    "sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718"
)
CONTAINER = "dadus-sql"
VOLUME = "dadus-sql-data"
LABEL = "io.dadus.local-development"
LABEL_VALUE = "sql-server-v1"


class SetupError(Exception):
    pass


def docker(*args: str, capture: bool = True, env: dict[str, str] | None = None,
           check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["docker", *args], text=True, capture_output=capture, env=env, timeout=timeout,
    )
    if check and result.returncode:
        # Do not include inspect results or environment values in error messages.
        detail = (result.stderr or "Docker command failed.").strip()
        raise SetupError(detail)
    return result


def inspect(kind: str, name: str) -> dict | None:
    result = docker(kind, "inspect", name, check=False)
    if result.returncode:
        text = (result.stderr or "").lower()
        if "no such" in text or "not found" in text:
            return None
        raise SetupError("Cannot inspect Docker resources. Check docker version and daemon access.")
    data = json.loads(result.stdout)
    if len(data) != 1:
        raise SetupError("Unexpected Docker inspection result.")
    return data[0]


def owned_container() -> dict | None:
    container = inspect("container", CONTAINER)
    if container is None:
        return None
    labels = container.get("Config", {}).get("Labels", {}) or {}
    if labels.get(LABEL) != LABEL_VALUE:
        raise SetupError(
            f"Container {CONTAINER} is not managed by DADUS AI. It was left unchanged."
        )
    mounts = container.get("Mounts", [])
    if not any(m.get("Name") == VOLUME and m.get("Destination") == "/var/opt/mssql"
               for m in mounts):
        raise SetupError("Managed SQL container has unexpected storage; refusing to change it.")
    bindings = container.get("HostConfig", {}).get("PortBindings", {}).get("1433/tcp", []) or []
    if bindings != [{"HostIp": "127.0.0.1", "HostPort": "1433"}]:
        raise SetupError("SQL port binding must be restricted to 127.0.0.1:1433.")
    return container


def pull_image() -> None:
    if inspect("image", IMAGE) is None:
        # Docker verifies every downloaded layer against the pinned OCI digest.
        docker("pull", IMAGE, capture=False, timeout=900)


def create_container() -> None:
    volume = inspect("volume", VOLUME)
    supplied_password = os.environ.get("DADUS_SQL_SA_PASSWORD")
    if volume is not None:
        labels = volume.get("Labels", {}) or {}
        if labels.get(LABEL) != LABEL_VALUE:
            raise SetupError(f"Volume {VOLUME} is not managed by DADUS AI; it was left unchanged.")
        if not supplied_password:
            raise SetupError(
                "The SQL data volume exists without its container. Preserve it and supply its "
                "original password through DADUS_SQL_SA_PASSWORD before recovery."
            )
    pull_image()
    if volume is None:
        docker("volume", "create", "--label", f"{LABEL}={LABEL_VALUE}", VOLUME)
    password = supplied_password or secrets.token_urlsafe(36) + "aA1!"
    env = os.environ.copy()
    env["MSSQL_SA_PASSWORD"] = password
    docker(
        "run", "--detach", "--name", CONTAINER,
        "--label", f"{LABEL}={LABEL_VALUE}",
        "--env", "ACCEPT_EULA=Y", "--env", "MSSQL_PID=Developer",
        "--env", "MSSQL_SA_PASSWORD", "--env", "MSSQL_MEMORY_LIMIT_MB=2048",
        "--publish", "127.0.0.1:1433:1433",
        "--mount", f"type=volume,source={VOLUME},target=/var/opt/mssql",
        IMAGE, env=env,
    )


def probe() -> bool:
    # The password never appears in a command argument or host-visible output.
    command = (
        'if [ -x /opt/mssql-tools18/bin/sqlcmd ]; then '
        'tool=/opt/mssql-tools18/bin/sqlcmd; else tool=/opt/mssql-tools/bin/sqlcmd; fi; '
        'SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" "$tool" '
        '-S localhost -U sa -C -b -l 3 -h -1 -Q "SET NOCOUNT ON; SELECT 1;"'
    )
    result = docker("exec", CONTAINER, "sh", "-c", command, check=False, timeout=10)
    return result.returncode == 0 and result.stdout.strip() == "1"


def ensure() -> dict:
    container = owned_container()
    if container is None:
        create_container()
        container = owned_container()
    if not container.get("State", {}).get("Running"):
        docker("start", CONTAINER)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        container = owned_container()
        if not container.get("State", {}).get("Running"):
            raise SetupError(
                "SQL Server exited before readiness. Inspect its Docker logs locally; "
                "no data or container was removed."
            )
        if probe():
            print("SQL Server ready: authenticated SELECT 1 passed on 127.0.0.1:1433.",
                  file=sys.stderr)
            return container
        time.sleep(1)
    raise SetupError("SQL Server did not pass the authenticated readiness query within 120 seconds.")


def application_environment(container: dict) -> dict[str, str]:
    # Only this managed container's generated password is read, and it is never printed.
    password = next(
        (item.partition("=")[2] for item in container.get("Config", {}).get("Env", [])
         if item.partition("=")[0] == "MSSQL_SA_PASSWORD"), None,
    )
    if not password:
        raise SetupError("The managed SQL container has no configured password.")
    # SqlClient quoted-value escaping, including externally supplied recovery passwords.
    quoted = '"' + password.replace('"', '""') + '"'
    env = os.environ.copy()
    env["ConnectionStrings__Dadus"] = (
        "Server=127.0.0.1,1433;Database=Dadus;User Id=sa;Password=" + quoted + ";"
        "Encrypt=True;TrustServerCertificate=True;Connect Timeout=5"
    )
    return env


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Manage the private, local DADUS AI SQL Server Developer database."
    )
    parser.add_argument("action", choices=("ensure", "exec", "status", "stop", "pull"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == "pull":
        pull_image()
    elif args.action == "ensure":
        ensure()
    elif args.action == "status":
        container = owned_container()
        if not container or not container.get("State", {}).get("Running") or not probe():
            print("SQL Server is not ready.", file=sys.stderr)
            return 1
        print("SQL Server ready: authenticated SELECT 1 passed.")
    elif args.action == "stop":
        container = owned_container()
        if container and container.get("State", {}).get("Running"):
            docker("stop", "--time", "30", CONTAINER)
        print("SQL Server stopped; container and data volume preserved.")
    elif args.action == "exec":
        command = args.command
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            parser.error("exec requires a command")
        container = ensure()
        os.execvpe(command[0], command, application_environment(container))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SetupError, subprocess.TimeoutExpired, OSError, ValueError) as error:
        print(f"SQL setup failed: {error}", file=sys.stderr)
        raise SystemExit(1)
