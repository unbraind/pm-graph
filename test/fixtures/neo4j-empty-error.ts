/** Module-evaluation failure with an Error instance that has no message. */

const emptyError = new Error();
Object.defineProperty(emptyError, "message", { value: undefined });
throw emptyError;
