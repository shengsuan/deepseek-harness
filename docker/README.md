# Docker deployment

Containerizes `dsh` built from this repository's source (not the published
`@deepseek-ai/dsh` npm package), so the image always reflects local,
possibly unreleased, changes.

## Build

From the repository root:

```sh
docker build \
  --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  -f docker/Dockerfile \
  -t dsh:local .
```

`DSH_CLIENT_COMMIT_HASH` stands in for the Git commit hash that
`scripts/client-build-environment.ts` normally reads via `git rev-parse
HEAD`; the build context has no `.git` directory (see `.dockerignore`), so
it must be supplied explicitly. Omitting it falls back to a placeholder
hash, which is fine for local testing but should not be used for an image
you intend to attribute to a real commit.

The image is a two-stage build: `deps`/`build` run a full `pnpm install
--frozen-lockfile` and `pnpm run build` over the complete monorepo; `runtime`
copies that entire built workspace tree (`packages/`, `vendor/`, `native/`,
`apps/`) and its `node_modules` virtual store into the final layer.
`pnpm deploy` was evaluated and rejected here: its output does not preserve
the `pnpm-workspace.yaml` `overrides` that redirect the vendored
`@deepseek-ai/cosmokit` and `@deepseek-ai/schemastery` to `vendor/`, and a
deployed tree fails at startup with `ERR_MODULE_NOT_FOUND`.

## Run

The default command is `dsh web --no-open`, serving the browser UI on
`127.0.0.1:3080` **inside** the container.

**The CLI intentionally refuses `--host 0.0.0.0`** for safety
(`packages/bundle/web-app/src/startup.ts`: binding all interfaces would
expose remote code execution to the network). This means a normal
`-p 3080:3080` port mapping cannot reach the service, because Docker's
default bridge networking publishes ports for the container's external
interface, not `127.0.0.1` inside it. Reach the UI one of two ways:

- **Host networking** (simplest, single-host use):

  ```sh
  docker run --rm -it \
    --network=host \
    -e SHENGSUANYUN_API_KEY=sk-... \
    -v dsh-home:/home/node/.dsh \
    dsh:local
  ```

  Then browse `http://127.0.0.1:3080` on the host.

- **Reverse proxy**: run a proxy container that shares this container's
  network namespace (`--network=container:<name>` or a compose service on
  the same `network_mode`) and forwards to `127.0.0.1:3080` from inside that
  namespace, terminating externally on whatever host/port you choose.

`docker-compose.yml` in this directory wires up the host-networking path,
including a named volume for `$DSH_HOME` (default `/home/node/.dsh` in-image)
so profiles, credentials, and session data survive container recreation:

```sh
SHENGSUANYUN_API_KEY=sk-... docker compose -f docker/docker-compose.yml up --build
```

## Overriding the container command

The `CMD` is only a default; anything after the image name replaces it, and
still runs `dsh`'s other invocation modes:

```sh
docker run --rm -it -e SHENGSUANYUN_API_KEY=sk-... dsh:local \
  dsh --profile headless "task"
```

## Environment

- `SHENGSUANYUN_API_KEY` (required for any real LLM call) and optional
  `SHENGSUANYUN_BASE_URL` — read the same way as outside a container (see root
  `.env` / credentials docs); pass them with `-e` or a compose `.env` file,
  never bake them into the image.
- `DSH_HOME` (default `/home/node/.dsh` in-image) — mount a volume here to
  persist profiles and session data across container recreation.
