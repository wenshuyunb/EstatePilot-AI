# DEVELOPMENT_ENVIRONMENT.md

**How to work on this machine** — EstatePilot AI development environment

| | |
|---|---|
| Machine | `DESKTOP-2BEKLIA` |
| Project home | `D:\Projects\EstatePilot-AI` |
| Stack | Next.js · NestJS · PostgreSQL/pgvector · Redis/BullMQ · Docker · Nginx · pnpm |
| Last updated | 2026-10-08 (Phase 0 — verified 12/12 test suites) |

> All commands below were **actually executed and verified** during Phase 0. Copy-paste them as-is.
>
> ⚠️ **Read §15 "Known gotchas" before writing any infrastructure code** — there are four
> version-specific traps on this machine that will otherwise cost you hours.

---

## 1. Quick reference — ports & paths

| Service | Port | Path |
|---|---|---|
| Next.js Frontend | **3000** | `D:\Projects\EstatePilot-AI\apps\web` (planned) |
| NestJS Backend | **3001** | `D:\Projects\EstatePilot-AI\apps\api` (planned) |
| PostgreSQL | **5432** | Docker container |
| Redis | **6379** | Docker container |
| Nginx | **80 / 443** | Docker container |
| Docker Desktop data | — | `C:\Users\11382\AppData\Local\Docker` |
| WSL Ubuntu distro | — | **`D:\WSL\Ubuntu`** (moved off C:) |
| WSL default user | — | `dev` (uid 1000, in `sudo` group) |
| pnpm store | — | `D:\.pnpm-store\v11` |
| Playwright browsers | — | `%LOCALAPPDATA%\ms-playwright` |

### Verified tool versions

```
git      2.55.0.windows.1     node     v24.19.0 LTS      npm      11.17.0
pnpm     12.10.1              docker   29.8.2            compose  v5.5.1
gh       2.102.0              python   3.12.10           pip      25.0.1
code     1.140.0              7z       26.04             chrome   155.0.8059.40
wsl      3.0.1.0 (kernel 6.18.40.1-microsoft-standard-WSL2)
Ubuntu   26.04.1 LTS          Docker Desktop 4.94.0       Playwright 1.63.0
```

### VS Code extensions already installed (10)

```
dbaeumer.vscode-eslint           esbenp.prettier-vscode        prisma.prisma
ms-azuretools.vscode-docker      ms-azuretools.vscode-containers
eamodio.gitlens                  bradlc.vscode-tailwindcss
editorconfig.editorconfig        ms-playwright.playwright
ashinzekene.nestjs
```

Re-install them all on another machine in one line:

```powershell
code --install-extension dbaeumer.vscode-eslint esbenp.prettier-vscode prisma.prisma `
     ms-azuretools.vscode-docker eamodio.gitlens bradlc.vscode-tailwindcss `
     editorconfig.editorconfig ms-playwright.playwright ashinzekene.nestjs
```

---

## 2. How to open the project

### Option A — VS Code from PowerShell (recommended)

```powershell
cd D:\Projects\EstatePilot-AI
code .
```

### Option B — From WSL Ubuntu (Linux toolchain, recommended for scripts/CI parity)

```powershell
wsl -d Ubuntu
```

then inside Ubuntu:

```bash
cd /mnt/d/Projects/EstatePilot-AI
code .
```

> **Tip:** for best file-watching performance keep source code on the Linux filesystem (`~/projects`) when running heavy builds inside WSL, because `/mnt/d` crosses the 9p filesystem boundary. For normal Windows-side development, `D:\Projects` is correct and fast.

### Option C — Windows Terminal

Open **Windows Terminal** → new tab dropdown → choose **PowerShell** or **Ubuntu**.

---

## 3. How to start Docker

Docker Desktop must be running before any container command works.

### Start it

```powershell
# GUI way
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"

# or just click the Docker Desktop icon; wait for the whale icon to stop animating
```

### Verify the engine is actually up (not just the GUI)

```powershell
docker version
docker info
docker run --rm hello-world
```

Expected: `docker version` prints both a **Client** and a **Server** section. If the Server section errors with `cannot connect to the Docker daemon`, the engine is not up yet — wait and retry.

### Check that the WSL2 backend + Ubuntu integration are on

```powershell
wsl --list --verbose          # Ubuntu must show VERSION = 2
docker context ls             # should show "desktop-linux *"
```

### Set Docker Desktop to start automatically (optional, convenient)

Docker Desktop → **Settings → General → ✅ Start Docker Desktop when you sign in to your computer**.

### Stop Docker

```powershell
# graceful shutdown of the engine
& "C:\Program Files\Docker\Docker\DockerCli.exe" -Shutdown

# or quit from the tray icon → Quit Docker Desktop
```

---

## 4. How to start the Frontend (Next.js)

```powershell
cd D:\Projects\EstatePilot-AI
pnpm install                 # only when dependencies change
pnpm --filter web dev        # or: cd apps\web ; pnpm dev
```

Open **http://localhost:3000**

- Stop the dev server: `Ctrl + C` in its terminal
- Production build check: `pnpm --filter web build`
- Type check: `pnpm --filter web exec tsc --noEmit`

---

## 5. How to start the Backend (NestJS)

```powershell
cd D:\Projects\EstatePilot-AI
pnpm --filter api start:dev  # watch mode / hot reload
```

Open **http://localhost:3001**

- Stop: `Ctrl + C`
- Production mode: `pnpm --filter api build` then `pnpm --filter api start:prod`
- Debug (Node inspector on 9229): `pnpm --filter api start:debug`

---

## 6. How to start / stop everything

### If the project has a root `docker-compose.yml`

```powershell
cd D:\Projects\EstatePilot-AI

docker compose up -d          # start postgres + redis + nginx in background
docker compose ps             # show status + health
docker compose logs -f        # follow logs (Ctrl+C to stop following)
docker compose down           # stop and remove containers (keeps data volumes)
docker compose down -v        # stop and remove containers AND volumes (DESTROYS DB DATA)
```

### Recommended daily workflow

```powershell
# 1. engine up
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
# 2. infrastructure up
cd D:\Projects\EstatePilot-AI ; docker compose up -d
# 3. app servers (two terminals, or pnpm -r --parallel dev)
pnpm --filter web dev
pnpm --filter api start:dev
```

### Order matters

1. Docker Desktop (engine)
2. `docker compose up -d` (PostgreSQL + Redis)
3. NestJS backend (needs DB + Redis)
4. Next.js frontend (needs backend)

---

## 7. How to inspect Docker

```powershell
docker ps                          # running containers
docker ps -a                        # including stopped
docker compose ps                   # compose project status + health
docker stats                        # live CPU/RAM/network per container
docker images                       # local images
docker volume ls                    # volumes (your DB data)
docker network ls                   # networks
docker system df                    # disk usage summary

# shell inside a container
docker exec -it <container> bash

# PostgreSQL specifically
docker exec -it <pg-container> psql -U <user> -d <db>

# Redis specifically
docker exec -it <redis-container> redis-cli

# logs
docker logs -f <container>
docker compose logs -f <service>

# cleanup
docker system prune                 # unused containers/networks/dangling images
docker system prune -a --volumes    # ⚠️ also removes unused images AND volumes
```

---

## 8. How to enter WSL

```powershell
wsl                          # default distro
wsl -d Ubuntu                # explicit
wsl --list --verbose         # what is installed + running state
wsl --shutdown               # stop all distros (use when WSL misbehaves)
```

Inside Ubuntu:

```bash
cd /mnt/d/Projects           # access Windows D: drive
sudo apt update && sudo apt upgrade -y
exit                         # leave WSL
```

**Networking note:** inside WSL, `localhost` refers to the Linux VM. Services published by Docker Desktop are reachable from WSL **and** from Windows `localhost` (Docker Desktop forwards them). If you need the Windows host IP from WSL:

```bash
ip route show default | awk '{print $3}'
```

---

## 9. How to check ports

### What is using a port right now

```powershell
# all dev ports at once
foreach ($p in 3000,3001,5432,6379,80,443) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { "{0} IN USE by PID {1} ({2})" -f $p, $c.OwningProcess, (Get-Process -Id $c.OwningProcess).ProcessName }
  else    { "{0} FREE" -f $p }
}
```

### Find what a PID is

```powershell
Get-Process -Id <PID> | Select-Object Id, ProcessName, Path
```

### Kill whatever holds a port (use carefully)

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess
```

### Ports reserved by Hyper-V/WSL (can block binds even when "free")

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

---

## 10. How to check Node / npm / pnpm

```powershell
node -v          # expected: v24.x LTS
npm -v           # expected: 11.x
pnpm -v          # expected: 12.x  (activated via corepack)
corepack --version
```

### pnpm is provided by Corepack

Corepack is what puts `pnpm` on your PATH; it resolves the pnpm version per project via the `packageManager` field in `package.json`. That is intentional — it guarantees every machine and CI uses the same pnpm version.

If `pnpm` is ever missing:

```powershell
corepack enable
corepack prepare pnpm@latest --activate
```

To activate the exact version a project pins:

```powershell
cd D:\Projects\EstatePilot-AI
corepack use pnpm@<version>
```

### Node version switching (if you ever need multiple Node versions)

Corepack does **not** manage Node itself. Node 24.19.0 LTS is installed system-wide at `C:\Program Files\nodejs`. If a future project needs a different Node major, install `nvm-windows` or use `fnm` — do **not** uninstall the system Node, several tools depend on it.

### npm scripts are blocked? (already fixed, documented for reference)

If you ever see `running scripts is disabled on this system`:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

This was the root cause of an initial `npm`/`npx`/`pnpm` failure during Phase 0.

---

## 11. Testing commands

```powershell
# unit / integration (Vitest or Jest — depends on what the package uses)
pnpm --filter api test
pnpm --filter web test
pnpm -r test                    # all packages

# watch mode
pnpm --filter api test --watch

# coverage
pnpm --filter api test -- --coverage

# end-to-end (Playwright)
pnpm --filter web exec playwright test              # headless
pnpm --filter web exec playwright test --headed     # watch the browser
pnpm --filter web exec playwright test --ui         # Playwright UI mode
pnpm --filter web exec playwright show-report       # open last HTML report
```

Install browsers once per machine (not global):

```powershell
cd D:\Projects\EstatePilot-AI
pnpm exec playwright install
```

---

## 12. Git / GitHub quick reference

```powershell
git --version
git config --global --list
gh auth status          # check login state
gh auth login           # log in (interactive — user action)
```

> ⚠️ `user.name` / `user.email` must be configured before the first commit:
> ```powershell
> git config --global user.name  "<Your Name>"
> git config --global user.email "<your@email>"
> ```

---

## 13. Daily health check (30 seconds)

```powershell
node -v ; npm -v ; pnpm -v ; git --version ; python --version
docker version
wsl --list --verbose
docker ps
```

If all of these answer, the environment is healthy.

---

## 14. Troubleshooting quick map

| Symptom | Cause | Fix |
|---|---|---|
| `cannot connect to the Docker daemon` | Docker Desktop not running | start Docker Desktop, wait for whale icon to settle |
| `docker pull` hangs / TLS timeout | system proxy not applied | see **§15.4** — Docker pulls work directly on this machine, but Node-based downloaders need the proxy |
| `running scripts is disabled` | ExecutionPolicy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (already applied) |
| `pnpm : not recognized` | corepack shims missing | `corepack enable` (needs Administrator) |
| `EACCES`/`EPERM` on `C:\Program Files\nodejs` | needs elevation | run that one command in an Administrator PowerShell |
| Ubuntu missing from `wsl -l -v` | distro not installed | `wsl --install -d Ubuntu --no-launch` |
| `wsl` prints a **localhost-proxy warning** | system proxy is on; WSL2 NAT mode cannot mirror a `127.0.0.1` proxy | **harmless** — commands still succeed (verified `exit=0`); ignore it |
| Port 3000 already in use | stale dev server | see §9 to find and stop the PID |
| `wsl` commands fail entirely | WSL feature/reboot pending | `wsl --update`, reboot if Windows requests it |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 12 blocks dependency build scripts | see **§15.1** |
| Postgres container exits code 1 | PG 18 volume path changed | see **§15.2** |
| nginx container `unhealthy` but serves 200 | busybox `wget` + `localhost` → `::1` | see **§15.3** |
| Python opens the Microsoft Store | Store alias stub shadows real Python | already fixed via PATH (§15.5) |

---

## 15. Known gotchas — version-specific traps on this machine

These four traps were hit and solved during Phase 0. They are **not** environment faults;
they are behaviour changes in current tool versions. Save yourself the debugging time.

### 15.1 pnpm 12 blocks dependency build scripts (`ERR_PNPM_IGNORED_BUILDS`)

pnpm 12 denies all lifecycle scripts by default (supply-chain hardening). Any package needing
a `postinstall` (Prisma engines, esbuild, `sharp`, native modules) will abort the install.

**Fix** — create `pnpm-workspace.yaml` in the project root:

```yaml
allowBuilds:
  '@prisma/client': true
  prisma: true
  '@prisma/engines': true
  esbuild: true
  sharp: true
```

Two traps inside this trap:

1. The setting is **`allowBuilds`** (a YAML **map** of `name: true`). The older
   **`onlyBuiltDependencies`** list form is no longer what pnpm writes.
2. The file **must be UTF-8 without a BOM**. A BOM makes pnpm fail hard with
   `a BOM must not appear inside a document`.

Write it BOM-free from PowerShell like this:

```powershell
$yaml = "allowBuilds:`n  prisma: true`n  '@prisma/engines': true`n  esbuild: true`n"
[System.IO.File]::WriteAllText("$pwd\pnpm-workspace.yaml", $yaml, (New-Object System.Text.UTF8Encoding($false)))
```

`pnpm approve-builds <pkg>` also works but is interactive — it prints `IO error: not a terminal`
when run from a non-interactive shell, so prefer the file above.

### 15.2 PostgreSQL 18 changed the volume mount path

The official PG 18+ images store data in a **major-version-specific subdirectory**, so mounting
`/var/lib/postgresql/data` makes the container refuse to start with:

```
Error: in 18+, these Docker images are configured to store database data in a
       format which is compatible with "pg_ctlcluster" ...
```

**Correct (PG 18+):**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg18
    volumes:
      - pgdata:/var/lib/postgresql        # ← parent dir, NOT /var/lib/postgresql/data
volumes:
  pgdata:
```

### 15.3 Nginx healthcheck fails while nginx is perfectly healthy

If you mount your config read-only, nginx's entrypoint cannot add its IPv6 listener:

```
10-listen-on-ipv6-by-default.sh: info: can not modify /etc/nginx/conf.d/default.conf
```

Alpine's busybox `wget` resolves `localhost` to **`::1` first**, so a healthcheck on
`http://localhost/...` gets `Connection refused` even though IPv4 works.

**Fix both ends:**

```yaml
healthcheck:
  test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/health"]
```

```nginx
server {
    listen 80;
    listen [::]:80;      # ← add this when config is mounted read-only
    ...
}
```

### 15.4 The system proxy at `127.0.0.1:17891` — and its two different meanings

A system proxy is enabled (process `0dcloudCore`). Its effect differs per context — this was
measured, not assumed:

| Context | Does `127.0.0.1:17891` work? | Evidence |
|---|---|---|
| Windows native tools (`Invoke-WebRequest`, `winget`, `curl.exe`, Docker daemon) | ✅ **Yes, and often required** | `docker pull` of all 4 images succeeded; `curl` hit the Playwright CDN at 50 MB/s |
| Node.js-based downloaders (`playwright install`, some CLI fetchers) | ⚠️ **Needs to be told explicitly** | `playwright install chromium` stalled at 9.68/148.9 MB until `HTTPS_PROXY` was set |
| **Inside WSL Ubuntu** | ❌ **Never** — `127.0.0.1` is the Linux VM itself | WSL2 in NAT mode cannot mirror a localhost proxy |

**Fix for Node downloaders:**

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:17891'
$env:HTTP_PROXY  = 'http://127.0.0.1:17891'
pnpm exec playwright install chromium
Remove-Item Env:HTTPS_PROXY, Env:HTTP_PROXY
```

**Fix for WSL** — a helper is already installed:

```bash
set-proxy              # current shell only; resolves the Windows host gateway
set-proxy 17891 persist  # also writes to /etc/environment
```

It derives the host IP dynamically (`ip route show default | awk '{print $3}'` → `172.20.112.1`)
because the address changes between WSL restarts. Note that WSL **does not need** the proxy for
npm/apt/GitHub — those were all verified working directly.

### 15.5 Python: a 0-byte Microsoft Store stub can shadow the real interpreter

`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` is a 0-byte App Execution Alias. If it comes
before the real interpreter in PATH, typing `python` silently opens the Microsoft Store and
`python --version` prints **nothing**.

Phase 0 fixed this by prepending the real directories to the persistent user PATH. If you ever
see the Store open instead of Python, check:

```powershell
Get-Command python -All | Select-Object Source
```

The first entry must be `...\Programs\Python\Python312\python.exe`.

### 15.6 `npm latest` is not always a stable release

On this machine `pnpm add -D prisma` resolved to **`8.0.0-rc.20`** (a release candidate) and
`pnpm add -D typescript` resolved to **`7.0.2`**. Always check before committing a lockfile:

```powershell
npm view <package> dist-tags
```

Phase 0 pinned the working stable versions: **Prisma 7.10.0** and **TypeScript 5.9.3**.

### 15.7 Prisma 7 project layout is different from Prisma 6

| Prisma 6 | Prisma 7 (this machine) |
|---|---|
| config inside `schema.prisma` | separate **`prisma7.config.ts`** |
| `.env` auto-loaded | needs **`import "dotenv/config"`** in the config, and `dotenv` must be installed |
| `generator client { provider = "prisma-client-js" }` | **`provider = "prisma-client"`**, emits **TypeScript source** |
| `import { PrismaClient } from '@prisma/client'` | `import { PrismaClient } from './generated/prisma/client.ts'` |
| client works standalone | **a driver adapter is required**: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` |
| `migrate dev --name x` | `--name` removed; use `migrate diff --from-empty --to-schema … --script --output …` then `migrate deploy` |
| `migrate diff --to-schema-datamodel` | renamed to **`--to-schema`** |

pgvector columns are declared as `Unsupported("vector(3)")` so Prisma manages the migration
while the app queries them with `$queryRaw`:

```prisma
embedding Unsupported("vector(3)")
```

```ts
const nearest = await prisma.$queryRawUnsafe(
  `SELECT title, embedding <-> '[1,2,3]'::vector AS distance
     FROM "Property" WHERE embedding IS NOT NULL
    ORDER BY embedding <-> '[1,2,3]'::vector LIMIT 3`,
);
```

### 15.8 `$pid` is a read-only PowerShell variable

Do not name a variable `$pid` — assigning to it throws
`Cannot overwrite variable PID because it is read-only or constant`. Use `$procId`.

---

*Companion document: [`ENVIRONMENT_SETUP_REPORT.md`](ENVIRONMENT_SETUP_REPORT.md) — what was installed and verified.*
