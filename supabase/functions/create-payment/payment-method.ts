/** Only configured, own string keys may become payment provider methods. */
export function isAllowedPaymentMethod<T extends Record<string, readonly string[]>>(
  methods: T,
  candidate: unknown,
): candidate is Extract<keyof T, string> {
  return typeof candidate === 'string'
    && Object.prototype.hasOwnProperty.call(methods, candidate);
}
