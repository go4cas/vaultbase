/**
 * OpenAPI 3.0 spec generation from collection definitions (roadmap F-2).
 *
 * The spec is derived from the DATA MODEL (each collection's field defs → JSON
 * Schema + the record CRUD paths), not from route introspection — so it stays
 * in sync with collections automatically. The field-type → schema mapping here
 * is the core F-3 (typed SDK generator) will build on.
 */
import type { Collection } from "../db/schema.ts";
import { parseFields, type FieldDef, type FieldType } from "./collections.ts";

type JsonSchema = Record<string, unknown>;

/** Map one field to its JSON Schema (read/write shape), applying easy constraints. */
export function fieldToSchema(field: FieldDef): JsonSchema {
  const o = field.options ?? {};
  const base = ((): JsonSchema => {
    switch (field.type as FieldType) {
      case "text":
      case "editor":
        return { type: "string" };
      case "email":
        return { type: "string", format: "email" };
      case "url":
        return { type: "string", format: "uri" };
      case "number":
        return { type: "number" };
      case "bool":
        return { type: "boolean" };
      case "date":
      case "autodate":
        return { type: "integer", description: "Unix timestamp (seconds)" };
      case "json":
        return {}; // arbitrary JSON
      case "password":
        return { type: "string", writeOnly: true };
      case "vector":
        return { type: "array", items: { type: "number" } };
      case "geoPoint":
        return {
          type: "object",
          properties: { lat: { type: "number" }, lon: { type: "number" } },
        };
      case "file":
        return o.multiple ? { type: "array", items: { type: "string" } } : { type: "string" };
      case "relation":
        return o.multiple
          ? { type: "array", items: { type: "string" }, description: "Related record ids" }
          : { type: "string", description: "Related record id" };
      case "select": {
        const values = Array.isArray(o.values) ? o.values : [];
        const item: JsonSchema = values.length
          ? { type: "string", enum: values }
          : { type: "string" };
        return o.multiple ? { type: "array", items: item } : item;
      }
      default:
        return {};
    }
  })();

  // Easy constraints.
  if (field.type === "number") {
    if (typeof o.min === "number") base.minimum = o.min;
    if (typeof o.max === "number") base.maximum = o.max;
  } else if (field.type === "text" || field.type === "editor") {
    if (typeof o.min === "number") base.minLength = o.min;
    if (typeof o.max === "number") base.maxLength = o.max;
    if (typeof o.pattern === "string" && o.pattern) base.pattern = o.pattern;
  }
  return base;
}

const recordSchemaName = (name: string) => `${name}`;
const createSchemaName = (name: string) => `${name}Create`;
const updateSchemaName = (name: string) => `${name}Update`;

/** Read schema: record meta + all fields (password fields are write-only). */
function recordSchema(fields: FieldDef[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    id: { type: "string" },
    collectionId: { type: "string" },
    collectionName: { type: "string" },
    created: { type: "integer", description: "Unix timestamp (seconds)" },
    updated: { type: "integer", description: "Unix timestamp (seconds)" },
  };
  for (const f of fields) {
    if (f.system || f.type === "password") continue;
    properties[f.name] = fieldToSchema(f);
  }
  return { type: "object", properties };
}

/** Write schema for create/update. `requireRequired` includes the `required` list. */
function writeSchema(fields: FieldDef[], requireRequired: boolean): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const f of fields) {
    if (f.system || f.type === "autodate") continue;
    properties[f.name] = fieldToSchema(f);
    if (requireRequired && f.required) required.push(f.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const LIST_PARAMS: JsonSchema[] = [
  { name: "page", in: "query", schema: { type: "integer", default: 1 } },
  { name: "perPage", in: "query", schema: { type: "integer", default: 30 } },
  { name: "filter", in: "query", schema: { type: "string" }, description: "Filter expression" },
  { name: "sort", in: "query", schema: { type: "string" }, description: "e.g. `-created,name`" },
  {
    name: "expand",
    in: "query",
    schema: { type: "string" },
    description: "Comma-separated relations",
  },
  { name: "fields", in: "query", schema: { type: "string" }, description: "Field projection" },
  { name: "skipTotal", in: "query", schema: { type: "string" } },
  {
    name: "search",
    in: "query",
    schema: { type: "string" },
    description: "Full-text search (FTS5)",
  },
  {
    name: "cursor",
    in: "query",
    schema: { type: "string" },
    description: "Keyset pagination cursor",
  },
];

const idParam: JsonSchema = { name: "id", in: "path", required: true, schema: { type: "string" } };

function jsonBody(schemaName: string): JsonSchema {
  return { required: true, content: { "application/json": { schema: ref(schemaName) } } };
}
function jsonResp(desc: string, schema: JsonSchema): JsonSchema {
  return { description: desc, content: { "application/json": { schema } } };
}

/** Build the record CRUD paths for one collection. Views are read-only. */
function collectionPaths(col: Collection): Record<string, JsonSchema> {
  const name = col.name;
  const isView = col.type === "view";
  const recordRef = ref(recordSchemaName(name));
  const listResp = jsonResp("List of records", {
    type: "object",
    properties: {
      data: { type: "array", items: recordRef },
      page: { type: "integer" },
      perPage: { type: "integer" },
      totalItems: { type: "integer" },
      totalPages: { type: "integer" },
    },
  });
  const oneResp = jsonResp("A record", {
    type: "object",
    properties: { data: recordRef },
  });
  const tag = name;

  const listPath: JsonSchema = {
    get: {
      tags: [tag],
      summary: `List ${name} records`,
      parameters: LIST_PARAMS,
      responses: { "200": listResp },
    },
  };
  if (!isView) {
    listPath.post = {
      tags: [tag],
      summary: `Create a ${name} record`,
      requestBody: jsonBody(createSchemaName(name)),
      responses: { "200": oneResp, "422": { description: "Validation failed" } },
    };
  }

  const itemPath: JsonSchema = {
    get: {
      tags: [tag],
      summary: `Get a ${name} record`,
      parameters: [idParam],
      responses: { "200": oneResp, "404": { description: "Not found" } },
    },
  };
  if (!isView) {
    itemPath.patch = {
      tags: [tag],
      summary: `Update a ${name} record`,
      parameters: [idParam],
      requestBody: jsonBody(updateSchemaName(name)),
      responses: { "200": oneResp, "404": { description: "Not found" } },
    };
    itemPath.delete = {
      tags: [tag],
      summary: `Delete a ${name} record`,
      parameters: [idParam],
      responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } },
    };
  }

  return { [`/${name}`]: listPath, [`/${name}/{id}`]: itemPath };
}

export interface OpenApiOptions {
  serverUrl: string;
  version: string;
}

/** Assemble the full OpenAPI 3.0 document from the collection set. */
export function buildOpenApiSpec(collections: Collection[], opts: OpenApiOptions): JsonSchema {
  const schemas: Record<string, JsonSchema> = {};
  const paths: Record<string, JsonSchema> = {};

  for (const col of collections) {
    const fields = parseFields(col.fields);
    schemas[recordSchemaName(col.name)] = recordSchema(fields);
    if (col.type !== "view") {
      schemas[createSchemaName(col.name)] = writeSchema(fields, true);
      schemas[updateSchemaName(col.name)] = writeSchema(fields, false);
    }
    Object.assign(paths, collectionPaths(col));
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Cogworks API",
      version: opts.version,
      description: "Auto-generated from collection definitions.",
    },
    servers: [{ url: opts.serverUrl }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };
}
