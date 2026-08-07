// Escapes a value for safe interpolation into a JCR-SQL2 string literal (doubles single quotes) --
// mirrors functions:sqlencode from the legacy JSP / JCRContentUtils.sqlEncode server-side.
export function sqlEncode(value: string): string {
    return value.replaceAll("'", "''");
}
