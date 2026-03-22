# AST Extension
## Install from git URL

```bash
pi install git:github.com/yofriadi/pi-extensions@ast-v<version>
```

To load only this extension from the monorepo package source, use package filtering in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/yofriadi/pi-extensions@ast-v<version>",
      "extensions": ["packages/ast/src/index.ts"]
    }
  ]
}
```

This extension provides integration with `ast-grep`.

## Features

- Health check for the `ast-grep` binary (`sg_health` tool)
- AST Search (`ast_search` tool): search code using `ast-grep run --pattern`
- AST Rewrite (`ast_rewrite` tool): rewrite code using `ast-grep run --pattern --rewrite` (safe default: dry-run)

## Prerequisites

- Install the system `ast-grep` package.
- Ensure `ast-grep` is available in your PATH.
