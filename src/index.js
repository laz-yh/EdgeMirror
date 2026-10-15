import portal from "./tools/portal.js";
import { CATALOG_DEFINITION, HEALTH_PATHS, HELP_DEFINITION, PROJECT, TOOL_DEFINITIONS } from "./config.js";
import docker from "./tools/docker.js";
import github from "./tools/github.js";
import help from "./tools/help.js";
import hf from "./tools/hf.js";
import mirrors from "./tools/mirrors.js";
import npm from "./tools/npm.js";
import proxy from "./tools/proxy.js";
import pypi from "./tools/pypi.js";
import go from "./tools/go.js";
import maven from "./tools/maven.js";
import crates from "./tools/crates.js";
import downloads from "./tools/downloads.js";
import catalog from "./tools/catalog.js";
import repositories from "./tools/repositories.js";
import nuget from "./tools/nuget.js";
import sdks from "./tools/sdks.js";
import { REPOSITORY_SOURCES } from "./repositories/catalog.js";
import { enforceNoStore } from "./proxy-utils.js";

const HANDLERS = new Map([
  ["portal", portal],
  ["pypi", pypi],
  ["hf", hf],
  ["github", github],
  ["help", help],
  ["docker", docker],
  ["mirrors", mirrors],
  ["proxy", proxy],
  ["npm", npm],
  ["go", go],
  ["maven", maven],
  ["crates", crates],
  ["downloads", downloads],
]);

const TOOLS = TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  handler: HANDLERS.get(tool.key),
}));

const HOST_ROUTES = new Map(TOOLS.map((tool) => [tool.host, tool]));
const PATH_ROUTES = new Map(TOOLS.map((tool) => [tool.key, tool]));
PATH_ROUTES.set("help", { key: "help", handler: help });
PATH_ROUTES.set("catalog", { key: "catalog", handler: catalog });
PATH_ROUTES.set("edgemirror", { key: "portal", handler: portal });
PATH_ROUTES.set("box", { key: "portal", handler: portal });

export default {
  async fetch(request, env, ctx) {
    return enforceNoStore(await routeRequest(request, env, ctx));
  },
};

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === "/ads.txt") {
    return new Response("Not Found", { status: 404 });
  }

  if (url.pathname === "/favicon.ico") {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><rect width="100" height="100" rx="20" fill="url(#g)"/><path d="M50 25a25 25 0 00-25 25h10a15 15 0 0115-15v-8l16 16-16 16v-8a25 25 0 0025-25h-10z" fill="#fff" opacity="0.95"/><circle cx="35" cy="50" r="3" fill="#6366f1"/><circle cx="65" cy="50" r="3" fill="#6366f1"/></svg>`,
      {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
        },
      }
    );
  }

  if (HEALTH_PATHS.has(url.pathname)) {
    return jsonResponse({
      status: "ok",
      service: PROJECT.name,
      version: PROJECT.version,
      primaryHost: PROJECT.primaryHost,
      hostname: url.hostname,
      tools: TOOL_DEFINITIONS.map(({ key, title, path, status, description }) => ({
        key,
        title,
        path,
        status,
        description,
      })),
      repositories: {
        path: "/repo",
        count: REPOSITORY_SOURCES.length,
      },
      canonicalRoutes: {
        packages: ["/pkg/npm", "/pkg/nuget"],
        sdks: ["/sdk/node", "/sdk/flutter"],
        oci: ["/oci/docker/v2"],
        git: ["/git/github"],
      },
      pages: [CATALOG_DEFINITION, HELP_DEFINITION],
    });
  }

  const firstSegment = url.pathname.split("/").filter(Boolean)[0];

  if (firstSegment === "repo") {
    return repositories.fetch(stripToolPrefix(request, "repo", "repo"), env, ctx);
  }

  if (firstSegment === "pkg") {
    return routePackageRequest(request, env, ctx);
  }

  if (firstSegment === "sdk") {
    return sdks.fetch(stripToolPrefix(request, "sdk", "sdk"), env, ctx);
  }

  if (firstSegment === "oci") {
    return routeCanonicalAdapter(request, "/oci/docker", "docker", docker, env, ctx);
  }

  if (firstSegment === "git") {
    return routeCanonicalAdapter(request, "/git/github", "github", github, env, ctx);
  }

  if (["v2", "token", "_worker_blob_proxy"].includes(firstSegment)) {
    return docker.fetch(withToolContext(request, "docker"), env, ctx);
  }

  const pathTool = PATH_ROUTES.get(firstSegment);
  if (pathTool) {
    const routedRequest = pathTool.keepPathPrefix
      ? withToolContext(request, pathTool.key)
      : stripToolPrefix(request, firstSegment, pathTool.key);
    return pathTool.handler.fetch(routedRequest, env, ctx);
  }

  const hostTool = HOST_ROUTES.get(url.hostname.toLowerCase());
  if (hostTool) {
    return hostTool.handler.fetch(withToolContext(request, hostTool.key, hostTool.path), env, ctx);
  }

  return portal.fetch(withToolContext(request, "portal"), env, ctx);
}

function routePackageRequest(request, env, ctx) {
  const url = new URL(request.url);
  const [, , adapter] = url.pathname.split("/");

  if (!adapter) {
    return jsonResponse({
      service: "EdgeMirror package gateway",
      cache: "disabled",
      adapters: [
        { id: "npm", route: `${url.origin}/pkg/npm/`, compatibilityAlias: "/npm" },
        { id: "nuget", route: `${url.origin}/pkg/nuget/v3/index.json`, readOnly: true },
      ],
    });
  }

  if (adapter === "npm") {
    return npm.fetch(stripPathPrefix(request, "/pkg/npm", "npm", "/pkg/npm"), env, ctx);
  }
  if (adapter === "nuget") {
    return nuget.fetch(stripPathPrefix(request, "/pkg/nuget", "nuget", "/pkg/nuget"), env, ctx);
  }

  return textResponse(`Unknown package adapter: ${adapter}`, { status: 404 });
}

function routeCanonicalAdapter(request, prefix, key, handler, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    return textResponse(`Unknown canonical route: ${url.pathname}`, { status: 404 });
  }
  return handler.fetch(stripPathPrefix(request, prefix, key, prefix), env, ctx);
}

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers,
  });
}

function textResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(body, {
    ...init,
    headers,
  });
}

function stripToolPrefix(request, segment, contextSegment = segment) {
  const configuredBasePath = contextSegment === "portal" ? "/edgemirror" : `/${contextSegment}`;
  return stripPathPrefix(request, `/${segment}`, contextSegment, configuredBasePath);
}

function stripPathPrefix(request, prefix, contextKey, basePath = prefix) {
  const url = new URL(request.url);
  if (url.pathname === prefix) {
    url.pathname = "/";
  } else if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length);
  }
  return withToolContext(new Request(url.toString(), request), contextKey, basePath);
}

function withToolContext(request, segment, basePath = segment === "portal" ? "" : `/${segment}`) {
  const headers = new Headers(request.headers);
  headers.set("X-EdgeMirror-Tool-Key", segment);
  headers.set("X-EdgeMirror-Base-Path", basePath);
  return new Request(request, { headers });
}
