# Deploy

The GitHub Actions workflow builds a Docker image and pushes it to **GHCR**
(`ghcr.io/<your-user>/ai-server`). On the target machine you just pull and run.

The LLM (LM Studio / Ollama / Gemini / any OpenAI-compatible server) and the
plant-tree MCP run **outside** the container. **First run is configured through a
web UI** at `/setup` — pick a provider, enter Base URL + API key, choose models,
and Connect. The choice is saved to `data/llm-config.json`; mount that path as a
volume so it survives container recreation and later runs auto-reconnect with no
UI. The env vars below only **prefill** the setup form — they never auto-connect.

---

## 1. One-time: push this repo to GitHub

The workflow only runs once the code is on GitHub.

```bash
git init
git add .
git commit -m "Add Docker image + GHCR publish workflow"
git branch -M main
git remote add origin https://github.com/<your-user>/ai-server.git
git push -u origin main
```

Every push to `main` (or a `v*` tag) then builds and publishes the image.
No secrets to configure — the workflow uses the built-in `GITHUB_TOKEN`.

## 2. One-time: make the image pullable on the target machine

Either make the GHCR package **public** (Package settings → Change visibility →
Public) so `docker pull` needs no login, **or** log in on the target machine:

```bash
# create a GitHub PAT with read:packages scope, then:
echo <YOUR_PAT> | docker login ghcr.io -u <your-user> --password-stdin
```

## 3. Pull and run on the target machine

The simplest path is `docker compose up -d` (the repo's `docker-compose.yml`
already sets the `./data` volume and env). With plain `docker run`:

```bash
docker pull ghcr.io/<your-user>/ai-server:latest
mkdir -p data   # holds the saved LLM config + embedding cache

docker run -d --name ai-server --restart unless-stopped \
  -p 8787:8787 \
  --add-host=host.docker.internal:host-gateway \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/<your-user>/ai-server:latest
```

Then **configure once**:

```bash
curl http://localhost:8787/health   # -> {"status":"ok","phase":"waiting_config"}
# open http://<host>:8787/setup in a browser → pick provider → Connect
```

In the setup UI, for an LLM running on the **host** machine use
`http://host.docker.internal:1234/v1` (LM Studio) or `:11434/v1` (Ollama) — NOT
`localhost`, which inside the container means the container itself. For an LLM on
**another** machine, use its IP (e.g. `http://192.168.1.50:1234/v1`). After a
successful Connect, `/health` reports `"phase":"ready"` and `/chat` works.

### Volume permissions (Linux hosts)

The container runs as uid **1000** (`node`). With a bind mount, the host `./data`
dir must be writable by that uid or saving the config fails:

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

Docker Desktop (macOS/Windows) handles this automatically — no chown needed.
Alternatively use a **named volume** (`-v ai-server-data:/app/data`), which
inherits the correct permissions from the image and needs no host chown.

### Other overridable settings

`LMSTUDIO_*` / `MODEL` / `EMBED_MODEL` / `LLM_PROVIDER` only **prefill** the
setup form; the live config comes from `/setup` → `data/llm-config.json`.

| Env var                  | Default                                | Note                          |
| ------------------------ | -------------------------------------- | ----------------------------- |
| `PORT`                   | `8787`                                 |                               |
| `LLM_PROVIDER`           | `lmstudio`                             | form: preselected provider    |
| `LMSTUDIO_BASE_URL`      | `http://host.docker.internal:1234/v1`  | form prefill only             |
| `LMSTUDIO_API_KEY`       | `lm-studio`                            | form prefill only             |
| `MODEL`                  | `qwen2.5-3b-instruct`                  | form prefill only             |
| `EMBED_MODEL`            | `text-embedding-bge-m3`                | form prefill only             |
| `LLM_CONFIG_PATH`        | `data/llm-config.json`                 | mount this as a volume        |
| `SETUP_PROBE_TIMEOUT_MS` | `10000`                                | raise for Ollama cold-load    |
| `SETUP_OPEN_BROWSER`     | `0` (in image)                         | never launch a browser        |
| `MCP_URL`                | `http://host.docker.internal:8000/mcp` |                               |
| `MAX_TOOL_STEPS`         | `3`                                    |                               |
| `RAG_TOP_K`              | `4`                                    |                               |
| `DEFAULT_PLANT`          | `strawberry`                           |                               |

## Updating

```bash
docker pull ghcr.io/<your-user>/ai-server:latest
docker rm -f ai-server
# re-run the docker run command above — the ./data volume keeps your saved
# config, so no need to reconfigure via /setup.
```

## Build / run locally (optional)

```bash
docker build -t ai-server:local .
docker run --rm -p 8787:8787 --add-host=host.docker.internal:host-gateway \
  -v "$(pwd)/data:/app/data" ai-server:local
```
