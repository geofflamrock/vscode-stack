// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  env,
  ExtensionContext,
  workspace,
  window,
  Disposable,
  commands,
  Uri,
  version as vscodeVersion,
  WorkspaceFolder,
  LogOutputChannel,
  l10n,
  LogLevel,
  languages,
} from "vscode";
import {
  BranchTreeItem,
  StackTreeDataProvider,
  StackTreeItem,
} from "./StackTreeDataProvider";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  const disposables: Disposable[] = [];
  context.subscriptions.push(
    new Disposable(() => Disposable.from(...disposables).dispose())
  );

  const logger = window.createOutputChannel("Stack", { log: true });
  disposables.push(logger);

  const rootPath =
    workspace.workspaceFolders && workspace.workspaceFolders.length > 0
      ? workspace.workspaceFolders[0].uri.fsPath
      : undefined;

  const stackDataProvider = new StackTreeDataProvider(rootPath, logger);

  window.registerTreeDataProvider("stack", stackDataProvider);

  commands.registerCommand("stack.refresh", () => stackDataProvider.refresh());
  commands.registerCommand("stack.new", () => stackDataProvider.new());
  commands.registerCommand("stack.pull", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.pull(stack);
    }
  });
  commands.registerCommand("stack.push", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.push(stack, true);
    }
  });

  commands.registerCommand("stack.delete", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.delete(stack);
    }
  });

  commands.registerCommand("stack.switch", async (branch?: BranchTreeItem) => {
    if (branch) {
      await stackDataProvider.switchTo(branch);
    }
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
