export interface DeprecatedQueryDtoImport {
  file: string;
  line: number;
  specifier: string;
}

export function findDeprecatedQueryDtoImports(filePath: string, sourceText: string): DeprecatedQueryDtoImport[];
export function checkDeprecatedQueryDtoImports(sourceRoot?: string): Promise<{
  checkedFiles: number;
  violations: DeprecatedQueryDtoImport[];
}>;
