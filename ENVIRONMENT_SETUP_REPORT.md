# ENVIRONMENT_SETUP_REPORT.md

**Phase 0 — Windows Development Environment Initialization**

| Field | Value |
|---|---|
| Machine | `DESKTOP-2BEKLIA` — THUNDEROBOT 911MT |
| OS | Microsoft Windows 11 企业版 (Enterprise) 25H2, Build 26200.9168 |
| User | `DESKTOP-2BEKLIA\11382` (Microsoft Account, member of Administrators) |
| Date | 2026-10-08 |
| Project home | `D:\Projects\EstatePilot-AI` |
| **Status** | **✅ ENVIRONMENT READY** |

> Every item in this report was executed and verified on this machine with real commands.
> Nothing is claimed as installed without a captured command output.

---

## 1. Executive Summary

| Category | Result |
|---|---|
| Components installed | 15 |
| Verification tests executed | 12 test suites |
| Tests passed | **12 / 12** |
| Failures | **0** |
| Manual user actions pending | 2 (Git identity, `gh auth login`) |
| Reboots required | **0** (the one required reboot was completed at 13:43) |

The machine can now develop, run, test, Dockerize and deploy the full target stack:
Next.js · React · TypeScript · Tailwind · shadcn/ui · NestJS · PostgreSQL · Prisma ·
pgvector · Redis · BullMQ · Vitest · Jest-compatible · Playwright · Docker · Compose · Nginx · pnpm

---

## 2. Operating System & Hardware

### 2.1 Windows

| Item | Value |
|---|---|
| Caption | Microsoft Windows 11 企业版 (Enterprise) |
| DisplayVersion | 25H2 |
| Version / Build | 10.0.26200.9168 |
| Architecture | 64-bit (x64) |
| Install date | 2026-04-09 |
| Last boot | 2026-10-08 13:43:49 (post-reboot, `CBS RebootPending = False`) |
| Locale / Time zone | zh-CN / China Standard Time |

### 2.2 CPU

| Item | Value |
|---|---|
| Model | 11th Gen Intel(R) Core(TM) i7-11800H @ 2.30GHz |
| Cores / Threads | 8 physical / 16 logical |
| Address width | 64-bit |
| VirtualizationFirmwareEnabled | True |
| HypervisorPresent (after WSL2 setup) | True |

### 2.3 Memory

| Item | Value |
|---|---|
| Total physical RAM | 15.78 GB |
| Docker engine allocation | **7.76 GB** (meets ≥4 GB requirement, within 6–8 GB recommendation) |
| WSL2 VM limit (`.wslconfig`) | 8 GB RAM / 8 processors / 4 GB swap |

### 2.4 Disk

| Drive | Total | Free (final) | Notes |
|---|---|---|---|
| `C:` | 99.1 GB | **42.9 GB** | Docker Desktop WSL data (3,065 MB) + Playwright browsers (705 MB) live here |
| `D:` | 375.7 GB | **317.7 GB** | Project home + WSL Ubuntu vhdx (2,526 MB) |

### 2.5 PowerShell

| Item | Value |
|---|---|
| Version | 5.1.26100.9168 (Desktop) |
| Executable | `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe` |
| ExecutionPolicy | `RemoteSigned` (CurrentUser **and** LocalMachine) |
| Group Policy override | none |

---

## 3. Installed Components — Verified Versions

All commands below were run in a **real fresh `powershell.exe` process**.

| # | Component | Version | Resolved path | Status |
|---|---|---|---|---|
| 1 | Git | `2.55.0.windows.1` | `C:\Program Files\Git\cmd\git.exe` | ✅ pre-existing, kept (already current) |
| 2 | Node.js | `v24.19.0` (LTS) | `C:\Program Files\nodejs\node.exe` | ✅ pre-existing, kept |
| 3 | npm | `11.17.0` | `C:\Program Files\nodejs\npm.ps1` | ✅ |
| 4 | Corepack | `0.35.0` | `C:\Program Files\nodejs\corepack.cmd` | ✅ enabled (was not activated) |
| 5 | **pnpm** | **`12.10.1`** (stable) | `C:\Program Files\nodejs\pnpm.ps1` | ✅ installed via Corepack |
| 6 | **Docker** | **`29.8.2`** | `C:\Program Files\Docker\Docker\resources\bin\docker.exe` | ✅ installed |
| 7 | **Docker Compose** | **`v5.5.1`** | same dir | ✅ |
| 8 | **Docker Desktop** | **`4.94.0`** (241994) | `C:\Program Files\Docker\Docker\Docker Desktop.exe` | ✅ WSL2 backend |
| 9 | **VS Code** | **`1.140.0`** (x64) | `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd` | ✅ installed || 10 | **GitHub CLI** | **`2.102.0`** (2026-09-30) | `C:\Program Files\GitHub CLI\gh.exe` | ✅ installed |
| 11 | **Python** | **`3.12.10`** | `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` | ✅ installed (per-user) |
| 12 | **pip** | **`25.0.1`** | `…\Python312\Scripts\pip.exe` | ✅ |
| 13 | `py` launcher | `3.12.10` | `%LOCALAPPDATA%\Programs\Python\Launcher\py.exe` | ✅ |
| 14 | **7-Zip** | **`26.04`** | `C:\Program Files\7-Zip\7z.exe` | ✅ installed |
| 15 | **Windows Terminal** | **`1.25.2733.0`** | MSIX | ✅ upgraded from 1.24 |
| 16 | **Google Chrome** | **`155.0.8059.40`** | `C:\Program Files\Google\Chrome\Application\chrome.exe` | ✅ installed |
| 17 | Microsoft Edge | present | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | ✅ kept (not removed) |
| 18 | **Playwright** | **`1.63.0`** + Chromium `153.0.8010.12` | project-local + `%LOCALAPPDATA%\ms-playwright` | ✅ |
| 19 | Git for Windows | — | — | ✅ |
| 20 | TypeScript | `5.9.3` (project-local) | — | ✅ verified compiles |

### 3.1 VS Code extensions (§12 requirement) — verified via `code --list-extensions`

| Extension | ID | Version | Required by §12 |
|---|---|---|---|
| ESLint | `dbaeumer.vscode-eslint` | 3.0.34 | ✅ yes |
| Prettier | `esbenp.prettier-vscode` | 12.4.0 | ✅ yes |
| Prisma | `prisma.prisma` | 31.12.10 | ✅ yes |
| Docker | `ms-azuretools.vscode-docker` | 2.0.0 | ✅ yes |
| GitLens | `eamodio.gitlens` | 19.3.0 | ✅ yes |
| Tailwind CSS IntelliSense | `bradlc.vscode-tailwindcss` | 0.16.0 | ✅ yes |
| EditorConfig | `editorconfig.editorconfig` | 0.18.2 | ✅ yes |
| Playwright Test for VSCode | `ms-playwright.playwright` | 1.1.19 | ✅ yes |
| NestJS snippets | `ashinzekene.nestjs` | 1.4.2 | ➕ extra (NestJS is a core stack item; **no official NestJS extension exists on the marketplace**) |
| Container Tools | `ms-azuretools.vscode-containers` | 2.5.2 | ➕ installed automatically as a dependency of the Docker extension |

**8 / 8 required extensions installed — total 10.**

Deliberately **not** installed (to avoid plugin bloat, per §12 "不要安装大量没有必要的插件"):
PostgreSQL client extensions (marked optional), Vim/IntelliJ keybinding emulations, themes, and
snippet packs beyond the one NestJS pack.

> Note: an incorrect extension ID (`k--kato.intellij-idea-keybindings`, an IntelliJ keybinding
> emulator) was briefly installed while probing for a NestJS extension, immediately detected and
> **uninstalled** — confirmed removed.

### 3.2 Correctly ABSENT (must stay absent per user requirements)

| Software | Confirmed absent | Note |
|---|---|---|
| Local PostgreSQL server | ✅ | Docker-only |
| Local Redis server | ✅ | Docker-only |
| `psql` / `redis-cli` on Windows | ✅ | provided by containers |
| Java | ✅ | not needed |
| Android Studio | ✅ | not needed |
| Visual Studio (full IDE) | ✅ | not needed |
| MongoDB / MySQL | ✅ | not needed |
| XAMPP / WAMP / phpMyAdmin | ✅ | not needed |
| Anaconda | ✅ | explicitly avoided |
| Kubernetes / Minikube | ✅ | not needed |
| Postman | ✅ | deliberately skipped (API testing is automated) |
| Notepad++ | ✅ | deliberately skipped (VS Code covers it) |

---

## 4. WSL2 + Ubuntu

| Item | Value | Status |
|---|---|---|
| WSL runtime | **3.0.1.0** | ✅ |
| WSL kernel | **6.18.40.1-microsoft-standard-WSL2** | ✅ |
| WSLg | **1.0.79** | ✅ |
| MSRDC | 1.2.7214 | ✅ |
| Direct3D | 1.611.1-81528511 | ✅ |
| Default WSL version | **2** | ✅ |
| Distribution | **Ubuntu 26.04.1 LTS** (`resolute`) | ✅ |
| `wsl --list --verbose` | `Ubuntu  Stopped  Version 2` | ✅ matches requirement |
| `docker-desktop` distro | present, Version 2 | ✅ |
| Default user | **`dev`** (uid 1000, member of `sudo`) | ✅ verified via `whoami` |
| Storage location | **`D:\WSL\Ubuntu\ext4.vhdx`** (2,526 MB) — moved off `C:` | ✅ |
| C: residue after move | none | ✅ |
| `/etc/wsl.conf` | `[user] default=dev`, `[boot] systemd=false`, `[interop] enabled=true` | ✅ |
| `~/.wslconfig` | `memory=8GB`, `processors=8`, `swap=4GB`, `localhostForwarding=true` | ✅ |
| Host gateway as seen from WSL | `172.20.112.1` | ✅ |

### 4.1 Ubuntu base packages — all verified present

`apt-get update` → `apt-get upgrade -y` executed successfully.

| Command | Path | Version |
|---|---|---|
| `gcc` | `/usr/bin/gcc` | 15.2.0-16ubuntu1 |
| `g++` | `/usr/bin/g++` | 15.2.0-16ubuntu1 |
| `make` | `/usr/bin/make` | GNU Make 4.4.1 |
| `curl` | `/usr/bin/curl` | 8.18.0 (OpenSSL 3.5.5) |
| `wget` | `/usr/bin/wget` | GNU Wget 1.25.0 |
| `unzip` | `/usr/bin/unzip` | UnZip 6.00 |
| `zip` | `/usr/bin/zip` | ✅ |
| `jq` | `/usr/bin/jq` | 1.8.1 |
| `openssl` | `/usr/bin/openssl` | OpenSSL 3.5.5 (27 Jan 2026) |
| `git` | `/usr/bin/git` | 2.53.0 |
| `python3` | `/usr/bin/python3` | 3.14.4 |
| `sudo` | `/usr/bin/sudo` | ✅ |
| `locale-gen` | `/usr/sbin/locale-gen` | `en_US.UTF-8` generated |

Also installed: `build-essential`, `ca-certificates`, `gnupg`, `software-properties-common`,
`less`, `nano`, `htop`, `net-tools`, `iputils-ping`, `dnsutils`, `procps`, `tzdata`.

### 4.2 WSL proxy helper

Installed at `/usr/local/bin/set-proxy` — points to the **Windows host gateway**, because
`127.0.0.1` inside WSL refers to the Linux VM itself, never the Windows host:

```bash
HOSTIP=$(ip route show default | awk '{print $3}')   # -> 172.20.112.1
```

Network reachability **from inside WSL** (direct, no proxy needed):

| Target | Result |
|---|---|
| `https://registry.npmjs.org` | HTTP 200 |
| `https://github.com` | HTTP 200 |
| `https://archive.ubuntu.com` | HTTP 200 |

---

## 5. Docker

| Item | Value |
|---|---|
| Docker Desktop | 4.94.0 (241994) |
| Client / Server | 29.8.2 / 29.8.2 |
| API version | 1.56 (min 1.40) |
| Compose | v5.5.1 |
| Backend | **WSL 2** (`docker-desktop` distro, Version 2) |
| OSType / Arch | linux / x86_64 |
| Storage driver | overlayfs |
| Cgroup | cgroupfs, version 2 |
| Kernel | 6.18.40.1-microsoft-standard-WSL2 |
| CPUs / Memory | **8 / 7.76 GB** |
| Docker root dir | `/var/lib/docker` |
| `docker-users` group | user `11382` is a member ✅ |
| Installer integrity | SHA256 `a9814e31049d66156477a86614e83365669677733014ec72f74229623ff3890a` — **matched the official winget manifest** |

### 5.1 Engine really works — not just "installed"

```
$ docker run --rm hello-world
Hello from Docker!
This message shows that your installation appears to be working correctly.
```
Executed twice (during setup and again after cleanup) — **both succeeded**.

### 5.2 Images available (official tags only — no third-party mirrors used)

| Image | Content size | Purpose |
|---|---|---|
| `postgres:18-alpine` | 121 MB | plain PostgreSQL |
| `pgvector/pgvector:pg18` | 162 MB | PostgreSQL 18.6 **+ pgvector 0.8.7** |
| `redis:8-alpine` | 39.6 MB | Redis 8.10.2 |
| `nginx:alpine` | 27.2 MB | Nginx 1.31.6 |
| `alpine:latest` | 3.94 MB | test utility |
| `hello-world:latest` | 9.49 kB | engine smoke test |

**No registry mirror was configured.** Only the official Docker Hub / official vendor images were used.

---

## 6. Verification Test Results — 12 / 12 PASSED

### TEST 1 — Node / npm / pnpm / registry / network ✅

`pnpm init` → `pnpm add is-odd@3.0.1` → run under ESM and CJS → `pnpm install` idempotent.

| Check | Result |
|---|---|
| `pnpm init` | ✅ wrote `package.json`, pinned `packageManager: pnpm@12.10.1` |
| `pnpm add` | ✅ `is-odd 3.0.1` from `registry.npmjs.org` |
| content-addressable store | `D:\.pnpm-store\v11` |
| ESM execution (`import`) | ✅ `is-odd(3) = true` |
| CJS execution (`.cjs` + `require`) | ✅ `CJS is-odd(5) = true` |
| dynamic `import()` | ✅ resolved |
| `pnpm install` re-run | ✅ `Already up to date` |

### TEST 2 — TypeScript / tsx ✅

| Check | Result |
|---|---|
| `typescript` | **5.9.3** (deliberately pinned from TS 7.0.2 — see FAIL-004) |
| `tsc --noEmit` | ✅ exit 0, no errors |
| `tsc` build | ✅ emitted `dist/hello.js` + `.d.ts` + `.js.map` |
| `node dist/hello.js` | ✅ correct output incl. Chinese characters |
| `tsx src/hello.ts` | ✅ direct TS execution |
| strict typing rejects bad code | ✅ `error TS2322: Type 'string' is not assignable to type 'number'` |
| native esbuild binary | ✅ `@esbuild/win32-x64` present, `tsx -e` works |

### TEST 3 — Next.js ✅

Official template: `next@16.4.0`, `react@19.3.0`, `tailwindcss@4.3.3`, TypeScript, ESLint, App Router, `src/` dir.

| Check | Result |
|---|---|
| `next dev` (Turbopack) | ✅ `Ready in 584ms` |
| `GET http://localhost:3000/` | ✅ **HTTP 200**, 16,620 bytes |
| HTML contains `<!DOCTYPE html>`, `__next`, `<title>` | ✅ |
| `GET /favicon.ico` | ✅ HTTP 200 |
| `tsc --noEmit` | ✅ exit 0 |
| `next build` | ✅ `Compiled successfully in 4.1s`, TypeScript finished in 2.4s |
| static pages generated | ✅ 4/4 — routes `○ /` and `○ /_not-found` |
| **Tailwind CSS compiled** | ✅ `.next/static/chunks/3hfzki5wsrkgp.css` = **14,580 bytes**, contains utility classes, `--tw-` vars, `--color-` theme vars |
| `next start` (production) | ✅ `Ready in 3.7s`, `GET /` → **HTTP 200**, 11,885 bytes |
| production CSS served | ✅ `GET /_next/static/chunks/3hfzki5wsrkgp.css` → 14,580 bytes |
| console / network errors | ✅ none |
| server shutdown + port release | ✅ port 3000 and 3100 released |

### TEST 4 — NestJS ✅

Official scaffold: `@nestjs/cli@12.0.8`, Vitest (not Jest) by default, `@nestjs/common`, `core`, `platform-express`.

| Check | Result |
|---|---|
| `pnpm start:dev` (watch) | ✅ `Found 0 errors. Watching for file changes.` |
| `GET http://localhost:3001/` | ✅ **HTTP 200**, body `Hello World!` |
| route mapping logged | ✅ `Mapped {/, GET} route` |
| Nest application started | ✅ `successfully started +3ms` |
| **Hot reload** | ✅ edited `app.service.ts` → `File change detected` → new body `HotReload-OK-3001` served **within 3 seconds** |
| hot reload (revert) | ✅ restored `Hello World!` |
| `pnpm test` (Vitest unit) | ✅ `1 test passed` (v4.1.11), Duration 1.51s |
| `pnpm test:e2e` (supertest) | ✅ `1 test passed`, Duration 1.89s |
| `pnpm build` | ✅ exit 0, `dist/` emitted |
| shutdown + port release | ✅ port 3001 released |

### TEST 5 — PostgreSQL (Docker) ✅

| Check | Result |
|---|---|
| `SELECT version()` | ✅ `PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2) on x86_64-pc-linux-gnu, compiled by gcc 12.2.0, 64-bit` |
| database / user | `phase0db` / `phase0user` — connected and queried |
| port mapping | `0.0.0.0:5432->5432/tcp` |
| healthcheck | `pg_isready` → **healthy** |
| container cleanup | ✅ container + volume removed, port released |

### TEST 6 — Redis (Docker) ✅

| Check | Result |
|---|---|
| `redis-cli ping` | ✅ **`PONG`** |
| server version | ✅ `8.10.2` |
| `SET` / `GET` | ✅ `OK` / `hello-bullmq` |
| **BullMQ prerequisite — Lua `EVAL`** | ✅ `redis.call('set', ...)` returned `OK`, value readable |
| **BullMQ prerequisite — Streams `XADD`** | ✅ returned id `1791439632904-0` |
| healthcheck | `redis-cli ping` → **healthy** |
| container cleanup | ✅ container + volume removed, port released |

### TEST 7 — pgvector ✅

| Check | Result |
|---|---|
| `CREATE EXTENSION vector;` | ✅ `CREATE EXTENSION` |
| extension version | ✅ **0.8.7** |
| column type | ✅ `embedding | vector(3)` |
| L2 distance operator `<->` | ✅ `[1,2,3]`→`0`, `[4,5,6]`→`5.196152422706632` |
| verified in **two independent** containers | ✅ compose stack + Prisma container |
| via Prisma raw SQL | ✅ see TEST 8 |

### TEST 8 — Prisma ✅

Pinned to the **stable** line: `prisma@7.10.0` + `@prisma/client@7.10.0` + `@prisma/adapter-pg@7.10.0`.

| Check | Result |
|---|---|
| `prisma init` | ✅ generated `prisma/schema.prisma`, `prisma7.config.ts`, `.env` |
| `prisma validate` | ✅ `The schema at prisma\schema.prisma is valid 🚀` |
| `prisma migrate diff` | ✅ generated migration SQL containing enum, tables, indexes, FK, and `"embedding" vector(3)` |
| `prisma migrate deploy` | ✅ `All migrations have been successfully applied` |
| `_prisma_migrations` | ✅ row `20261008000000_init` with `finished_at` timestamp |
| tables in DB | ✅ `Agency`, `Property`, `_prisma_migrations` |
| `prisma generate` | ✅ `Generated Prisma Client (7.10.0)` in 38 ms |
| end-to-end script | ✅ **`PRISMA_E2E_OK`** |

End-to-end script detail (all real database round-trips):

```
connected to: PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2)
CREATE agency      : EstatePilot 测试中介
CREATE properties  : 3 (APARTMENT / HOUSE / COMMERCIAL, BigInt prices, Chinese titles)
READ + relation    : 滨江公寓 3 室 | EstatePilot 测试中介 | APARTMENT
FILTER by enum     : APARTMENT count: 1
AGGREGATE          : count = 3 | avg = 1850000000 | max = 3200000000
UPDATE             : new price = 910000000
TRANSACTION        : committed
pgvector search    : 滨江公寓 3 室 distance=0.0000
                     独栋别墅        distance=5.1962
                     临街商铺        distance=10.3923
pgvector version   : 0.8.7
FINAL COUNTS       : agencies = 2, properties = 4
```

### TEST 9 — Playwright ✅

Project-local install (never global): `@playwright/test@1.63.0`, Chromium **153.0.8010.12**.

```
Running 6 tests using 2 workers
ok 1  chromium version and browser capabilities
ok 2  opens the real example.com and validates live content  (HTTP 200, 1989 bytes, title "Example Domain")
ok 3  renders a data URL and runs JavaScript in the page     (JS-RAN-5, page.evaluate = 10)
ok 4  screenshots, viewport and console listeners work        (screenshot 7485 bytes, viewport 1280x720)
ok 5  request interception works against a real origin        (mocked 201, real server hits 1, intercepted 1)
ok 6  launches a real visible Chromium window                 ← HEADED MODE
6 passed (2.3s)
```

| Check | Result |
|---|---|
| headless mode | ✅ 5 tests passed |
| **headed mode (visible window)** | ✅ 1 test passed — real Chromium window opened on screen |
| HTML report generated | ✅ `playwright-report/index.html` |
| failure artifacts | ✅ traces + screenshots captured on the earlier (test-side) failures |
| browsers installed to | `%LOCALAPPDATA%\ms-playwright` (705.6 MB total) |

### TEST 10 — Docker Compose 3-container integration ✅

`docker-compose.yml` with PostgreSQL + Redis + Nginx, healthchecks and `depends_on: service_healthy`.

| Container | Image | Final state |
|---|---|---|
| `phase0-postgres` | `pgvector/pgvector:pg18` | **running (healthy)** |
| `phase0-redis` | `redis:8-alpine` | **running (healthy)** |
| `phase0-nginx` | `nginx:alpine` | **running (healthy)** |

```
>>> 三容器全部 healthy: True
```

Additional evidence while the stack was up:

| Check | Result |
|---|---|
| `docker compose config --quiet` | ✅ exit 0 |
| init SQL ran from `docker-entrypoint-initdb.d` | ✅ created extension + table + rows |
| `GET http://localhost:8080/` | ✅ HTTP 200 `nginx-phase0-ok` |
| `GET http://localhost:8080/health` | ✅ HTTP 200 `nginx-healthy` |
| resource usage | postgres 43.8 MB + redis 6.4 MB + nginx 8.4 MB ≈ **58 MB** total |

**Cleanup per §36:** `docker compose down -v` executed → all containers, both volumes and
the network removed; ports 5432/6379/8080 released. Verified: `docker ps -a` empty,
`docker volume ls` empty. The Docker Desktop sample `welcome-to-docker` container/image was
also removed to keep the environment clean.

### TEST 11 — Fresh-shell PATH verification ✅

Run in a **genuine new `powershell.exe` process**, and re-run against the registry-persisted
PATH that Windows will broadcast after the next sign-in:

| Command | Resolved to | Status |
|---|---|---|
| `git` | `C:\Program Files\Git\cmd\git.exe` | ✅ |
| `node` | `C:\Program Files\nodejs\node.exe` | ✅ |
| `npm` | `C:\Program Files\nodejs\npm.ps1` | ✅ |
| `pnpm` | `C:\Program Files\nodejs\pnpm.ps1` | ✅ |
| `docker` | `C:\Program Files\Docker\Docker\resources\bin\docker.exe` | ✅ |
| `gh` | `C:\Program Files\GitHub CLI\gh.exe` | ✅ |
| `python` | `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` | ✅ |
| `py` | `%LOCALAPPDATA%\Programs\Python\Launcher\py.exe` | ✅ |
| `pip` | `…\Python312\Scripts\pip.exe` | ✅ |
| `code` | `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd` | ✅ |
| `7z` | `C:\Program Files\7-Zip\7z.exe` | ✅ (added during Phase 0 — see FIX-006) |
| `wsl` | `C:\WINDOWS\system32\wsl.exe` | ✅ |
| `npx` | `C:\Program Files\nodejs\npx.ps1` | ✅ |
| `corepack` | `C:\Program Files\nodejs\corepack.cmd` | ✅ |

**Missing: none — 14 / 14 commands resolve.** No temporary shell path hacks were used;
all PATH entries are persisted in `HKLM` / `HKCU` environment.

### TEST 12 — VS Code extensions ✅

Verified with `code --list-extensions` (not by assuming the install commands worked).
See §3.1 for the full table.

| Check | Result |
|---|---|
| Required extensions from §12 | ✅ **8 / 8 installed** |
| Total extensions present | 10 (2 extras: NestJS snippets; Docker's container-tools dependency) |
| Incorrectly-installed extension detected & removed | ✅ `k--kato.intellij-idea-keybindings` uninstalled |
| Plugin bloat avoided | ✅ no themes, no PostgreSQL-client extensions, no keybinding emulators |

---

## 7. Port Reservation Check (§34)

All six target ports are **FREE** — no long-lived conflicts.

| Port | Service | Status |
|---|---|---|
| 3000 | Next.js Frontend | ✅ FREE |
| 3001 | NestJS Backend | ✅ FREE |
| 5432 | PostgreSQL | ✅ FREE |
| 6379 | Redis | ✅ FREE |
| 80 | Nginx HTTP | ✅ FREE |
| 443 | Nginx HTTPS | ✅ FREE |

Windows TCP excluded port ranges (reserved by Hyper-V/WSL — these can block binds even when
a port looks free). **None of them overlaps any development port:**

```
Start Port    End Port
     50000       50059   *
     55631       55730
     55731       55830
     55906       56005
     56006       56105
     56106       56205
     56206       56305
```

---

## 8. Issues Found and Resolved

| ID | Issue | Root cause | Resolution | State |
|---|---|---|---|---|
| FIX-001 | `npm` / `npx` / `pnpm` refused to run: *"running scripts is disabled on this system"* | All execution-policy scopes were `Undefined` → effective policy `Restricted` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (machine scope also applied) | ✅ RESOLVED |
| FIX-002 | `corepack enable` failed: `EPERM ... C:\Program Files\nodejs\yarnpkg.CMD` | Corepack writes shims into the Node.js install dir, which needs Administrator | Re-ran inside a single elevated (UAC) batch | ✅ RESOLVED |
| FIX-003 | `winget install Python.Python.3.12` appeared hung at 23 MB / 25.7 MB with 0 % CPU | winget's download wrapper deadlocked — **the file had actually finished downloading** | Identified the completed 26,964,224-byte payload, killed only the stuck `winget.exe` (elevated `Stop-Process`), retried; winget then reported exit 1601 and the **per-user** Python install had in fact succeeded | ✅ RESOLVED |
| FIX-004 | `tsc --noEmit` failed with `TS2591: Cannot find name 'process'` | `@types/node` was installed but the tsconfig relied on implicit type inclusion | Added `"types": ["node"]` and `"lib": ["ES2022"]`; also **pinned TypeScript to 5.9.3** because npm `latest` resolved to the brand-new TS 7.0.2 which the surrounding ecosystem does not yet fully support | ✅ RESOLVED |
| FIX-005 | `ERR_PNPM_IGNORED_BUILDS` — pnpm 12 blocked every dependency build script | pnpm 12 defaults to **denying** lifecycle scripts (supply-chain hardening); the setting was also renamed | Learned the setting is now **`allowBuilds`** (a YAML **map**, not `onlyBuiltDependencies`), and that **the file must not contain a BOM** or pnpm aborts with `a BOM must not appear inside a document` | ✅ RESOLVED |
| FIX-006 | `7z` and `docker` were NOT FOUND in a fresh PowerShell | 7-Zip never adds itself to PATH; Docker's installer had added itself to `HKLM` but Explorer had not yet broadcast the change | Added `C:\Program Files\7-Zip` to the persistent user PATH; confirmed Docker's entry is correct in `HKLM` and will appear after the next sign-in | ✅ RESOLVED |
| FIX-007 | `python` resolved to a **0-byte Microsoft Store alias stub** | `%LOCALAPPDATA%\Microsoft\WindowsApps` was earlier in PATH than the real interpreter | Prepended the real Python dirs to the user PATH (and de-duplicated the trailing-slash duplicates the installer left) | ✅ RESOLVED |
| FIX-008 | `wsl --install -d Ubuntu` appeared hung for ~5 minutes | It was **actually downloading** (~1 MB/s); the Store-protocol download also emitted a benign *"localhost proxy is not supported … NAT mode"* warning because a system proxy is enabled | Waited it out; the warning was proven harmless (`exit=0`, distro registered). `--no-launch` was used to avoid the interactive first-run wizard | ✅ RESOLVED |
| FIX-009 | Playwright browser download stalled at 9.68 MB / 148.9 MB and never moved | Playwright's internal Node fetch does not use the Windows system proxy, and its direct connection stalled (CDN itself measured 50 MB/s via `curl`) | Set `HTTPS_PROXY`/`HTTP_PROXY=http://127.0.0.1:17891` for the Playwright process — download then completed immediately | ✅ RESOLVED |
| FIX-010 | Docker Compose PostgreSQL container exited with code 1 | **PostgreSQL 18 official images changed the volume contract**: data now lives in a major-version-specific subdirectory, so the mount point must be `/var/lib/postgresql`, **not** `/var/lib/postgresql/data` | Changed the mount point; container then reported **healthy** | ✅ RESOLVED |
| FIX-011 | Nginx container reported **unhealthy** although it served HTTP 200 | Config was mounted read-only, so nginx's entrypoint could not add the IPv6 listener; Alpine's busybox `wget` resolves `localhost` to `::1` first → `Connection refused` | Healthcheck switched to `http://127.0.0.1/health` and the config now explicitly listens on `[::]:80` | ✅ RESOLVED |
| FIX-012 | Playwright test asserted `<h1>` on example.com and failed | **example.com changed its markup** (dropped `<h1>`, replaced text with a multilingual disclaimer) — a test-side assumption, not an environment fault | Rewrote assertions against stable facts (HTTP 200, exact `<title>`, rendered text present) | ✅ RESOLVED |

### 8.1 Notes on deliberate decisions

- **npm `latest` is not always stable.** `prisma` resolved to `8.0.0-rc.20` and `typescript` to
  `7.0.2`. Both were **pinned to the stable line** (`7.10.0`, `5.9.3`) per the user's
  "no RC / no beta" requirement.
- **No public Docker registry mirror was configured**, per the user's rule against
  untrusted image sources. Only official images and the official proxy path were used.
- **No security feature was disabled.** Windows Defender, Firewall and UAC are untouched.
  `RemoteSigned` is the Microsoft-recommended development setting, not a security bypass.

---

## 9. Failure Log

**Zero unresolved failures.** All 12 issues in §8 were root-caused and fixed, and the
corresponding verification test was re-run and passed.

| Item | State |
|---|---|
| Test suites executed | 12 |
| Test suites passed | **12** |
| Test suites failed | **0** |
| Unresolved errors | **0** |
| Leftover test containers / volumes | **0** |
| Leftover test networks | **0** |

---

## 10. Pending User Actions

These were deliberately **not** done on the user's behalf:

| # | Action | Command | Why it is not automated |
|---|---|---|---|
| 1 | **Set Git identity** | `git config --global user.name "Your Name"`<br>`git config --global user.email "you@example.com"` | Per §4, the agent must not invent a name or e-mail. `user.name` and `user.email` are currently **unset**, and no commit can be authored until they are set. |
| 2 | **Log in to GitHub CLI** | `gh auth login` | Per §13, the agent must not log into the user's GitHub account. `gh` is installed (2.102.0) and **not logged in**. |
| 3 | *(Optional)* Sign out / restart Explorer so new terminals inherit Docker's PATH immediately | sign out and back in | Docker's PATH entry is already correct in `HKLM`; it simply has not been broadcast to already-running processes. A new terminal after the next sign-in will have it. |
| 4 | *(Optional)* Install the 2 pending Windows security updates | Windows Update | Checked in §5 of the setup: KB5126052 and KB5129195 are ordinary security updates, **not** Preview builds. Neither blocks development; left for the user's normal update cycle. |

### 10.1 Recommended (not required) Git defaults

```powershell
git config --global init.defaultBranch main
git config --global core.autocrlf input     # recommended when sharing with WSL/Linux CI
git config --global pull.rebase true
```

---

## 11. Reboot Status

| Item | Value |
|---|---|
| Reboot required by Phase 0 | **No** |
| Reboot already performed | ✅ Yes — 2026-10-08 13:43:49, to activate WSL2 / VirtualMachinePlatform |
| `CBS RebootPending` | `False` |
| `PendingFileRenameOperations` | `False` |
| Windows Update reboot required | No |

**No further reboots are needed.** `WSL2`, Docker Desktop and Ubuntu are all fully active.

---

## 12. Disk Footprint of New Components

| Component | Size | Location |
|---|---|---|
| WSL Ubuntu `ext4.vhdx` | 2,526 MB | `D:\WSL\Ubuntu` |
| Docker Desktop WSL data | 3,065 MB | `%LOCALAPPDATA%\Docker\wsl` |
| Docker images (6) | ~1,320 MB | Docker engine |
| Playwright browsers | 705.6 MB | `%LOCALAPPDATA%\ms-playwright` |
| VS Code | ~400 MB | `%LOCALAPPDATA%\Programs\Microsoft VS Code` |
| Python 3.12.10 | ~120 MB | `%LOCALAPPDATA%\Programs\Python` |
| Chrome | ~450 MB | `C:\Program Files\Google\Chrome` |
| pnpm content-addressable store | grows with use | `D:\.pnpm-store\v11` |

Final free space: **C: 42.9 GB**, **D: 317.7 GB**.

All temporary test projects, the 606 MB Docker installer, the 149 MB Chromium zip and a
1.2 GB WSL export backup were **deleted** after verification.

---

## 13. Project Home

| Path | State |
|---|---|
| `D:\Projects` | ✅ created |
| `D:\Projects\EstatePilot-AI` | ✅ created — **deliberately EMPTY** |

Per §31 and §39, **no business code was initialized**.
`D:\Projects\EstatePilot-AI` contains no files.

A reusable reference directory `D:\Projects\_phase0-temp` retains:
`setup-ubuntu.sh` (the Ubuntu provisioning script), `fresh-shell-test.ps1`,
and the raw log files — 64.6 KB total. Safe to delete at any time.

---

## 14. Conclusion

```
Environment Ready
```

| | |
|---|---|
| Passed items | **12 / 12 verification suites — 14/14 CLI commands resolve — 8/8 required VS Code extensions** |
| Failed items | **0** |
| Manual actions required | 2 (Git identity, `gh auth login`) + 2 optional |
| Reboots required | **0** |

**Next phase: `Phase 1 — EstatePilot AI Project Initialization`** — awaiting the user's explicit go-ahead.
No real-estate SaaS code has been written.

---

*Companion document: [`DEVELOPMENT_ENVIRONMENT.md`](DEVELOPMENT_ENVIRONMENT.md) — daily usage guide.*
