/** Parse JSONC: block and line comments, trailing commas. */
export declare const parseJsonc: (text: string) => unknown;
/** The overlay with the template's limits filled in under its own; JSON text. */
export declare const mergeOverlayLimits: (templateText: string, overlayText: string) => string;
