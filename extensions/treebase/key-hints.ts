import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

const KEY_LABELS: Record<string, string> = {
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    pageup: "PgUp",
    pagedown: "PgDn",
    escape: "Esc",
    esc: "Esc",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Del",
    home: "Home",
    end: "End",
    space: "Space",
};

function keysFor(bindingName: Keybinding): string[] {
    const kb = getKeybindings();
    const configured = kb.getKeys(bindingName);
    if (configured.length > 0) return configured;

    const defaultKeys = kb.getDefinition(bindingName).defaultKeys;
    return Array.isArray(defaultKeys) ? [...defaultKeys] : [defaultKeys];
}

function fallbackText(bindingName: Keybinding): string {
    const short = bindingName.split(".").pop() ?? bindingName;
    return short.replace(/([A-Z])/g, " $1").toLowerCase();
}

export function formatKey(key: string): string {
    return key
        .split("+")
        .map((part) => {
            const normalized = part.trim().toLowerCase();
            if (normalized === "ctrl" || normalized === "control") return "Ctrl";
            if (normalized === "alt" || normalized === "meta" || normalized === "option") return "Alt";
            if (normalized === "shift") return "Shift";
            return KEY_LABELS[normalized] ?? (part.length === 1 ? part.toUpperCase() : part);
        })
        .join("+");
}

export function keyText(bindingName: Keybinding, opts: { maxKeys?: number } = {}): string {
    const keys = keysFor(bindingName);
    if (keys.length === 0) return fallbackText(bindingName);
    return keys.slice(0, opts.maxKeys ?? 2).map(formatKey).join("/");
}

export function keyHint(bindingName: Keybinding, label: string): string {
    return `${keyText(bindingName)}: ${label}`;
}
