/** Strict ordinary records reject unknown keys at an untrusted input boundary. */
export declare function record(value: unknown, keys: string[]): value is Record<string, unknown>;
/** Dense bounded arrays reject holes that Array.every otherwise silently skips. */
export declare function dense(value: unknown, max: number, check: (entry: unknown) => boolean): value is unknown[];
/** Preserve exact nonblank identities, including surrounding whitespace. */
export declare function identity(value: unknown): value is string;
