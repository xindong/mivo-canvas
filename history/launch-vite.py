#!/usr/bin/env python3
"""Fully daemonize `npm run dev` so it survives the agent tool-call boundary."""
import os
import sys

PROJECT = "/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas"
LOG = os.path.join(PROJECT, "history", "vite-dev.log")
PIDFILE = os.path.join(PROJECT, "history", "vite-dev.pid")

# double-fork daemonize
if os.fork() > 0:
    os._exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)

os.chdir(PROJECT)
with open(PIDFILE, "w") as f:
    f.write(str(os.getpid()))

logfd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(logfd, 1)
os.dup2(logfd, 2)
nullfd = os.open("/dev/null", os.O_RDONLY)
os.dup2(nullfd, 0)

os.execvp("npm", ["npm", "run", "dev"])
