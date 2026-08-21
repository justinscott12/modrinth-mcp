# modrinth-mcp

An [MCP](https://modelcontextprotocol.io) server that wraps the [Modrinth](https://modrinth.com) API so an AI agent (Claude Code, Claude Desktop, Cursor, …) can search projects, read project/version metadata, and **publish Minecraft mods** — create projects and upload built jars as new versions.

## Tools

| Tool | Auth | What it does |
| --- | --- | --- |
| `modrinth_whoami` | ✅ | Verify your token; return the authenticated user. |
| `modrinth_search_projects` | – | Search public Modrinth projects. |
| `modrinth_get_project` | – | Get a project's metadata by slug or id. |
| `modrinth_list_project_versions` | – | List a project's published versions. |
| `modrinth_create_version` | ✅ | Publish a **new version** by uploading one or more jars. |
| `modrinth_create_project` | ✅ | Create a **new project** (as a draft). |
| `modrinth_modify_version` | ✅ | Edit metadata of an existing version. |

Read-only tools work without a token. Anything that writes needs a Modrinth **Personal Access Token**.

## Getting a token

Create a PAT at <https://modrinth.com/settings/pats> with these scopes:

- Read projects
- Read versions
- Create versions
- Write versions

Set it as the `MODRINTH_TOKEN` environment variable.

## Install

### As a Claude Code plugin

```bash
/plugin marketplace add justinscott12/modrinth-mcp
/plugin install modrinth-mcp@justinscott12
```

You'll be prompted for your Modrinth token when enabling the plugin. It runs the published npm package under the hood via `npx`.

### As an MCP server (any client)

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "modrinth": {
      "command": "npx",
      "args": ["-y", "@justinscott12/modrinth-mcp"],
      "env": {
        "MODRINTH_TOKEN": "your-modrinth-pat"
      }
    }
  }
}
```

Or in Claude Code directly:

```bash
claude mcp add modrinth --env MODRINTH_TOKEN=your-modrinth-pat -- npx -y @justinscott12/modrinth-mcp
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODRINTH_TOKEN` | – | Modrinth Personal Access Token. Required for write actions. |
| `MODRINTH_STAGING` | unset | Set to `1` to hit `https://staging-api.modrinth.com` for safe testing. |
| `MODRINTH_USER_AGENT` | `modrinth-mcp/<version> …` | Override the User-Agent sent to Modrinth. |

## Example flow

1. `modrinth_whoami` — confirm auth works.
2. `modrinth_create_project` — create the project page (created as a draft).
3. `modrinth_create_version` — upload your built jar(s) with the target `game_versions` and `loaders`.
4. Submit the project for review on the Modrinth site when ready.

> **Note:** `create_version` and `create_project` publish public content. Only call them when you actually intend to publish.

## Development

```bash
npm install
MODRINTH_STAGING=1 MODRINTH_TOKEN=your-staging-pat npm start
```

The server speaks MCP over stdio. `stdout` is reserved for the protocol; logs go to `stderr`.

## License

[MIT](./LICENSE)
