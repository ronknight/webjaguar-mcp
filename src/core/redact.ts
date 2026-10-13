// Removes secrets from anything that may reach a log, an error message or a tool result.

const SECRET_FIELD = /(api[_-]?key|password|passwd|secret|token|authorization|session[_-]?id|client[_-]?secret)/i;
const MASK = "***";

export class Redactor {
  private secrets: string[] = [];

  /** Registers literal secret values (API keys, passwords, tokens) to mask. */
  add(...values: Array<string | undefined | null>): void {
    for (const value of values) {
      if (value && value.length >= 4 && !this.secrets.includes(value)) {
        this.secrets.push(value);
      }
    }
    // Longest first, so a secret that contains another is masked whole.
    this.secrets.sort((a, b) => b.length - a.length);
  }

  /** Masks registered secrets and common credential shapes in free text. */
  text(input: string): string {
    let out = input;
    for (const secret of this.secrets) {
      out = out.split(secret).join(MASK);
    }
    return out
      .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`)
      .replace(/("?(?:api[_-]?key|password|token|client_secret|access_token|refresh_token)"?\s*[:=]\s*)"[^"]*"/gi, `$1"${MASK}"`);
  }

  /** Deep-copies a value, masking secret-named fields and registered secrets. */
  value<T>(input: T): T {
    return this.walk(input, 0) as T;
  }

  private walk(input: unknown, depth: number): unknown {
    if (depth > 50) return input;
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.walk(item, depth + 1));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        out[key] = SECRET_FIELD.test(key) && typeof val === "string" && val ? MASK : this.walk(val, depth + 1);
      }
      return out;
    }
    return input;
  }
}
