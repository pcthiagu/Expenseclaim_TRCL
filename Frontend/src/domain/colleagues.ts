export function parseEmployeeCodes(value: string): string[] {
  return [...new Set(value.split(',').map((code) => code.trim()).filter(Boolean))];
}

export function serializeEmployeeCodes(codes: readonly string[]): string {
  return [...new Set(codes.map((code) => code.trim()).filter(Boolean))].join(', ');
}
