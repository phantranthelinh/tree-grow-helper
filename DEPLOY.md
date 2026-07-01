# Deploy

The GitHub Actions workflow builds a Docker image and pushes it to **GHCR**
(`ghcr.io/<your-user>/ai-server`). On the target machine you just pull and run.

LM Studio and the plant-tree MCP run **outside** the container. The image points
at them via `host.docker.internal` by default; override with real addresses if
they live on another machine.

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

```bash
docker pull ghcr.io/<your-user>/ai-server:latest

docker run -d --name ai-server --restart unless-stopped \
  -p 8787:8787 \
  --add-host=host.docker.internal:host-gateway \
  -e LMSTUDIO_BASE_URL=http://host.docker.internal:1234/v1 \
  -e MCP_URL=http://host.docker.internal:8000/mcp \
  ghcr.io/<your-user>/ai-server:latest
```

Verify:

```bash
curl http://localhost:8787/health   # -> {"status":"ok"}
```

### Pointing at services on a different machine

Replace `host.docker.internal` with the real host/IP (the `--add-host` flag is
only needed for reaching the *local* host):

```bash
docker run -d --name ai-server --restart unless-stopped \
  -p 8787:8787 \
  -e LMSTUDIO_BASE_URL=http://192.168.1.50:1234/v1 \
  -e MCP_URL=http://192.168.1.50:8000/mcp \
  ghcr.io/<your-user>/ai-server:latest
```

### Other overridable settings

| Env var             | Default                                   |
| ------------------- | ----------------------------------------- |
| `PORT`              | `8787`                                     |
| `LMSTUDIO_BASE_URL` | `http://host.docker.internal:1234/v1`      |
| `LMSTUDIO_API_KEY`  | `lm-studio`                                |
| `MODEL`             | `qwen2.5-3b-instruct`                      |
| `EMBED_MODEL`       | `text-embedding-bge-m3`                    |
| `MCP_URL`           | `http://host.docker.internal:8000/mcp`     |
| `MAX_TOOL_STEPS`    | `3`                                        |
| `RAG_TOP_K`         | `4`                                        |
| `DEFAULT_PLANT`     | `strawberry`                               |

## Updating

```bash
docker pull ghcr.io/<your-user>/ai-server:latest
docker rm -f ai-server
# re-run the docker run command above
```

## Build / run locally (optional)

```bash
docker build -t ai-server:local .
docker run --rm -p 8787:8787 --add-host=host.docker.internal:host-gateway ai-server:local
```
