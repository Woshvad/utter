// openapi-fields.ts - the pure, React-free OpenAPI-to-fields helper behind the
// STU-03 request builder.
//
// extractRequestSchema walks an OpenAPI 3.1 document (the SAME value the resource
// detail `api` tab already renders) and projects the first path's request-body
// object schema into a typed field list plus the available HTTP methods. It is
// defensive by construction: any missing or odd shape yields an empty result
// rather than throwing, so the builder can always fall back to raw JSON.
//
// buildBody is the inverse seam: it turns the typed field values back into the
// plain request object JSON.parse would have produced before this work, so the
// onRun seam receives the exact same body shape it always did. This module touches
// the REQUEST body only - it never renders or computes money.

/** A single typed request parameter projected from the OpenAPI body schema. */
export interface ParamField {
  /** The property name (the body key). */
  name: string;
  /** The input type the builder renders. */
  type: "string" | "number" | "boolean" | "enum";
  /** True when the schema lists the property in its `required` array. */
  required: boolean;
  /** The allowed values when the field is an enum. */
  enumValues?: string[];
}

/** The extracted request shape: the available methods + the typed body fields. */
export interface RequestSchema {
  /** Every defined operation verb on the path, uppercased (e.g. ["GET","POST"]). */
  methods: string[];
  /** The typed body fields, or empty when no request-body object schema exists. */
  fields: ParamField[];
}

/** The OpenAPI operation verbs the builder surfaces, in canonical order. */
const VERBS = ["get", "post", "put", "patch", "delete"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Resolve a single local `$ref` (e.g. "#/components/schemas/Foo") against the doc. */
function resolveRef(doc: Record<string, unknown>, ref: string): unknown {
  // Only local refs of the form #/a/b/c are resolved; anything else yields undefined.
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = doc;
  for (const segment of ref.slice(2).split("/")) {
    if (!isObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Find the request-body JSON schema for an operation, resolving one level of $ref. */
function bodySchema(
  doc: Record<string, unknown>,
  operation: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const requestBody = operation.requestBody;
  if (!isObject(requestBody)) return undefined;
  const content = requestBody.content;
  if (!isObject(content)) return undefined;
  const json = content["application/json"];
  if (!isObject(json)) return undefined;
  let schema = json.schema;
  if (isObject(schema) && typeof schema.$ref === "string") {
    schema = resolveRef(doc, schema.$ref);
  }
  return isObject(schema) ? schema : undefined;
}

/** Map a single property schema to its builder field type. */
function fieldType(prop: Record<string, unknown>): ParamField["type"] {
  if (Array.isArray(prop.enum)) return "enum";
  if (prop.type === "integer" || prop.type === "number") return "number";
  if (prop.type === "boolean") return "boolean";
  return "string";
}

/**
 * Project the first path's request-body object schema into typed fields + methods.
 * Never throws: a missing/odd shape yields `{ methods: [], fields: [] }` (or
 * methods-only when the verbs are present but no body schema is).
 */
export function extractRequestSchema(openapi: unknown): RequestSchema {
  if (!isObject(openapi)) return { methods: [], fields: [] };
  const paths = openapi.paths;
  if (!isObject(paths)) return { methods: [], fields: [] };

  const firstPath = Object.values(paths)[0];
  if (!isObject(firstPath)) return { methods: [], fields: [] };

  const methods: string[] = [];
  for (const verb of VERBS) {
    if (isObject(firstPath[verb])) methods.push(verb.toUpperCase());
  }

  // The body schema comes from the first operation that declares one.
  let schema: Record<string, unknown> | undefined;
  for (const verb of VERBS) {
    const op = firstPath[verb];
    if (isObject(op)) {
      schema = bodySchema(openapi, op);
      if (schema) break;
    }
  }

  const fields: ParamField[] = [];
  if (schema && isObject(schema.properties)) {
    const requiredList = Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [];
    for (const [name, raw] of Object.entries(schema.properties)) {
      if (!isObject(raw)) continue;
      const type = fieldType(raw);
      const field: ParamField = { name, type, required: requiredList.includes(name) };
      if (type === "enum" && Array.isArray(raw.enum)) {
        field.enumValues = raw.enum.map((v) => String(v));
      }
      fields.push(field);
    }
  }

  return { methods, fields };
}

/**
 * Build the request body object from the typed field values, coercing per type.
 * Number fields become `Number`, booleans become real booleans, and empty optional
 * fields are omitted. The result is the same plain object JSON.parse would have
 * yielded from the raw editor, so the onRun seam is unchanged.
 */
export function buildBody(
  fields: ParamField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? "";
    if (raw === "" && !field.required) continue;
    switch (field.type) {
      case "number":
        body[field.name] = Number(raw);
        break;
      case "boolean":
        body[field.name] = raw === "true";
        break;
      default:
        body[field.name] = raw;
    }
  }
  return body;
}
