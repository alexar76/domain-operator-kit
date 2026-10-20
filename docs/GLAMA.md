# Glama build — admin form

Listing: [glama.ai/mcp/servers/alexar76/domain-operator-kit](https://glama.ai/mcp/servers/alexar76/domain-operator-kit)

Admin: […/admin/dockerfile](https://glama.ai/mcp/servers/alexar76/domain-operator-kit/admin/dockerfile)

Glama generates the image from this form. It clones the repo into `/app` and wraps the command with `mcp-proxy`. [`Dockerfile.glama`](../Dockerfile.glama) is the same runtime for a local `docker build`. The seller image stays [`Dockerfile`](../Dockerfile) (`node src/server.js`).

The form's base-image list is `debian:bookworm-slim` or `debian:trixie-slim`. This project runs on bookworm with Node 22 (`engines.node` is `>=22.13`; local verification used 22.22.1). Leave Python empty so the generated image does not install a second interpreter.

| Field | Value |
| --- | --- |
| Base image | `debian:bookworm-slim` |
| Node.js version | `22` |
| Python version | empty |
| Build steps | `["npm ci --omit=dev --ignore-scripts"]` |
| CMD arguments | `["node", "bin/domain-rails.mjs", "mcp"]` |
| Environment variables | `{"type":"object","properties":{},"required":[]}` |
| Pinned commit SHA | empty |

`initialize` and `tools/list` answer with no seller URL and no owner key. A purchase still needs the buyer files from [examples/mcp.json](../examples/mcp.json). Do not put those values in the form.
