#!/usr/bin/env node
/**
 * Modrinth MCP server
 *
 * A local (stdio) MCP server that wraps the Modrinth REST API so an MCP client
 * (Claude Code, Claude Desktop, Cursor, ...) can search projects, read project
 * and version metadata, and — the main point — publish new versions by
 * uploading built mod jars.
 *
 * Auth: set MODRINTH_TOKEN to a Modrinth Personal Access Token (PAT).
 *   Create one at https://modrinth.com/settings/pats with at least the
 *   scopes: Read projects, Read versions, Create versions, Write versions.
 *
 * Optional env:
 *   MODRINTH_STAGING=1   -> use https://staging-api.modrinth.com (safe testing)
 *   MODRINTH_USER_AGENT  -> override the User-Agent Modrinth asks clients to send
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const VERSION = "0.1.1";
const BASE_URL = process.env.MODRINTH_STAGING
  ? "https://staging-api.modrinth.com"
  : "https://api.modrinth.com";
const USER_AGENT =
  process.env.MODRINTH_USER_AGENT ||
  `modrinth-mcp/${VERSION} (+https://github.com/justinscott12/modrinth-mcp)`;

const TOKEN = process.env.MODRINTH_TOKEN || "";

/** Throw a clean, agent-actionable error if the token is missing. */
function requireToken() {
  if (!TOKEN) {
    throw new Error(
      "MODRINTH_TOKEN is not set. Create a Personal Access Token at " +
        "https://modrinth.com/settings/pats (scopes: read + create + write " +
        "versions) and set it in the MCP server env as MODRINTH_TOKEN.",
    );
  }
}

/**
 * Perform a Modrinth API request. Returns parsed JSON (or null for 204).
 * On non-2xx, throws an Error carrying Modrinth's own error description.
 */
async function api(path, { method = "GET", body, auth = false, headers = {} } = {}) {
  const h = { "User-Agent": USER_AGENT, ...headers };
  if (auth) {
    requireToken();
    h["Authorization"] = TOKEN; // Modrinth uses the raw PAT, no "Bearer" prefix
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers: h, body });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail =
      data && typeof data === "object"
        ? data.description || data.error || JSON.stringify(data)
        : data || res.statusText;
    throw new Error(`Modrinth API ${res.status} on ${method} ${path}: ${detail}`);
  }
  return data;
}

/** Wrap a result object as an MCP text tool response. */
function ok(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: "modrinth_whoami",
    description:
      "Verify the configured Modrinth token and return the authenticated " +
      "user (username, id, email, role). Use this first to confirm auth works.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({}),
    handler: async () => {
      const user = await api("/v2/user", { auth: true });
      return ok({
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        email: user.email,
      });
    },
  },

  {
    name: "modrinth_search_projects",
    description:
      "Search public Modrinth projects. Returns a compact list of hits " +
      "(slug, title, project_type, downloads, description).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({
      query: z.string().describe("Search text, e.g. 'sodium' or 'anvil'."),
      limit: z.number().int().min(1).max(50).default(10).describe("Max hits."),
      facets: z
        .string()
        .optional()
        .describe(
          'Optional raw Modrinth facets JSON, e.g. \'[["project_type:mod"],["categories:fabric"]]\'.',
        ),
    }),
    handler: async ({ query, limit, facets }) => {
      const params = new URLSearchParams({ query, limit: String(limit) });
      if (facets) params.set("facets", facets);
      const data = await api(`/v2/search?${params.toString()}`);
      const hits = (data.hits || []).map((h) => ({
        slug: h.slug,
        title: h.title,
        project_type: h.project_type,
        downloads: h.downloads,
        latest_version: h.latest_version,
        description: h.description,
      }));
      return ok({ total_hits: data.total_hits, hits });
    },
  },

  {
    name: "modrinth_get_project",
    description:
      "Get a Modrinth project's metadata by slug or id (title, type, " +
      "loaders, game_versions, published version ids, status).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({
      id_or_slug: z.string().describe("Project slug (e.g. 'no-anvil-limit') or id."),
    }),
    handler: async ({ id_or_slug }) => {
      const p = await api(`/v2/project/${encodeURIComponent(id_or_slug)}`);
      return ok({
        id: p.id,
        slug: p.slug,
        title: p.title,
        project_type: p.project_type,
        status: p.status,
        loaders: p.loaders,
        game_versions: p.game_versions,
        client_side: p.client_side,
        server_side: p.server_side,
        downloads: p.downloads,
        versions: p.versions,
      });
    },
  },

  {
    name: "modrinth_list_project_versions",
    description:
      "List a project's published versions (version_number, id, type, " +
      "loaders, game_versions, download url of primary file).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({
      id_or_slug: z.string().describe("Project slug or id."),
    }),
    handler: async ({ id_or_slug }) => {
      const versions = await api(
        `/v2/project/${encodeURIComponent(id_or_slug)}/version`,
      );
      const out = (versions || []).map((v) => ({
        id: v.id,
        version_number: v.version_number,
        name: v.name,
        version_type: v.version_type,
        loaders: v.loaders,
        game_versions: v.game_versions,
        featured: v.featured,
        date_published: v.date_published,
        downloads: v.downloads,
        primary_file: (v.files || []).find((f) => f.primary)?.url,
      }));
      return ok(out);
    },
  },

  {
    name: "modrinth_create_version",
    description:
      "Publish a NEW version to an existing Modrinth project by uploading one " +
      "or more built jar files. This is a write action that publishes public " +
      "content — only call it when the user has explicitly asked to publish. " +
      "The project must already exist on Modrinth.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      project_id: z
        .string()
        .describe("Target project slug or id (must already exist)."),
      version_number: z
        .string()
        .describe("Version string, e.g. '1.21.8' or '2.0.0+1.21.8'."),
      file_paths: z
        .array(z.string())
        .min(1)
        .describe(
          "Absolute path(s) to the jar file(s) to upload. First is treated as the primary file.",
        ),
      game_versions: z
        .array(z.string())
        .min(1)
        .describe("Supported Minecraft versions, e.g. ['1.21.8']."),
      loaders: z
        .array(z.string())
        .default(["fabric"])
        .describe("Mod loaders, e.g. ['fabric']. Defaults to fabric."),
      version_type: z
        .enum(["release", "beta", "alpha"])
        .default("release")
        .describe("Release channel."),
      name: z.string().optional().describe("Display name for the version."),
      changelog: z.string().optional().describe("Markdown changelog."),
      featured: z.boolean().default(false).describe("Feature this version."),
      dependencies: z
        .array(
          z.object({
            project_id: z.string().optional(),
            version_id: z.string().optional(),
            file_name: z.string().optional(),
            dependency_type: z.enum([
              "required",
              "optional",
              "incompatible",
              "embedded",
            ]),
          }),
        )
        .optional()
        .describe(
          "Dependencies. e.g. Fabric API as required: [{project_id:'P7dR8mSH', dependency_type:'required'}].",
        ),
    }),
    handler: async (input) => {
      requireToken();
      const {
        project_id,
        version_number,
        file_paths,
        game_versions,
        loaders,
        version_type,
        name,
        changelog,
        featured,
        dependencies,
      } = input;

      // The version endpoint requires the project's base62 id, not the slug —
      // resolve it so callers can pass either.
      const proj = await api(`/v2/project/${encodeURIComponent(project_id)}`);
      const realProjectId = proj.id;

      // Read all files first so we can append the JSON `data` part BEFORE the
      // file parts — Modrinth's multipart parser requires `data` to come first.
      const files = [];
      const fileParts = [];
      for (let i = 0; i < file_paths.length; i++) {
        const p = file_paths[i];
        let buf;
        try {
          buf = await readFile(p);
        } catch (e) {
          throw new Error(`Could not read file '${p}': ${e.message}`);
        }
        const partName = `file_${i}`;
        fileParts.push(partName);
        files.push({ partName, buf, name: basename(p) });
      }

      const data = {
        project_id: realProjectId,
        file_parts: fileParts,
        primary_file: fileParts[0],
        version_number,
        name: name || version_number,
        version_type,
        loaders,
        game_versions,
        featured,
        dependencies: dependencies || [],
        ...(changelog ? { changelog } : {}),
      };

      const form = new FormData();
      form.append("data", JSON.stringify(data)); // must be first
      for (const f of files) {
        form.append(
          f.partName,
          new File([f.buf], f.name, { type: "application/java-archive" }),
          f.name,
        );
      }

      const result = await api("/v2/version", {
        method: "POST",
        auth: true,
        body: form,
      });

      return ok({
        published: true,
        version_id: result.id,
        version_number: result.version_number,
        project_id: result.project_id,
        url: `https://modrinth.com/project/${result.project_id}/version/${result.id}`,
        files: (result.files || []).map((f) => ({
          filename: f.filename,
          primary: f.primary,
          url: f.url,
          size: f.size,
        })),
      });
    },
  },

  {
    name: "modrinth_create_project",
    description:
      "Create a NEW Modrinth project (the initial project page). Created as a " +
      "DRAFT — nothing is public until you submit it for review on the site or " +
      "set requested_status. This is a write action; only call it when the user " +
      "explicitly asks to create a new project. After it exists, publish jars " +
      "with modrinth_create_version.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      slug: z
        .string()
        .min(3)
        .max(64)
        .describe(
          "URL slug, 3-64 chars, e.g. 'no-anvil-limit'. Becomes modrinth.com/project/<slug>.",
        ),
      title: z.string().describe("Project display name, e.g. 'No Anvil Limit'."),
      description: z
        .string()
        .describe("Short one-or-two-sentence summary shown in search."),
      project_type: z
        .enum(["mod", "modpack", "resourcepack", "shader"])
        .default("mod")
        .describe("Project type. Defaults to mod."),
      body: z
        .string()
        .optional()
        .describe("Long-form markdown description for the project page."),
      categories: z
        .array(z.string())
        .optional()
        .describe(
          "Featured categories, e.g. ['utility','game-mechanics']. Must be valid Modrinth categories for the project_type.",
        ),
      client_side: z
        .enum(["required", "optional", "unsupported", "unknown"])
        .default("required")
        .describe("Whether the mod is needed on the client. Editable later."),
      server_side: z
        .enum(["required", "optional", "unsupported", "unknown"])
        .default("required")
        .describe("Whether the mod is needed on the server. Editable later."),
      license_id: z
        .string()
        .default("MIT")
        .describe("SPDX license id, e.g. 'MIT', 'GPL-3.0-only', 'ARR'."),
      source_url: z.string().optional().describe("Source code repo URL."),
      issues_url: z.string().optional().describe("Issue tracker URL."),
      wiki_url: z.string().optional().describe("Wiki/docs URL."),
      discord_url: z.string().optional().describe("Discord invite URL."),
      icon_path: z
        .string()
        .optional()
        .describe("Absolute path to an icon image (png/jpg/webp/gif/svg)."),
      requested_status: z
        .enum(["approved", "archived", "unlisted", "private", "draft"])
        .default("draft")
        .describe(
          "Desired status once processed. Stays a draft until you submit for review on the site.",
        ),
    }),
    handler: async (input) => {
      requireToken();
      const {
        slug,
        title,
        description,
        project_type,
        body,
        categories,
        client_side,
        server_side,
        license_id,
        source_url,
        issues_url,
        wiki_url,
        discord_url,
        icon_path,
        requested_status,
      } = input;

      const data = {
        slug,
        title,
        description,
        project_type,
        body: body || description,
        categories: categories || [],
        additional_categories: [],
        client_side,
        server_side,
        license_id,
        is_draft: true, // Modrinth: always create as a draft
        requested_status,
        ...(source_url ? { source_url } : {}),
        ...(issues_url ? { issues_url } : {}),
        ...(wiki_url ? { wiki_url } : {}),
        ...(discord_url ? { discord_url } : {}),
      };

      const form = new FormData();
      form.append("data", JSON.stringify(data));
      if (icon_path) {
        let buf;
        try {
          buf = await readFile(icon_path);
        } catch (e) {
          throw new Error(`Could not read icon '${icon_path}': ${e.message}`);
        }
        form.append("icon", new File([buf], basename(icon_path)), basename(icon_path));
      }

      const p = await api("/v2/project", { method: "POST", auth: true, body: form });
      return ok({
        created: true,
        id: p.id,
        slug: p.slug,
        title: p.title,
        status: p.status,
        url: `https://modrinth.com/project/${p.slug}`,
        next: "Upload a jar with modrinth_create_version, then submit for review on the site.",
      });
    },
  },

  {
    name: "modrinth_modify_version",
    description:
      "Edit metadata of an EXISTING published version (name, changelog, " +
      "version_type, loaders, game_versions, featured). Does not upload files.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: z.object({
      version_id: z.string().describe("The version id to modify."),
      name: z.string().optional(),
      changelog: z.string().optional(),
      version_type: z.enum(["release", "beta", "alpha"]).optional(),
      loaders: z.array(z.string()).optional(),
      game_versions: z.array(z.string()).optional(),
      featured: z.boolean().optional(),
    }),
    handler: async ({ version_id, ...fields }) => {
      const payload = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) payload[k] = v;
      }
      if (Object.keys(payload).length === 0) {
        throw new Error("Nothing to modify — provide at least one field.");
      }
      await api(`/v2/version/${encodeURIComponent(version_id)}`, {
        method: "PATCH",
        auth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return ok({ modified: true, version_id, changed: Object.keys(payload) });
    },
  },
];

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Wire up the MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "modrinth-mcp", version: VERSION },
  { capabilities: { tools: {} } },
);

// Minimal JSON-Schema generation from the Zod shapes we use, so we don't pull
// in an extra dependency just for schema conversion.
function zodToJsonSchema(schema) {
  const shape = schema._def.shape ? schema._def.shape() : {};
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = describeField(field);
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function describeField(field) {
  let f = field;
  let description = f._def.description;
  // Unwrap optional / default wrappers to reach the base type.
  while (
    f._def.typeName === "ZodOptional" ||
    f._def.typeName === "ZodDefault"
  ) {
    description = description || f._def.description;
    f = f._def.innerType;
  }
  description = description || f._def.description;
  const base = baseType(f);
  return description ? { ...base, description } : base;
}

function baseType(f) {
  switch (f._def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: f._def.values };
    case "ZodArray":
      return { type: "array", items: describeField(f._def.type) };
    case "ZodObject":
      return zodToJsonSchema(f);
    default:
      return {};
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
    annotations: t.annotations,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = toolByName.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const args = tool.inputSchema.parse(request.params.arguments || {});
    return await tool.handler(args);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs; stdout is reserved for the MCP protocol.
console.error(
  `modrinth-mcp ${VERSION} ready (base: ${BASE_URL}, token: ${TOKEN ? "set" : "MISSING"})`,
);
