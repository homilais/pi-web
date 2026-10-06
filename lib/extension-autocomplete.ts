// Shared logic for extension autocomplete (the "@skill:" flow).
//
// Terminal pi chains providers registered through
// `ExtensionUIContext.addAutocompleteProvider()` on top of a base file/command
// provider. The web UI keeps its own @-file completion in ChatInput, so the
// providers extensions register here are stored on the session wrapper and
// queried on demand through the `get_autocomplete` RPC; results stream back as
// `autocomplete_result` events. This module holds the pure pieces of that
// flow — trigger detection (client), provider chaining (server), and result
// normalization — so both sides and the tests share one implementation.

export interface ExtensionAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface ExtensionAutocompleteSuggestions {
  items: ExtensionAutocompleteItem[];
  prefix: string;
}

/** The pi-tui provider shape extensions already implement. */
export interface ExtensionAutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<ExtensionAutocompleteSuggestions | null>;
  applyCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: ExtensionAutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
}

export type ExtensionAutocompleteProviderFactory = (
  current: ExtensionAutocompleteProvider | null,
) => ExtensionAutocompleteProvider;

/** Client → server: POST /api/agent/[id] body for an autocomplete query. */
export interface ExtensionAutocompleteRequest {
  type: "get_autocomplete";
  /** Echoed back so the client can drop stale responses. */
  requestId: string;
  /** The query text after the trigger, e.g. "co" for "@skill:co". */
  prefix: string;
  /** The trigger token, e.g. "@skill:" */
  trigger: string;
  /** The full editor text, so providers can inspect the current line. */
  text?: string;
  /** Zero-based caret line within `text`. */
  cursorLine?: number;
  /** Caret column within that line. */
  cursorCol?: number;
}

/** Server → client: both the POST response body and the SSE event of that type. */
export interface ExtensionAutocompleteResult {
  type: "autocomplete_result";
  requestId: string;
  items: ExtensionAutocompleteItem[];
  prefix: string;
}

/** Triggers the chat input recognizes before it asks the server. The TUI
 *  extension accepts both colons (/@skill[:：]/), so the web input does too. */
export const EXTENSION_AUTOCOMPLETE_TRIGGERS: readonly string[] = ["@skill:", "@skill："];

/**
 * A hung provider must not hold the POST open forever: the caller's own
 * timeout (3s client-side) is the outer bound, this one aborts the provider
 * call so the request settles early with an empty list.
 */
export const AUTOCOMPLETE_PROVIDER_TIMEOUT_MS = 2_500;

export interface ExtensionTriggerMatch {
  /** The full trigger token, e.g. "@skill:" */
  trigger: string;
  /** Query text after the trigger, e.g. "co" for "@skill:co"; may be empty. */
  query: string;
}

/**
 * Match an extension trigger against an @-token (`"@"` plus the query
 * extractAtQuery captured). Quoted tokens never match — those are file paths.
 */
export function matchExtensionTriggerToken(atToken: string): ExtensionTriggerMatch | null {
  for (const trigger of EXTENSION_AUTOCOMPLETE_TRIGGERS) {
    if (atToken === trigger) return { trigger, query: "" };
    if (atToken.startsWith(trigger) && atToken.length > trigger.length) {
      return { trigger, query: atToken.slice(trigger.length) };
    }
  }
  return null;
}

/**
 * Chain one more provider onto the registered ones. Later factories receive the
 * previous provider (`null` for the first), mirroring the TUI's wrapper list,
 * and errors leave the existing chain untouched.
 */
export function appendAutocompleteProvider(
  providers: ExtensionAutocompleteProvider[],
  factory: ExtensionAutocompleteProviderFactory,
): ExtensionAutocompleteProvider {
  const current = providers.length > 0 ? providers[providers.length - 1] : null;
  const next = factory(current);
  if (!next || typeof next.getSuggestions !== "function") {
    throw new Error("addAutocompleteProvider factory must return a provider with getSuggestions()");
  }
  providers.push(next);
  return next;
}

/**
 * The TUI always registers a base editor provider before extensions run, so
 * extension factories freely dereference `current`. In pi-web there is no
 * editor; seed the chain with this no-op base so first factories written for
 * the TUI (`current.triggerCharacters ?? []`) do not throw on null.
 */
export function createBaseAutocompleteProvider(): ExtensionAutocompleteProvider {
  return {
    getSuggestions: async () => null,
  };
}

/**
 * Drop malformed shapes so one sloppy provider cannot break the popup: keeps
 * only { value, label } items and falls back to the trigger as the prefix.
 */
export function normalizeAutocompleteSuggestions(
  suggestions: unknown,
  fallbackPrefix: string,
): ExtensionAutocompleteSuggestions {
  const raw = suggestions as { items?: unknown; prefix?: unknown } | null | undefined;
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const items: ExtensionAutocompleteItem[] = [];
  for (const entry of rawItems) {
    const candidate = entry as { value?: unknown; label?: unknown; description?: unknown } | null;
    if (typeof candidate?.value !== "string" || typeof candidate.label !== "string") continue;
    items.push({
      value: candidate.value,
      label: candidate.label,
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
    });
  }
  return {
    items,
    prefix: typeof raw?.prefix === "string" && raw.prefix ? raw.prefix : fallbackPrefix,
  };
}

export interface AutocompleteEditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

/**
 * Build the lines/cursor state a provider sees. The browser editor reports the
 * full text plus the caret, which maps onto the lines/cursor arguments TUI
 * providers expect; a request without text (protocol-only clients, tests) gets
 * a synthetic single line of trigger+prefix with the caret at its end.
 */
export function resolveAutocompleteEditorState(
  command: Pick<ExtensionAutocompleteRequest, "prefix" | "trigger" | "text" | "cursorLine" | "cursorCol">,
): AutocompleteEditorState {
  const trigger = typeof command.trigger === "string" ? command.trigger : "";
  const prefix = typeof command.prefix === "string" ? command.prefix : "";
  if (typeof command.text === "string" && command.text.length > 0) {
    const lines = command.text.split("\n");
    const cursorLine = Math.min(Math.max(0, command.cursorLine ?? 0), lines.length - 1);
    const line = lines[cursorLine] ?? "";
    const cursorCol = Math.min(Math.max(0, command.cursorCol ?? line.length), line.length);
    return { lines, cursorLine, cursorCol };
  }
  const line = `${trigger}${prefix}`;
  return { lines: [line], cursorLine: 0, cursorCol: line.length };
}

export interface ExtensionInsertion {
  text: string;
  cursorOffset: number;
}

/**
 * Replacement for the trigger token when an extension suggestion is confirmed:
 * the trigger stays (so the provider stays active for further typing), the
 * chosen value follows, and the trailing space closes the token. A provider
 * that returns the trigger inside `value` is taken verbatim instead.
 */
export function buildExtensionInsertText(
  trigger: string,
  item: ExtensionAutocompleteItem,
): ExtensionInsertion {
  const body = item.value.startsWith(trigger) ? item.value : `${trigger}${item.value}`;
  const text = `${body} `;
  return { text, cursorOffset: text.length };
}
