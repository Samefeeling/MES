/** Resolve imported SharePoint columns without changing list data. */
export interface ListField {
  InternalName: string;
  Title: string;
  ReadOnlyField?: boolean;
}
const key = (value: string): string => value.replace(/[\s_-]+/g, '').toLowerCase();

export function resolveField(fields: ListField[], name: string): ListField | undefined {
  const exact = fields.find(field => field.InternalName === name);
  if (exact) return exact;
  const matches = fields.filter(field =>
    key(field.InternalName) === key(name) || key(field.Title) === key(name));
  if (matches.length > 1) throw new Error(`Ambiguous SharePoint column: ${name}. Check the list settings.`);
  return matches[0];
}

export function readableFields(row: Record<string, unknown>, fields: ListField[]): Record<string, unknown> {
  const result = { ...row };
  for (const field of fields) {
    if (!(field.InternalName in row) || field.Title in result) continue;
    if (resolveField(fields, field.Title)?.InternalName === field.InternalName) {
      result[field.Title] = row[field.InternalName];
    }
  }
  return result;
}

export function writableFields(values: Record<string, unknown>, fields: ListField[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const field = resolveField(fields, name);
    if (!field) throw new Error(`Missing SharePoint column: ${name}. Add the column or correct its display name in list settings.`);
    if (field.ReadOnlyField) throw new Error(`SharePoint column is read-only: ${name}.`);
    if (field.InternalName in result) throw new Error(`Duplicate SharePoint column mapping: ${name}.`);
    result[field.InternalName] = value;
  }
  return result;
}
