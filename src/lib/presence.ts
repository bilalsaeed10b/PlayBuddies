/** Each tab owns one child. A user stays online while any child remains. */
export function hasConnections(value: unknown): boolean {
  return Boolean(value && typeof value === "object" &&
    Object.values(value).some((connected) => connected === true));
}
