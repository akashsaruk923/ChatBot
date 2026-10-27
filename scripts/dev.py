#!/usr/bin/env python3
"""Run only the DADUS AI processes started by this command."""

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
API_PROJECT = ROOT / "backend/Dadus.Api/Dadus.Api.csproj"


def unused_port(port):
    with socket.socket() as sock:
        # A closed listener may leave TCP connections in TIME_WAIT. Match the
        # server's reuse behavior while still refusing an active listener.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as error:
            raise RuntimeError(f"Port {port} is already in use; its existing process was left unchanged.") from error


def sql_command(command, env):
    if env.get("ConnectionStrings__Dadus") or env.get("Database__Provider", "").lower() == "sqlite":
        return command
    return ["bash", str(ROOT / "scripts/sql-server.sh"), "exec", "--", *command]


def main():
    parser = argparse.ArgumentParser(description="Start the local DADUS AI development app.")
    parser.add_argument("target", nargs="?", choices=("all", "api", "web"), default="all")
    args = parser.parse_args()
    children = []
    logs = []
    log_dir = ROOT / ".logs"
    log_dir.mkdir(exist_ok=True)
    env = os.environ.copy()
    env.setdefault("ASPNETCORE_ENVIRONMENT", "Development")
    env["ASPNETCORE_URLS"] = "http://127.0.0.1:5088"
    if env.get("Database__Provider", "").lower() == "sqlite":
        (ROOT / ".local").mkdir(exist_ok=True)
        if not env.get("ConnectionStrings__Dadus"):
            env["ConnectionStrings__Dadus"] = f"Data Source={ROOT / '.local/dadus.db'}"

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    def start(name, command, cwd):
        log = (log_dir / f"{name}.log").open("w")
        logs.append(log)
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        children.append((name, child))
        return child

    def ready(name, child, url, expected_json=False):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(60):
            if child.poll() is not None:
                raise RuntimeError(f"{name} exited during startup. Read .logs/{name}.log.")
            try:
                with opener.open(url, timeout=1) as response:
                    if response.status == 200:
                        if expected_json and json.load(response).get("status") != "ok":
                            raise RuntimeError("API did not report readiness.")
                        print(f"{name} is ready on the loopback interface. Logs: .logs/{name}.log", flush=True)
                        return
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(0.5)
        raise RuntimeError(f"{name} did not become ready. Read .logs/{name}.log.")

    try:
        if args.target in ("all", "api"):
            unused_port(5088)
            migration = ["dotnet", "run", "--project", str(API_PROJECT), "--configuration", "Release",
                         "--no-build", "--no-restore", "--no-launch-profile", "--", "--migrate"]
            subprocess.run(sql_command(migration, env), cwd=ROOT, env=env, check=True)
            command = ["dotnet", "run", "--project", str(API_PROJECT), "--configuration", "Release",
                       "--no-build", "--no-restore", "--no-launch-profile"]
            api = start("api", sql_command(command, env), ROOT)
            ready("api", api, "http://127.0.0.1:5088/api/health", expected_json=True)
        if args.target in ("all", "web"):
            unused_port(4200)
            web = start("web", ["npm", "start", "--", "--host", "127.0.0.1", "--port", "4200"],
                        ROOT / "frontend/dadus-web")
            ready("web", web, "http://127.0.0.1:4200/")
        print("Press Ctrl+C to stop these app processes. The SQL data volume is preserved.", flush=True)
        while True:
            for name, child in children:
                if child.poll() is not None:
                    raise RuntimeError(f"{name} stopped; see .logs/{name}.log.")
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        for _name, child in reversed(children):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for _name, child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
        for log in logs:
            log.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"DADUS AI could not start: {error}", file=sys.stderr)
        raise SystemExit(1)
