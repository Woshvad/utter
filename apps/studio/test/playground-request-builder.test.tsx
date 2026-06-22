// playground-request-builder.test.tsx - the STU-03 OpenAPI-driven request builder.
//
// Covers three layers, all against the FROZEN onRun seam (request body only; no money
// rendering touched):
//   (1) the pure openapi-fields helper: extractRequestSchema maps a requestBody object
//       schema to typed fields + methods, falls back to methods-only (empty fields) for
//       a body-less doc like the echo example, and buildBody coerces the typed values
//       back to the same plain object JSON.parse would have yielded.
//   (2) the RequestBuilder component: typed fields render from a schema, changes are
//       reported via the callbacks, the method selector reports a change, and the
//       raw-JSON toggle swaps to the textarea (and the textarea keeps the existing
//       data-testid / aria-label the playground.test.tsx assertions rely on).
//   (3) PlaygroundPlayer wiring: it builds the body from the typed fields in form mode
//       and passes THAT to onRun, falls back to parsing the raw JSON otherwise, and lets
//       the user change the rendered method - the onRun signature is unchanged.
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import {
  extractRequestSchema,
  buildBody,
  type ParamField,
  type RequestSchema,
} from "../app/components/playground/openapi-fields";
import { RequestBuilder } from "../app/components/playground/RequestBuilder";
import { PlaygroundPlayer } from "../app/components/playground/PlaygroundPlayer";
import echoOpenapi from "../../../packages/x402-arc/examples/echo/openapi.json";
import type { Pricing } from "@utter/x402-arc";

/** A small inline OpenAPI 3.1 doc: POST /echo with a string field + an enum + a number. */
const BODY_DOC = {
  openapi: "3.1.0",
  info: { title: "Echo", version: "1.0.0" },
  paths: {
    "/echo": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EchoRequest" },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      EchoRequest: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
          tone: { type: "string", enum: ["plain", "loud"] },
          repeat: { type: "integer" },
          shout: { type: "boolean" },
        },
      },
    },
  },
};

const METERED_PRICING: Pricing = {
  model: "metered",
  base: "2000",
  perKB: "500",
  computeMultiplier: "100",
  maxResponseBytes: 1_048_576,
};

describe("extractRequestSchema (pure OpenAPI -> typed fields)", () => {
  it("maps a $ref'd requestBody object schema to typed fields preserving name/type/enum/required", () => {
    const schema = extractRequestSchema(BODY_DOC);
    expect(schema.methods).toEqual(["POST"]);

    const byName: Record<string, ParamField | undefined> = Object.fromEntries(
      schema.fields.map((f) => [f.name, f]),
    );
    expect(byName.text).toMatchObject({ name: "text", type: "string", required: true });
    expect(byName.tone).toMatchObject({ name: "tone", type: "enum", required: false });
    expect(byName.tone?.enumValues).toEqual(["plain", "loud"]);
    expect(byName.repeat).toMatchObject({ name: "repeat", type: "number", required: false });
    expect(byName.shout).toMatchObject({ name: "shout", type: "boolean", required: false });
  });

  it("uppercases every defined operation verb on the path into methods", () => {
    const multi = {
      openapi: "3.1.0",
      paths: { "/x": { get: { responses: {} }, post: { responses: {} } } },
    };
    expect(extractRequestSchema(multi).methods.sort()).toEqual(["GET", "POST"]);
  });

  it("returns methods-only (empty fields) for a body-less doc like the echo example", () => {
    const schema = extractRequestSchema(echoOpenapi);
    expect(schema.methods).toEqual(["POST"]);
    expect(schema.fields).toEqual([]);
  });

  it("is defensive: a missing/odd shape yields empty methods + fields, never throws", () => {
    expect(extractRequestSchema(undefined)).toEqual({ methods: [], fields: [] });
    expect(extractRequestSchema({})).toEqual({ methods: [], fields: [] });
    expect(extractRequestSchema({ paths: { "/x": {} } })).toEqual({ methods: [], fields: [] });
  });
});

describe("buildBody (typed values -> the prior JSON object shape)", () => {
  const fields: ParamField[] = [
    { name: "text", type: "string", required: true },
    { name: "repeat", type: "number", required: false },
    { name: "shout", type: "boolean", required: false },
    { name: "tone", type: "enum", required: false, enumValues: ["plain", "loud"] },
  ];

  it("coerces values by type (number -> Number, boolean -> boolean)", () => {
    const body = buildBody(fields, { text: "hi", repeat: "3", shout: "true", tone: "loud" });
    expect(body).toEqual({ text: "hi", repeat: 3, shout: true, tone: "loud" });
  });

  it("omits empty optional fields but keeps required fields verbatim", () => {
    const body = buildBody(fields, { text: "hi", repeat: "", shout: "false", tone: "" });
    expect(body).toEqual({ text: "hi", shout: false });
  });
});

describe("RequestBuilder (method + typed fields + raw-JSON toggle)", () => {
  const SCHEMA: RequestSchema = {
    methods: ["GET", "POST"],
    fields: [
      { name: "text", type: "string", required: true },
      { name: "shout", type: "boolean", required: false },
      { name: "tone", type: "enum", required: false, enumValues: ["plain", "loud"] },
    ],
  };

  function setup(overrides: Partial<React.ComponentProps<typeof RequestBuilder>> = {}) {
    const props = {
      schema: SCHEMA,
      method: "POST",
      onMethodChange: vi.fn(),
      mode: "form" as const,
      onModeChange: vi.fn(),
      values: {} as Record<string, string>,
      onValuesChange: vi.fn(),
      rawBody: '{\n  "text": "hello"\n}',
      onRawBodyChange: vi.fn(),
      ...overrides,
    };
    render(<RequestBuilder {...props} />);
    return props;
  }

  it("renders one labeled control per field from the schema", () => {
    setup();
    expect(screen.getByTestId("field-text")).toBeInTheDocument();
    expect(screen.getByTestId("field-shout")).toBeInTheDocument();
    expect(screen.getByTestId("field-tone")).toBeInTheDocument();
  });

  it("reports a field change via onValuesChange", () => {
    const props = setup();
    fireEvent.change(screen.getByTestId("field-text"), { target: { value: "hi" } });
    expect(props.onValuesChange).toHaveBeenCalledWith({ text: "hi" });
  });

  it("reports a method change via onMethodChange", () => {
    const props = setup();
    fireEvent.change(screen.getByTestId("playground-method"), { target: { value: "GET" } });
    expect(props.onMethodChange).toHaveBeenCalledWith("GET");
  });

  it("toggles to the raw-JSON textarea (keeping the existing testid + aria-label)", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("playground-raw-toggle"));
    expect(props.onModeChange).toHaveBeenCalledWith("raw");
  });

  it("renders the raw textarea when in raw mode", () => {
    setup({ mode: "raw" });
    const ta = screen.getByTestId("playground-request");
    expect(ta).toBeInTheDocument();
    expect(ta).toHaveAttribute("aria-label", "request body");
  });

  it("falls back to the raw textarea by default when the schema has no fields", () => {
    setup({ schema: { methods: ["POST"], fields: [] } });
    expect(screen.getByTestId("playground-request")).toBeInTheDocument();
  });
});

describe("PlaygroundPlayer (builds the body from the typed fields, onRun seam unchanged)", () => {
  const SCHEMA: RequestSchema = {
    methods: ["POST"],
    fields: [
      { name: "text", type: "string", required: true },
      { name: "repeat", type: "number", required: false },
    ],
  };

  it("builds the body from the typed fields and passes that object to onRun", async () => {
    const onRun = vi.fn().mockResolvedValue({ paid: true, debitAmount: 1n, body: { ok: true } });
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
        requestSchema={SCHEMA}
      />,
    );
    fireEvent.change(screen.getByTestId("field-text"), { target: { value: "hello" } });
    fireEvent.change(screen.getByTestId("field-repeat"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("playground-run"));

    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0]![0]).toEqual({ text: "hello", repeat: 2 });
  });

  it("falls back to parsing the raw JSON when there are no schema fields", async () => {
    const onRun = vi.fn().mockResolvedValue({ paid: true, debitAmount: 1n, body: { ok: true } });
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
      />,
    );
    // No requestSchema -> raw mode by default; the seed body is the prior shape.
    fireEvent.click(screen.getByTestId("playground-run"));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0]![0]).toEqual({ text: "hello" });
  });

  it("lets the user change the rendered method", () => {
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={vi.fn()}
        requestSchema={{ methods: ["GET", "POST"], fields: SCHEMA.fields }}
      />,
    );
    const select = screen.getByTestId("playground-method") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "GET" } });
    expect(within(screen.getByTestId("playground-player")).getByText("get")).toBeInTheDocument();
  });
});
