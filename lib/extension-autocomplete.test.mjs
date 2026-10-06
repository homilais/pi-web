import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const {
  appendAutocompleteProvider,
  buildExtensionInsertText,
  createBaseAutocompleteProvider,
  EXTENSION_AUTOCOMPLETE_TRIGGERS,
  matchExtensionTriggerToken,
  normalizeAutocompleteSuggestions,
  resolveAutocompleteEditorState,
} = await jiti.import("./extension-autocomplete.ts");

// ---------------------------------------------------------------------------
// Client-side trigger detection
// ---------------------------------------------------------------------------

test("extension trigger matches @skill: tokens with their query", () => {
  assert.deepEqual(matchExtensionTriggerToken("@skill:"), { trigger: "@skill:", query: "" });
  assert.deepEqual(matchExtensionTriggerToken("@skill:co"), { trigger: "@skill:", query: "co" });
  assert.deepEqual(matchExtensionTriggerToken("@skill:code-review"), {
    trigger: "@skill:",
    query: "code-review",
  });
  // The full-width colon is the same trigger (the TUI extension accepts both).
  assert.deepEqual(matchExtensionTriggerToken("@skill："), { trigger: "@skill：", query: "" });
  assert.deepEqual(matchExtensionTriggerToken("@skill：代码"), {
    trigger: "@skill：",
    query: "代码",
  });
  assert.deepEqual(EXTENSION_AUTOCOMPLETE_TRIGGERS, ["@skill:", "@skill："]);
});

test("non-extension @ tokens and quoted forms never match", () => {
  // Plain file @-mention stays with the file completion.
  assert.equal(matchExtensionTriggerToken("@"), null);
  assert.deepEqual(matchExtensionTriggerToken("@src/lib"), null);
  // A quoted @"..." token is always a file token, even with a skill-looking body.
  assert.equal(matchExtensionTriggerToken("@\"skill:co\""), null);
  // Unknown trigger characters keep file behavior.
  assert.equal(matchExtensionTriggerToken("@file:"), null);
});

// ---------------------------------------------------------------------------
// Server-side provider registration
// ---------------------------------------------------------------------------

test("providers chain: the next factory receives the previous provider", async () => {
  const base = {
    getSuggestions: async () => ({ items: [{ value: "base", label: "base" }], prefix: "@" }),
  };
  const providers = [base];
  const first = appendAutocompleteProvider(providers, (current) => {
    assert.equal(current, base);
    return { ...current, getSuggestions: async () => ({ items: [{ value: "one", label: "one" }], prefix: "" }) };
  });
  const second = appendAutocompleteProvider(providers, (current) => {
    assert.equal(current, first);
    return { ...current, triggerCharacters: ["@skill:"] };
  });
  assert.deepEqual(providers, [base, first, second]);
  assert.equal(providers[providers.length - 1], second);
  // Chained: the last provider still reaches the first registration's data.
  assert.equal((await second.getSuggestions([], 0, 0, { signal: new AbortController().signal })).items[0].value, "one");
  assert.deepEqual(second.triggerCharacters, ["@skill:"]);
});

test("the first factory receives null and malformed providers are refused", () => {
  const providers = [];
  appendAutocompleteProvider(providers, (current) => {
    assert.equal(current, null);
    return { getSuggestions: async () => null };
  });
  assert.equal(providers.length, 1);

  assert.throws(() => appendAutocompleteProvider(providers, () => null), /getSuggestions/);
  assert.throws(() => appendAutocompleteProvider(providers, () => ({})), /getSuggestions/);
  // A refused registration must not leave a half-added provider behind.
  assert.equal(providers.length, 1);
});

// TUI-written extensions dereference `current` freely (e.g.
// `current.triggerCharacters ?? []`); the seeded base must absorb that.
test("the seeded base provider answers null and tolerates reads", async () => {
  const base = createBaseAutocompleteProvider();
  assert.equal(await base.getSuggestions(["line"], 0, 0, { signal: new AbortController().signal }), null);
  const providers = [base];
  let observed = null;
  appendAutocompleteProvider(providers, (current) => {
    observed = current.triggerCharacters ?? [];
    return { getSuggestions: async () => null };
  });
  assert.deepEqual(observed, []);
});

// ---------------------------------------------------------------------------
// Server-side request handling pieces
// ---------------------------------------------------------------------------

test("normalizeAutocompleteSuggestions keeps only well-formed items", () => {
  assert.deepEqual(
    normalizeAutocompleteSuggestions(
      { items: [
        { value: "code-review", label: "code-review", description: "Review code" },
        { value: 42, label: "bad" },
        null,
        { label: "no value" },
      ], prefix: "@skill:co" },
      "@skill:",
    ),
    {
      items: [{ value: "code-review", label: "code-review", description: "Review code" }],
      prefix: "@skill:co",
    },
  );
  // Null/undefined/error shapes all degrade to an empty list with the trigger
  // as the prefix, so a broken provider can never break typing.
  assert.deepEqual(normalizeAutocompleteSuggestions(null, "@skill:"), { items: [], prefix: "@skill:" });
  assert.deepEqual(normalizeAutocompleteSuggestions(undefined, "@skill:"), { items: [], prefix: "@skill:" });
  assert.deepEqual(normalizeAutocompleteSuggestions("garbage", "@skill:"), { items: [], prefix: "@skill:" });
  assert.deepEqual(
    normalizeAutocompleteSuggestions({ items: "nope" }, "@skill:"),
    { items: [], prefix: "@skill:" },
  );
});

test("resolveAutocompleteEditorState maps the browser editor onto provider args", () => {
  // With full editor text the caret line/column are clamped into it.
  assert.deepEqual(
    resolveAutocompleteEditorState({ trigger: "@skill:", prefix: "co", text: "first\n@skill:co", cursorLine: 1, cursorCol: 9 }),
    { lines: ["first", "@skill:co"], cursorLine: 1, cursorCol: 9 },
  );
  // Out-of-range carets clamp instead of throwing.
  assert.deepEqual(
    resolveAutocompleteEditorState({ trigger: "@skill:", prefix: "", text: "one", cursorLine: 9, cursorCol: 99 }),
    { lines: ["one"], cursorLine: 0, cursorCol: 3 },
  );
  // Protocol-only requests get a synthetic line of trigger+prefix.
  assert.deepEqual(
    resolveAutocompleteEditorState({ trigger: "@skill:", prefix: "co" }),
    { lines: ["@skill:co"], cursorLine: 0, cursorCol: 9 },
  );
});

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

test("extension completions keep the trigger open with a closing space", () => {
  assert.deepEqual(
    buildExtensionInsertText("@skill:", { value: "code-review", label: "code-review" }),
    { text: "@skill:code-review ", cursorOffset: "@skill:code-review ".length },
  );
  // A provider that returns the trigger inside the value is taken verbatim.
  assert.deepEqual(
    buildExtensionInsertText("@skill:", { value: "@skill:tdd", label: "tdd" }),
    { text: "@skill:tdd ", cursorOffset: "@skill:tdd ".length },
  );
});
