import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
    // Shared prettier config extension to disable stylistic conflicts
    prettierConfig,
    {
        files: ["**/*.ts"],
        plugins: {
            "@typescript-eslint": typescriptEslint,
            prettier: prettierPlugin,
        },
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "@typescript-eslint/naming-convention": [
                "warn",
                {
                    selector: "import",
                    format: ["camelCase", "PascalCase"],
                },
            ],
            "@typescript-eslint/no-explicit-any": ["error", { ignoreRestArgs: false }],
            // Let Prettier handle all formatting (indent, etc.)
            indent: "off",
            // Surface prettier issues as ESLint errors
            "prettier/prettier": [
                "error",
                {
                    tabWidth: 4,
                    useTabs: false,
                    trailingComma: "all",
                    printWidth: 100,
                    semi: true,
                    singleQuote: false,
                },
            ],
            curly: "warn",
            eqeqeq: "warn",
            "no-throw-literal": "warn",
            semi: "warn",
        },
    },
];
