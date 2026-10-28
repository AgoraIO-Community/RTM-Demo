const ENGLISH_NAMES = [
  "Alice", "Amelia", "Ava", "Bella", "Charlotte", "Chloe", "Clara", "Daisy",
  "Ella", "Emily", "Emma", "Eva", "Grace", "Hannah", "Hazel", "Ivy",
  "Jack", "James", "Leo", "Liam", "Lucas", "Mia", "Noah", "Nora",
  "Olivia", "Oscar", "Ruby", "Sophia", "Theo", "William", "Zoe",
] as const;

function hashText(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function isAudienceDisplayName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][a-z]+_\d{3}$/u.test(value);
}

export function createAudienceDisplayName(userId: string): string {
  const name = ENGLISH_NAMES[hashText(userId) % ENGLISH_NAMES.length];
  const suffix = String(hashText(`${userId}:suffix`) % 1000).padStart(3, "0");
  return `${name}_${suffix}`;
}
