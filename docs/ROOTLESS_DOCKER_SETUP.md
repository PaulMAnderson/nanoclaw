# Rootless Docker Setup for NanoClaw

This document explains the rootless Docker configuration used in this fork and the permission fixes required for reliable operation.

## Why Rootless Docker?

NanoClaw spawns agent containers on behalf of user sessions. Running these containers under a dedicated `nanoclaw` user (rather than root) limits the blast radius if a container escapes its sandbox.

This fork uses a **nanoclaw rootless Docker daemon** — a separate Docker daemon running as the `nanoclaw` user, completely isolated from the host's main Docker daemon.

```
Host
├── Main Docker daemon (root)        ← your other services, untouched
└── nanoclaw rootless daemon (uid=1667)
      └── nanoclaw container (Node.js host process)
            └── agent containers (ephemeral, one per turn)
```

## Setup

### 1. Create the nanoclaw user

```bash
sudo useradd -m -s /bin/bash nanoclaw
sudo usermod -aG docker nanoclaw   # optional, not used for the isolated daemon
```

### 2. Install rootless Docker for nanoclaw

```bash
sudo su - nanoclaw
dockerd-rootless-setuptool.sh install
systemctl --user enable docker
systemctl --user start docker
exit
```

The daemon socket is at `/run/user/1667/docker.sock` (where 1667 is nanoclaw's UID).

### 3. Expose the socket to the main container

In `compose.yml`, mount the socket:
```yaml
volumes:
  - /run/user/1667/docker.sock:/var/run/nanoclaw-docker.sock
environment:
  - DOCKER_HOST=unix:///var/run/nanoclaw-docker.sock
```

### 4. Linger (survive logout)

```bash
sudo loginctl enable-linger nanoclaw
```

Without this, the daemon stops when no nanoclaw session is active.

## Permission Issues and Fixes

### The Problem: UID Remapping

Rootless Docker remaps UIDs inside containers. When the nanoclaw container (running as the host `nanoclaw` uid=1667) spawns an agent container, the agent container runs as `node` (uid=1000) which is remapped to a sub-UID on the host (e.g., uid=166999).

This means:
- Files written by the agent container are owned by the remapped UID on the host
- The nanoclaw process (uid=1667) cannot `chmod` those files
- Claude Code inside the agent container fails if it can't write to `.claude/` session dirs

### Fix 1: Pre-chmod workspace directories

Before spawning each agent container, `chmod -R 777` the session `.claude/` directory and the group workspace directory. This ensures the remapped container UID can write to them.

```typescript
// src/container-runner.ts
execSync(`chmod -R 777 ${sessionDir} ${groupWorkspaceDir}`, { stdio: 'pipe' });
```

The `777` is intentional — these are ephemeral per-session directories inside an already-isolated container sandbox, not shared host paths.

### Fix 2: Suppress chmod errors from container-owned files

After an agent run completes, if the agent wrote files, those files are owned by the remapped UID. Subsequent `chmod` calls from the host will fail with `EPERM`. These errors are suppressed:

```typescript
try {
  execSync(`chmod -R 777 ${path}`, { stdio: 'pipe' });
} catch {
  // Ignore: files may be owned by remapped container UID
}
```

## Inspecting the Isolated Daemon

```bash
# List containers running under the nanoclaw daemon
DOCKER_HOST=unix:///run/user/1667/docker.sock docker ps

# View nanoclaw daemon logs
sudo journalctl -u user@1667 --user-unit docker -f

# Check daemon status
sudo su - nanoclaw -c "systemctl --user status docker"
```

## Home Assistant Hostname

When running inside rootless Docker, the host's `/etc/hosts` is not visible inside the container's network namespace. Use a fixed IP instead of a hostname for services like Home Assistant:

```bash
# Instead of: HA_URL=http://homeassistant.local:8123
HA_URL=http://192.168.1.254:8123
```
