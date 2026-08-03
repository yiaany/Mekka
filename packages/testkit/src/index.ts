export function requireHeader(headers: Headers, name: string): string {
  const value = headers.get(name);

  if (value === null) {
    throw new Error(`Expected response header ${name}.`);
  }

  return value;
}
